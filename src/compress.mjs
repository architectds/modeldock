// Structured, CPU-only conversation compression for the compact path.
//
// A local backend with a small context window cannot finish an LLM handoff
// summary of a large history inside Codex's ~5 minute request timeout: prefill
// of the full history alone can run for minutes on a modest local backend, the
// client aborts, and the retry only resumes via the backend's KV cache.
// Instead of shrinking the model, shrink the history: extract the parts a
// handoff needs and drop the rest, deterministically, in milliseconds, on the
// CPU.
//
// Priority, in order:
//   1. current user asks   - the task definition, deduped and noise-stripped
//   2. the tail            - the recent state of the work, kept verbatim
//   3. assistant findings  - TF-IDF-scored conclusions, truncated to first and
//                            last sentence
//   4. recent tool calls   - bounded argument excerpts for the recent workflow
//   5. older tool calls    - aggregated into one inventory line
// Bulk tool outputs are dropped; recent snippets and decisive failures survive.
// A handoff must not mistake omitted old output for current authoritative state.

import { createHash } from "node:crypto";
import { CURRENT_TURN_MARKER } from "./router.mjs";

const HEARTBEAT_RE = /^<heartbeat>\s*<automation_id>([A-Za-z0-9_-]{1,128})<\/automation_id>\s*<current_time_iso>(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))<\/current_time_iso>\s*<instructions>([\s\S]+?)<\/instructions>\s*<\/heartbeat>\s*$/;

function parseHeartbeatText(text) {
  if (typeof text !== "string" || text.length > 128 * 1024) return null;
  const match = HEARTBEAT_RE.exec(text);
  if (!match || !Number.isFinite(Date.parse(match[2]))) return null;
  const [, automationId, time, instructions] = match;
  const version = createHash("sha256").update(automationId).update("\0").update(instructions).digest("hex");
  return { automationId, time, instructions, version };
}

function heartbeatIdentity(item) {
  if (item?.type !== "message" || item.role !== "user" || item.content?.length !== 1) return null;
  const part = item.content[0];
  if (!["input_text", "text"].includes(part?.type)) return null;
  return parseHeartbeatText(part.text);
}

function heartbeatMarker(item, identity, { count = 1, first = identity.time, last = identity.time } = {}) {
  const span = count === 1
    ? `<current_time_iso>${identity.time}</current_time_iso>`
    : `<runs>${count}</runs><first_time_iso>${first}</first_time_iso><last_time_iso>${last}</last_time_iso>`;
  return {
    ...item,
    content: [{
      ...item.content[0],
      text: `<heartbeat_history><automation_id>${identity.automationId}</automation_id><instruction_version>${identity.version}</instruction_version>${span}<note>Earlier scheduled invocation(s). The unchanged full instructions are retained in the latest heartbeat of this version.</note></heartbeat_history>`,
    }],
  };
}

// Codex keeps user messages when it compacts, so the same scheduled instruction
// can return dozens of times in the next model request. Factor only a complete,
// structured heartbeat whose instruction body is byte-identical after removing
// its timestamp. Keep the latest full instruction and every distinct version;
// leave ordinary user messages untouched. Before an existing compaction item,
// the earlier invocations can share one bounded history marker. Elsewhere keep
// short per-run markers in place so tool-turn chronology remains readable.
export function foldRecurringHeartbeatHistory(input) {
  if (!Array.isArray(input)) return input;
  const groups = new Map();
  let lastCompaction = -1;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index]?.type === "compaction") lastCompaction = index;
    const identity = heartbeatIdentity(input[index]);
    if (!identity) continue;
    const occurrences = groups.get(identity.version) || [];
    occurrences.push({ index, identity });
    groups.set(identity.version, occurrences);
  }
  if (![...groups.values()].some((occurrences) => occurrences.length > 1)) return input;

  const replacements = new Map();
  const omitted = new Set();
  for (const occurrences of groups.values()) {
    if (occurrences.length < 2) continue;
    const previous = occurrences.slice(0, -1);
    const compacted = previous.filter(({ index }) => index < lastCompaction);
    if (compacted.length) {
      const anchor = compacted.at(-1);
      replacements.set(anchor.index, heartbeatMarker(input[anchor.index], anchor.identity, {
        count: compacted.length,
        first: compacted[0].identity.time,
        last: anchor.identity.time,
      }));
      for (const { index } of compacted.slice(0, -1)) omitted.add(index);
    }
    for (const { index, identity } of previous) {
      if (index < lastCompaction) continue;
      replacements.set(index, heartbeatMarker(input[index], identity));
    }
  }
  return input.flatMap((item, index) => omitted.has(index) ? [] : [replacements.get(index) || item]);
}

const HISTORICAL_USER_DAYS = 14;
const RECENT_USER_KEEP = 8;
const HISTORICAL_USER_BUDGET = 6_000;
const HISTORICAL_USER_RE = /^<historical_user_requests\b/;

function messageTimeMs(item) {
  const value = item?.internal_chat_message_metadata_passthrough?.create_time;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return ms >= 0 && ms <= 8.64e15 ? ms : null;
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function historicalPlainUser(item) {
  if (item?.type !== "message" || item.role !== "user" || item.content?.length !== 1) return null;
  const part = item.content[0];
  if (!["input_text", "text"].includes(part?.type) || typeof part.text !== "string") return null;
  if (heartbeatIdentity(item) || /^<(?:heartbeat|heartbeat_history|historical_user_requests)\b/.test(part.text)) return null;
  return { text: part.text, timeMs: messageTimeMs(item) };
}

function hasLocalCompactionSummary(item) {
  return item?.type === "compaction" && typeof item.encrypted_content === "string" && item.encrypted_content.startsWith("kcr1:");
}

// A ModelDock CPU handoff already summarizes the history before this boundary.
// Codex nevertheless replays old user items beside it. Preserve current and
// post-handoff turns exactly, and replace only dated, plain-text pre-handoff
// human asks with a bounded, explicitly historical index. Undated or rich
// content is left alone: an unknown age is not evidence that it is obsolete.
// This changes only the provider projection, never Codex's recorded history.
function foldHistoricalUserHistory(input) {
  const boundary = input.findLastIndex(hasLocalCompactionSummary);
  if (boundary < 0) return input;
  const latestHeartbeat = [...input.slice(boundary + 1)].reverse().map(heartbeatIdentity).find(Boolean);
  let latestTime = latestHeartbeat ? Date.parse(latestHeartbeat.time) : 0;
  if (!latestTime) {
    for (const item of input) latestTime = Math.max(latestTime, messageTimeMs(item) || 0);
  }
  if (!Number.isFinite(latestTime) || latestTime <= 0) return input;

  const candidates = [];
  for (let index = 0; index < boundary; index += 1) {
    const plain = historicalPlainUser(input[index]);
    if (plain?.timeMs && plain.timeMs <= latestTime) candidates.push({ index, ...plain });
  }
  const recent = new Set(candidates.slice(-RECENT_USER_KEEP)
    .filter(({ timeMs }) => latestTime - timeMs <= HISTORICAL_USER_DAYS * 86_400_000)
    .map(({ index }) => index));
  const archived = candidates.filter(({ index }) => !recent.has(index));
  if (!archived.length) return input;

  const selected = [...archived.slice(0, 2), ...archived.slice(-30)]
    .filter((entry, index, entries) => entries.findIndex((other) => other.index === entry.index) === index);
  const lines = [
    `<historical_user_requests count="${archived.length}" first="${new Date(archived[0].timeMs).toISOString()}" last="${new Date(archived.at(-1).timeMs).toISOString()}">`,
    "These are earlier user requests, not the current task. The adjacent CPU handoff summarizes prior work. Current human overrides take priority over scheduled heartbeats.",
  ];
  let included = 0;
  for (const entry of selected) {
    const normalized = entry.text.replace(/\s+/g, " ").trim();
    const excerpt = firstAndLast(normalized, 150);
    const line = `${new Date(entry.timeMs).toISOString()} ${JSON.stringify(excerpt)}`;
    if (lines.join("\n").length + line.length + 30 > HISTORICAL_USER_BUDGET) break;
    lines.push(line);
    included += 1;
  }
  if (included < archived.length) lines.push(`${archived.length - included} earlier request(s) omitted from this index; see the CPU handoff for the historical context.`);
  lines.push("</historical_user_requests>");
  const anchor = archived[0].index;
  const archivedIndexes = new Set(archived.map(({ index }) => index));
  return input.flatMap((item, index) => {
    if (index === anchor) return [{
      ...item,
      content: [{ ...item.content[0], text: lines.join("\n") }],
    }];
    return archivedIndexes.has(index) ? [] : [item];
  });
}

// One owner for the local model's history projection. Both CPU compact and
// ordinary relay must apply the same derivation before Chat normalization.
export function projectLocalHistory(input) {
  const folded = foldRecurringHeartbeatHistory(input);
  return foldHistoricalUserHistory(folded);
}

const TOOL_OUTPUT_CAP = 150;
// The gateway expands a compaction item back into a user message whose text is
// our own previous extract - which always starts with the handoff header line
// ("HEAD: task=..."). That restored text is not a fresh user ask: it must never
// be capped like one, or the second compaction of a long session silently
// throws the whole history away (task, errors, and tool inventory all collapse
// to userCap characters and the model "forgets"). The marker is detected from
// the extract's own first line, not a separately written tag: the old
// "[Compressed conversation history]" header belonged to the removed
// summarize-then-return path and is never produced anymore.
const COMPRESSED_MARK_RE = /^HEAD:\s*(?:task|phase)=/m;
// The restored history grows a little every hop; keep its task and error lines
// plus the edges, bounded, instead of either capping it like a user ask or
// letting it grow unbounded across hops.
const BASE_BUDGET = 40_000;
const BASE_CRITICAL_RE = /^(?:LAST_ERROR:|TOOLS_AGGREGATED:)/;
const BASE_PLAN_RE = /^PLAN_STATE:/;
const BASE_LINE_CAP = 2_500;

function itemText(item) {
  if (!item || typeof item !== "object") return "";
  const text = Array.isArray(item.content)
    ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
    : typeof item.content === "string"
      ? item.content
      : "";
  return text.trim();
}

function toolOutputText(item) {
  const output = item?.output;
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return output
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return output == null ? "" : JSON.stringify(output);
}

function toolCallArguments(item) {
  if (typeof item?.input === "string") return item.input;
  if (typeof item?.arguments === "string") return item.arguments;
  return JSON.stringify(item?.input ?? item?.arguments ?? "");
}

// Flatten the Responses input into a list of keep-able lines. Reasoning items
// are omitted (they are noise for a handoff), tool outputs are truncated.
export function flattenConversation(input) {
  const lines = [];
  for (const item of input) {
    const type = item?.type;
    if (type === "message") {
      const role = item.role || "user";
      const body = itemText(item);
      if (!body) continue;
      if (role === "user" && item[CURRENT_TURN_MARKER] === true) {
        lines.push({ kind: "base", role: "user", text: body });
        continue;
      }
      if (role === "user" && HISTORICAL_USER_RE.test(body)) {
        lines.push({ kind: "base", role: "user", text: body });
        continue;
      }
      if (role === "user" && COMPRESSED_MARK_RE.test(body)) {
        // A restored compaction item. Strip the header line so hops do not
        // pile up "HEAD:" blocks, and keep the whole extract as one unit - it
        // is already compressed history.
        const rest = body.replace(COMPRESSED_MARK_RE, "").trim();
        if (rest) lines.push({ kind: "base", role: "user", text: rest });
        continue;
      }
      lines.push({ kind: "msg", role, text: `${role.toUpperCase()}: ${body}` });
    } else if (type === "function_call" || type === "custom_tool_call") {
      const args = toolCallArguments(item);
      lines.push({ kind: "tool", text: `TOOL_CALL: ${item.name || item.call_id}(${firstAndLast(args || "", 120)})` });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const output = toolOutputText(item);
      lines.push({ kind: "tool", text: `TOOL_OUTPUT: ${firstAndLast(output, TOOL_OUTPUT_CAP)}` });
    }
  }
  return lines;
}

function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9_]{2,}/g) || []);
}

// TF-IDF sentence scores: lines carrying rare tokens carry the information.
function tfidfScores(lines) {
  const docs = lines.map((line) => tokenize(line.text));
  const df = new Map();
  for (const tokens of docs) {
    for (const token of new Set(tokens)) df.set(token, (df.get(token) || 0) + 1);
  }
  const n = lines.length;
  return docs.map((tokens) => {
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    let score = 0;
    for (const [token, count] of tf) {
      const idf = Math.log(n / (df.get(token) || 1));
      score += (1 + Math.log(count)) * idf;
    }
    return tokens.length ? score / Math.sqrt(tokens.length + 1) : 0;
  });
}

function stripNoise(text) {
  return String(text)
    .replace(/\s*\d{1,2}:\d{2}\s*(AM|PM)/g, "")
    .replace(/\n{2,}/g, " ")
    .replace(/Context automatically compacted/g, "")
    .replace(/Reconnecting \/\d+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Sentence terminators in both families. The boundary used to be the ideographic
// full stop alone, so an English conversation - the common case - never found
// one and always fell back to a blind character cut. The CJK codepoints are
// escaped because sources here are ASCII-only (AGENTS.md): U+3002 ideographic
// full stop, U+FF01 fullwidth exclamation, U+FF1F fullwidth question mark.
const SENTENCE_END = /[\u3002\uFF01\uFF1F]|[.!?](?=\s|$)/;

// Snap a cut back to a word boundary, but only when one sits near the cut: CJK
// has no word spaces, and dragging a Western cut halfway across the text to
// reach a space would lose more than the ragged edge costs.
function snapToWord(text, fromEnd = false) {
  const at = fromEnd ? text.indexOf(" ") : text.lastIndexOf(" ");
  if (at < 0) return text;
  const kept = fromEnd ? text.length - at - 1 : at;
  if (kept < text.length * 0.75) return text;
  return fromEnd ? text.slice(at + 1) : text.slice(0, at);
}

// Keep a long assistant message's opening claim and its closing conclusion.
// The head is bounded by the cap even when a sentence runs long: searching the
// whole text for the first terminator let a message whose first sentence ended
// 4000 characters in ignore the cap entirely.
function firstAndLast(text, cap) {
  if (text.length <= cap) return text;
  const headMax = Math.floor(cap * 0.6);
  const window = text.slice(0, headMax);
  const end = SENTENCE_END.exec(window);
  const head = end ? window.slice(0, end.index + end[0].length) : snapToWord(window);
  const tail = snapToWord(text.slice(-Math.floor(cap * 0.4)), true);
  return `${head.trim()} ... ${tail.trim()}`;
}

// --- decisive-output extraction ------------------------------------------
// A handoff benefits more from the few lines that say what went wrong than
// from the full command output. Scan each tool output's head and tail for
// error-shaped lines (the tail carries late failures, the head early ones)
// and keep a small deduped set as explicit LAST_ERROR entries.
// Only decisive shapes count as error lines: explicit error markers, stack
// traces, nonzero exit codes, and hard failure verbs. A bare "error" token
// matches file names (error-translation.mjs), coverage tables, and prose, so
// it is deliberately absent here.
const ERROR_LINE_RE =
  /(?:^\s*(?:[A-Za-z]+:\s*)?(?:ERROR|FATAL|SEVERE|Unhandled\s+exception)[:\uFF1A]|\b[A-Z]\w*(?:Error|Exception)[:\uFF1A]\s|Traceback \(most recent call last\)|FullyQualifiedErrorId|\b\u2717\b|\u274C|Exit code: [1-9]\d*|\bCannot (?:find|read|resolve|open|write|access|connect|parse|load)\b|\bUnable to \w+\b|\bexception of type\b|\b(?:error|failed|failure)[s]?\s+(?:occurred|happened|while|when|to|during)\b)/i;
const ERROR_NEG_RE = /\b(?:no|zero)\s+errors?\b|\b0\s+errors?\b|\berrors?\s*:\s*0\b/i;
const ERROR_TABLE_RE = /\s\|\s|^---|\s-\s-\s/;
// A tool output that dumps source text (Get-Content / cat) reads like prose but
// is code, not a runtime failure: braces, template literals, and common
// statement keywords give it away.
const ERROR_CODE_RE = /[{}\[\]]|\$\{|\b(?:const|let|var|function|return|if|else|instanceof|throw)\b|\/\/|\/\*|`/;
const MAX_ERROR_LINES = 12;
const ERROR_LINE_CAP = 200;
const ERROR_SCAN = 80;

function structuredToolFailure(text, name) {
  const outputSection = /(?:^|\n)Output:\s*\n([\s\S]*)$/.exec(text)?.[1];
  let result;
  for (const candidate of [outputSection, text]) {
    if (!candidate) continue;
    try {
      result = JSON.parse(candidate.trim());
      break;
    } catch { /* A prose or partial result is handled by the line scan. */ }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const status = String(result.status || "");
  const failed = result.ok === false || result.success === false || /^(?:failed|error|rejected)$/.test(status.toLowerCase())
    || (result.error != null && result.ok !== true);
  if (!failed) return "";
  const error = result.error;
  const code = error && typeof error === "object" ? error.code : result.code;
  const message = typeof error === "string" ? error
    : error && typeof error === "object" ? error.message
      : result.message;
  return `LAST_ERROR: ${name}: ${[code, message || status || "failed"].filter(Boolean).join(" - ")}`.slice(0, ERROR_LINE_CAP);
}

export function extractErrorLines(input) {
  const seen = new Set();
  const lines = [];
  const items = Array.isArray(input) ? input : [];
  const callNames = new Map(items
    .filter((item) => ["function_call", "custom_tool_call"].includes(item?.type) && item.call_id)
    .map((item) => [item.call_id, item.name || "tool"]));
  // A long-lived task can have more than twelve historical failures. The
  // current unresolved failure must win the bounded handoff, not the oldest.
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (!item || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) continue;
    const output = toolOutputText(item);
    const structured = structuredToolFailure(output, callNames.get(item.call_id) || "tool");
    if (structured && !seen.has(structured.slice(0, 60))) {
      seen.add(structured.slice(0, 60));
      lines.push(structured);
      if (lines.length >= MAX_ERROR_LINES) return lines;
    }
    const all = output.split(/\r?\n/);
    const scanned = [...all.slice(0, ERROR_SCAN), ...all.slice(-ERROR_SCAN)];
    for (const raw of scanned) {
      const line = raw.trim();
      if (line.length < 4 || line.length > 400) continue;
      if (/^\s*\d/.test(line)) continue; // coverage/stat rows
      if (ERROR_TABLE_RE.test(line)) continue; // markdown/ASCII tables
      if (ERROR_CODE_RE.test(line) && !/^\s*(?:ERROR|FATAL|SEVERE)[:\uFF1A]/i.test(line)) continue; // dumped source, not a failure
      if (!ERROR_LINE_RE.test(line)) continue;
      if (ERROR_NEG_RE.test(line)) continue;
      const key = line.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`LAST_ERROR: ${line.slice(0, ERROR_LINE_CAP)}`);
      if (lines.length >= MAX_ERROR_LINES) return lines;
    }
  }
  return lines;
}

// Decisive-sentence signal for assistant findings: sentences that state a
// conclusion, decision, or cause outrank information-dense-but-ambient prose
// under equal TF-IDF. Deterministic word signals only - no model involved.
// Escaped per AGENTS.md (ASCII-only sources). In order: conclusion, decision,
// fix, resolve, cause, because, need, note, switch-to, suggest, success, found,
// next-step, ultimately, the-problem-is.
const SIGNAL_CJK_RE = /\u7ED3\u8BBA|\u51B3\u5B9A|\u4FEE\u590D|\u89E3\u51B3|\u539F\u56E0|\u56E0\u4E3A|\u9700\u8981|\u6CE8\u610F|\u6539\u7528|\u5EFA\u8BAE|\u6210\u529F|\u53D1\u73B0|\u4E0B\u4E00\u6B65|\u5F52\u6839\u7ED3\u5E95|\u95EE\u9898\u51FA\u5728/g;
const SIGNAL_EN_RE = /\b(root cause|fixed|decided|switched|conclusion|because|success|resolved|summary|turned out)\b/gi;

function signalScore(text) {
  const cjk = String(text).match(SIGNAL_CJK_RE);
  const en = String(text).match(SIGNAL_EN_RE);
  return (cjk ? cjk.length : 0) + (en ? en.length : 0);
}

// A file path inside serialized tool arguments: a Windows drive path on any
// drive letter, or a POSIX/relative path, ending in a name with an extension.
// The previous pattern matched only C:, D: and E:, so the inventory's file list
// was always empty on macOS and Linux - platforms this project ships installers
// for - and on any other Windows drive. Requiring an extension keeps command
// flags and bare "/" arguments out of the list.
const PATH_IN_ARGS = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@ +-]+[\\/])+[\w.@+-]+\.\w{1,8}/;

// Aggregate older tool calls into a single inventory line so hundreds of
// repetitive apply_patch/exec_command rows collapse to one.
export function aggregateToolCalls(lines, isKeptVerbatim) {
  const byName = new Map();
  const files = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind !== "tool" || !line.text.startsWith("TOOL_CALL:")) continue;
    if (isKeptVerbatim(i)) continue;
    const match = line.text.match(/TOOL_CALL: ([A-Za-z_]+)\(/);
    const name = match ? match[1] : "other";
    byName.set(name, (byName.get(name) || 0) + 1);
    const fileMatch = PATH_IN_ARGS.exec(line.text);
    if (fileMatch) {
      const file = fileMatch[0].split(/[\\/]/).slice(-2).join("/");
      if (!files.has(file)) files.set(file, name);
    }
  }
  if (!byName.size) return "";
  const inventory = [...byName.entries()].map(([name, count]) => `${name}\u00D7${count}`).join(", ");
  const fileList = [...files.keys()].slice(0, 12).join(", ");
  return `TOOLS_AGGREGATED: ${inventory}${fileList ? ` (files: ${fileList}...)` : ""}`;
}

// Raw character volume of the Responses input BEFORE any flattening: message
// text, reasoning text, tool call arguments, and full tool outputs. The
// compression ratio is measured against this, not against the flattened
// lines - flattening already drops reasoning (~29% of a real session) and
// truncates tool outputs (~33%), so measuring after flattening would report
// only the extract's own shrink (18%) instead of what compaction actually
// did (real ~4%). Arguments and input hold the same payload on a function
// call, so count whichever is present, never both.
function rawInputChars(input) {
  let n = 0;
  for (const item of input || []) {
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part?.text === "string") n += part.text.length;
      }
    } else if (typeof item.content === "string") {
      n += item.content.length;
    }
    if (item.output !== undefined) n += toolOutputText(item).length;
    if (typeof item.arguments === "string") n += item.arguments.length;
    else if (typeof item.input === "string") n += item.input.length;
    else if (item.input && typeof item.input === "object") n += JSON.stringify(item.input).length;
  }
  return n;
}

// Bound the restored-history unit: a long-lived session accumulates a little
// every hop, so keep the decisive structure - the leading task lines, the
// trailing edge (recent state), error/inventory lines, and the most recent
// user asks - and summarize what fell out. If the first tier still exceeds the
// budget, fall to smaller tiers; a hard head-only cap is the last resort. The
// restored unit is one multi-line text, so the cap works on its lines.
const BASE_TIERS = [
  { head: 8, tail: 20, recent: 10, critical: 8 },
  { head: 4, tail: 12, recent: 5, critical: 5 },
  { head: 2, tail: 6, recent: 2, critical: 3 },
];

function boundedBaseText(text) {
  if (text.length <= BASE_BUDGET) return text;
  const lines = text.split("\n");
  const n = lines.length;
  const latestPlan = lines.findLastIndex((line) => BASE_PLAN_RE.test(line));
  for (const tier of BASE_TIERS) {
    const userIdx = [];
    const criticalIdx = [];
    for (let i = 0; i < n; i++) if (/^USER:/.test(lines[i])) userIdx.push(i);
    for (let i = 0; i < n; i++) if (BASE_CRITICAL_RE.test(lines[i])) criticalIdx.push(i);
    const recent = new Set(userIdx.slice(-tier.recent));
    const critical = new Set(criticalIdx.slice(-tier.critical));
    const want = new Set();
    for (let i = 0; i < n; i++) {
      if (i < tier.head || i >= n - tier.tail) want.add(i);
      else if (recent.has(i) || critical.has(i)) want.add(i);
    }
    if (latestPlan >= 0) want.add(latestPlan);
    const kept = lines.filter((_, i) => want.has(i)).map((line) =>
      firstAndLast(line, BASE_PLAN_RE.test(line) ? 6_000 : BASE_LINE_CAP));
    const size = kept.join("\n").length;
    if (size <= BASE_BUDGET) {
      const dropped = Math.max(0, text.length - size);
      return `${kept.join("\n")}\n... ${dropped} characters of earlier compressed history omitted ...`;
    }
  }
  const edges = [...new Set([0, 1, latestPlan, n - 4, n - 3, n - 2, n - 1].filter((index) => index >= 0 && index < n))]
    .sort((a, b) => a - b)
    .map((index) => firstAndLast(lines[index], index === latestPlan ? 6_000 : 1_500));
  const edgeText = edges.join("\n");
  return `${edgeText}\n... ${Math.max(0, text.length - edgeText.length)} characters of earlier compressed history omitted ...`;
}

function truncateHead(text, max) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}\u2026`;
}

// A short, deterministic handoff header: what the task was, where the work
// stands, what failed, and which tools were used. This is the narrative layer
// a model-written handoff would provide, assembled from material the extract
// already kept - no model call, CPU only.
// The first field is deliberately named `task`, not `goal`: Codex's built-in
// `goal` tool carries the model-maintained objective and budget, while this
// header's value is only the compressor's read of the most recent user ask.
// Same word, different semantics would invite the model to conflate them.
function handoffHeader({ lines, kept, inventory, errorLines }) {
  const userLines = lines.filter((l) => l.kind === "msg" && l.role === "user");
  // Prefer a kept conclusion, falling back to the most recent assistant line:
  // the keep ratio can round a one-message session down to zero, but the
  // header still wants a phase.
  const lastAssistant =
    [...kept].reverse().find((l) => l.kind === "msg" && l.role === "assistant") ||
    [...lines].reverse().find((l) => l.kind === "msg" && l.role === "assistant");
  // The goal is the most recent real user ask: the leading user messages of a
  // session are usually injected system blocks (<recommended_plugins>, skills),
  // so skip those when picking it.
  const latestUser = userLines.at(-1);
  const currentHeartbeat = latestUser && parseHeartbeatText(latestUser.text.replace(/^USER:\s*/, ""));
  const lastHumanAsk = [...userLines].reverse().find((l) => !/^USER:\s*</.test(l.text));
  const firstCycleInstruction = currentHeartbeat?.instructions.trim().split(/\r?\n/).find(Boolean) || "";
  const task = currentHeartbeat
    ? truncateHead(`${currentHeartbeat.automationId}: ${firstCycleInstruction}`, 100)
    : lastHumanAsk ? truncateHead(lastHumanAsk.text.replace(/^USER:\s*/, ""), 100) : "";
  const phase = lastAssistant ? truncateHead(lastAssistant.text.replace(/^ASSISTANT:\s*/, ""), 100) : "";
  const head = [task && `task=${task}`, currentHeartbeat && `cycle_at=${currentHeartbeat.time}`, phase && `phase=${phase}`].filter(Boolean).join(" | ");
  const parts = [`HEAD: ${head || "task=unknown"}`];
  if (errorLines.length) {
    const failures = errorLines
      .slice(0, 3)
      .map((line) => line.replace(/^LAST_ERROR:\s*/, "").slice(0, 60))
      .join(" | ");
    parts.push(`FAILED: ${failures}`);
  }
  if (inventory) parts.push(`TOOLS: ${inventory.replace(/^TOOLS_AGGREGATED:\s*/, "")}`);
  return `${parts.join("\n")}\n---`;
}

function pairedToolOutput(input, callIndex) {
  const callId = input[callIndex]?.call_id;
  if (!callId) return null;
  for (let index = callIndex + 1; index < input.length; index++) {
    const item = input[index];
    if (item?.call_id !== callId) continue;
    if (["function_call_output", "custom_tool_call_output"].includes(item.type)) return item;
    if (["function_call", "custom_tool_call"].includes(item.type)) return null;
  }
  return null;
}

// A confirmed update_plan call is the session's explicit task state. Its full
// bounded steps are more reliable than trying to infer a plan from prose or
// retaining a generic 120-character TOOL_CALL excerpt.
function planCheckpoint(input) {
  const index = input.findLastIndex((item) => item?.type === "compaction" || item?.[CURRENT_TURN_MARKER] === true);
  return { index, hasPlan: index >= 0 && /^PLAN_STATE:/m.test(itemText(input[index])) };
}

function latestConfirmedPlan(input, checkpoint) {
  // A newer checkpoint owns its plan. Codex may replay older tool calls beside
  // that checkpoint; they must not overwrite the plan already carried there.
  const firstEligible = checkpoint.hasPlan ? checkpoint.index + 1 : 0;
  for (let index = input.length - 1; index >= firstEligible; index--) {
    const call = input[index];
    if (!["function_call", "custom_tool_call"].includes(call?.type) || call.name !== "update_plan") continue;
    const output = pairedToolOutput(input, index);
    if (!output || extractErrorLines([call, output]).length) continue;
    let args;
    try { args = JSON.parse(toolCallArguments(call)); } catch { continue; }
    if (!Array.isArray(args?.plan) || !args.plan.length) continue;
    const timeMs = messageTimeMs(call) || messageTimeMs(output);
    const selectedSteps = args.plan.slice(-12);
    const state = {
      source: "update_plan",
      as_of: timeMs ? new Date(timeMs).toISOString() : null,
      explanation: firstAndLast(String(args.explanation || "").replace(/\s+/g, " ").trim(), 500),
      omitted_steps: Math.max(0, args.plan.length - 12),
      truncated_steps: selectedSteps.filter((entry) => String(entry?.step || "").length > 350).length,
      steps: selectedSteps.map((entry) => ({
        status: ["pending", "in_progress", "completed"].includes(entry?.status) ? entry.status : "unknown",
        step: firstAndLast(String(entry?.step || "").replace(/\s+/g, " ").trim(), 350),
      })).filter((entry) => entry.step),
      note: "Last confirmed plan; newer user instructions take priority. Recheck volatile facts before acting.",
    };
    if (!state.steps.length) continue;
    let line = `PLAN_STATE: ${JSON.stringify(state)}`;
    while (line.length > 6_000 && state.steps.length > 1) {
      state.steps.shift();
      state.omitted_steps += 1;
      line = `PLAN_STATE: ${JSON.stringify(state)}`;
    }
    return line;
  }
  return "";
}

// Compress a Responses input into handoff-oriented text. Deterministic, CPU
// only, milliseconds. Returns { text, originalChars, compressedChars } where
// originalChars is the raw input volume (see rawInputChars) and compressedChars
// is the extract's.
export function compressConversation(input, options = {}) {
  const {
    tailLines = 24,
    tailToolKeep = 40,
    assistantKeepRatio = 0.35,
    assistantCap = 180,
    userCap = 300,
  } = options;
  const projectedInput = projectLocalHistory(input);
  const checkpoint = planCheckpoint(projectedInput);
  const planState = latestConfirmedPlan(projectedInput, checkpoint);
  const suppressGenericPlan = Boolean(planState || checkpoint.hasPlan);
  const lines = flattenConversation(projectedInput);
  const scores = tfidfScores(lines);
  const keep = new Array(lines.length).fill(false);

  // 0. restored compaction output (previous hops) is already compressed
  //    history - it survives as a unit, never capped like a fresh user ask.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "base") keep[i] = true;
  }
  // 1. Current user asks define the task. A repeated ask keeps its latest
  //    position, not the stale first occurrence from an earlier cycle.
  const seenUser = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role !== "user") continue;
    const normalized = stripNoise(lines[i].text).replace(/\s+/g, " ");
    if (seenUser.has(normalized)) continue;
    seenUser.add(normalized);
    keep[i] = true;
  }
  // 2. the tail - recent state, verbatim.
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) keep[i] = true;
  // The latest substantive assistant update often carries the actual next
  // step. Keep one fuller copy even if later tool turns pushed it out of tail.
  const latestSubstantiveAssistant = lines.findLastIndex((line, i) =>
    i >= lines.length - 64 && line.kind === "msg" && line.role === "assistant" && line.text.length > 200);
  if (latestSubstantiveAssistant >= 0) keep[latestSubstantiveAssistant] = true;
  // 3. assistant findings - TF-IDF-scored, signal-boosted, noise-filtered,
  //    truncated. A sentence that states a conclusion or cause is kept before
  //    one that merely scores high on rare tokens.
  const noisy = (text) => (text.match(/\d{1,2}:\d{2}\s*(AM|PM)/g) || []).length > 1 || /\n{3,}/.test(text);
  const assistants = lines
    .map((line, i) => ({ i, score: scores[i], signal: signalScore(line.text), line }))
    .filter((x) => x.line.kind === "msg" && x.line.role === "assistant" && !keep[x.i] && !noisy(x.line.text))
    .sort((a, b) => (b.signal - a.signal) || (b.score - a.score));
  for (const { i } of assistants.slice(0, Math.floor(assistants.length * assistantKeepRatio))) keep[i] = true;
  // 4. recent tool calls with bounded arguments.
  let keptTools = 0;
  for (let i = lines.length - 1; i >= 0 && keptTools < tailToolKeep; i--) {
    if (lines[i].kind === "tool" && lines[i].text.startsWith("TOOL_CALL:")) {
      keep[i] = true;
      keptTools++;
    }
  }
  // 5. aggregate the older tool calls.
  const inventory = aggregateToolCalls(lines, (i) => keep[i]);
  const omittedOutputs = lines.reduce((count, line, i) =>
    count + (line.kind === "tool" && line.text.startsWith("TOOL_OUTPUT:") && !keep[i] ? 1 : 0), 0);
  const kept = lines.flatMap((line, i) => keep[i] ? [{ ...line, sourceIndex: i }] : []);
  const baseLines = kept.filter((line) => line.kind === "base").map((line) => suppressGenericPlan ? {
    ...line,
    text: line.text.split("\n").filter((part) => !(planState && BASE_PLAN_RE.test(part)) && !/^TOOL_CALL: update_plan\(/.test(part)).join("\n"),
  } : line);
  const cleaned = kept.filter((line) => line.kind !== "base" && !(suppressGenericPlan && line.text.startsWith("TOOL_CALL: update_plan("))).map((line) => {
    let text = stripNoise(line.text);
    if (line.kind === "msg" && line.role === "assistant") {
      text = firstAndLast(text, line.sourceIndex === latestSubstantiveAssistant ? 2_500 : assistantCap);
    }
    // User asks keep their opening and closing edges: pasted errors and long
    // instructions usually end with the decisive part a blind head-cut would
    // throw away.
    if (line.kind === "msg" && line.role === "user" && text.length > userCap) text = firstAndLast(text, userCap);
    return { ...line, text };
  });
  if (inventory) cleaned.push({ kind: "tool", text: inventory });
  if (omittedOutputs) cleaned.push({ kind: "tool", text: `TOOL_OUTPUTS_OMITTED: ${omittedOutputs}. Re-read authoritative state before acting on old tool results.` });
  // Decisive error lines from tool outputs ride along explicitly.
  const errorLines = extractErrorLines(projectedInput);
  for (const errorLine of errorLines) cleaned.push({ kind: "tool", text: errorLine });
  const originalChars = rawInputChars(projectedInput);
  const assembled = [...baseLines.map((line) => ({ ...line, text: boundedBaseText(line.text) })), ...cleaned];
  const header = handoffHeader({ lines, kept, inventory, errorLines });
  const body = assembled.map((line) => line.text).filter(Boolean).join("\n");
  const text = [header, body, planState].filter(Boolean).join("\n");
  const compressedChars = text.length;
  return { text, originalChars, compressedChars, keptCount: cleaned.length };
}

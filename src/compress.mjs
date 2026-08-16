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
//   1. user asks           - the task definition, deduped and noise-stripped
//   2. the tail            - the recent state of the work, kept verbatim
//   3. assistant findings  - TF-IDF-scored conclusions, truncated to first and
//                            last sentence
//   4. recent tool calls   - kept verbatim so the handoff retains the feel of
//                            the actual recent workflow
//   5. older tool calls    - aggregated into one inventory line
// Tool outputs are dropped: a handoff needs to know what was done, not what
// each command printed.

const TOOL_OUTPUT_CAP = 150;
// Codex restores a compaction item into the conversation as a user message
// headed by a marker line. That restored text is our own previous extract, not
// a fresh user ask: it must never be capped like one, or the second compaction
// of a long session silently throws the whole history away (task, errors, and
// tool inventory all collapse to userCap characters and the model "forgets").
const COMPRESSED_MARK_RE = /^\s*\[\s*Compressed conversation history\s*\]\s*$/m;
// The restored history grows a little every hop; keep its task and error lines
// plus the edges, bounded, instead of either capping it like a user ask or
// letting it grow unbounded across hops.
const BASE_BUDGET = 40_000;
const BASE_KEEP_RE = /^(?:USER:|LAST_ERROR:|TOOLS_AGGREGATED:)/;

function itemText(item) {
  if (!item || typeof item !== "object") return "";
  const text = Array.isArray(item.content)
    ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join(" ")
    : typeof item.content === "string"
      ? item.content
      : "";
  return text.trim();
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
      if (role === "user" && COMPRESSED_MARK_RE.test(body)) {
        // A restored compaction item. Strip the marker so hops do not pile up
        // "[Compressed conversation history]" headers, and keep the whole
        // extract as one unit - it is already compressed history.
        const rest = body.replace(COMPRESSED_MARK_RE, "").trim();
        if (rest) lines.push({ kind: "base", role: "user", text: rest });
        continue;
      }
      lines.push({ kind: "msg", role, text: `${role.toUpperCase()}: ${body}` });
    } else if (type === "function_call" || type === "custom_tool_call") {
      const args = typeof item.input === "string" ? item.input : JSON.stringify(item.input || item.arguments || "");
      lines.push({ kind: "tool", text: `TOOL_CALL: ${item.name || item.call_id}(${(args || "").slice(0, 120)})` });
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
      lines.push({ kind: "tool", text: `TOOL_OUTPUT: ${output.slice(0, TOOL_OUTPUT_CAP)}` });
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

// Sentence terminators in both families. The boundary used to be "。" alone, so
// an English conversation - the common case - never found one and always fell
// back to a blind character cut.
const SENTENCE_END = /[。！？]|[.!?](?=\s|$)/;

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
  /(?:^\s*(?:[A-Za-z]+:\s*)?(?:ERROR|FATAL|SEVERE|Unhandled\s+exception)[:：]|\b[A-Z]\w*(?:Error|Exception)[:：]\s|Traceback \(most recent call last\)|FullyQualifiedErrorId|\b✗\b|❌|Exit code: [1-9]\d*|\bCannot (?:find|read|resolve|open|write|access|connect|parse|load)\b|\bUnable to \w+\b|\bexception of type\b|\b(?:error|failed|failure)[s]?\s+(?:occurred|happened|while|when|to|during)\b)/i;
const ERROR_NEG_RE = /\b(?:no|zero)\s+errors?\b|\b0\s+errors?\b|\berrors?\s*:\s*0\b/i;
const ERROR_TABLE_RE = /\s\|\s|^---|\s-\s-\s/;
// A tool output that dumps source text (Get-Content / cat) reads like prose but
// is code, not a runtime failure: braces, template literals, and common
// statement keywords give it away.
const ERROR_CODE_RE = /[{}\[\]]|\$\{|\b(?:const|let|var|function|return|if|else|instanceof|throw)\b|\/\/|\/\*|`/;
const MAX_ERROR_LINES = 12;
const ERROR_LINE_CAP = 200;
const ERROR_SCAN = 80;

export function extractErrorLines(input) {
  const seen = new Set();
  const lines = [];
  for (const item of input || []) {
    if (!item || (item.type !== "function_call_output" && item.type !== "custom_tool_call_output")) continue;
    const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
    const all = output.split(/\r?\n/);
    const scanned = [...all.slice(0, ERROR_SCAN), ...all.slice(-ERROR_SCAN)];
    for (const raw of scanned) {
      const line = raw.trim();
      if (line.length < 4 || line.length > 400) continue;
      if (/^\s*\d/.test(line)) continue; // coverage/stat rows
      if (ERROR_TABLE_RE.test(line)) continue; // markdown/ASCII tables
      if (ERROR_CODE_RE.test(line)) continue; // dumped source, not a failure
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
const SIGNAL_CJK_RE = /结论|决定|修复|解决|原因|因为|需要|注意|改用|建议|成功|发现|下一步|归根结底|问题出在/g;
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
  const inventory = [...byName.entries()].map(([name, count]) => `${name}×${count}`).join(", ");
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
    if (typeof item.output === "string") n += item.output.length;
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
  { head: 8, tail: 20, recent: 10 },
  { head: 4, tail: 12, recent: 5 },
  { head: 2, tail: 6, recent: 2 },
];

function boundedBaseText(text) {
  if (text.length <= BASE_BUDGET) return text;
  const lines = text.split("\n");
  const n = lines.length;
  for (const tier of BASE_TIERS) {
    const userIdx = [];
    for (let i = 0; i < n; i++) if (/^USER:/.test(lines[i])) userIdx.push(i);
    const recent = new Set(userIdx.slice(-tier.recent));
    const want = new Set();
    for (let i = 0; i < n; i++) {
      if (i < tier.head || i >= n - tier.tail) want.add(i);
      else if (BASE_KEEP_RE.test(lines[i]) || recent.has(i)) want.add(i);
    }
    const kept = lines.filter((_, i) => want.has(i));
    const size = kept.join("\n").length;
    if (size <= BASE_BUDGET) {
      const dropped = text.length - size;
      return `${kept.join("\n")}\n... ${dropped} characters of earlier compressed history omitted ...`;
    }
  }
  const head = lines.slice(0, 2).join("\n");
  return `${head}\n... ${text.length - head.length} characters of earlier compressed history omitted ...`;
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
  const lines = flattenConversation(input);
  const scores = tfidfScores(lines);
  const keep = new Array(lines.length).fill(false);

  // 0. restored compaction output (previous hops) is already compressed
  //    history - it survives as a unit, never capped like a fresh user ask.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "base") keep[i] = true;
  }
  // 1. user asks define the task - always survive, deduped.
  const seenUser = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].role !== "user") continue;
    const normalized = stripNoise(lines[i].text).replace(/\s+/g, " ");
    if (seenUser.has(normalized)) continue;
    seenUser.add(normalized);
    keep[i] = true;
  }
  // 2. the tail - recent state, verbatim.
  for (let i = Math.max(0, lines.length - tailLines); i < lines.length; i++) keep[i] = true;
  // 3. assistant findings - TF-IDF-scored, signal-boosted, noise-filtered,
  //    truncated. A sentence that states a conclusion or cause is kept before
  //    one that merely scores high on rare tokens.
  const noisy = (text) => (text.match(/\d{1,2}:\d{2}\s*(AM|PM)/g) || []).length > 1 || /\n{3,}/.test(text);
  const assistants = lines
    .map((line, i) => ({ i, score: scores[i], signal: signalScore(line.text), line }))
    .filter((x) => x.line.kind === "msg" && x.line.role === "assistant" && !keep[x.i] && !noisy(x.line.text))
    .sort((a, b) => (b.signal - a.signal) || (b.score - a.score));
  for (const { i } of assistants.slice(0, Math.floor(assistants.length * assistantKeepRatio))) keep[i] = true;
  // 4. recent tool calls verbatim.
  let keptTools = 0;
  for (let i = lines.length - 1; i >= 0 && keptTools < tailToolKeep; i--) {
    if (lines[i].kind === "tool" && lines[i].text.startsWith("TOOL_CALL:")) {
      keep[i] = true;
      keptTools++;
    }
  }
  // 5. aggregate the older tool calls.
  const inventory = aggregateToolCalls(lines, (i) => keep[i]);
  const kept = lines.filter((_, i) => keep[i]).map((line) => ({ ...line }));
  const baseLines = kept.filter((line) => line.kind === "base");
  const cleaned = kept.filter((line) => line.kind !== "base").map((line) => {
    let text = stripNoise(line.text);
    if (line.kind === "msg" && line.role === "assistant") text = firstAndLast(text, assistantCap);
    // User asks keep their opening and closing edges: pasted errors and long
    // instructions usually end with the decisive part a blind head-cut would
    // throw away.
    if (line.kind === "msg" && line.role === "user" && text.length > userCap) text = firstAndLast(text, userCap);
    return { ...line, text };
  });
  if (inventory) cleaned.push({ kind: "tool", text: inventory });
  // Decisive error lines from tool outputs ride along explicitly.
  for (const errorLine of extractErrorLines(input)) cleaned.push({ kind: "tool", text: errorLine });
  const originalChars = rawInputChars(input);
  const assembled = [...baseLines.map((line) => ({ ...line, text: boundedBaseText(line.text) })), ...cleaned];
  const compressedChars = assembled.reduce((sum, line) => sum + line.text.length, 0);
  const text = assembled.map((line) => line.text).join("\n");
  return { text, originalChars, compressedChars, keptCount: cleaned.length };
}

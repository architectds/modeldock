// Structured, CPU-only conversation compression for the compact path.
//
// A local backend (qwen3.8 at 81920 ctx) cannot finish an LLM handoff summary
// of a 60K+ token history inside Codex's ~5 minute request timeout: prefill of
// the full history alone runs minutes on the AMD Vulkan backend, the client
// aborts, and the retry only resumes via the llama.cpp KV cache. Instead of
// shrinking the model, shrink the history: extract the parts a handoff needs
// and drop the rest, deterministically, in milliseconds, on the CPU.
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
  // 3. assistant findings - TF-IDF-scored, noise-filtered, truncated.
  const noisy = (text) => (text.match(/\d{1,2}:\d{2}\s*(AM|PM)/g) || []).length > 1 || /\n{3,}/.test(text);
  const assistants = lines
    .map((line, i) => ({ i, score: scores[i], line }))
    .filter((x) => x.line.kind === "msg" && x.line.role === "assistant" && !keep[x.i] && !noisy(x.line.text))
    .sort((a, b) => b.score - a.score);
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
  const cleaned = kept.map((line) => {
    let text = stripNoise(line.text);
    if (line.kind === "msg" && line.role === "assistant") text = firstAndLast(text, assistantCap);
    if (line.kind === "msg" && line.role === "user" && text.length > userCap) text = `${text.slice(0, userCap - 3)}...`;
    return { ...line, text };
  });
  if (inventory) cleaned.push({ kind: "tool", text: inventory });
  const originalChars = rawInputChars(input);
  const compressedChars = cleaned.reduce((sum, line) => sum + line.text.length, 0);
  const text = cleaned.map((line) => line.text).join("\n");
  return { text, originalChars, compressedChars, keptCount: cleaned.length };
}

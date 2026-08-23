// One SSE framing rule for the whole gateway.
//
// The split(/\r?\n/) -> startsWith("data:") -> JSON.parse walk was implemented
// eight times across gateway.mjs, metrics.mjs and upstreams.mjs, each copy
// re-deciding on its own what to do about [DONE], blank data lines and
// malformed JSON. Eight copies of a framing rule is a framing rule that gets
// fixed in one - the same reasoning that collapsed the five loopback checks
// into loopback.mjs. The two stream pipes keep their own line loops (their
// return/continue control flow is block-scoped and easy to break in a callback
// rewrite) but parse each line through the same primitive.
import { StringDecoder } from "node:string_decoder";

// The line primitive: the parsed event for a well-formed `data:` line, or
// undefined for anything else - non-data lines, blank data, [DONE], and
// malformed JSON all read as "nothing here", which is the tolerance every
// caller had individually.
export function parseSseData(line) {
  if (!line.startsWith("data:")) return undefined;
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

// Walk every parsed event in a complete SSE text (or a single event block).
// Returning false from fn stops the walk early.
export function forEachSseEvent(text, fn) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const event = parseSseData(line);
    if (event === undefined) continue;
    if (fn(event) === false) return;
  }
}

// The raw `data:` payload strings, unparsed. For the one caller
// (parseMcpTextResult) that applies its own multi-shape JSON handling and so
// needs the strings rather than the events.
export function sseDataLines(text) {
  const payloads = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
  }
  return payloads;
}

// Incremental SSE scanner used by the relay's tee observer. It recognizes
// complete events as they arrive across chunk boundaries, hands each parsed
// event to the callback, and never retains the stream. The forwarded bytes are
// never parsed for this purpose beyond this read-only copy.
export function createUsageTee(onEvent) {
  let buffer = "";
  let discardingOversizedEvent = false;
  const decoder = new StringDecoder("utf8");
  const consume = (text) => {
    if (discardingOversizedEvent) {
      const boundary = text.match(/\r?\n\r?\n/);
      if (!boundary) return;
      text = text.slice(boundary.index + boundary[0].length);
      discardingOversizedEvent = false;
    }
    buffer += text;
  };
  const process = () => {
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      forEachSseEvent(block, (event) => {
        onEvent?.(event);
      });
    }
    // Usage observation must never hold an unbounded malformed event. This
    // affects only telemetry: the client-facing stream is forwarded elsewhere
    // and is never truncated by this observer.
    if (Buffer.byteLength(buffer) > 1_000_000) {
      buffer = "";
      discardingOversizedEvent = true;
    }
  };
  const push = (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    consume(text);
    process();
  };
  const end = () => {
    consume(decoder.end());
    process();
    // Non-streaming upstreams return a single JSON body with no SSE framing. When
    // the buffer is a complete JSON object (a stream would leave a partial event
    // or an empty buffer here), surface it as a completed response so usage and
    // tool-call affinity are still captured.
    const trimmed = buffer.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          onEvent?.({ type: "response.completed", response: parsed });
        }
      } catch {
        // Partial SSE event residue or non-JSON body: ignore.
      }
    }
    buffer = "";
  };
  return { push, end };
}

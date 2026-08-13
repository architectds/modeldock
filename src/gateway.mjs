import { Readable } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { bareModelId, modelEntryFor, providerForModel } from "./profiles.mjs";
import { recordUsageEvent } from "./usage-events.mjs";
import { translateUpstreamError, freeEmptyOutputError } from "./error-translation.mjs";
import { RouteAffinity, routeResponsesRequest } from "./router.mjs";
import { extractResponseUsage } from "./metrics.mjs";

// Hosted / special tool types Codex can emit that the Go and DeepSeek upstreams
// reject. The catalog declarations are the primary control; stripping here is the
// safety net, not the mechanism.
const HOSTED_TOOL_TYPES = new Set([
  "tool_search",
  "web_search",
  "computer_use",
  "browser_use",
  "artifact",
]);

// Tools that hand the model bytes it cannot interpret (text-only main models).
// The vision path is vision_inspect or direct image escalation, not view_image.
const TEXT_MODEL_HIDDEN_TOOLS = new Set(["view_image"]);

function redactBearer(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
}

export { redactBearer };

// MODELDOCK_DUMP_DIR diagnostics: write the exact upstream request body so a
// stuck turn (tool-pairing rejections, quota edge cases) can be reproduced from
// the file. By default only failing relays are dumped (one small, targeted
// file); MODELDOCK_DUMP_ALL=1 opts into every request. A dump failure must
// never break the relay.
function dumpRequestBody(dir, body) {
  try {
    mkdirSync(dir, { recursive: true });
    // Redact any bearer/sk tokens before a diagnostic dump leaves process
    // memory, so a debug artifact never becomes a credential leak.
    writeFileSync(path.join(dir, `request-${Date.now()}.json`), redactBearer(JSON.stringify(body, null, 2)), "utf8");
  } catch {
    // Diagnostics only.
  }
}

// Per-request skeleton for the trace card, so an upstream rejection (tool
// pairing, thinking-mode reasoning) can be diagnosed from /api/status without
// full-traffic dumps. Describes item types and the reasoning items Go is
// strict about; never includes prompt text, tool arguments or outputs.
export function describeInputShape(input) {
  if (!Array.isArray(input)) return { itemTypes: {}, reasoning: [] };
  const itemTypes = {};
  const reasoning = [];
  input.forEach((item, index) => {
    const type = item?.type ?? "unknown";
    itemTypes[type] = (itemTypes[type] || 0) + 1;
    if (type !== "reasoning" || !item) return;
    const content = Array.isArray(item.content) ? item.content : [];
    reasoning.push({
      index,
      status: item.status ?? "missing",
      contentTypes: content.map((part) => part?.type ?? "unknown"),
      hasReasoningText: content.some((part) => part?.type === "reasoning_text" && typeof part.text === "string" && part.text.length > 0),
      hasSummary: Array.isArray(item.summary) ? item.summary.length > 0 : false,
      hasId: typeof item.id === "string" && item.id.length > 0,
    });
  });
  return { itemTypes, reasoning };
}

// Compaction is the one request we rewrite wholesale and cannot replay from the
// Codex session log, and it is rare enough that a per-failure record costs
// nothing. Full-traffic dumping (MODELDOCK_DUMP_ALL) stays off: it produced
// gigabytes for the one payload anybody ever wanted to read. Only the tool-item
// skeleton is kept - ids and types, never arguments, output text or prompts.
export function compactFailureReport(body, { status, upstreamError } = {}) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const calls = new Map();
  for (const item of input) {
    const type = item?.type;
    if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      calls.set(item.call_id ?? item.id, { ...(calls.get(item.call_id ?? item.id) || {}), call: type });
    }
    if (type === "function_call_output" || type === "custom_tool_call_output" || type === "local_shell_call_output") {
      calls.set(item.call_id ?? item.id, { ...(calls.get(item.call_id ?? item.id) || {}), output: type });
    }
  }
  const unpaired = [...calls.entries()]
    .filter(([, sides]) => !sides.call || !sides.output)
    .map(([id, sides]) => ({ id, ...sides }));
  const itemTypes = {};
  for (const item of input) itemTypes[item?.type ?? "unknown"] = (itemTypes[item?.type ?? "unknown"] || 0) + 1;
  return {
    at: new Date().toISOString(),
    status,
    upstreamError: String(upstreamError || "").slice(0, 400),
    model: body?.model,
    // Server-side continuation keys are the prime suspect when the input we sent
    // is fully paired but the upstream still reports an orphan: whatever state
    // they resolve is history this gateway never saw and could not clean.
    stateKeys: Object.keys(body || {}).filter((key) => /^(previous_response_id|conversation|prompt_cache_key|store)$/.test(key)),
    inputItems: input.length,
    itemTypes,
    unpairedToolItems: unpaired,
  };
}

function writeCompactFailureReport(report) {
  try {
    const dir = process.env.MODELDOCK_STATE_DIR
      ? path.resolve(process.env.MODELDOCK_STATE_DIR)
      : path.join(homedir(), ".modeldock");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "compact-failures.jsonl"), `${JSON.stringify(report)}\n`, { encoding: "utf8", flag: "a" });
  } catch {
    // Diagnostics must never take a request down.
  }
}

// Native GPT passthrough (the parallel leg). Model slugs the catalog does not
// publish - the built-in provider's own GPT-5.x ids that the App picker lists
// from its native model list - are forwarded verbatim to ChatGPT's Codex
// backend with the client's signed-in headers. That is what keeps native GPT
// usable in the same picker as our catalog models while the openai_base_url
// managed config is active. Same shape as codex-router's native leg.
const NATIVE_BASE = process.env.CODEX_NATIVE_BASE_URL || "https://chatgpt.com/backend-api/codex";

export const NATIVE_IMAGE_PATHS = new Set([
  "/images/edits",
  "/images/generations",
  "/v1/images/edits",
  "/v1/images/generations",
]);

// A stream that already sent headers cannot carry a JSON error. Terminate a
// Responses stream with a response.failed event so the client parses a failure
// instead of reporting a mid-stream disconnect ("stream disconnected before
// completion"). Fall back to destroying the socket if the stream refuses.
function endRelayStreamFailure(res, message) {
  try {
    res.write(`event: response.failed\r\ndata: ${JSON.stringify({
      type: "response.failed",
      response: { id: undefined, status: "failed", error: { code: "upstream_failed", message } },
    })}\r\n\r\n`);
    res.end();
  } catch {
    res.destroy();
  }
}

// A stream that already sent headers cannot switch protocols mid-response:
// terminate in the shape the client was told to expect. Responses SSE streams
// end with a response.failed event (above); a JSON payload - e.g. the native
// images endpoints answer application/json - ends with a JSON error object.
// Writing SSE events into an application/json body leaves the client with a
// body it cannot parse.
function endRelayFailure(res, message, bodyStarted = false) {
  const contentType = String(res.getHeader?.("Content-Type") || "");
  if (/text\/event-stream/i.test(contentType) || /ndjson|jsonl/i.test(contentType)) {
    endRelayStreamFailure(res, message);
    return;
  }
  // Once any JSON bytes have reached the client there is no valid error object
  // we can append. Reset the response so clients see a transport failure instead
  // of accepting a syntactically corrupt 200 body.
  if (bodyStarted) {
    res.destroy();
    return;
  }
  try {
    res.write(JSON.stringify({ error: { type: "upstream_failed", message } }));
    res.end();
  } catch {
    res.destroy();
  }
}

// Headers Codex's signed-in transport sends that the native backend needs.
// Everything else (tokens for routed providers, loopback bookkeeping) stays out.
const NATIVE_FORWARD_HEADERS = new Set([
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
]);

function nativeHeaders(incoming) {
  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": "modeldock-gateway/0.1",
  };
  for (const name of NATIVE_FORWARD_HEADERS) {
    const value = incoming?.[name];
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function splitRequestUrl(url) {
  const question = String(url || "").indexOf("?");
  return question < 0
    ? { pathname: String(url || ""), search: "" }
    : { pathname: String(url).slice(0, question), search: String(url).slice(question) };
}

// Map the path Codex sent (keyed /c/<key>/v1/... or bare /v1/...) onto the
// native backend path (no /v1 prefix). /v1/responses -> /responses.
export function nativeTarget(pathname, search) {
  const withoutPrefix = String(pathname)
    .replace(/^\/c\/[^/]+\/v1/, "")
    .replace(/^\/v1(?=\/|$)/, "");
  return `${NATIVE_BASE}${withoutPrefix}${search || ""}`;
}

// Codex marks every request with its conversation and session ids in headers;
// they ride into usage events so cache rate can be analyzed per session (hit
// rate vs turns since last compaction) instead of as an anonymous aggregate.
export function sessionIdsFrom(headers) {
  const get = (name) => {
    const value = headers?.[name];
    return Array.isArray(value) ? String(value[0] ?? "").trim() : String(value ?? "").trim();
  };
  const threadId = get("x-codex-parent-thread-id") || get("x-codex-thread-id") || get("thread-id") || get("thread_id");
  const sessionId = get("session_id") || get("session-id") || get("x-codex-session-id");
  return { sessionId, threadId };
}

// Threads created under codex-router (or our own pre-rewrite config) persist
// merged-catalog ids of the form "<provider>/<model>". Left alone they would
// look like native GPT slugs and get shipped to the ChatGPT backend, which
// rejects them ("model is not supported when using Codex with a ChatGPT
// account"). Map them onto the slug we actually publish before routing.
export function normalizeLegacySlug(model, knownModels) {
  if (typeof model !== "string") return model;
  const match = model.match(/^([a-z0-9][a-z0-9-]*)\/(.+)$/);
  if (!match || !knownModels) return model;
  const [, provider, id] = match;
  const qualified = `${id}@${provider}`;
  if (knownModels.has(qualified)) return qualified;
  if (knownModels.has(id)) return id;
  return model;
}

// A slug we do not serve is native GPT traffic. Empty models (provider defaults
// with no id) stay on the routed path so the dashboard selection still applies.
// Native GPT models are published in the catalog (so the App picker shows
// them), so the captured native slug set is checked first: a published native
// slug must still reach ChatGPT rather than an external upstream.
export function isNativeModel(requestedModel, knownModels, nativeSlugs) {
  if (typeof requestedModel !== "string" || requestedModel.length === 0) return false;
  if (nativeSlugs?.has?.(requestedModel)) return true;
  return !(knownModels && knownModels.has(requestedModel));
}

function isOpaqueEncryptedContent(value) {
  // OpenAI encrypted content is a URL-safe Fernet token. Treating any
  // whitespace-free string as encrypted lets malformed harness output reach
  // the native backend, which then aborts the turn during decryption.
  return typeof value === "string" && /^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(value);
}

// Remote compaction (v1/v2) is Codex's client-side protocol for context-full
// sessions. In transparent mode Codex believes it is talking to the native
// backend, so a compact request expects a `compaction` output item back (v2) or
// replacement history (v1) instead of a plain summary. Routed models (DeepSeek)
// do not speak that protocol, so ModelDock synthesizes it exactly like
// codex-router does: the model writes a handoff summary, which is wrapped in a
// kcr1: payload and decoded back into a continuation message when Codex replays
// the compacted history.
const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another language model that will resume the task.

Include current progress, key decisions, constraints, user preferences, remaining steps, and critical data or references. Be concise, structured, and focused on seamless continuation.`;
const SUMMARY_PREFIX =
  "Another language model started this task and produced a continuation summary. Use it to continue without repeating completed work:";
const COMPACTION_PREFIX = "kcr1:";
// The v1 replacement-history budget: keep the most recent user messages up to
// this many characters, then append the continuation message.
const COMPACT_BUDGET_CHARS = 80_000;
const MAX_COMPACT_RESPONSE_BYTES = 32 * 1024 * 1024;

export function encodeCompactionSummary(summary) {
  return COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

export function decodeCompactionSummary(value) {
  if (typeof value !== "string" || !value.startsWith(COMPACTION_PREFIX)) return undefined;
  const payload = value.slice(COMPACTION_PREFIX.length);
  // Buffer.from(base64) is lenient about garbage; only accept canonical base64
  // (the payloads this gateway produces) so junk never decodes to noise.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) return undefined;
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

// compactV1: POST /responses/compact (the older replacement-history contract).
export function isCompactV1Request(requestUrl) {
  return /\/responses\/compact$/.test(splitRequestUrl(requestUrl).pathname);
}

// compactV2: a Responses request whose last input item is compaction_trigger.
export function isCompactV2Request(payload) {
  return Array.isArray(payload?.input) && payload.input.at(-1)?.type === "compaction_trigger";
}

// OpenAI-issued reasoning encrypted_content is an opaque Fernet-style token with
// no whitespace. Local providers that mimic the shape with a plain-text summary
// must be stripped before replay to the native backend, which rejects the blob
// with "Encrypted content could not be decrypted or parsed." The item's summary
// still carries the readable reasoning.
function sanitizeReasoningForNative(item) {
  if (item?.encrypted_content === undefined) return item;
  if (isOpaqueEncryptedContent(item.encrypted_content)) return item;
  const { encrypted_content, ...rest } = item;
  return rest;
}

function sanitizeMessageContentForNative(item) {
  if (!Array.isArray(item?.content)) return item;
  let changed = false;
  const content = item.content.map((part) => {
    if (part?.type !== "encrypted_content" || isOpaqueEncryptedContent(part.encrypted_content)) return part;
    changed = true;
    return {
      type: "input_text",
      text: typeof part?.encrypted_content === "string" ? part.encrypted_content : "",
    };
  });
  return changed ? { ...item, content } : item;
}

function compactionSummaryText(item) {
  if (typeof item?.encrypted_content === "string" && item.encrypted_content.length) {
    // Ours: a kcr1: payload produced by this gateway's compact synthesis.
    const decoded = decodeCompactionSummary(item.encrypted_content);
    if (decoded !== undefined) return decoded;
    if (isOpaqueEncryptedContent(item.encrypted_content)) return undefined;
    return item.encrypted_content;
  }
  if (Array.isArray(item?.encrypted_content)) {
    return item.encrypted_content
      .filter((part) => ["summary_text", "text"].includes(part?.type) && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
  }
  return undefined;
}

// Native input rewrites: strip non-opaque reasoning blobs and expand compaction
// summaries into a plain message the native backend accepts. Opaque native
// tokens pass through untouched.
export function normalizeNativeInput(input) {
  if (!Array.isArray(input)) return input;
  return input.map((item) => {
    if (item?.type === "reasoning") return sanitizeReasoningForNative(item);
    if (item?.type !== "compaction") return sanitizeMessageContentForNative(item);
    const summary = compactionSummaryText(item);
    if (summary === undefined) return item;
    return {
      type: "message",
      role: "user",
      content: [
        {
          type: "input_text",
          text: `Another language model started this task and produced a continuation summary. Use it to continue without repeating completed work:\n\n${summary}`,
        },
      ],
    };
  });
}

function isToolCallItem(item) {
  return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function isToolOutputItem(item) {
  return item?.type === "function_call_output" || item?.type === "custom_tool_call_output";
}

// Go (Console Go) validates tool pairing strictly and rejects the whole request
// when a tool call has no matching output ("No tool output found for tool call
// ..."). Codex genuinely produces such orphans - a remote compact task slices
// history and can sever a call from its output at the cut. Both dialects Codex
// emits are paired here: the Responses shape (top-level function_call /
// custom_tool_call items with function_call_output / custom_tool_call_output)
// and the chat shape (an assistant message carrying a `tool_calls` array whose
// results are role:"tool" messages with tool_call_id). The unpaired side is
// dropped in both directions so the turn survives; paired history is untouched.
export function dropUnpairedToolItems(input) {
  if (!Array.isArray(input)) return input;
  const callIds = new Set();
  const outputIds = new Set();
  for (const item of input) {
    if (isToolCallItem(item)) callIds.add(item.call_id);
    if (isToolOutputItem(item)) outputIds.add(item.call_id);
    if (item?.type === "message" && item?.role === "assistant" && Array.isArray(item.tool_calls)) {
      for (const call of item.tool_calls) {
        const id = typeof call === "object" && call !== null ? (call.id ?? call.call_id) : undefined;
        if (typeof id === "string" && id) callIds.add(id);
      }
    }
    if (item?.type === "message" && item?.role === "tool" && typeof item.tool_call_id === "string" && item.tool_call_id) {
      outputIds.add(item.tool_call_id);
    }
  }
  const paired = input
    .map((item) => {
      if (isToolCallItem(item)) {
        return outputIds.has(item.call_id) ? item : null;
      }
      if (isToolOutputItem(item)) {
        return callIds.has(item.call_id) ? item : null;
      }
      if (item?.type === "message" && item?.role === "tool") {
        return callIds.has(item.tool_call_id) ? item : null;
      }
      if (item?.type === "message" && item?.role === "assistant" && Array.isArray(item.tool_calls)) {
        const kept = item.tool_calls.filter((call) => {
          const id = typeof call === "object" && call !== null ? (call.id ?? call.call_id) : undefined;
          return outputIds.has(id);
        });
        if (kept.length === item.tool_calls.length) return item;
        // A message whose calls all got severed and that carries no other text
        // would reach the upstream as an empty assistant turn, which strict
        // upstreams reject ("content or tool_calls must be set"). Drop it.
        const hasContent = Array.isArray(item.content)
          ? item.content.length > 0
          : typeof item.content === "string" && item.content.trim() !== "";
        if (kept.length === 0 && !hasContent) return null;
        const next = { ...item, tool_calls: kept };
        if (kept.length === 0) delete next.tool_calls;
        return next;
      }
      return item;
    })
    .filter((item) => item !== null);
  return relocateToolOutputs(paired);
}

// Go's Responses->chat translation only accepts a tool result when it directly
// follows the assistant message that declared the call. A remote compact task
// slices an assistant turn apart, so a call can still be paired with its output
// while an assistant text message sits between them; the chat translation then
// emits the tool row after a different assistant and strict upstreams reject
// the whole request ("No tool output found for tool call ..."). Relocate each
// output to sit right after its call group (parallel calls keep their group,
// interleaved text moves after the outputs) so the translated chat stays
// well-formed. Everything else keeps its position. Same intent as codex-router's
// coalesceAssistantMessages + ensureToolResultsForCalls, applied on the
// Responses shape we forward.
function relocateToolOutputs(items) {
  const firstOutputById = new Map();
  for (const item of items) {
    if (isToolOutputItem(item) && !firstOutputById.has(item.call_id)) {
      firstOutputById.set(item.call_id, item);
    }
  }
  const out = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!isToolCallItem(item)) {
      // A stray or duplicate output already had its home relocated (or no call
      // at all); an extra tool row after a different assistant would break the
      // contract again, so it is dropped here.
      if (!isToolOutputItem(item)) out.push(item);
      index += 1;
      continue;
    }
    const group = [];
    while (index < items.length && isToolCallItem(items[index])) group.push(items[index++]);
    for (const call of group) out.push(call);
    for (const call of group) {
      const output = firstOutputById.get(call.call_id);
      if (output) {
        out.push(output);
        firstOutputById.delete(call.call_id);
      }
    }
  }
  return out;
}

// The only input rewriting the gateway is allowed to do. Everything else in the
// history must pass through untouched. Tool items are additionally paired so a
// sliced compact history (call without output, or output without call) cannot
// fail the whole request under Go's strict validation; paired history survives.
// Reasoning items get a content-stable id when Codex omitted one: native OpenAI
// tolerates id-less reasoning, but opencode's deepseek-v4-pro route deserializes
// each replayed reasoning item as a chat message and rejects the whole history
// with "missing field `id`" when it is absent. The id is derived from the item's
// text so the request prefix stays byte-identical across turns (cache-friendly)
// instead of churning a random uuid on every request.
function fillReasoningIds(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = input.map((item) => {
    if (item?.type !== "reasoning" || (typeof item.id === "string" && item.id.length > 0)) return item;
    const text = Array.isArray(item.content)
      ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";
    changed = true;
    return {
      ...item,
      id: `reasoning_${createHash("sha256").update(text || "reasoning").digest("hex").slice(0, 16)}`,
    };
  });
  return changed ? out : input;
}

function fillProToolCallIds(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = input.map((item) => {
    if (!isToolCallItem(item) || (typeof item.id === "string" && item.id.length > 0)) return item;
    if (typeof item.call_id !== "string" || !item.call_id) return item;
    changed = true;
    return { ...item, id: item.call_id };
  });
  return changed ? out : input;
}

// opencode's responses-to-chat translator replays an assistant history message
// as a chat-style `content` string. Codex replays `output_text` part arrays,
// which the translator turns into an empty content and rejects on its
// thinking-model routes ("Invalid assistant message: content or tool_calls
// must be set"). Flatten the parts to a plain string so every opencode route
// accepts the history. Non-assistant items and already-string content pass
// through untouched.
function flattenAssistantContent(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = input.flatMap((item) => {
    if (item?.type !== "message" || item?.role !== "assistant") return [item];
    const hasToolCalls = Array.isArray(item.tool_calls) && item.tool_calls.length > 0;
    if (typeof item.content === "string") {
      if (item.content.trim() || hasToolCalls) return [item];
      changed = true;
      return [];
    }
    if (!Array.isArray(item.content)) return [item];
    const text = item.content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    changed = true;
    // Codex places an empty assistant message immediately before top-level
    // custom_tool_call history. Console Go translates it to a standalone chat
    // assistant row and rejects the request before it reaches the paired call.
    // It carries no user-visible content or tool identity, so omit only that
    // empty placeholder. Assistant messages with chat-style tool_calls remain.
    if (!text.trim() && !hasToolCalls) return [];
    return [{ ...item, content: text }];
  });
  return changed ? out : input;
}

function interleaveToolOutputs(input) {
  if (!Array.isArray(input)) return input;
  const outputById = new Map();
  for (const item of input) {
    if (isToolOutputItem(item) && !outputById.has(item.call_id)) outputById.set(item.call_id, item);
  }
  let changed = false;
  const out = [];
  for (const item of input) {
    if (isToolOutputItem(item)) continue;
    out.push(item);
    if (!isToolCallItem(item)) continue;
    const output = outputById.get(item.call_id);
    if (!output) continue;
    out.push(output);
    outputById.delete(item.call_id);
    changed = true;
  }
  return changed ? out : input;
}

function appendProToolContinuation(input) {
  if (!Array.isArray(input)) return input;
  if (!isToolOutputItem(input.at(-1))) return input;
  // A Responses tool output semantically asks the model to continue. Console
  // Go translates the history to DeepSeek chat but omits that continuation
  // boundary, so thinking mode rejects the assistant tool-call row for missing
  // reasoning_content. An explicit internal user turn restores the boundary;
  // the same exact Codex harness payload then continues and produces its final
  // answer. This is strictly Pro+Go input normalization.
  const identity = input
    .filter(isToolOutputItem)
    .map((item) => item.call_id)
    .join("\n");
  return [
    ...input,
    {
      type: "message",
      id: `msg_pro_continue_${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
      role: "user",
      content: [{ type: "input_text", text: "Continue from the tool results above and complete the current task." }],
    },
  ];
}

const PRO_EXECUTION_GUIDANCE = [
  "ModelDock execution protocol for this Codex turn:",
  "When the user requests an action, do not end with a progress update, plan, or future-tense promise.",
  "Use the available tools now and continue through their results until the requested action is complete or a concrete blocker prevents it.",
  "A final answer must report completed evidence or the blocker; statements such as 'I will do it' or 'doing it now' are not a completed result.",
].join(" ");

function attachProExecutionGuidance(input) {
  if (!Array.isArray(input)) return input;
  const index = input.findLastIndex((item) => item?.type === "message" && item?.role === "user");
  if (index < 0) return input;
  const message = input[index];
  const content = Array.isArray(message.content)
    ? [...message.content, { type: "input_text", text: PRO_EXECUTION_GUIDANCE }]
    : `${String(message.content || "")}\n\n${PRO_EXECUTION_GUIDANCE}`;
  const out = [...input];
  out[index] = { ...message, content };
  return out;
}

export function normalizeGatewayInput(input) {
  if (!Array.isArray(input)) return input;
  return dropUnpairedToolItems(input)
    .filter((item) => item?.type !== "compaction_trigger")
    .map((item) => {
      if (item?.type !== "compaction") return item;
      const text = compactionSummaryText(item);
      return {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: text || "[Earlier conversation history was compacted in an unreadable format.]" }],
      };
    });
}

// opencode's deepseek-v4-pro route deserializes replayed reasoning items as
// chat messages (a stable id is required) and its responses-to-chat translator
// needs assistant content as a plain string. These rewrites are strictly
// pro+opencode-go: the generic routed path (flash, official, custom) works
// without them, and byte-stable flash traffic must stay untouched.
export function normalizeOpenCodeProInput(input) {
  if (!Array.isArray(input)) return input;
  const normalized = normalizeGatewayInput(input);
  const interleaved = interleaveToolOutputs(normalized);
  const withToolCallIds = fillProToolCallIds(interleaved);
  const withReasoningIds = fillReasoningIds(withToolCallIds);
  const flattened = flattenAssistantContent(withReasoningIds);
  const continued = appendProToolContinuation(flattened);
  return attachProExecutionGuidance(continued);
}

// A message is "current" when it follows the last assistant turn. Only those
// images may reach the upstream: the request is either escalated to the vision
// model or the main model itself can see images. Images in earlier turns were
// already handled (often by the vision model) and re-sending their bytes on every
// turn burns tokens the text-only main model cannot use.
function currentTurnStart(input) {
  if (!Array.isArray(input)) return 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index]?.role === "assistant") start = index + 1;
  }
  return start;
}

export function currentTurnStartForTesting(input) {
  return currentTurnStart(input);
}

// Replace input_image parts in non-current turns with a lightweight image_ref
// placeholder. The media store keeps the image so vision_inspect can re-read it.
// Current-turn images stay untouched (they are either escalated or read by a
// vision-capable main model). Without a media store the rewrite is a no-op, so a
// partial services stub stays safe.
export function rewriteHistoricalImages(input, mediaStore) {
  if (!Array.isArray(input)) return input;
  const turnStart = currentTurnStart(input);
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || !Array.isArray(item.content) || index >= turnStart) return item;
    let changed = false;
    const content = item.content.map((part) => {
      if (!part || typeof part !== "object" || part.type !== "input_image" || typeof part.image_url !== "string") return part;
      changed = true;
      if (!mediaStore) {
        return { type: "input_text", text: "[An image was attached earlier in this conversation. Its visual contents were handled in a prior turn; do not re-inspect unless the user asks a new visual question.]" };
      }
      let ref;
      try {
        ref = mediaStore.put(part.image_url);
      } catch {
        return { type: "input_text", text: "[An image was attached earlier in this conversation. Its visual contents were handled in a prior turn; do not re-inspect unless the user asks a new visual question.]" };
      }
      return {
        type: "input_text",
        text: `[Image attachment ${ref}. Its visual contents were handled in a prior turn. To re-inspect it, use vision_inspect with image_ref "${ref}", or spawn a vision subagent (agent_type="modeldock_subagent", fork_turns="none") to analyze it.]`,
      };
    });
    return changed ? { ...item, content } : item;
  });
}

// Tool policy: keep standard function/custom tools, flatten MCP namespaces so
// text models see plain functions, and strip hosted schemas plus tools the model
// cannot use. Returns the filtered list and a report of what was removed.
export function applyToolPolicy(tools, { hiddenToolNames = TEXT_MODEL_HIDDEN_TOOLS } = {}) {
  if (!Array.isArray(tools)) return { tools, stripped: { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0 } };
  const hidden = new Set(hiddenToolNames || []);
  const stripped = { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0 };
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (
      tool.type === "namespace"
      && typeof tool.name === "string"
      && (tool.name.startsWith("mcp__") || tool.name.startsWith("namespace:mcp__"))
    ) {
      const children = Array.isArray(tool.tools) ? tool.tools : [];
      for (const child of children) {
        if (!child?.name) continue;
        if (hidden.has(child.name)) {
          stripped.hidden += 1;
          continue;
        }
        stripped.namespaceChildren += 1;
        out.push({ ...structuredClone(child), type: "function", name: `${tool.name}__${child.name}` });
      }
      continue;
    }
    if (HOSTED_TOOL_TYPES.has(tool.type)) {
      if (tool.type === "tool_search") stripped.toolSearch += 1;
      else if (tool.type === "web_search") stripped.webSearch += 1;
      else stripped.otherHosted += 1;
      continue;
    }
    if (typeof tool.name === "string" && hidden.has(tool.name)) {
      stripped.hidden += 1;
      continue;
    }
    out.push(structuredClone(tool));
  }
  return { tools: out, stripped };
}

// Resolve the upstream for a model. The owning provider decides the base URL and
// token; the wire is always Responses. The @provider suffix is stripped before
// the id reaches the upstream.
export function upstreamTargetFor(config, model) {
  const provider = providerForModel(config, model);
  const upstreamModel = bareModelId(model);
  if (provider === "custom") {
    return {
      provider,
      model: upstreamModel,
      url: `${(config.customBaseUrl || "").replace(/\/+$/, "")}/responses`,
      token: config.tokens?.["custom"] || config.customApiKey || "",
    };
  }
  if (provider === "deepseek-official") {
    return {
      provider,
      model: upstreamModel,
      url: `${(config.deepseekBaseUrl || "https://api.deepseek.com").replace(/\/+$/, "")}/responses`,
      token: config.tokens?.["deepseek-official"] || config.deepseekToken || "",
    };
  }
  const entry = modelEntryFor(config, upstreamModel);
  const baseUrl = entry?.zen
    ? (config.zenBaseUrl || "https://opencode.ai/zen/v1")
    : (config.opencodeBaseUrl || config.goBaseUrl || "https://opencode.ai/zen/go/v1");
  return {
    provider: "opencode-go",
    model: upstreamModel,
    url: `${baseUrl.replace(/\/+$/, "")}/responses`,
    token: config.tokens?.["opencode-go"] || "",
    // Zen free tier: failure copy should carry trial-mode guidance instead of the
    // generic hint (see error-translation.mjs FREE_HINTS).
    free: Boolean(entry?.free),
  };
}

export function routeGatewayRequest(source, { mainModel, visionModel, affinity, knownModels }) {
  return routeResponsesRequest(source, { mainModel, visionModel, affinity, knownModels });
}

export { RouteAffinity };

// Incremental SSE scanner used by the tee observer. It recognizes complete events
// as they arrive across chunk boundaries, extracts usage, and never retains the
// stream. The forwarded bytes are never parsed for this purpose beyond this
// read-only copy.
export function createUsageTee(onEvent) {
  let buffer = "";
  const push = (chunk) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    buffer += text;
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          onEvent?.(JSON.parse(data));
        } catch {
          // Ignore non-JSON or partial SSE data lines.
        }
      }
    }
    if (buffer.length > 1_000_000) buffer = buffer.slice(-500_000);
  };
  const end = () => {
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

function usageFromEvent(event) {
  return extractResponseUsage(event);
}

// Pipe an upstream response body to the client as bytes. No buffering, no
// re-emission, no synthetic keepalive: an idle upstream stays idle downstream so
// Codex's own timeout remains the only stall safety net. The tee observer
// receives a read-only copy of each chunk for usage extraction.
//
// Node stream .pipe() is used instead of a manual read/write loop so downstream
// backpressure is honoured (a slow client pauses the upstream read instead of
// buffering the whole response in memory). A client that disconnects mid-stream
// emits "close" without "finish" or "error"; without that handler the promise
// never settles and the request stays counted as in-flight forever, with the
// upstream body still being read.
export async function pipeGatewayStream(upstreamBody, res, tee, onFirstResponse, onChunk) {
  if (!upstreamBody) {
    res.end();
    return { bytes: 0, interrupted: false };
  }
  let bytes = 0;
  let interrupted = false;
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstreamBody);
    let firstResponseMarked = false;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    stream.on("data", (chunk) => {
      if (!firstResponseMarked) {
        firstResponseMarked = true;
        onFirstResponse?.();
      }
      tee?.push(chunk);
      const size = chunk.byteLength || Buffer.byteLength(chunk);
      bytes += size;
      onChunk?.(size);
    });
    stream.once("end", () => tee?.end?.());
    stream.once("error", settle);
    res.once("finish", () => settle());
    res.once("error", settle);
    res.once("close", () => {
      if (!settled) {
        interrupted = true;
        stream.destroy();
      }
      settle();
    });
    stream.pipe(res);
  });
  return { bytes, interrupted };
}

// opencode's thinking-model stream (deepseek-v4-pro today) does not honor the
// Responses item/part lifecycle the way Codex expects. Text turns arrive as a
// bare response.output_text.delta with no item context; tool turns arrive as an
// output_item.added(function_call) followed by function_call_arguments.delta
// events with no item_id and no trailing done events; and response.completed
// never carries an output array. Codex renders from the
// output_item.added / content_part.added / output_item.done sequence and
// attaches deltas by item_id, so these streams render as empty turns. This pipe
// re-frames such streams into the standard sequence, synthesizing missing
// lifecycle events and the completed response's output array. Streams that
// already carry the full lifecycle pass through event-for-event.
export async function pipeNormalizedStream(upstreamBody, res, tee, onFirstResponse) {
  if (!upstreamBody) {
    res.end();
    return { bytes: 0, rewrote: false, terminal: false, failure: "OpenCode Go returned no response body." };
  }
  let bytes = 0;
  let sseBuffer = "";
  let rewrote = false;
  let interrupted = false;
  let sawTerminal = false;
  let sawDeliverable = false;
  let completedResponse;
  let responseFailure = "";
  // Rewrite state. A full stream starts with response.created and is passed
  // through untouched; a thinking stream starts straight into a delta (bare) or
  // an output_item.added without the rest of the lifecycle (sparse), and is
  // re-framed. Detection is sticky - once a full sequence is seen we never
  // rewrite.
  let bare = null; // { respId, model, items: Map<partType, { itemId, text, index }> }
  let track = null; // { respId, model, items: Map<index, entry>, nextIndex, activeIndex }
  let sawFirstEvent = false;
  let normal = false;
  const prelude = [];
  let preludeResponse = null;
  const writeOut = (text) => res.write(text);
  const sseEvent = (obj) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
  const flushPrelude = () => {
    while (prelude.length) writeOut(prelude.shift());
  };
  const outputIsDeliverable = (output) => Array.isArray(output) && output.some((item) => {
    if (item?.type === "function_call" || item?.type === "custom_tool_call") return true;
    if (item?.type !== "message") return false;
    return Array.isArray(item.content) && item.content.some((part) =>
      part?.type === "output_text" && typeof part.text === "string" && part.text.length > 0);
  });
  const failedCompletion = (parsed, message) => ({
    id: parsed?.id || parsed?.response?.id,
    type: "response.failed",
    response: {
      ...(parsed?.response || {}),
      status: "failed",
      error: { code: "upstream_failed", message },
    },
  });
  const finishEvent = (parsed) => {
    if (parsed?.type === "response.failed") {
      sawTerminal = true;
      responseFailure = parsed.response?.error?.message || parsed.error?.message || "OpenCode Go response failed.";
      return parsed;
    }
    if (parsed?.type !== "response.completed") return parsed;
    sawTerminal = true;
    if (outputIsDeliverable(parsed.response?.output)) sawDeliverable = true;
    if (!sawDeliverable) {
      responseFailure = "OpenCode Go completed without an assistant message or tool call.";
      return failedCompletion(parsed, responseFailure);
    }
    completedResponse = parsed.response;
    return parsed;
  };
  const itemIdFor = (respId, partType, index) => `${respId}-${partType === "reasoning_text" ? "reasoning" : "message"}-${index}`;
  const partItem = (partType, itemId, index) => ({
    ...(partType === "reasoning_text"
      ? { id: itemId, type: "reasoning", status: "in_progress", summary: [] }
      : { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] }),
    output_index: index,
  });
  const openBareItem = (parsed, emitPrelude = true) => {
    const respId = parsed.id || parsed.response?.id || preludeResponse?.id || `resp_${Date.now()}`;
    const model = parsed.response?.model || preludeResponse?.model || "";
    bare = { respId, model, items: new Map(), nextIndex: 0 };
    rewrote = true;
    if (emitPrelude) {
      writeOut(sseEvent({ id: respId, type: "response.created", response: { id: respId, model } }));
      writeOut(sseEvent({ id: respId, type: "response.in_progress", response: { id: respId, model } }));
    }
  };
  const ensureBareItem = (parsed, partType) => {
    if (!bare || bare.items.has(partType)) return;
    const index = bare.nextIndex;
    bare.nextIndex += 1;
    const itemId = itemIdFor(bare.respId, partType, index);
    bare.items.set(partType, { itemId, text: "", index });
    const item = partItem(partType, itemId, index);
    writeOut(sseEvent({ id: bare.respId, type: "response.output_item.added", item, response_id: bare.respId }));
    writeOut(sseEvent({
      id: bare.respId,
      type: "response.content_part.added",
      item_id: itemId,
      output_index: index,
      content_index: 0,
      part: { type: partType, text: "" },
      response_id: bare.respId,
    }));
  };
  const closeBare = (parsed) => {
    if (!bare) return parsed;
    for (const [partType, { itemId, text }] of bare.items) {
      const index = bare.nextIndex === 1 && bare.items.size === 1 ? 0 : Array.from(bare.items.keys()).indexOf(partType);
      writeOut(sseEvent({
        id: bare.respId,
        type: partType === "reasoning_text" ? "response.reasoning_text.done" : "response.output_text.done",
        item_id: itemId,
        output_index: index,
        content_index: 0,
        text,
        response_id: bare.respId,
      }));
      writeOut(sseEvent({
        id: bare.respId,
        type: "response.content_part.done",
        item_id: itemId,
        output_index: index,
        content_index: 0,
        part: { type: partType, text },
        response_id: bare.respId,
      }));
      const doneItem = partItem(partType, itemId, index);
      if (partType === "reasoning_text") {
        doneItem.status = "completed";
        doneItem.content = [{ type: "reasoning_text", text }];
      } else {
        doneItem.status = "completed";
        doneItem.content = [{ type: "output_text", text }];
        if (text.length > 0) sawDeliverable = true;
      }
      writeOut(sseEvent({ id: bare.respId, type: "response.output_item.done", item: doneItem, response_id: bare.respId }));
    }
    const response = parsed?.response || {};
    const output = Array.from(bare.items.entries()).map(([partType, { itemId, text }]) => {
      const item = partItem(partType, itemId, Array.from(bare.items.keys()).indexOf(partType));
      item.status = "completed";
      item.content = partType === "reasoning_text"
        ? [{ type: "reasoning_text", text }]
        : [{ type: "output_text", text }];
      return item;
    });
    bare = null;
    return finishEvent({ ...parsed, response: { ...response, output: [...(Array.isArray(response.output) ? response.output : []), ...output] } });
  };
  const openTrack = (parsed) => {
    const respId = parsed.id || parsed.response?.id || preludeResponse?.id || `resp_${Date.now()}`;
    const model = parsed.response?.model || preludeResponse?.model || "";
    track = { respId, model, items: new Map(), nextIndex: 0, activeIndex: null };
    rewrote = true;
  };
  const trackItem = (parsed) => {
    if (!track) return null;
    const item = parsed.item || {};
    for (const [existingIndex, existing] of track.items) {
      if (item.id && existing.itemId === item.id) {
        track.activeIndex = existingIndex;
        return { index: existingIndex, entry: existing };
      }
    }
    // Console Go currently labels every function_call as output_index 0. The
    // item boundary is authoritative; allocate a fresh downstream index for
    // each added item and attach following id-less deltas to the most recently
    // added item. Without this, parallel calls collapse into one item and their
    // JSON argument strings are concatenated.
    const index = track.nextIndex;
    track.nextIndex += 1;
    const partType = item.type === "function_call" ? "function_call" : (item.type === "reasoning" ? "reasoning_text" : "output_text");
    const entry = {
      itemId: item.id || itemIdFor(track.respId, partType, index),
      partType,
      text: "",
      name: item.name || "",
      callId: item.call_id || item.id || "",
      status: "in_progress",
    };
    track.items.set(index, entry);
    track.activeIndex = index;
    return { index, entry };
  };
  const trackDelta = (parsed) => {
    if (!track) return parsed;
    let index = null;
    if (parsed.item_id) {
      for (const [candidate, entry] of track.items) {
        if (entry.itemId === parsed.item_id) {
          index = candidate;
          break;
        }
      }
    }
    if (index === null) index = track.activeIndex;
    if (index === null && Number.isInteger(parsed.output_index) && track.items.has(parsed.output_index)) {
      index = parsed.output_index;
    }
    const entry = track.items.get(index);
    if (!entry) return parsed;
    entry.text += typeof parsed.delta === "string" ? parsed.delta : "";
    return {
      ...parsed,
      item_id: entry.itemId,
      output_index: index,
      content_index: 0,
      response_id: track.respId,
    };
  };
  const closeTrack = (parsed) => {
    if (!track) return parsed;
    for (const [index, entry] of track.items) {
      if (entry.partType === "function_call") {
        sawDeliverable = true;
        writeOut(sseEvent({
          id: track.respId,
          type: "response.function_call_arguments.done",
          item_id: entry.itemId,
          output_index: index,
          arguments: entry.text,
          response_id: track.respId,
        }));
      } else if (entry.partType === "reasoning_text") {
        writeOut(sseEvent({
          id: track.respId,
          type: "response.reasoning_text.done",
          item_id: entry.itemId,
          output_index: index,
          content_index: 0,
          text: entry.text,
          response_id: track.respId,
        }));
      } else {
        if (entry.text.length > 0) sawDeliverable = true;
        writeOut(sseEvent({
          id: track.respId,
          type: "response.output_text.done",
          item_id: entry.itemId,
          output_index: index,
          content_index: 0,
          text: entry.text,
          response_id: track.respId,
        }));
      }
      const doneItem = entry.partType === "function_call"
        ? { id: entry.itemId, type: "function_call", status: "completed", name: entry.name, call_id: entry.callId, arguments: entry.text }
        : entry.partType === "reasoning_text"
          ? { id: entry.itemId, type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: entry.text }] }
          : { id: entry.itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: entry.text }] };
      writeOut(sseEvent({ id: track.respId, type: "response.output_item.done", item: doneItem, response_id: track.respId }));
    }
    const response = parsed?.response || {};
    const output = Array.from(track.items.values()).map((entry, index) => entry.partType === "function_call"
      ? { id: entry.itemId, type: "function_call", status: "completed", name: entry.name, call_id: entry.callId, arguments: entry.text, output_index: index }
      : entry.partType === "reasoning_text"
        ? { id: entry.itemId, type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: entry.text }] }
        : { id: entry.itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: entry.text }] });
    track = null;
    return finishEvent({ ...parsed, response: { ...response, output: [...(Array.isArray(response.output) ? response.output : []), ...output] } });
  };
  const processBlock = (block, delim) => {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (normal) {
        if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string" && parsed.delta.length > 0) {
          sawDeliverable = true;
        }
        if (parsed?.type === "response.output_item.added" && ["function_call", "custom_tool_call"].includes(parsed.item?.type)) {
          sawDeliverable = true;
        }
        const finished = finishEvent(parsed);
        writeOut(finished === parsed ? block + delim : sseEvent(finished));
        return;
      }
      if (!sawFirstEvent) {
        const kind = parsed?.type;
        if (kind === "response.created" || kind === "response.in_progress") {
          prelude.push(block + delim);
          preludeResponse = { ...(preludeResponse || {}), ...(parsed.response || {}) };
          return;
        }
        sawFirstEvent = true;
        if (kind === "response.output_text.delta" || kind === "response.reasoning_text.delta") {
          const hadPrelude = prelude.length > 0;
          openBareItem(parsed, !hadPrelude);
          flushPrelude();
          ensureBareItem(parsed, kind === "response.output_text.delta" ? "output_text" : "reasoning_text");
        } else if (kind === "response.output_item.added" && parsed.item?.type === "function_call") {
          flushPrelude();
          openTrack(parsed);
          const tracked = trackItem(parsed);
          writeOut(sseEvent(tracked ? { ...parsed, output_index: tracked.index } : parsed));
          continue;
        } else {
          flushPrelude();
          normal = true;
          const finished = finishEvent(parsed);
          writeOut(finished === parsed ? block + delim : sseEvent(finished));
          return;
        }
      }
      if (track) {
        if (parsed?.type === "response.output_item.added") {
          const tracked = trackItem(parsed);
          writeOut(sseEvent(tracked ? { ...parsed, output_index: tracked.index } : parsed));
          continue;
        }
        if (parsed?.type === "response.function_call_arguments.delta") {
          writeOut(sseEvent(trackDelta(parsed)));
          continue;
        }
        if (parsed?.type === "response.output_text.delta") {
          writeOut(sseEvent(trackDelta(parsed)));
          continue;
        }
        if (parsed?.type === "response.reasoning_text.delta") {
          writeOut(sseEvent(trackDelta(parsed)));
          continue;
        }
        if (parsed?.type === "response.completed") {
          const rewritten = closeTrack(parsed);
          writeOut(sseEvent(rewritten));
          continue;
        }
      }
      if (bare) {
        if (parsed?.type === "response.output_text.delta") {
          ensureBareItem(parsed, "output_text");
          const entry = bare.items.get("output_text");
          entry.text += typeof parsed.delta === "string" ? parsed.delta : "";
          // The upstream delta carries no item context; Codex attaches deltas by
          // item_id, so re-frame it onto the synthesized message item.
          writeOut(sseEvent({
            ...parsed,
            item_id: entry.itemId,
            output_index: entry.index,
            content_index: 0,
            response_id: bare.respId,
          }));
          continue;
        }
        if (parsed?.type === "response.reasoning_text.delta") {
          ensureBareItem(parsed, "reasoning_text");
          const entry = bare.items.get("reasoning_text");
          entry.text += typeof parsed.delta === "string" ? parsed.delta : "";
          writeOut(sseEvent({
            ...parsed,
            item_id: entry.itemId,
            output_index: entry.index,
            content_index: 0,
            response_id: bare.respId,
          }));
          continue;
        }
        if (parsed?.type === "response.completed") {
          const rewritten = closeBare(parsed);
          writeOut(sseEvent(rewritten));
          continue;
        }
      }
      writeOut(sseEvent(parsed));
    }
  };
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstreamBody);
    let firstResponseMarked = false;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    stream.on("data", (chunk) => {
      if (!firstResponseMarked) {
        firstResponseMarked = true;
        onFirstResponse?.();
      }
      tee?.push(chunk);
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      bytes += Buffer.byteLength(text);
      sseBuffer += text;
      while (true) {
        const match = sseBuffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const block = sseBuffer.slice(0, match.index);
        const delim = match[0];
        sseBuffer = sseBuffer.slice(match.index + delim.length);
        processBlock(block, delim);
      }
      if (sseBuffer.length > 1_000_000) sseBuffer = sseBuffer.slice(-500_000);
    });
    stream.once("end", () => {
      tee?.end?.();
      flushPrelude();
      if (sseBuffer) writeOut(sseBuffer);
      if (!sawTerminal && !interrupted) {
        responseFailure = "OpenCode Go stream ended before a terminal response event.";
        writeOut(sseEvent(failedCompletion(null, responseFailure)));
        sawTerminal = true;
      }
      res.end();
      settle();
    });
    stream.once("error", settle);
    res.once("finish", () => settle());
    res.once("error", settle);
    res.once("close", () => {
      if (!settled) {
        interrupted = true;
        stream.destroy();
      }
      settle();
    });
  });
  return { bytes, rewrote, interrupted, terminal: sawTerminal, failure: responseFailure, completedResponse };
}

// Classify a 200 zen-free response body that silently failed. Returns
// "empty_output" when the output array is empty (the whole output budget was
// spent on reasoning), "upstream_error" when the body carries an error object
// despite the 200 (observed as a nemotron-free server_error), or null for a
// real response.
export function freeResponseFailure(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.error !== undefined) return "upstream_error";
  if (Array.isArray(parsed.output) && parsed.output.length === 0) return "empty_output";
  return null;
}

// Zen free streaming: the endpoint intermittently answers 200 with no output
// items - a bare response.completed event with no output array (all output
// tokens spent on reasoning). Codex's client parses a bare completed as a
// successful empty turn (its ResponseCompleted struct only requires an id), so
// the failure has to ride on the stream instead: hold the terminal tail
// (everything after the last response.completed block) and, when no output item
// arrived, replace it with a synthesized response.failed event carrying the
// free-tier guidance. Non-free traffic and upstream failures are untouched -
// only a response.completed block starts the hold. The tee still receives every
// chunk so usage extraction keeps working.
export async function pipeFreeStream(upstreamBody, res, tee, failedMessage, onFirstResponse) {
  if (!upstreamBody) {
    res.end();
    return { bytes: 0, empty: false, usage: undefined };
  }
  let bytes = 0;
  let sawOutput = false;
  let holding = false;
  let tail = "";
  let sseBuffer = "";
  let responseId = "";
  let usage;
  let outStream = null;
  const writeOut = (text) => {
    if (!res.write(text)) outStream?.pause();
  };
  const processBlock = (block, delim) => {
    let completed = false;
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (usage === undefined) usage = extractResponseUsage(parsed);
      const kind = parsed?.type;
      if (kind === "response.completed") {
        completed = true;
        responseId = parsed?.response?.id || "";
        const output = parsed?.response?.output;
        if (Array.isArray(output) && output.length > 0) sawOutput = true;
      } else if (
        kind === "response.output_text.delta" ||
        kind === "response.output_text.done" ||
        kind === "response.output_item.added" ||
        kind === "response.function_call_arguments.delta" ||
        kind === "response.reasoning_summary_part.delta" ||
        kind === "response.reasoning_content.delta"
      ) {
        sawOutput = true;
      }
    }
    if (completed) {
      holding = true;
      tail = block + delim;
      return;
    }
    if (holding) {
      tail += block + delim;
      return;
    }
    writeOut(block + delim);
  };
  const push = (chunk) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    sseBuffer += text;
    while (true) {
      const match = sseBuffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = sseBuffer.slice(0, match.index);
      const delim = match[0];
      sseBuffer = sseBuffer.slice(match.index + delim.length);
      processBlock(block, delim);
    }
    if (sseBuffer.length > 1_000_000) sseBuffer = sseBuffer.slice(-500_000);
  };
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(upstreamBody);
    let firstResponseMarked = false;
    outStream = stream;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    stream.on("data", (chunk) => {
      if (!firstResponseMarked) {
        firstResponseMarked = true;
        onFirstResponse?.();
      }
      tee?.push(chunk);
      push(chunk);
      bytes += chunk.byteLength || Buffer.byteLength(chunk);
    });
    stream.once("end", () => {
      tee?.end?.();
      if (holding) {
        if (sawOutput || !failedMessage) {
          writeOut(tail);
          if (sseBuffer) writeOut(sseBuffer);
        } else {
          writeOut(
            `event: response.failed\r\ndata: ${JSON.stringify({
              type: "response.failed",
              response: {
                id: responseId || undefined,
                status: "failed",
                error: { code: "server_error", message: failedMessage },
              },
            })}\r\n\r\n`,
          );
        }
      } else if (sseBuffer) {
        writeOut(sseBuffer);
      }
      res.end();
      settle();
    });
    stream.once("error", settle);
    // "on", not "once": writeOut pauses the upstream on every backpressure event,
    // so the drain that resumes it must fire every time too. With "once" the second
    // pause never gets a matching resume and the stream (and the promise) hangs.
    const onDrain = () => outStream?.resume();
    res.on("drain", onDrain);
    const cleanup = () => res.removeListener("drain", onDrain);
    res.once("finish", () => { cleanup(); settle(); });
    res.once("error", (error) => { cleanup(); settle(error); });
    res.once("close", () => {
      cleanup();
      if (!settled) stream.destroy();
      settle();
    });
  });
  return { bytes, empty: holding && !sawOutput, usage };
}

// Native passthrough for a Responses request. Unlike the routed path there is no
// tool policy, no historical-image rewrite, and no image escalation: the native
// backend owns hosted tools, history images, and its own vision. Only the input
// normalization above and previous_response_id removal apply, then the stream is
// piped byte-for-byte with the client's signed-in headers.
export async function relayNativeResponses(payload, res, services, { signal } = {}) {
  const { incomingHeaders, requestUrl, metrics } = services;
  const { sessionId, threadId } = sessionIdsFrom(incomingHeaders);
  const native = { ...payload };
  if (Array.isArray(payload.input)) native.input = normalizeNativeInput(payload.input);
  delete native.previous_response_id;
  const bytesIn = Buffer.byteLength(JSON.stringify(payload));
  const { pathname, search } = splitRequestUrl(requestUrl);
  const target = nativeTarget(pathname, search);
  const finish = metrics?.begin?.("responses", {
    operation: "native_passthrough",
    model: payload.model,
    upstream: "openai",
    routeReason: "native_passthrough",
    sessionId,
    threadId,
  });
  const markFirstResponse = () => finish?.markFirstResponse?.();
  const startedAt = Date.now();
  let usage;
  let responseCompleted = false;
  let responseFailure = "";
  const tee = createUsageTee((event) => {
    const eventUsage = usageFromEvent(event);
    if (eventUsage) usage = eventUsage;
    if (event?.type === "response.completed") responseCompleted = true;
    if (event?.type === "response.failed") {
      responseFailure = event.response?.error?.message || event.error?.message || "Native response failed.";
    }
  });
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: nativeHeaders(incomingHeaders),
      body: JSON.stringify(native),
      signal,
    });
    const upstreamBytes = Buffer.byteLength(JSON.stringify(native));
    if (!upstream.ok) {
      markFirstResponse();
      const raw = await upstream.text();
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.end(raw);
      }
      finish?.({ ok: false, httpStatus: upstream.status, upstream: "openai", error: redactBearer(raw).slice(0, 400) });
      metrics?.recordResponseUsage?.({ bytesOut: 0, usage });
      metrics?.recordResponseTransform?.({
        blocked: { tool_search: 0, web_search: 0 },
        toolChoiceRewritten: false,
        imageRefs: [],
        directVision: false,
        droppedAssistantMessages: 0,
        nativeToolCalls: 0,
        nativeToolOutputs: 0,
        fallbackToolResults: 0,
      }, { streaming: false, routeReason: "native_passthrough", bytesIn });
      (services.recordUsage || recordUsageEvent)({
        model: payload.model,
        provider: "openai",
        route: "native_passthrough",
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        sessionId,
        threadId,
      });
      return { ok: false, httpStatus: upstream.status, route: { model: payload.model, reason: "native_passthrough" }, error: raw.slice(0, 400), upstreamBytes };
    }

    if (!res.headersSent) {
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.flushHeaders();
    }
    const piped = await pipeGatewayStream(upstream.body, res, tee, markFirstResponse);
    const bytesOut = piped.bytes;
    // Codex closes the HTTP response as soon as it consumes the terminal SSE
    // event. The upstream socket can still be open for a trailing delimiter or
    // transport teardown, so a later close is not a failed request once
    // response.completed has already been observed.
    const interrupted = piped.interrupted && !responseCompleted && !responseFailure;
    const semanticFailed = Boolean(responseFailure);
    markFirstResponse();
    finish?.({
      ok: !interrupted && !semanticFailed,
      httpStatus: interrupted ? 499 : upstream.status,
      upstream: "openai",
      error: interrupted ? "client disconnected" : responseFailure || undefined,
      bytesOut,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      // Same fields as the relay path so the dashboard's token waveforms
      // (context, cache rate, reasoning) also sample native passthrough calls.
      cachedTokens: usage?.input_tokens_details?.cached_tokens || 0,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens || 0,
    });
    metrics?.recordResponseUsage?.({ bytesOut, usage });
    metrics?.recordResponseTransform?.({
      blocked: { tool_search: 0, web_search: 0 },
      toolChoiceRewritten: false,
      imageRefs: [],
      directVision: false,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: payload.stream !== false, routeReason: "native_passthrough", bytesIn });
    (services.recordUsage || recordUsageEvent)({
      model: payload.model,
      provider: "openai",
      route: "native_passthrough",
      status: interrupted ? 499 : semanticFailed ? "error" : upstream.status,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens,
      cachedTokens: usage?.input_tokens_details?.cached_tokens,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
      sessionId,
      threadId,
    });
    return {
      ok: !interrupted && !semanticFailed,
      httpStatus: interrupted ? 499 : upstream.status,
      route: { model: payload.model, reason: "native_passthrough" },
      ...(responseFailure ? { error: responseFailure } : {}),
      usage,
      bytesOut,
      upstreamBytes,
      latencyMs: Date.now() - startedAt,
      upstream: "openai",
    };
  } catch (error) {
    finish?.({ ok: false, error: error.message });
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { type: "upstream_failed", message: redactBearer(error.message) } }));
    } else {
      endRelayStreamFailure(res, redactBearer(error.message));
    }
    return { ok: false, httpStatus: 502, route: { model: payload.model, reason: "native_passthrough" }, error: error.message };
  }
}

// Native passthrough for the image endpoints the built-in image_gen tool posts
// to (the openai_base_url redirect lands them here). The body is forwarded as
// received; the native backend and the client's subscription do the rest.
export async function relayNativeImage(payload, res, services, { signal } = {}) {
  const { incomingHeaders, requestUrl } = services;
  const { pathname, search } = splitRequestUrl(requestUrl);
  const target = nativeTarget(pathname, search);
  const body = typeof payload === "string" || Buffer.isBuffer(payload)
    ? payload
    : JSON.stringify(payload || {});
  let forwardedBytes = 0;
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: nativeHeaders(incomingHeaders),
      body,
      signal,
    });
    if (!upstream.ok) {
      const raw = await upstream.text();
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
        res.end(raw);
      }
      return { ok: false, httpStatus: upstream.status, error: raw.slice(0, 400) };
    }
    if (!res.headersSent) {
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.flushHeaders();
    }
    const piped = await pipeGatewayStream(upstream.body, res, null, null, (size) => {
      forwardedBytes += size;
    });
    if (piped.interrupted) {
      return { ok: false, httpStatus: 499, error: "client disconnected" };
    }
    return { ok: true, httpStatus: upstream.status };
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { type: "upstream_failed", message: redactBearer(error.message) } }));
    } else {
      endRelayFailure(res, redactBearer(error.message), forwardedBytes > 0);
    }
    return { ok: false, httpStatus: 502, error: error.message };
  }
}

function messageItem(text) {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

// Pull the model's plain-text answer out of a Responses payload (JSON body or a
// streamed response that was already parsed by the caller).
function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const texts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "message") continue;
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (["output_text", "text"].includes(part?.type) && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

// The v1 compact response follows Codex's replacement-history contract: the
// recent user messages (up to a character budget) plus the continuation summary.
function compactOutput(input, summary) {
  const selected = [];
  let remaining = COMPACT_BUDGET_CHARS;
  const messages = extractUserMessages(input);
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const value = messages[index];
    if (value.length <= remaining) {
      selected.push(value);
      remaining -= value.length;
    } else {
      selected.push(value.slice(value.length - remaining));
      break;
    }
  }
  selected.reverse();
  return [
    ...selected.map(messageItem),
    messageItem(summary.trim() ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)"),
  ];
}

function extractUserMessages(input) {
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.type !== undefined && item.type !== "message") continue;
    if (item.role !== "user") continue;
    const text = Array.isArray(item.content)
      ? item.content
          .filter((part) => ["input_text", "text"].includes(part?.type) && typeof part.text === "string")
          .map((part) => part.text)
          .join("")
      : typeof item.content === "string"
        ? item.content
        : "";
    if (text.trim()) messages.push(text);
  }
  return messages;
}

function compactionItem(summary) {
  return {
    type: "compaction",
    id: `cmp_${randomUUID().replaceAll("-", "")}`,
    encrypted_content: encodeCompactionSummary(summary),
  };
}

function compactionSnapshot(model, item, usage) {
  return {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    status: "completed",
    model,
    output: item ? [item] : [],
    usage: usage || null,
  };
}

function writeCompactionSse(res, model, summary) {
  const item = compactionItem(summary);
  const created = { ...compactionSnapshot(model, undefined, null), status: "in_progress" };
  const completed = { ...created, status: "completed", output: [item] };
  const events = [
    ["response.created", { response: created }],
    ["response.output_item.done", { output_index: 0, item }],
    ["response.completed", { response: completed }],
  ];
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  events.forEach(([type, data], sequence) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...data })}\n\n`);
  });
  res.end("data: [DONE]\n\n");
}

// Synthesize the compaction response Codex expects instead of forwarding the
// compact request to a routed model that would answer with a plain summary.
// The model is asked for a handoff summary in a separate non-streaming call;
// that summary rides back as a compaction item whose encrypted_content is a
// kcr1: payload. v2 returns a single compaction output item (JSON or SSE);
// v1 returns replacement history under { output }.
export async function relayCompaction(payload, res, services, { signal } = {}, v2 = true) {
  const { config, metrics, mediaStore, routeAffinity, knownModels, incomingHeaders } = services;
  const { sessionId, threadId } = sessionIdsFrom(incomingHeaders);
  const requestedModel = normalizeLegacySlug(typeof payload.model === "string" ? payload.model : "", knownModels);
  if (requestedModel !== payload.model && requestedModel) payload = { ...payload, model: requestedModel };
  const mainModel = services.mainModel || config.mainModel;
  const visionModel = services.visionModel || config.visionModel;
  const route = routeGatewayRequest(payload, {
    mainModel,
    visionModel,
    affinity: routeAffinity,
    knownModels,
  });
  const summarizeBody = {
    ...payload,
    model: route.model,
    stream: false,
    tools: [],
    tool_choice: "none",
    input: [...rewriteHistoricalImages(normalizeGatewayInput(payload.input), mediaStore), messageItem(COMPACT_PROMPT)],
  };
  delete summarizeBody.previous_response_id;
  delete summarizeBody.client_metadata;
  const bytesIn = Buffer.byteLength(JSON.stringify(payload));

  const target = upstreamTargetFor(config, route.model);
  const upstreamModel = target.model;
  const operation = v2 ? "compact_v2" : "compact_v1";
  const finish = metrics?.begin?.("responses", {
    operation,
    model: route.model,
    upstream: target.provider,
    routeReason: route.reason,
    sessionId,
    threadId,
  });
  const startedAt = Date.now();
  let usage;
  try {
    if (!target.token) {
      const body = JSON.stringify({
        error: {
          type: "configuration_error",
          message: `No API token configured for provider ${target.provider}.`,
        },
      });
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(body);
      finish?.({ ok: false, httpStatus: 503, error: `No API token configured for provider ${target.provider}.` });
      (services.recordUsage || recordUsageEvent)({
        model: route.model,
        provider: target.provider,
        route: operation,
        status: 503,
        durationMs: Date.now() - startedAt,
        sessionId,
        threadId,
      });
      return { ok: false, httpStatus: 503, route, error: body };
    }
    if (config.debug?.dumpAll && config.debug?.dumpDir) {
      dumpRequestBody(config.debug.dumpDir, { ...summarizeBody, model: upstreamModel });
    }
    const upstream = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders(target),
      body: JSON.stringify({ ...summarizeBody, model: upstreamModel }),
      signal,
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_COMPACT_RESPONSE_BYTES) {
      const body = JSON.stringify({ error: { type: "upstream_failed", message: "Compact response is too large." } });
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      }
      finish?.({ ok: false, httpStatus: 502, error: "Compact response is too large." });
      (services.recordUsage || recordUsageEvent)({
        model: route.model,
        provider: target.provider,
        route: operation,
        status: 502,
        durationMs: Date.now() - startedAt,
        sessionId,
        threadId,
      });
      return { ok: false, httpStatus: 502, route, error: "Compact response is too large." };
    }
    if (!upstream.ok) {
      // Translate before parsing: a non-JSON upstream error (e.g. a proxy's HTML
      // 502) must reach translateUpstreamError and writeCompactFailureReport, not
      // throw out of a JSON.parse into the generic catch below.
      const translated = translateUpstreamError({ provider: target.provider, status: upstream.status, bodyText: redactBearer(bytes.toString("utf8")), free: target.free });
      writeCompactFailureReport(
        compactFailureReport(
          { ...summarizeBody, model: upstreamModel },
          { status: upstream.status, upstreamError: translated.body.error.message },
        ),
      );
      const body = JSON.stringify(translated.body);
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      }
      finish?.({
        ok: false,
        httpStatus: upstream.status,
        upstream: target.provider,
        error: translated.body.error.message.slice(0, 400),
        requestShape: describeInputShape(payload.input),
      });
      metrics?.recordResponseTransform?.({
        blocked: { tool_search: 0, web_search: 0 },
        toolChoiceRewritten: false,
        imageRefs: [],
        directVision: false,
        droppedAssistantMessages: 0,
        nativeToolCalls: 0,
        nativeToolOutputs: 0,
        fallbackToolResults: 0,
      }, { streaming: false, routeReason: operation, bytesIn });
      (services.recordUsage || recordUsageEvent)({
        model: route.model,
        provider: target.provider,
        route: operation,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        sessionId,
        threadId,
      });
      return { ok: false, httpStatus: upstream.status, route, error: translated.body.error.message.slice(0, 400), upstreamBytes: bytes.length };
    }

    let parsed;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      // An OK response that is not JSON (a proxy's HTML, a truncated body): surface
      // a translated provider error rather than throwing to the generic 502 catch.
      const translated = translateUpstreamError({ provider: target.provider, status: 502, bodyText: redactBearer(bytes.toString("utf8")), free: target.free });
      if (!res.headersSent) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(translated.body));
      }
      finish?.({ ok: false, httpStatus: 502, upstream: target.provider, error: translated.body.error.message.slice(0, 400) });
      (services.recordUsage || recordUsageEvent)({
        model: route.model,
        provider: target.provider,
        route: operation,
        status: 502,
        durationMs: Date.now() - startedAt,
        sessionId,
        threadId,
      });
      return { ok: false, httpStatus: 502, route, error: translated.body.error.message.slice(0, 400), upstreamBytes: bytes.length };
    }
    usage = extractResponseUsage(parsed);
    const summary = extractResponseText(parsed);
    if (v2) {
      if (payload.stream === false) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(compactionSnapshot(payload.model, compactionItem(summary), usage)));
      } else {
        writeCompactionSse(res, payload.model, summary);
      }
    } else {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: compactOutput(payload.input, summary) }));
    }
    finish?.({
      ok: true,
      httpStatus: 200,
      upstream: target.provider,
      bytesOut: bytes.length,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
    });
    metrics?.recordResponseUsage?.({ bytesOut: bytes.length, usage });
    metrics?.recordResponseTransform?.({
      blocked: { tool_search: 0, web_search: 0 },
      toolChoiceRewritten: false,
      imageRefs: [],
      directVision: false,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: payload.stream !== false, routeReason: operation, bytesIn });
    (services.recordUsage || recordUsageEvent)({
      model: route.model,
      provider: target.provider,
      route: operation,
      status: 200,
      durationMs: Date.now() - startedAt,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      totalTokens: usage?.total_tokens,
      sessionId,
      threadId,
    });
    return {
      ok: true,
      httpStatus: 200,
      route,
      usage,
      bytesOut: bytes.length,
      latencyMs: Date.now() - startedAt,
      upstream: target.provider,
    };
  } catch (error) {
    finish?.({ ok: false, error: error.message });
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { type: "upstream_failed", message: redactBearer(error.message) } }));
    } else {
      endRelayStreamFailure(res, redactBearer(error.message));
    }
    return { ok: false, httpStatus: 502, route, error: error.message };
  }
}

// Relay one Responses request: normalize, route (with image escalation and
// affinity), apply tool policy, choose upstream, forward, pipe, and tee.
// `services` carries { config, metrics, mediaStore, routeAffinity, modelSelection,
// knownModels, visionModelOf } so the caller decides wiring.
export async function relayResponses(payload, res, services, { signal } = {}) {
  const { config, metrics, mediaStore, routeAffinity, knownModels, incomingHeaders } = services;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = {
      error: {
        type: "bad_request",
        message: "Expected a JSON Responses request body.",
      },
    };
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(error));
    return { ok: false, httpStatus: 400, route: { model: "", reason: "bad_request" }, error };
  }
  const { sessionId, threadId } = sessionIdsFrom(incomingHeaders);
  const requestedModel = normalizeLegacySlug(typeof payload.model === "string" ? payload.model : "", knownModels);
  if (requestedModel !== payload.model && requestedModel) payload = { ...payload, model: requestedModel };
  if (isNativeModel(requestedModel, knownModels, services.nativeSlugs)) {
    return relayNativeResponses(payload, res, services, { signal });
  }
  // Remote compaction for routed models: Codex expects a compaction output item
  // (v2) or replacement history (v1) back, which DeepSeek does not produce
  // natively. Intercept instead of forwarding the raw request.
  if (isCompactV1Request(services.requestUrl)) {
    return relayCompaction(payload, res, services, { signal }, false);
  }
  if (isCompactV2Request(payload)) {
    return relayCompaction(payload, res, services, { signal }, true);
  }
  const mainModel = services.mainModel || config.mainModel;
  const visionModel = services.visionModel || config.visionModel;
  const route = routeGatewayRequest(payload, {
    mainModel,
    visionModel,
    affinity: routeAffinity,
    knownModels,
  });

  // opencode's pro route needs the reasoning-id and assistant-content rewrites;
  // every other routed model (flash, official, custom) keeps the plain path so
  // its byte-stable history is never touched.
  const proOpenCodeGo =
    bareModelId(route.model) === "deepseek-v4-pro" && providerForModel(config, route.model) === "opencode-go";
  const normalizedPayload = {
    ...payload,
    input: rewriteHistoricalImages(
      proOpenCodeGo ? normalizeOpenCodeProInput(payload.input) : normalizeGatewayInput(payload.input),
      mediaStore,
    ),
    model: route.model,
  };
  delete normalizedPayload.client_metadata;
  // The input array is the authoritative history here. A previous_response_id
  // would make the upstream resolve continuation state server-side - state
  // that can still carry the orphaned tool call this gateway just cleaned, so
  // strict upstreams (Go) would reject the request again.
  delete normalizedPayload.previous_response_id;

  // Transfer-card "in": the request body bytes the client actually sent this
  // gate. Re-serializing the parsed payload is the honest post-decode size.
  const bytesIn = Buffer.byteLength(JSON.stringify(payload));

  const { tools, stripped } = applyToolPolicy(normalizedPayload.tools);
  if (tools !== normalizedPayload.tools) normalizedPayload.tools = tools;

  const target = upstreamTargetFor(config, normalizedPayload.model);
  // The upstream sees the bare model id; the route model (possibly owner-suffixed)
  // stays in the response and affinity so provider resolution keeps working on
  // continuation requests.
  const upstreamModel = target.model;
  if (config.debug?.dumpAll && config.debug?.dumpDir) {
    dumpRequestBody(config.debug.dumpDir, { ...normalizedPayload, model: upstreamModel });
  }
  if (!target.token) {
    const error = {
      error: {
        type: "configuration_error",
        message: `No API token configured for provider ${target.provider}.`,
      },
    };
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(error));
    metrics?.recordResponseTransform?.({
      blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
      toolChoiceRewritten: false,
      imageRefs: [],
      directVision: route.directVision,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: false, routeReason: route.reason, bytesIn });
    return { ok: false, httpStatus: 503, route, error };
  }

  const finish = metrics?.begin?.("responses", {
    operation: "relay",
    model: normalizedPayload.model,
    upstream: target.provider,
    routeReason: route.reason,
    sessionId,
    threadId,
  });
  const markFirstResponse = () => finish?.markFirstResponse?.();
  const startedAt = Date.now();
  let usage;
  let bytesOut = 0;
  let completedResponse;
  let responseCompleted = false;
  let responseFailure = "";
  const tee = createUsageTee((event) => {
    const eventUsage = usageFromEvent(event);
    if (eventUsage) usage = eventUsage;
    if (event?.type === "response.completed") {
      responseCompleted = true;
      if (Array.isArray(event.response?.output)) completedResponse = event.response;
    }
    if (event?.type === "response.failed") {
      responseFailure = event.response?.error?.message || event.error?.message || "OpenCode Go response failed.";
    }
  });

  try {
    const upstream = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders(target),
      body: JSON.stringify({ ...normalizedPayload, model: upstreamModel }),
      signal,
    });
    const upstreamBytes = Buffer.byteLength(JSON.stringify(normalizedPayload));
    if (!upstream.ok) {
      markFirstResponse();
      if (config.debug?.dumpDir) {
        dumpRequestBody(config.debug.dumpDir, { ...normalizedPayload, model: upstreamModel });
      }
      const raw = await upstream.text();
      // Translate before forwarding: name the failing provider, surface the
      // innermost message, and classify quota exhaustion before the status
      // mapping so a quota 429 does not read as "retry shortly".
      const translated = translateUpstreamError({ provider: target.provider, status: upstream.status, bodyText: redactBearer(raw), free: target.free });
      const body = JSON.stringify(translated.body);
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json");
        res.end(body);
      }
      finish?.({
        ok: false,
        httpStatus: upstream.status,
        upstream: target.provider,
        error: translated.body.error.message.slice(0, 400),
        requestShape: describeInputShape(normalizedPayload.input),
      });
      metrics?.recordResponseTransform?.({
        blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
        toolChoiceRewritten: false,
        imageRefs: [],
        directVision: route.directVision,
        droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: false, routeReason: route.reason, bytesIn });
      return { ok: false, httpStatus: upstream.status, route, error: translated.body.error.message.slice(0, 400), upstreamBytes };
    }

    // Zen free endpoint: a 200 with no output items is a silent failure - the
    // free tier burns the whole output budget on reasoning and returns nothing.
    // Capture it on both wires and surface the quota_exhausted guidance instead
    // of letting Codex read an empty completion as a successful turn.
    const freeEmptyError = target.free ? freeEmptyOutputError({ provider: target.provider }) : null;
    let upstreamBody = upstream.body;
    let freeEmpty = false;
    let interrupted = false;
    if (target.free && normalizedPayload.stream !== true) {
      const raw = await upstream.text();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Non-JSON 200 (HTML gateway page etc.): leave the response untouched.
      }
      const failure = parsed && freeResponseFailure(parsed);
      if (failure) {
        const translated = failure === "upstream_error"
          ? translateUpstreamError({ provider: target.provider, status: 502, bodyText: redactBearer(raw), free: true })
          : freeEmptyError;
        const errorStatus = failure === "upstream_error" ? 502 : 429;
        const errorBody = JSON.stringify(translated.body);
        if (!res.headersSent) {
          res.statusCode = errorStatus;
          res.setHeader("Content-Type", "application/json");
          res.end(errorBody);
        }
        finish?.({
          ok: false,
          httpStatus: errorStatus,
          upstream: target.provider,
          error: translated.body.error.message.slice(0, 400),
          requestShape: describeInputShape(normalizedPayload.input),
        });
        metrics?.recordResponseTransform?.({
          blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
          toolChoiceRewritten: false,
          imageRefs: [],
          directVision: route.directVision,
          droppedAssistantMessages: 0,
          nativeToolCalls: 0,
          nativeToolOutputs: 0,
          fallbackToolResults: 0,
        }, { streaming: false, routeReason: route.reason, bytesIn });
        return { ok: false, httpStatus: errorStatus, route, error: translated.body.error.message.slice(0, 400), upstreamBytes };
      }
      // Real non-stream free response: rebuild the body as a web stream so the
      // shared pipe below handles framing, usage and affinity unchanged.
      upstreamBody = Readable.toWeb(Readable.from([Buffer.from(raw)]));
    }

    if (!res.headersSent) {
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.flushHeaders();
    }
    if (target.free && normalizedPayload.stream === true) {
      const result = await pipeFreeStream(upstreamBody, res, tee, freeEmptyError?.body.error.message, markFirstResponse);
      bytesOut = result.bytes;
      freeEmpty = result.empty;
      if (result.usage) usage = result.usage;
    } else {
      const bareId = bareModelId(route.model);
      // opencode's pro translation emits a bare-delta stream; the official
      // DeepSeek route is a standard Responses implementation and stays native.
      const piped = normalizedPayload.stream === true && bareId === "deepseek-v4-pro" && target.provider === "opencode-go"
        ? await pipeNormalizedStream(upstreamBody, res, tee, markFirstResponse)
        : await pipeGatewayStream(upstreamBody, res, tee, markFirstResponse);
      bytesOut = piped.bytes;
      if (piped.completedResponse) completedResponse = piped.completedResponse;
      if (piped.failure) responseFailure = piped.failure;
      interrupted = piped.interrupted && !responseCompleted;
    }
    markFirstResponse();
    if (completedResponse && routeAffinity) {
      routeAffinity.registerResponse(completedResponse, route.model);
    }
    // The zen free stream reports usage in the trailing chat chunk
    // (prompt_tokens/completion_tokens) instead of the Responses shape; map it
    // so the dashboard trace shows the burned budget even on the empty path.
    const traceUsage =
      usage && usage.input_tokens === undefined && usage.prompt_tokens !== undefined
        ? {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            input_tokens_details: usage.prompt_tokens_details,
            output_tokens_details: usage.completion_tokens_details,
          }
        : usage;
    if (freeEmpty) {
      const errorMessage = freeEmptyError.body.error.message;
      finish?.({
        ok: false,
        httpStatus: 429,
        upstream: target.provider,
        error: errorMessage.slice(0, 400),
        requestShape: describeInputShape(normalizedPayload.input),
        bytesOut,
        inputTokens: traceUsage?.input_tokens || 0,
        outputTokens: traceUsage?.output_tokens || 0,
        cachedTokens: traceUsage?.input_tokens_details?.cached_tokens || 0,
        reasoningTokens: traceUsage?.output_tokens_details?.reasoning_tokens || 0,
      });
      metrics?.recordResponseTransform?.({
        blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
        toolChoiceRewritten: false,
        imageRefs: [],
        directVision: route.directVision,
        droppedAssistantMessages: 0,
        nativeToolCalls: 0,
        nativeToolOutputs: 0,
        fallbackToolResults: 0,
      }, { streaming: true, routeReason: route.reason, bytesIn });
      metrics?.recordResponseUsage?.({ bytesOut, usage: traceUsage });
      (services.recordUsage || recordUsageEvent)({
        model: normalizedPayload.model,
        provider: target.provider,
        route: route.reason,
        status: 429,
        durationMs: Date.now() - startedAt,
        inputTokens: traceUsage?.input_tokens,
        outputTokens: traceUsage?.output_tokens,
        totalTokens: traceUsage?.total_tokens,
        cachedTokens: traceUsage?.input_tokens_details?.cached_tokens,
        reasoningTokens: traceUsage?.output_tokens_details?.reasoning_tokens,
        sessionId,
        threadId,
      });
      return { ok: false, httpStatus: 429, route, error: errorMessage.slice(0, 400), usage: traceUsage, bytesOut, upstreamBytes, latencyMs: Date.now() - startedAt, upstream: target.provider };
    }
    // inputTokens/outputTokens ride on the trace record: the dashboard's
    // context-token waveform plots recent[].inputTokens per completed call.
    const semanticFailed = Boolean(responseFailure);
    finish?.({
      ok: !interrupted && !semanticFailed,
      httpStatus: interrupted ? 499 : upstream.status,
      upstream: target.provider,
      error: interrupted ? "client disconnected" : responseFailure || undefined,
      bytesOut,
      inputTokens: traceUsage?.input_tokens || 0,
      outputTokens: traceUsage?.output_tokens || 0,
      // Both upstreams report prompt-cache hits and reasoning spend in the
      // standard details objects (verified live on go and deepseek-official);
      // the dashboard's cache-rate wave reads these off the trace records.
      cachedTokens: traceUsage?.input_tokens_details?.cached_tokens || 0,
      reasoningTokens: traceUsage?.output_tokens_details?.reasoning_tokens || 0,
    });
    metrics?.recordResponseTransform?.({
      blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
      toolChoiceRewritten: false,
      imageRefs: [],
      directVision: route.directVision,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
    }, { streaming: true, routeReason: route.reason, bytesIn });
    metrics?.recordResponseUsage?.({ bytesOut, usage: traceUsage });
    // Injectable so unit tests do not append to the real ~/.modeldock file.
    (services.recordUsage || recordUsageEvent)({
      model: normalizedPayload.model,
      provider: target.provider,
      route: route.reason,
      status: interrupted ? 499 : semanticFailed ? "error" : upstream.status,
      durationMs: Date.now() - startedAt,
      inputTokens: traceUsage?.input_tokens,
      outputTokens: traceUsage?.output_tokens,
      totalTokens: traceUsage?.total_tokens,
      cachedTokens: traceUsage?.input_tokens_details?.cached_tokens,
      reasoningTokens: traceUsage?.output_tokens_details?.reasoning_tokens,
      sessionId,
      threadId,
    });
    return {
      ok: !interrupted && !semanticFailed,
      httpStatus: interrupted ? 499 : upstream.status,
      route,
      error: responseFailure || undefined,
      usage: traceUsage,
      bytesOut,
      upstreamBytes,
      latencyMs: Date.now() - startedAt,
      upstream: target.provider,
    };
  } catch (error) {
    finish?.({ ok: false, error: error.message });
    if (!res.headersSent) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { type: "upstream_failed", message: redactBearer(error.message) } }));
    } else {
      endRelayStreamFailure(res, redactBearer(error.message));
    }
    return { ok: false, httpStatus: 502, route, error: error.message };
  }
}

function upstreamHeaders(target) {
  const headers = {
    Authorization: `Bearer ${target.token}`,
    "Content-Type": "application/json",
    "User-Agent": "modeldock-gateway/0.1",
  };
  return headers;
}

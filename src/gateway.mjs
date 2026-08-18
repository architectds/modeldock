import { Readable } from "node:stream";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { bareModelId, modelEntryFor, providerForModel } from "./profiles.mjs";
import { compressConversation } from "./compress.mjs";
import { normalizeOllamaBase } from "./ollama.mjs";
import { recordUsageEvent } from "./usage-events.mjs";
import { translateUpstreamError, freeEmptyOutputError } from "./error-translation.mjs";
import { RouteAffinity, routeResponsesRequest, isAssistantMarker } from "./router.mjs";
import { extractResponseUsage } from "./metrics.mjs";
import { stateDir } from "./state-dir.mjs";
import { historicalImageSpawnHint, promoteCollaborationNewTask } from "./subagent-guidance.mjs";

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

// Local backends (llama.cpp / Ollama) run on a small context window; Codex
// sends 150+ tool schemas (mostly MCP) that alone cost ~39K tokens and,
// together with the system prompt, eat roughly 61K of the window. Whitelist
// the core tools so the fixed overhead fits and the model keeps real
// conversation room (a small-context backend would otherwise be left with
// almost no room for the task).
const LOCAL_TOOL_ALLOWLIST = new Set([
  "exec_command",
  "apply_patch",
  "write_stdin",
  "update_plan",
  "read_file",
  "write_file",
  "glob",
  "grep",
  "task",
  // ModelDock harness tools that do NOT require the local model to be smart:
  // memory (external, mitigates the 32K window), web search (Exa), vision
  // (rerouted to the cloud vision model). The bare hosted "web_search" is a
  // different tool and is intentionally not whitelisted.
  "mcp__modeldock__recall_memory",
  "mcp__modeldock__store_memory",
  "mcp__modeldock__web_search_exa",
  "mcp__modeldock__vision_inspect",
  "mcp__modeldock__image_gen",
  "mcp__modeldock__speak",
  "mcp__modeldock__hear",
  // Let the model stop and ask the user when it is stuck; cheap and flat.
  "request_user_input",
  // codex_apps document control (Excel / Sheets / Word / PPT sessions): the
  // only office tools a small local model can usefully drive. Names carry the
  // plugin's truncated+hashed suffixes; update them if the plugin renames.
  "mcp__codex_apps__codex_document_control___execute_d_7437ad2e4ffa",
  "mcp__codex_apps__codex_document_control___get_docum_83c7f0565c0f",
  "mcp__codex_apps__codex_document_control___list_document_sessions",
  // Goal tracking: cheap, flat, and useful for a long-running local session.
  "get_goal",
  "create_goal",
  "update_goal",
]);

// A custom/Ollama backend that runs on this machine (loopback base URL).
//
// This is the real signal behind the budget decisions - the tool whitelist,
// the instruction stripping, and the compact pre-compression - because all
// three exist for slow local models. The earlier context-window proxy
// (ctx <= 100K) existed only to avoid trimming remote endpoints like
// OpenAI/OpenRouter; the loopback check excludes those directly instead of
// guessing from a token count. A local backend with a large window still gets
// the budget treatment (it is still a local model), and a remote one never
// does, whatever it advertises.
//
// Like its predecessor it does NOT gate the *protocol* adaptation (system
// hoisting, standard tool rewrite, reasoning mapping): that keys off the
// provider alone, because a local server can reject a mid-history system
// item at any advertised window. Conflating the two is what made compact_v2
// fail with "System message must be at the beginning"; see the comment in
// relayCompaction before widening this function's role again.
export function isLocalBackend(config, model) {
  const provider = providerForModel(config, model);
  if (provider !== "custom" && provider !== "ollama") return false;
  const baseUrl = provider === "ollama" ? config.ollamaBaseUrl : config.customBaseUrl;
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

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
    const dir = stateDir();
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

// The fallback for requests that carry no model id. Per session we remember the
// last actual main request so a no-model continuation stays on the model the
// user picked. Before a session has seen one, the current selected main model
// applies (e.g. what ON mode selected); only when there is no routed selection
// does the native config default apply, so a fresh session behaves exactly as
// Codex would without ModelDock.
const NATIVE_DEFAULT_MODEL = "gpt-5.6-sol";
function mainModelFor(services, sessionId) {
  const sessionModel = services.derivedFallback?.resolve?.(sessionId, "");
  if (sessionModel) return sessionModel;
  const selected = services.mainModel || services.config?.mainModel || "";
  // A routed selection is provider-qualified or a known legacy bare id; a bare
  // native slug (gpt-5.6-sol) is not published in the routed catalog.
  if (selected && (selected.includes("@") || services.knownModels?.has?.(selected))) return selected;
  return NATIVE_DEFAULT_MODEL;
}

function recordDerivedFallback(services, sessionId, route) {
  if (!route || (route.reason !== "client_selected" && route.reason !== "default_main")) return;
  services.derivedFallback?.record?.(sessionId, route.model);
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

// Codex can replay reasoning after compaction or a tool turn as an opaque
// encrypted_content item with only a public summary. Console Go cannot decrypt
// that provider-private payload, and both paid DeepSeek thinking routes require
// a concrete reasoning_text part. Promote the existing summary (never invented
// text) into the replayable content shape. An opaque item with neither content
// nor summary carries nothing this provider can consume, so omit it instead of
// sending an invalid thinking message that rejects the whole session.
function normalizeOpenCodeReasoningContent(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = input.flatMap((item) => {
    if (item?.type !== "reasoning") return [item];
    const content = Array.isArray(item.content) ? item.content : [];
    const hasReasoningText = content.some((part) =>
      part?.type === "reasoning_text" && typeof part.text === "string" && part.text.trim());
    if (hasReasoningText) return [item];
    const summaryText = (Array.isArray(item.summary) ? item.summary : [])
      .filter((part) => ["summary_text", "text"].includes(part?.type) && typeof part.text === "string")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    changed = true;
    if (!summaryText) return [];
    const { encrypted_content: _opaque, ...rest } = item;
    return [{ ...rest, content: [{ type: "reasoning_text", text: summaryText }] }];
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

// A hybrid sparse/full Console Go stream can make Codex persist the same tool
// call more than once. Replaying that poisoned history fails before the model
// runs because call_id is globally unique within a Responses request. Keep the
// first occurrence; normalizeGatewayInput has already retained and relocated
// only the first matching output, restoring one valid call/output pair.
function dedupeProToolCalls(input) {
  if (!Array.isArray(input)) return input;
  const seen = new Set();
  let changed = false;
  const out = input.filter((item) => {
    if (!isToolCallItem(item) || typeof item.call_id !== "string" || !item.call_id) return true;
    if (!seen.has(item.call_id)) {
      seen.add(item.call_id);
      return true;
    }
    changed = true;
    return false;
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
  const rewritten = dropUnpairedToolItems(input)
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
  return promoteCollaborationNewTask(rewritten);
}

// Codex emits its built-in tools as custom_tool_call / local_shell_call items
// (with matching _output siblings). Upstreams that only speak the standard
// Responses wire - Ollama's /v1/responses dialect in particular - reject those
// as unknown input item types, so they are rewritten to the standard
// function_call / function_call_output shape before forwarding. Codex carries
// the call payload in `input`; the standard wire expects it in `arguments`.
function normalizeStandardToolItem(item) {
  if (!item || typeof item !== "object") return item;
  const type = item.type;
  if (type === "custom_tool_call" || type === "local_shell_call") {
    const next = { ...item, type: "function_call" };
    delete next.input;
    if (item.input !== undefined) {
      next.arguments = standardToolArguments(item.input);
    }
    return next;
  }
  if (type === "custom_tool_call_output" || type === "local_shell_call_output") {
    return { ...item, type: "function_call_output" };
  }
  return item;
}

// llama.cpp's /v1/responses parses function_call.arguments with a strict JSON
// parser. Codex's custom_tool_call.input is often a double-encoded string
// (e.g. apply_patch content starting with a quote) that is not a JSON object.
// Normalize to a well-formed object string: parse-and-reserialize when the
// value is itself valid JSON, otherwise wrap it under { input } so the strict
// parser always accepts it.
function standardToolArguments(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string" ? JSON.stringify({ input: parsed }) : JSON.stringify(parsed);
    } catch {
      return JSON.stringify({ input: value });
    }
  }
  return JSON.stringify(value);
}

// Local Responses backends (Ollama, llama.cpp behind a custom endpoint) implement
// the standard Responses subset and reject Codex's own item types. Run the generic
// gateway normalization first (pairing, compaction, orphan removal on the
// Codex-native shapes) and then rewrite the remaining Codex tool types to the
// standard wire.
export function normalizeOllamaInput(input) {
  if (!Array.isArray(input)) return input;
  return normalizeGatewayInput(input).map(normalizeStandardToolItem);
}

// llama.cpp's jinja template requires the system message to be first
// ("System message must be at the beginning") and rejects a mid-history system
// item - Codex can emit one after compaction or a tool turn. Merge every
// system item's text into a single leading system message and drop the
// originals, so local backends (llama.cpp / Ollama) always see system first.
export function hoistLocalSystem(input) {
  if (!Array.isArray(input)) return input;
  const texts = [];
  const rest = [];
  for (const item of input) {
    // Codex sends its system guidance as role "developer"; llama.cpp's
    // template treats both developer and system as leading system messages.
    if (item?.role === "system" || item?.role === "developer") {
      const text = Array.isArray(item.content)
        ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim()
        : "";
      if (text) texts.push(text);
      continue;
    }
    rest.push(item);
  }
  if (!texts.length) return input;
  return [{ role: "system", content: [{ type: "input_text", text: texts.join("\n") }] }, ...rest];
}

// Local backend input, used by the custom route (typically llama.cpp). It needs
// both local adaptations, not just one: system hoisting so Codex's mid-history
// system items never trip llama.cpp's template validator, AND the standard-item
// rewrite, because llama.cpp implements the same Responses subset as Ollama and
// rejects Codex's custom_tool_call / local_shell_call types. Missing the rewrite
// meant a custom llama.cpp endpoint failed on the first tool call - which is
// nearly every turn in an agentic session.
export function normalizeLocalInput(input) {
  if (!Array.isArray(input)) return input;
  return hoistLocalSystem(normalizeOllamaInput(input));
}

// llama.cpp's /v1/responses renders `instructions` as the system message, so a
// role=system item anywhere in input then sits mid-history and trips the
// template ("System message must be at the beginning"). When instructions exist,
// merge every system item's text into them and drop the items; when they do not,
// hoist system to the front as before. Both paths keep the standard-tool rewrite.
export function normalizeLocalPayload(payload) {
  if (!payload || !Array.isArray(payload.input)) return payload;
  // Codex sends `instructions` as an array of input_text parts, not a string.
  // Normalize either shape to text so the merge below always sees a string.
  const instructions = typeof payload.instructions === "string"
    ? payload.instructions
    : Array.isArray(payload.instructions)
      ? payload.instructions.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim()
      : "";
  if (instructions) {
    const texts = [];
    const rest = [];
    for (const item of payload.input) {
      if (item?.role === "system" || item?.role === "developer") {
        const text = Array.isArray(item.content)
          ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim()
          : "";
        if (text) texts.push(text);
        continue;
      }
      rest.push(item);
    }
    const input = normalizeOllamaInput(rest);
    return {
      ...payload,
      instructions: texts.length ? [instructions, ...texts].filter(Boolean).join("\n") : instructions,
      input,
    };
  }
  return { ...payload, input: normalizeLocalInput(payload.input) };
}

// The skills a small-context local backend keeps in the <skills_instructions>
// block: the four harness/media skills plus the office skills whose
// codex_document_control tools ARE whitelisted (their SKILL.md guides how to
// drive Word/PPT/Spreadsheet sessions). Everything else is dropped - its tools
// are not whitelisted, so the descriptions are dead weight for a small model.
const LOCAL_SKILLS_KEEP = new Set([
  "imagegen",
  "openai-docs",
  "content-to-video",
  "media-use",
  "documents",
  "presentations",
  "spreadsheets", // covers both the spreadsheet skill and excel-live-control
]);
const SKILLS_BLOCK_RE = /<skills_instructions>[\s\S]*?<\/skills_instructions>/;
const APP_CONTEXT_BLOCK_RE = /<app-context>[\s\S]*?<\/app-context>/;
const APPS_INSTRUCTIONS_RE = /<apps_instructions>[\s\S]*?<\/apps_instructions>\s*/g;
// The collaboration "/root primary agent" block plus its mode fence describe
// tools (spawn_agent, send_message, wait_agent...) that are not whitelisted
// for small local backends, so the whole span is removable.
const AGENT_BLOCK_RE = /You are `\/root`, the primary agent[\s\S]*?<\/multi_agent_mode>\s*/g;
// The memory citation ceremony (oai-mem-citation block, rollout ids, format
// rules) is platform bookkeeping; recall_memory results do not need it.
const MEMORY_CITATION_RE = /Memory citation requirements:[\s\S]*?(?=Updating memories:)/g;
// ModelDock's own base instructions, shortened for small models: the
// mandatory design-first image-gen loop and the long vision preamble are
// disproportionate for a small-context local backend.
const VERBOSE_VISION_GUIDANCE =
  /Vision guidance \(MANDATORY\): you are a TEXT-ONLY model[\s\S]*?view_image is only for showing the human the file\./g;
const VERBOSE_DESIGN_FIRST =
  /Design-first workflow \(MANDATORY for frontend\/UI work\):[\s\S]*?read it with vision_inspect instead\./g;
const VERBOSE_ACTION_RULE =
  /IMPORTANT: To perform any action[\s\S]*?re-emit the call\./g;
const VERBOSE_RESTART =
  /Restarting the gateway: if you need to restart the ModelDock service[\s\S]*?wait for that line before continuing\./g;

function stripSkillsBlock(text) {
  if (typeof text !== "string") return text;
  const block = text.match(SKILLS_BLOCK_RE)?.[0];
  if (!block) return text;
  const kept = block
    .split("\n")
    .filter((line) => {
      const entry = line.match(/^\s*-\s*([A-Za-z0-9._-]+)\s*:/);
      if (!entry) return true;
      return LOCAL_SKILLS_KEEP.has(entry[1]);
    })
    .map((line) => (line.match(/^\s*-\s*([A-Za-z0-9._-]+)\s*:/) ? compressSkillLine(line) : line))
    .join("\n");
  if (kept === block) return text;
  return text.replace(block, kept);
}

// "name + one sentence + locator": a kept skill's entry is compressed to its
// first sentence so the picker stays a directory, not a brochure. The model
// reads the SKILL.md when it actually uses the skill.
function compressSkillLine(line) {
  const match = line.match(/^(\s*-\s*[A-Za-z0-9._:-]+:\s*)([\s\S]*?)(\s*\((?:file|environment resource|orchestrator package|custom resource):[\s\S]*\)\s*)$/);
  if (!match) return line;
  const [, head, description, locator] = match;
  const firstSentence = firstSentenceOf(description.trim());
  return `${head}${firstSentence}${locator}`;
}

function firstSentenceOf(text) {
  if (!text) return "";
  const boundary = text.indexOf(". ");
  const candidate = boundary > 0 ? text.slice(0, boundary + 1) : text;
  if (candidate.length <= 90) return candidate;
  const cut = candidate.slice(0, 90);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 60 ? lastSpace : 90)}...`;
}

function stripAppContextBlock(text) {
  if (typeof text !== "string") return text;
  const block = text.match(APP_CONTEXT_BLOCK_RE)?.[0];
  if (!block) return text;
  const dropHeaders = new Set(["### Automations", "### Thread Coordination", "### Workspace Dependencies"]);
  const lines = block.split("\n");
  let dropping = false;
  const kept = lines.filter((line) => {
    if (line.startsWith("### ")) dropping = dropHeaders.has(line.trim());
    return !dropping;
  }).join("\n");
  if (kept === block) return text;
  return text.replace(block, kept);
}

function stripLocalInstructionText(text) {
  if (typeof text !== "string") return text;
  let out = text;
  out = stripSkillsBlock(out);
  out = stripAppContextBlock(out);
  out = out
    .replace(VERBOSE_VISION_GUIDANCE, "Vision: you cannot see images; use vision_inspect for any visual task.")
    .replace(VERBOSE_DESIGN_FIRST, "Design: only run image_gen when the user asks for a visual direction.")
    .replace(VERBOSE_ACTION_RULE, "IMPORTANT: perform any action by emitting a function_call in this turn; never describe an action in text.")
    .replace(VERBOSE_RESTART, (match) => {
      const path = match.match(/"([^"]+\\restart\.ps1)"/)?.[1] || "scripts/restart.ps1";
      return `Restarting ModelDock: run powershell -ExecutionPolicy Bypass -File "${path}" and wait for the "started gateway" line.`;
    })
    .replace(AGENT_BLOCK_RE, "")
    .replace(APPS_INSTRUCTIONS_RE, "")
    .replace(MEMORY_CITATION_RE, "");
  return out;
}

// Remove the dead-weight sections from the payload instructions for
// small-context local backends. Codex sends instructions either as a plain
// string or as an array of input_text parts; both shapes are handled and
// unchanged input is returned as-is so the upstream prefix cache is stable.
export function stripLocalInstructions(instructions) {
  if (Array.isArray(instructions)) {
    let changed = false;
    const out = instructions.map((part) => {
      if (!part || typeof part !== "object" || typeof part.text !== "string") return part;
      const text = stripLocalInstructionText(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? out : instructions;
  }
  return stripLocalInstructionText(instructions);
}

// llama.cpp's jinja template accepts only xhigh/medium/low and raises
// on "high" (Codex's default effort). Map "high" to the closest accepted value
// and drop anything else so local custom/Ollama routes never trip the template
// validator. Valid efforts pass through so the picker's selection is honored.
export function normalizeLocalReasoning(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const reasoning = payload.reasoning;
  if (!reasoning || typeof reasoning !== "object") return payload;
  const effort = reasoning.effort;
  if (effort === "high") {
    return { ...payload, reasoning: { ...reasoning, effort: "xhigh" } };
  }
  if (effort !== "xhigh" && effort !== "medium" && effort !== "low") {
    const { reasoning: _dropped, ...rest } = payload;
    return rest;
  }
  return payload;
}

// Flash otherwise stays on the generic byte-stable path. Its only required
// OpenCode Go adaptation is making Codex's public reasoning summary replayable
// after compaction or a tool result. Pro's broader chat/stream repairs below do
// not apply to Flash.
export function normalizeOpenCodeFlashInput(input) {
  if (!Array.isArray(input)) return input;
  return normalizeOpenCodeReasoningContent(normalizeGatewayInput(input));
}

// opencode's deepseek-v4-pro route deserializes replayed reasoning items as
// chat messages (a stable id is required) and its responses-to-chat translator
// needs assistant content as a plain string. These rewrites are strictly
// pro+opencode-go: the generic routed path (flash, official, custom) works
// without them, and byte-stable flash traffic must stay untouched.
export function normalizeOpenCodeProInput(input) {
  if (!Array.isArray(input)) return input;
  const normalized = normalizeGatewayInput(input);
  const deduped = dedupeProToolCalls(normalized);
  const interleaved = interleaveToolOutputs(deduped);
  const withToolCallIds = fillProToolCallIds(interleaved);
  const withReasoningContent = normalizeOpenCodeReasoningContent(withToolCallIds);
  const withReasoningIds = fillReasoningIds(withReasoningContent);
  const flattened = flattenAssistantContent(withReasoningIds);
  const continued = appendProToolContinuation(flattened);
  return attachProExecutionGuidance(continued);
}

// Keep every routed entry point on the same provider/model-specific input
// contract. Both ordinary responses and remote compaction replay Codex history;
// letting either path fall back to generic normalization reintroduces the same
// strict-upstream failures only when a long task crosses that boundary.
function normalizeInputForRoute(config, model, input, localPayload = null) {
  const routedModel = bareModelId(model);
  const routedProvider = providerForModel(config, model);
  if (routedModel === "deepseek-v4-pro" && routedProvider === "opencode-go") {
    return normalizeOpenCodeProInput(input);
  }
  if (routedModel === "deepseek-v4-flash" && routedProvider === "opencode-go") {
    return normalizeOpenCodeFlashInput(input);
  }
  return localPayload ? localPayload.input : normalizeGatewayInput(input);
}

// A message is "current" when it follows the last assistant turn. In the
// Responses wire an assistant turn is not always a role:"assistant" message: an
// agentic turn is frequently a bare function_call / reasoning item. This mirrors
// router.mjs's isAssistantMarker so the rewrite's notion of "current" matches the
// turn that triggered vision escalation.
function currentTurnStart(input) {
  if (!Array.isArray(input)) return 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (isAssistantMarker(input[index])) start = index + 1;
  }
  return start;
}

export function currentTurnStartForTesting(input) {
  return currentTurnStart(input);
}

// Replace input_image parts with a lightweight image_ref placeholder so a text
// main model never re-receives image bytes. By default every input_image is
// rewritten (no turn gating), which keeps the text model's history byte-stable:
// an image serializes the same way whether it sits in the current turn or an
// older one, so the upstream prefix cache is not invalidated as turns advance.
// preserveCurrentImages=true keeps current-turn images (index >= turnStart) as
// real input_image parts for the vision escalation path, which must see the
// bytes. Without a media store the rewrite is a no-op, so a partial services stub
// stays safe.
// Codex always sends `image_url` as a string. MiMo's Responses endpoint rejects
// that form and requires an object - measured against opencode.ai/zen/go/v1 with
// mimo-v2.5 and a 1x1 PNG data URL: the string form returns 400 "Param
// Incorrect", the object form returns 200. gpt-5.6-luna is the exact opposite,
// so this is opt-in per model via imageUrlShape rather than a blanket rewrite.
//
// This must run AFTER rewriteHistoricalImages, which decides what to replace by
// testing `typeof image_url === "string"`; converting first would make every
// image invisible to it.
export function adaptImageUrlShape(input, shape) {
  if (shape !== "object" || !Array.isArray(input)) return input;
  return input.map((item) => {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
    let changed = false;
    const content = item.content.map((part) => {
      if (part?.type !== "input_image" || typeof part.image_url !== "string") return part;
      changed = true;
      return { ...part, image_url: { url: part.image_url } };
    });
    return changed ? { ...item, content } : item;
  });
}

export function rewriteHistoricalImages(input, mediaStore, { preserveCurrentImages = false } = {}) {
  if (!Array.isArray(input)) return input;
  const turnStart = currentTurnStart(input);
  return input.map((item, index) => {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
    if (preserveCurrentImages && index >= turnStart) return item;
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
        text: historicalImageSpawnHint(ref),
      };
    });
    return changed ? { ...item, content } : item;
  });
}

// Tool policy: keep standard function/custom tools, flatten MCP namespaces so
// text models see plain functions, and strip hosted schemas plus tools the model
// cannot use. Returns the filtered list and a report of what was removed.
export function applyToolPolicy(tools, { hiddenToolNames = TEXT_MODEL_HIDDEN_TOOLS, allowToolNames } = {}) {
  if (!Array.isArray(tools)) return { tools, stripped: { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0 } };
  const hidden = new Set(hiddenToolNames || []);
  const allow = allowToolNames ? new Set(allowToolNames) : null;
  const stripped = { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0, allowlist: 0 };
  const out = [];
  const allowed = (name) => !allow || allow.has(name);
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
        if (!allowed(child.name)) {
          stripped.allowlist += 1;
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
    if (typeof tool.name === "string" && !allowed(tool.name)) {
      stripped.allowlist += 1;
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
  if (provider === "ollama") {
    // The published id is colon-free but Ollama only serves the original tag
    // (a model tag may contain a colon that the slug cannot carry), so the
    // wire id comes from the profile entry.
    const entry = modelEntryFor(config, model);
    return {
      provider,
      model: entry?.upstreamId || upstreamModel,
      url: `${normalizeOllamaBase(config.ollamaBaseUrl || "http://127.0.0.1:11434")}/v1/responses`,
      token: "",
      // Ollama needs no credential; the tokenless gate below must not 503 it.
      tokenRequired: false,
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
    // Zen free tier: failure copy should carry free-tier guidance instead of the
    // generic hint (see error-translation.mjs FREE_HINTS).
    free: Boolean(entry?.free),
  };
}

export function routeGatewayRequest(source, { mainModel, visionModel, affinity, knownModels, mainModelSupportsVision }) {
  return routeResponsesRequest(source, { mainModel, visionModel, affinity, knownModels, mainModelSupportsVision });
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

// opencode's thinking-model stream (and any peer that copies that wire) does not honor the
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
      if ((item.id && existing.itemId === item.id) || (item.call_id && existing.callId === item.call_id)) {
        track.activeIndex = existingIndex;
        return { index: existingIndex, entry: existing, created: false };
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
      argumentsDone: false,
      itemDone: false,
    };
    track.items.set(index, entry);
    track.activeIndex = index;
    return { index, entry, created: true };
  };
  const trackLifecycleDone = (parsed, field) => {
    if (!track) return parsed;
    let index = null;
    const itemId = parsed.item_id || parsed.item?.id;
    const callId = parsed.item?.call_id;
    for (const [candidate, entry] of track.items) {
      if ((itemId && entry.itemId === itemId) || (callId && entry.callId === callId)) {
        index = candidate;
        break;
      }
    }
    if (index === null) index = track.activeIndex;
    const entry = track.items.get(index);
    if (!entry) return parsed;
    entry[field] = true;
    const completeArguments = parsed.arguments ?? parsed.item?.arguments;
    if (entry.partType === "function_call" && typeof completeArguments === "string") {
      entry.text = completeArguments;
    }
    return {
      ...parsed,
      item_id: entry.itemId,
      output_index: index,
      response_id: track.respId,
    };
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
        if (!entry.argumentsDone) {
          writeOut(sseEvent({
            id: track.respId,
            type: "response.function_call_arguments.done",
            item_id: entry.itemId,
            output_index: index,
            arguments: entry.text,
            response_id: track.respId,
          }));
        }
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
      if (!entry.itemDone) {
        writeOut(sseEvent({ id: track.respId, type: "response.output_item.done", item: doneItem, response_id: track.respId }));
      }
    }
    const response = parsed?.response || {};
    const output = Array.from(track.items.values()).map((entry, index) => entry.partType === "function_call"
      ? { id: entry.itemId, type: "function_call", status: "completed", name: entry.name, call_id: entry.callId, arguments: entry.text, output_index: index }
      : entry.partType === "reasoning_text"
        ? { id: entry.itemId, type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: entry.text }] }
        : { id: entry.itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: entry.text }] });
    const existingOutput = Array.isArray(response.output) ? response.output : [];
    const missingOutput = output.filter((item) => !existingOutput.some((existing) =>
      (item.id && existing?.id === item.id) || (item.call_id && existing?.call_id === item.call_id)));
    track = null;
    return finishEvent({ ...parsed, response: { ...response, output: [...existingOutput, ...missingOutput] } });
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
          if (!tracked || tracked.created) writeOut(sseEvent(tracked ? { ...parsed, output_index: tracked.index } : parsed));
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
          if (!tracked || tracked.created) writeOut(sseEvent(tracked ? { ...parsed, output_index: tracked.index } : parsed));
          continue;
        }
        if (parsed?.type === "response.function_call_arguments.delta") {
          writeOut(sseEvent(trackDelta(parsed)));
          continue;
        }
        if (parsed?.type === "response.function_call_arguments.done") {
          writeOut(sseEvent(trackLifecycleDone(parsed, "argumentsDone")));
          continue;
        }
        if (parsed?.type === "response.output_item.done") {
          writeOut(sseEvent(trackLifecycleDone(parsed, "itemDone")));
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
async function pipeFreeStream(upstreamBody, res, tee, failedMessage, onFirstResponse) {
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

// Every relay records the same envelope on every outcome - which session, how
// long it took, and through which dispatcher - and differs only in the result.
// Binding the envelope once per relay keeps the nine call sites down to what is
// actually specific to them: the status, and the token counts when the upstream
// reported any.
function usageRecorder(services, { startedAt, sessionId, threadId }) {
  const record = services.recordUsage || recordUsageEvent;
  return (fields) => record({ durationMs: Date.now() - startedAt, sessionId, threadId, ...fields });
}

// A transform report for a request that reached the upstream unchanged. Most
// call sites are failure paths that rewrote nothing, and each spelled out all
// eight fields to say so; they now pass only what they actually observed.
function noTransform(fields = {}) {
  return {
    blocked: { tool_search: 0, web_search: 0 },
    toolChoiceRewritten: false,
    imageRefs: [],
    directVision: false,
    droppedAssistantMessages: 0,
    nativeToolCalls: 0,
    nativeToolOutputs: 0,
    fallbackToolResults: 0,
    ...fields,
  };
}

// The upstream's usage object in the field names the meter stores. Written out
// per call site, this was five near-identical lines each time, and the two paths
// that only wanted three of them were easy to mistake for a bug.
function usageTokens(usage) {
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
    cachedTokens: usage.input_tokens_details?.cached_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  };
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
  const recordUsage = usageRecorder(services, { startedAt, sessionId, threadId });
  const nativeRoute = { model: payload.model, provider: "openai", route: "native_passthrough" };
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
      metrics?.recordResponseTransform?.(noTransform(), { streaming: false, routeReason: "native_passthrough", bytesIn });
      recordUsage({ ...nativeRoute, status: upstream.status });
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
    metrics?.recordResponseTransform?.(noTransform(), { streaming: payload.stream !== false, routeReason: "native_passthrough", bytesIn });
    recordUsage({
      ...nativeRoute,
      status: interrupted ? 499 : semanticFailed ? "error" : upstream.status,
      ...usageTokens(usage),
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

// Write a compaction response whose summary already exists (the CPU extract
// for a local backend) instead of synthesizing one from an upstream summarize
// call. v1 gets replacement history, v2 gets the single compaction item on
// either wire. Returns the JSON byte count so the trace can record bytesOut.
// The upstream compact path refuses a response over MAX_COMPACT_RESPONSE_BYTES;
// the direct path wrote whatever the extract came to, with no ceiling at all.
// The extract is ours and deterministic, so the right answer to an oversized one
// is not a 502 that leaves the session unable to compact - it is to keep the two
// ends that carry the handoff (the task at the head, the recent state at the
// tail) and say what went missing. Slicing by characters against a byte budget
// only ever under-fills, so the result cannot exceed the cap.
export function capDirectSummary(summary, cap = MAX_COMPACT_RESPONSE_BYTES) {
  const bytes = Buffer.byteLength(summary);
  if (bytes <= cap) return summary;
  const half = Math.floor(cap / 2);
  return `${summary.slice(0, half)}\n[... ${bytes - cap} characters of this handoff were dropped to fit the compaction size limit ...]\n${summary.slice(-half)}`;
}

function writeDirectCompaction(res, payload, summary, v2) {
  if (v2) {
    if (payload.stream === false) {
      const body = JSON.stringify(compactionSnapshot(payload.model, compactionItem(summary), null));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(body);
      return Buffer.byteLength(body);
    }
    writeCompactionSse(res, payload.model, summary);
    return 0;
  }
  const body = JSON.stringify({ output: compactOutput(payload.input, summary) });
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(body);
  return Buffer.byteLength(body);
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
  const mainModel = mainModelFor(services, sessionId);
  const visionModel = services.visionModel || config.visionModel;
  const route = routeGatewayRequest(payload, {
    mainModel,
    visionModel,
    affinity: routeAffinity,
    knownModels,
    mainModelSupportsVision: Boolean(modelEntryFor(config, mainModel)?.supportsVision),
  });
  recordDerivedFallback(services, sessionId, route);
  // Custom/ollama backends must see the same adapted shape on the compact path
  // as on the main relay path: Codex's mid-history system/developer items
  // hoisted into a single leading system (or merged into instructions), the
  // standard tool-item rewrite, and a reasoning effort the jinja template
  // accepts. Context size is not the right gate here - a local server can
  // advertise a large window and still reject a mid-history system item, so
  // this must match relayResponses unconditionally for the provider, not only
  // for isLocalBackend. Skipping the adaptation made compact_v2
  // fail with "System message must be at the beginning" whenever the compacted
  // history carried a mid-history system item.
  const routedProvider = providerForModel(config, route.model);
  const localPayload =
    routedProvider === "custom" || routedProvider === "ollama" ? normalizeLocalPayload(payload) : null;
  const normalizedInput = normalizeInputForRoute(config, route.model, payload.input, localPayload);
  const summarizeBody = {
    ...(localPayload || payload),
    model: route.model,
    stream: false,
    tools: [],
    tool_choice: "none",
    input: [
      ...adaptImageUrlShape(
        rewriteHistoricalImages(
          normalizedInput,
          mediaStore,
          { preserveCurrentImages: route.directVision },
        ),
        modelEntryFor(config, route.model)?.imageUrlShape,
      ),
      messageItem(COMPACT_PROMPT),
    ],
  };
  if (localPayload) {
    summarizeBody.reasoning = normalizeLocalReasoning(summarizeBody).reasoning;
  }
  // A small-context local backend cannot finish an LLM handoff of a large
  // history inside Codex's ~5 minute timeout: prefill alone can run for
  // minutes on a modest local backend. For these backends the CPU extract IS
  // the handoff - task, findings, recent state, tool inventory - so it is
  // handed straight back to Codex as the compaction summary. No upstream
  // summarize call at all: milliseconds, deterministic, zero model time. The
  // degenerate guard (extract essentially the same size as the input: a
  // two-message exchange, no tool noise) simply means the extract carries no
  // compression credit, but the direct return is still correct - the raw
  // history is tiny and is exactly what a handoff of it should look like.
  let compressionInfo = null;
  let directSummary = null;
  if (isLocalBackend(config, route.model)) {
    const compressed = compressConversation(normalizedInput);
    if (compressed.compressedChars < compressed.originalChars * 0.95) {
      compressionInfo = { fromChars: compressed.originalChars, toChars: compressed.compressedChars };
    }
    directSummary = compressed.text;
  }
  // Small-context local backends do not need the heavy creative skills; drop
  // their entries from the instructions so the summarize call (which replays
  // the full history) carries less dead weight.
  if (isLocalBackend(config, route.model)) {
    summarizeBody.instructions = stripLocalInstructions(summarizeBody.instructions);
  }
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
  const recordUsage = usageRecorder(services, { startedAt, sessionId, threadId });
  const compactRoute = { model: route.model, provider: target.provider, route: operation };
  let usage;
  try {
    // Local backend: the CPU extract is the compaction summary. Hand it back
    // directly - no upstream call, no token needed, no GPU prefill. The trace
    // records the compression credit and the synthesized response bytes.
    if (directSummary) {
      const bytesOut = writeDirectCompaction(res, payload, capDirectSummary(directSummary), v2);
      // No inputTokens here, deliberately. This path makes no upstream call, so
      // it consumes none, and inputTokens means "tokens the upstream billed"
      // everywhere else it is read: the per-request context column, the context
      // waveform, and the cache-rate denominator. Reporting fromChars/3 as if it
      // were usage put an estimate into a series of measurements with no way to
      // tell them apart afterwards - and the estimate is large (a 1.4M-char
      // history reads as ~460K tokens), so it would become the waveform's peak
      // and flatten every real point. The history size is still reported, as
      // measured characters, in `compression` - which is what the trace's detail
      // column renders.
      finish?.({
        ok: true,
        httpStatus: 200,
        upstream: target.provider,
        bytesOut,
        compression: compressionInfo,
      });
      metrics?.recordResponseUsage?.({ bytesOut });
      metrics?.recordResponseTransform?.(noTransform(), { streaming: payload.stream !== false, routeReason: operation, bytesIn });
      recordUsage({ ...compactRoute, status: 200, compression: compressionInfo });
      return {
        ok: true,
        httpStatus: 200,
        route,
        usage: null,
        bytesOut,
        latencyMs: Date.now() - startedAt,
        upstream: target.provider,
      };
    }
    if (!target.token && target.tokenRequired !== false) {
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
      recordUsage({ ...compactRoute, status: 503 });
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
      recordUsage({ ...compactRoute, status: 502 });
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
        compression: compressionInfo,
      });
      metrics?.recordResponseTransform?.(noTransform(), { streaming: false, routeReason: operation, bytesIn });
      recordUsage({ ...compactRoute, status: upstream.status });
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
      recordUsage({ ...compactRoute, status: 502 });
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
      compression: compressionInfo,
    });
    metrics?.recordResponseUsage?.({ bytesOut: bytes.length, usage });
    metrics?.recordResponseTransform?.(noTransform(), { streaming: payload.stream !== false, routeReason: operation, bytesIn });
    recordUsage({ ...compactRoute, status: 200, ...usageTokens(usage) });
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
  const mainModel = mainModelFor(services, sessionId);
  const visionModel = services.visionModel || config.visionModel;
  const route = routeGatewayRequest(payload, {
    mainModel,
    visionModel,
    affinity: routeAffinity,
    knownModels,
    mainModelSupportsVision: Boolean(modelEntryFor(config, mainModel)?.supportsVision),
  });
  recordDerivedFallback(services, sessionId, route);
  // A no-model request can fall back to the native default (gpt-5.6-sol) until
  // the session has seen a routed main request. That model must reach the
  // ChatGPT backend like any other native slug, not the external upstream.
  const routedNative = !payload.model
    && (services.nativeSlugs?.has?.(route.model) || route.model === NATIVE_DEFAULT_MODEL);
  if (routedNative) {
    return relayNativeResponses({ ...payload, model: route.model }, res, services, { signal });
  }

  // OpenCode Go's paid DeepSeek routes both require replayable reasoning_text.
  // Pro additionally needs the id, assistant-content, tool-history and stream
  // repairs; official and custom routes keep the generic path.
  const routedProvider = providerForModel(config, route.model);
  const localPayload =
    routedProvider === "custom" || routedProvider === "ollama" ? normalizeLocalPayload(payload) : null;
  const normalizedInput = normalizeInputForRoute(config, route.model, payload.input, localPayload);
  let normalizedPayload = {
    ...(localPayload || payload),
    input: adaptImageUrlShape(
      rewriteHistoricalImages(
        normalizedInput,
        mediaStore,
        { preserveCurrentImages: route.directVision },
      ),
      modelEntryFor(config, route.model)?.imageUrlShape,
    ),
    model: route.model,
  };
  // llama.cpp's jinja template accepts only xhigh/medium/low and
  // raises on "high" (Codex's default). Keep valid efforts, map "high" to the
  // closest accepted value, and drop anything else so local routes never trip
  // the template validator.
  if (routedProvider === "custom" || routedProvider === "ollama") {
    normalizedPayload = {
      ...normalizedPayload,
      reasoning: normalizeLocalReasoning(normalizedPayload).reasoning,
    };
  }
  delete normalizedPayload.client_metadata;
  // The input array is the authoritative history here. A previous_response_id
  // would make the upstream resolve continuation state server-side - state
  // that can still carry the orphaned tool call this gateway just cleaned, so
  // strict upstreams (Go) would reject the request again.
  delete normalizedPayload.previous_response_id;

  // Transfer-card "in": the request body bytes the client actually sent this
  // gate. Re-serializing the parsed payload is the honest post-decode size.
  const bytesIn = Buffer.byteLength(JSON.stringify(payload));

  // Trim tools only for small-context local backends (llama.cpp etc.).
  // A custom endpoint pointing at OpenAI/OpenRouter (128K+) keeps everything.
  const trimLocalTools = isLocalBackend(config, route.model);
  const { tools, stripped } = applyToolPolicy(normalizedPayload.tools, {
    allowToolNames: trimLocalTools ? LOCAL_TOOL_ALLOWLIST : undefined,
  });
  if (tools !== normalizedPayload.tools) normalizedPayload.tools = tools;
  // Same budget logic as the tool whitelist: a small-context local model gets
  // no value from the hyperframes skill entries, and every stripped line is
  // tokens the model no longer pays to read on each turn.
  if (trimLocalTools) {
    normalizedPayload.instructions = stripLocalInstructions(normalizedPayload.instructions);
  }

  const target = upstreamTargetFor(config, normalizedPayload.model);
  // The upstream sees the bare model id; the route model (possibly owner-suffixed)
  // stays in the response and affinity so provider resolution keeps working on
  // continuation requests.
  const upstreamModel = target.model;
  if (config.debug?.dumpAll && config.debug?.dumpDir) {
    dumpRequestBody(config.debug.dumpDir, { ...normalizedPayload, model: upstreamModel });
  }
  if (!target.token && target.tokenRequired !== false) {
    const error = {
      error: {
        type: "configuration_error",
        message: `No API token configured for provider ${target.provider}.`,
      },
    };
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(error));
    metrics?.recordResponseTransform?.(noTransform({ blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch }, directVision: route.directVision }), { streaming: false, routeReason: route.reason, bytesIn });
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
  const recordUsage = usageRecorder(services, { startedAt, sessionId, threadId });
  const relayRoute = { model: normalizedPayload.model, provider: target.provider, route: route.reason };
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
      metrics?.recordResponseTransform?.(noTransform({ blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch }, directVision: route.directVision }), { streaming: false, routeReason: route.reason, bytesIn });
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
        metrics?.recordResponseTransform?.(noTransform({ blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch }, directVision: route.directVision }), { streaming: false, routeReason: route.reason, bytesIn });
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
      // Codex points openai_base_url at this gate, so every picker model
      // (Go, Official, Z.AI, Kimi, custom) arrives here. The pipe inspects the
      // SSE shape: a sparse/bare tool stream is re-framed; a full Responses
      // lifecycle passes through event-for-event. Do not key this on provider.
      const piped = normalizedPayload.stream === true
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
      metrics?.recordResponseTransform?.(noTransform({ blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch }, directVision: route.directVision }), { streaming: true, routeReason: route.reason, bytesIn });
      metrics?.recordResponseUsage?.({ bytesOut, usage: traceUsage });
      recordUsage({ ...relayRoute, status: 429, ...usageTokens(traceUsage) });
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
    metrics?.recordResponseTransform?.(noTransform({ blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch }, directVision: route.directVision }), { streaming: true, routeReason: route.reason, bytesIn });
    metrics?.recordResponseUsage?.({ bytesOut, usage: traceUsage });
    // Injectable so unit tests do not append to the real ~/.modeldock file.
    recordUsage({
      ...relayRoute,
      status: interrupted ? 499 : semanticFailed ? "error" : upstream.status,
      ...usageTokens(traceUsage),
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

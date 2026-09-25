import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { allProfiles, bareModelId, modelAddressFor, modelEntryFor, modelRefParts, profileById, providerForModel, upstreamTargetFor } from "./profiles.mjs";
import { codexModelRef } from "./model-ref.mjs";
import { canonicalLlamaLocalKey, isLlamaLocalName } from "./model-identity.mjs";
import { compressConversation } from "./compress.mjs";
import { normalizeOllamaBase } from "./ollama.mjs";
import { recordUsageEvent } from "./usage-events.mjs";
import { translateUpstreamError, freeEmptyOutputError, isLocalConnectionFailure, localEngineDownMessage } from "./error-translation.mjs";
import { CURRENT_TURN_MARKER, RouteAffinity, currentTurnHasImage, currentTurnStartIndex, routeResponsesRequest } from "./router.mjs";
import { extractResponseUsage } from "./metrics.mjs";
import { stateDir } from "./state-dir.mjs";
import { customEndpointFor } from "./custom-endpoint-routing.mjs";
import { collaborationEnvelopeTurn, historicalImageSpawnHint, hasOpaqueCollaboration, isOpaqueEncryptedContent } from "./subagent-guidance.mjs";
import { attachSseKeepAlive, createUsageTee, forEachSseEvent, parseSseData } from "./sse.mjs";
import { chatCompletionToResponse, chatReasoningText, normalizeLlamaServerTimings, pipeChatCompletionStream, responsesToChat } from "./local-chat-bridge.mjs";
import { MIN_IMAGE_TRANSPORT_WIRE_BYTES } from "./image-transport.mjs";
import { NATIVE_CODEX_BASE } from "./native-endpoint.mjs";
import { NATIVE_PROVIDER_ID } from "./native-provider.mjs";
import { readCodexAuth } from "./codex-auth.mjs";
import { sessionIdsFrom, upstreamHeaders } from "./upstream-headers.mjs";
export { sessionIdsFrom };

// Re-exported so the existing import path keeps working: the tee is SSE
// machinery and lives with the rest of the framing rules in sse.mjs.
export { createUsageTee };

// Hosted / special tool types Codex can emit that the Go and DeepSeek upstreams
// reject. The catalog declarations are the primary control; stripping here is the
// safety net, not the mechanism.
const HOSTED_TOOL_TYPES = new Set([
  "tool_search",
  "web_search",
  "computer_use",
  "browser_use",
  "artifact",
  // Codex sends this one nameless (`{ type: "image_generation" }`). Because the
  // name filters below key off a string name, while a hosted type
  // that is missing from this set is not merely un-stripped - it is invisible to
  // every other filter and forwarded verbatim, even in slim mode. Observed
  // reaching a local backend on 2026-08-18. ModelDock serves image generation
  // through mcp__modeldock__image_gen instead.
  "image_generation",
]);

// Visual tools are complementary, not redundant. Text-only models delegate to
// vision_inspect and cannot use view_image pixels. Vision-capable models inspect
// pixels through view_image/preview_images and must not delegate the same work to
// the configured fallback model.
const TEXT_MODEL_HIDDEN_TOOLS = new Set(["view_image"]);
const VISION_MODEL_HIDDEN_TOOLS = new Set([
  "vision_inspect",
  "mcp__modeldock__vision_inspect",
]);

// Native Codex models already receive OpenAI's hosted web_search and inspect
// image pixels directly. ModelDock's Exa and delegated-vision duplicates add
// prompt/tool weight and can send the work through the wrong route. Keep every
// other ModelDock tool: memory, media production, previews, and voice remain
// complementary native capabilities.
const NATIVE_REDUNDANT_TOOL_NAMES = new Set([
  "mcp__modeldock__web_search_exa",
  "mcp__modeldock__vision_inspect",
]);
const NATIVE_REDUNDANT_NAMESPACE_CHILDREN = new Set(["web_search_exa", "vision_inspect"]);

// Local backends receive every callable tool Codex supplies. Tool names are not
// a compatibility boundary, and a static allowlist silently disabled project
// MCP servers such as trading_support. applyToolPolicy still removes only what
// the selected wire cannot encode: unsupported hosted types, model-specific
// modality conflicts, and provider-declared blocked types.

// A custom/Ollama backend that runs on this machine (loopback base URL).
//
// This is the real signal behind the local instruction compaction and compact
// pre-compression, because both exist for slow local models. Tool availability
// is intentionally independent of this budget decision. The earlier
// context-window proxy (ctx <= 100K) existed only to avoid compacting remote
// endpoints like OpenAI/OpenRouter; the loopback check excludes those directly
// instead of guessing from a token count. A local backend with a large window
// still gets the budget treatment (it is still a local model), and a remote one
// never does, whatever it advertises.
//
// Like its predecessor it does NOT gate the *protocol* adaptation (system
// hoisting, standard tool rewrite, reasoning mapping): that keys off the
// provider alone, because a local server can reject a mid-history system
// item at any advertised window. Conflating the two is what made compact_v2
// fail with "System message must be at the beginning"; see the comment in
// relayCompaction before widening this function's role again.
export function isLocalBackend(config, model) {
  const provider = providerForModel(config, model);
  const profile = profileById(provider);
  // A local engine says so about itself. A custom endpoint cannot: the same
  // provider serves both a laptop and a datacentre, so its address decides.
  if (profile?.local) return true;
  if (provider !== "custom") return false;
  const baseUrl = profile?.baseUrlFor?.(config, model);
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

// Transfer diagnostics deliberately describe structure and byte counts only.
// They never retain prompt text, a data URL, a ref, or a file path. Image wire
// bytes are the encoded URL bytes that actually occupy the Responses payload.
function describeImageTransfer(input) {
  const report = { items: Array.isArray(input) ? input.length : 0, images: 0, imageWireBytes: 0, imageReferences: 0 };
  if (!Array.isArray(input)) return report;
  for (const item of input) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === "input_image") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        report.images += 1;
        if (typeof url === "string") report.imageWireBytes += Buffer.byteLength(url);
      }
      if (part?.type === "input_text" && typeof part.text === "string") {
        report.imageReferences += imageRefsInText(part.text).length;
      }
    }
  }
  return report;
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
const NATIVE_BASE = NATIVE_CODEX_BASE;

// Auxiliary Codex endpoints use the same configured openai_base_url as
// Responses. When that URL points at ModelDock they must follow the same native
// passthrough, otherwise client-owned tools fail locally before reaching
// ChatGPT. The versioned /v1 tree is relayed generically by server.mjs; these
// are only the unversioned legacy spellings older configs may still call.
export const NATIVE_AUXILIARY_PATHS = new Set([
  "/alpha/search",
  "/images/edits",
  "/images/generations",
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
const NATIVE_FORWARD_HEADER_PREFIXES = ["x-codex-", "x-openai-", "x-oai-", "x-responsesapi-"];

function nativeHeaders(incoming, auth = null) {
  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "User-Agent": "modeldock-gateway/0.1",
  };
  for (const [name, value] of Object.entries(incoming || {})) {
    if (!NATIVE_FORWARD_HEADERS.has(name)
        && !NATIVE_FORWARD_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // The standalone web-search client does not copy the model request's auth
  // headers to /alpha/search. Use the same Codex sign-in reader as the other
  // native capabilities, but never replace an explicit client header.
  if (!headers.authorization && auth?.accessToken) headers.authorization = `Bearer ${auth.accessToken}`;
  if (!headers.authorization && auth?.apiKey) headers.authorization = `Bearer ${auth.apiKey}`;
  if (!headers["chatgpt-account-id"] && auth?.accountId) headers["chatgpt-account-id"] = auth.accountId;
  return headers;
}

const NATIVE_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-disposition",
  "content-type",
  "location",
  "retry-after",
]);

// Preserve capability metadata owned by the native endpoint. In particular,
// Codex image generation reads x-codex-imagegen-request-id and future endpoint
// families may add their own x-codex/x-openai response headers. Do not forward
// framing or content-encoding: fetch has already decoded the upstream stream.
function copyNativeResponseHeaders(upstream, res) {
  for (const [name, value] of upstream.headers.entries()) {
    if (!NATIVE_RESPONSE_HEADERS.has(name)
        && !NATIVE_FORWARD_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
        && name !== "x-request-id") continue;
    res.setHeader(name, value);
  }
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

// The fallback for requests that carry no model id. Per session we remember the
// last actual main request so a no-model continuation stays on the model the
// user picked. Before a session has seen one, the current selected main model
// applies (e.g. what ON mode selected); only when there is no routed selection
// does the native config default apply, so a fresh session behaves exactly as
// Codex would without ModelDock.
function nativeFallbackModel(services) {
  const available = Array.isArray(services.nativeSelectableModels)
    ? services.nativeSelectableModels
    : [];
  for (const candidate of [services.visionModel, services.subagentModel, services.mainModel]) {
    if (available.includes(candidate)) return candidate;
  }
  return available[0] || "";
}

// A routed provider can expire between turns. Compaction is the one request that
// must still succeed before Codex can move the task onto another model, so use a
// selectable native model captured from this Codex installation. No native
// model name is compiled into the gateway.
const NATIVE_COMPACTION_FALLBACK_CLASSES = new Set([
  "quota_exhausted",
  "auth_failed",
  "rate_limited",
  "upstream_unavailable",
]);
function mainModelFor(services, sessionId) {
  const sessionModel = services.derivedFallback?.resolve?.(sessionId, "");
  if (sessionModel) return sessionModel;
  const selected = canonicalLlamaLocalKey(String(services.mainModel || services.config?.mainModel || ""));
  // A boot selection can be replayed from a usage event recorded before the
  // stable entry existed (the latest-main-route read replays history, not
  // config). Fold it onto the stable identity here so the fallback route and
  // the catalog row it seeds cannot disagree with what the picker publishes.
  // A routed selection is provider-qualified or a known legacy bare id; native
  // slugs are bare and are published from Codex's captured catalog.
  if (selected && (modelRefParts(selected).qualified || services.knownModels?.has?.(selected))) return selected;
  return nativeFallbackModel(services);
}

function recordDerivedFallback(services, sessionId, route) {
  if (!route || !["client_selected", "default_main", "native_passthrough"].includes(route.reason)) return;
  services.derivedFallback?.record?.(sessionId, route.model);
}

// Threads created under codex-router (or our own pre-rewrite config) persist
// merged-catalog ids of the form "<provider>/<model>". Left alone they would
// look like native GPT slugs and get shipped to the ChatGPT backend, which
// rejects them ("model is not supported when using Codex with a ChatGPT
// account"). Map them onto the slug we actually publish before routing.
export function normalizeLegacySlug(model, knownModels) {
  if (typeof model !== "string") return model;
  const reference = modelRefParts(model);
  let normalized = reference.qualified
    ? reference.provider === NATIVE_PROVIDER_ID
      ? reference.model
      : modelAddressFor(reference.provider, reference.model)
    : model;
  // llama.cpp publishes one stable local entry that replaces whatever name the
  // loaded file has published over time ("Qwen3.8-27B@llamacpp", a GGUF codename
  // like "Src@llamacpp", a raw shard path). A session pinned to an older name
  // means "the llama.cpp server on this machine", and that server is answering;
  // answering it is the wire contract of the stable entry. The alias only fires
  // for a name that is not currently published while the stable one is, so with
  // no local engine connected the request still falls through to the honest
  // 503 configuration error. Bare ids and every other provider pass untouched.
  if (knownModels && isLlamaLocalName(normalized) && !knownModels.has(normalized)) {
    const stable = canonicalLlamaLocalKey(normalized);
    if (knownModels.has(stable)) return stable;
  }
  if (reference.qualified) return normalized;
  const match = normalized.match(/^([a-z0-9][a-z0-9-]*)\/(.+)$/);
  if (!match || !knownModels) return normalized;
  const [, provider, id] = match;
  const qualified = modelAddressFor(provider, id);
  if (knownModels.has(qualified)) return qualified;
  if (knownModels.has(id)) return id;
  return normalized;
}

// A slug we do not serve is native GPT traffic. Empty models (provider defaults
// with no id) stay on the routed path so the dashboard selection still applies.
// Native GPT models are published in the catalog (so the App picker shows
// them), so the captured native slug set is checked first: a published native
// slug must still reach ChatGPT rather than an external upstream.
export function isNativeModel(requestedModel, knownModels, nativeSlugs) {
  if (typeof requestedModel !== "string" || requestedModel.length === 0) return false;
  if (nativeSlugs?.has?.(requestedModel)) return true;
  const reference = modelRefParts(requestedModel);
  if (reference.qualified) return reference.provider === NATIVE_PROVIDER_ID;
  // A slug carrying a provider suffix this gateway owns is addressed to that
  // provider, whether or not it still resolves. "Unknown means native" is right
  // for a bare Codex slug and wrong here: it sent a request for a removed
  // custom endpoint to chatgpt.com, which has never heard of the model.
  return !(knownModels && knownModels.has(requestedModel));
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
// Exported because both decode sites (routed and native) must put the same words on
// a replayed compaction, and a test asserts the boundary they share.
export const SUMMARY_PREFIX =
  "Another language model started this task and produced a continuation summary. Use it to continue without repeating completed work:";
// What the routed leg says when a stored compaction payload cannot be read at all
// (a native Fernet token, which only the OpenAI backend can open). Named so the
// routed decode has one string to point at instead of an inline literal nobody
// greps for.
const UNREADABLE_COMPACTION = "[Earlier conversation history was compacted in an unreadable format.]";
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

// OpenAI-issued reasoning encrypted_content is the stateless continuation for a
// store:false response. A routed provider can emit the same `rs_*` item shape,
// but its empty/plain-text encrypted_content is not native state. Forwarding
// that item makes the native backend interpret its id as a stored OpenAI item
// and fail with "Item ... not found". Only genuine opaque native reasoning is
// replayable across this boundary; routed reasoning is already represented by
// the assistant result and tool history, so drop the foreign reasoning item.
function sanitizeReasoningForNative(item) {
  return isOpaqueEncryptedContent(item?.encrypted_content) ? item : null;
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

const NATIVE_ITEM_ID_PREFIX = new Map([
  ["message", "msg"],
  ["reasoning", "rs"],
  ["function_call", "fc"],
  ["function_call_output", "fco"],
  ["custom_tool_call", "ctc"],
  ["custom_tool_call_output", "ctco"],
  ["agent_message", "amsg"],
]);

function nativeResponsesItemId(item, index) {
  const prefix = NATIVE_ITEM_ID_PREFIX.get(item?.type);
  if (!prefix || typeof item?.id !== "string" || !item.id) return item?.id;
  if (item.id.startsWith(`${prefix}_`)) return item.id;
  // Chat Completions uses one `call_*` value as both its tool-call item id and
  // call id. Native Responses separates them: the item id is `fc_*`/`ctc_*`,
  // while the paired output still points at the unchanged `call_*` call_id.
  // Hashing makes the rewrite deterministic across retries without exposing
  // arguments or output text in the generated identifier.
  const identity = [item.type, item.id, item.call_id || "", index].join("\0");
  return `${prefix}_${createHash("sha256").update(identity).digest("hex").slice(0, 48)}`;
}

// All native input takes this one path: an ordinary turn, a direct native
// compact request, and a routed compact fallback. Routed Chat output can be in
// that history, so normalize native item-id namespaces as well as reasoning and
// ModelDock compaction summaries. `call_id` is deliberately untouched because
// it is the call/output join key. Opaque native compact tokens pass through.
export function normalizeNativeInput(input, { compaction = false } = {}) {
  if (!Array.isArray(input)) return input;
  return input.flatMap((item, index) => {
    if (!item || typeof item !== "object") return item;
    let next;
    if (item.type === "reasoning") {
      next = sanitizeReasoningForNative(item);
      if (!next) return [];
      if (compaction && Array.isArray(next.content) && next.content.length > 0) {
        const { content: _routedReasoningContent, ...withoutContent } = next;
        next = withoutContent;
      }
    } else if (item.type === "compaction") {
      const summary = compactionSummaryText(item);
      next = summary === undefined ? item : {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `${SUMMARY_PREFIX}\n\n${summary}`,
          },
        ],
      };
    } else {
      next = sanitizeMessageContentForNative(item);
    }
    const id = nativeResponsesItemId(next, index);
    if (id !== next.id) {
      next = { ...next, id };
    }
    return [next];
  });
}

function isToolCallItem(item) {
  return item?.type === "function_call" || item?.type === "custom_tool_call";
}

function isToolOutputItem(item) {
  return item?.type === "function_call_output" || item?.type === "custom_tool_call_output";
}

// Text of a delivered tool output, kept out of the log line but needed twice: as
// the promoted user content and for the "was anything readable delivered" test.
function deliveredOutputContent(output) {
  if (typeof output === "string") {
    return output.trim() ? [{ type: "input_text", text: output }] : [];
  }
  if (output == null) return [];
  if (!Array.isArray(output)) {
    let text;
    try {
      text = JSON.stringify(output);
    } catch {
      text = String(output);
    }
    return typeof text === "string" && text.trim() ? [{ type: "input_text", text }] : [];
  }
  const parts = [];
  for (const part of output) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_image" && typeof part.image_url === "string") {
      // The router already reads pixels out of an unpaired tool output, so they
      // must survive the conversion instead of dying with the tool row.
      parts.push({ type: "input_image", image_url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) });
      continue;
    }
    if (typeof part.text === "string" && part.text.trim()) {
      parts.push({ type: "input_text", text: part.text });
    }
  }
  return parts;
}

// One line per delivering tool, never the content. The class is rare, and the
// failure mode it replaces was total silence: a week of eaten heartbeats left no
// trace anywhere. Names and counts only.
const deliveredReportNames = new Set();
const DELIVERED_REPORT_NAME_LIMIT = 16;

function reportDeliveredToolOutput(item, content) {
  const name = typeof item.name === "string" && item.name ? item.name : item.type;
  if (deliveredReportNames.has(name)) return;
  if (deliveredReportNames.size >= DELIVERED_REPORT_NAME_LIMIT) deliveredReportNames.clear();
  deliveredReportNames.add(name);
  const chars = content.reduce((sum, part) => sum + (typeof part.text === "string" ? part.text.length : 0), 0);
  console.error(`[modeldock] delivered ${name} as a call-id-less tool output; its ${chars} chars now reach the model as a user message. Codex wakes (automation heartbeats, cross-thread messages) arrive in this shape.`);
}

// A tool output with no `call_id` at all is not a severed pair - the client never
// expressed a pairing for it. Codex uses exactly this shape to DELIVER content: an
// automation heartbeat and a cross-thread message both arrive as a
// `function_call_output` whose `name` is the delivering tool and whose `call_id` key
// is absent (measured in one real Codex session: 59 such items, 54
// `automation_update`, 5 `send_message_to_thread`). Deleting the item deleted the
// instruction, so the model was handed a history that ended with its own previous
// report and continued it - the "replay without doing the work" symptom, and it hit
// every route that normalizes while the native leg, which forwards the item as-is,
// worked. Keep the text by representing it as the user content it was meant to
// become.
//
// Only the id-less shape is rescued. An output that DOES carry a call id with no
// matching call stays dropped, as before: that is sliced compact history, the
// summary already covers it, and it is the pairing contract strict upstreams
// validate. The conversion depends on the item alone - never on its neighbours or on
// which turn is current - so replaying the same history re-derives the same bytes and
// the upstream prompt prefix stays cache-stable.
//
// This is the input-contract half of a deliberate pair. A Chat transport has a
// second, later rescue for items it cannot encode at all (responsesToChat folds them
// into a labeled turn); that one covers shapes normalization never sees, this one
// fixes the pairing before any provider validates it. Neither is redundant, so do
// not delete either one because the other exists.
function promoteDeliveredToolOutputs(input, callIds) {
  let changed = false;
  const out = [];
  for (const item of input) {
    if (!isToolOutputItem(item) || item.call_id != null || callIds.has(item.call_id)) {
      out.push(item);
      continue;
    }
    const content = deliveredOutputContent(item.output);
    changed = true;
    if (!content.length) continue;
    out.push({ type: "message", role: "user", content });
    reportDeliveredToolOutput(item, content);
  }
  return changed ? out : input;
}

function chatToolCallId(call) {
  if (!call || typeof call !== "object") return undefined;
  const id = call.id ?? call.call_id;
  return typeof id === "string" && id ? id : undefined;
}

// Based on jt-wang's PR #36: reuse after a completed pair is a new invocation,
// not a duplicate stream item. Chat rows are flattened before this pass, so
// there is only one pairing dialect. A duplicate pending call gets no second
// queue entry, and first-seen ids win to keep earlier request prefixes stable.
export function uniquifyReusedToolCallIds(input) {
  if (!Array.isArray(input)) return input;
  const used = new Set();
  const itemIds = new Set();
  const counts = new Map();
  const byOriginal = new Map();
  let changed = false;
  const out = input.map((item) => {
    const original = item?.call_id;
    if ((!isToolCallItem(item) && !isToolOutputItem(item)) || typeof original !== "string" || !original) return item;
    const repeatedItemId = item.id && itemIds.has(item.id);
    if (item.id) itemIds.add(item.id);
    let entry = byOriginal.get(original);
    if (isToolCallItem(item)) {
      // Chat and Responses copies may carry object versus serialized arguments.
      // Compare their meaning without changing the original wire payload.
      let args = item.arguments;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { /* Keep freeform arguments exact. */ }
      }
      const signature = [item.type, item.namespace, item.name, args, item.input];
      if (entry && !entry.closed) {
        if (!isDeepStrictEqual(entry.signature, signature)) throw new Error("Ambiguous tool history: different pending calls share call_id " + original + ".");
      } else {
        let alias = original;
        let n = counts.get(original) || 1;
        while (used.has(alias)) alias = original + "__" + (++n);
        counts.set(original, n);
        used.add(alias);
        entry = { alias, signature, closed: false };
        byOriginal.set(original, entry);
      }
    } else if (entry) {
      entry.closed = true;
    }
    // A leading orphan output is left for the existing pairing pass, not
    // interpreted as a completed invocation that never appeared in the input.
    if (!entry || entry.alias === original) return item;
    changed = true;
    const next = { ...item, call_id: entry.alias };
    if (repeatedItemId) {
      next.id = nativeResponsesItemId({ ...next, id: "reused:" + item.id + ":" + entry.alias }, 0);
    }
    return next;
  });
  return changed ? out : input;
}

// PR #36's Chat-to-Responses boundary, without a second output lookup/pairing
// map. Keep results in place and preserve structured content; only the common
// pairing pass below decides which result belongs to which invocation.
export function flattenChatToolCallsToResponses(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = [];
  for (const item of input) {
    if (item?.type === "message" && item?.role === "tool") {
      changed = true;
      const { type, role, tool_call_id, content, name, ...rest } = item;
      out.push({ ...rest, type: "function_call_output", call_id: tool_call_id, output: item.output ?? content ?? "" });
      continue;
    }
    if (item?.type === "message" && item?.role === "assistant" && Array.isArray(item.tool_calls) && item.tool_calls.length) {
      changed = true;
      const { tool_calls, reasoning_content, reasoning, reasoning_text, ...assistant } = item;
      const thought = chatReasoningText(item);
      if (thought) out.push({ type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: thought }] });
      const hasContent = Array.isArray(item.content) ? item.content.length > 0 : typeof item.content === "string" && item.content.trim() !== "";
      if (hasContent) out.push(assistant);
      for (const call of tool_calls) {
        const id = chatToolCallId(call);
        if (!id) continue;
        out.push({
          type: "function_call",
          call_id: id,
          name: call?.function?.name ?? call?.name,
          arguments: call?.function?.arguments ?? call?.arguments ?? "{}",
          ...(call.namespace ? { namespace: call.namespace } : {}),
        });
      }
      continue;
    }
    out.push(item);
  }
  return changed ? out : input;
}

// Go (Console Go) validates tool pairing strictly and rejects the whole request
// when a tool call has no matching output ("No tool output found for tool call
// ..."). Codex genuinely produces such orphans - a remote compact task slices
// history and can sever a call from its output at the cut. Both dialects Codex
// emits are paired here: the Responses shape (top-level function_call /
// custom_tool_call items with function_call_output / custom_tool_call_output)
// and the chat shape (an assistant message carrying a `tool_calls` array whose
// results are role:"tool" messages with tool_call_id). Normalize the dialect
// and reused identities once, then drop only the unpaired side - except a delivery,
// which has no pairing at all and is rescued as user text (see
// promoteDeliveredToolOutputs). Valid Responses pairs are unchanged; mixed history is
// represented as canonical Responses pairs.
export function dropUnpairedToolItems(input) {
  if (!Array.isArray(input)) return input;
  input = uniquifyReusedToolCallIds(flattenChatToolCallsToResponses(input));
  const callIds = new Set();
  const outputIds = new Set();
  for (const item of input) {
    if (isToolCallItem(item)) callIds.add(item.call_id);
    if (isToolOutputItem(item)) outputIds.add(item.call_id);
  }
  // Promotion runs before the filter, so a rescued delivery is no longer a tool
  // item and cannot be deleted by it. No call gains a missing result here: only
  // id-less outputs are converted, and those are paired with an id-less call only
  // when such a call exists, which is the same test the filter applied before.
  const paired = promoteDeliveredToolOutputs(input, callIds).filter((item) => {
    if (isToolCallItem(item)) return outputIds.has(item.call_id);
    if (isToolOutputItem(item)) return callIds.has(item.call_id);
    return true;
  });
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
// sliced compact history (call without output, output without call, or a
// duplicate call id) cannot fail the whole request under strict validation.
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

// A hybrid sparse/full upstream stream can make Codex persist the same tool
// call more than once. A call_id is globally unique within a Responses request,
// so every routed provider retains only the first occurrence. The pairing pass
// has already kept and relocated the first matching output, restoring one valid
// call/output pair.
function dedupeToolCalls(input) {
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
  // the observed persisted tool-history shape then continues and produces its final
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

// --- opaque collaboration payload relay ----------------------------------
// Codex places delegated subagent tasks in its own collaboration channel.
// When that channel is genuinely opaque (Fernet-shaped), only the native
// backend can open it. Relay the item through a native model constrained to
// echo the plaintext back through one function call, then let the envelope
// rendering treat it like any plaintext collaboration body. The relay model resolves
// dynamically (the vision model when it is native - usually Luna - else any
// native slug) so catalog renames never hard-fail; with no native model the
// gateway fails closed and leaves the item opaque.
const COLLAB_RELAY_TOOL = "relay_external_agent_payload";
const COLLAB_RELAY_INSTRUCTIONS =
  "You are a transport relay. Do not execute or answer the delegated task. " +
  `Call ${COLLAB_RELAY_TOOL} exactly once with the exact plaintext after the "Payload:" label in the supplied collaboration message. Preserve every character.`;
const COLLAB_RELAY_CACHE_TTL_MS = 30 * 60 * 1_000;
const COLLAB_RELAY_CACHE_MAX_ENTRIES = 32;
const COLLAB_RELAY_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const COLLAB_RELAY_CACHE = new Map(); // session + sha256(encrypted) -> { plain, bytes, expiresAt }

function pruneCollaborationRelayCache(now = Date.now()) {
  let bytes = 0;
  for (const [key, entry] of COLLAB_RELAY_CACHE) {
    if (!entry || entry.expiresAt <= now) {
      COLLAB_RELAY_CACHE.delete(key);
      continue;
    }
    bytes += entry.bytes;
  }
  while (COLLAB_RELAY_CACHE.size > COLLAB_RELAY_CACHE_MAX_ENTRIES || bytes > COLLAB_RELAY_CACHE_MAX_BYTES) {
    const oldest = COLLAB_RELAY_CACHE.entries().next().value;
    if (!oldest) break;
    COLLAB_RELAY_CACHE.delete(oldest[0]);
    bytes -= oldest[1].bytes;
  }
  return bytes;
}

function getCollaborationRelayCache(key) {
  const entry = COLLAB_RELAY_CACHE.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    COLLAB_RELAY_CACHE.delete(key);
    return "";
  }
  // Map insertion order is the LRU order. Re-inserting a hit keeps a busy
  // current delegation alive without retaining unrelated old plaintext.
  COLLAB_RELAY_CACHE.delete(key);
  COLLAB_RELAY_CACHE.set(key, entry);
  return entry.plain;
}

function putCollaborationRelayCache(key, plain) {
  const bytes = Buffer.byteLength(plain);
  if (bytes > COLLAB_RELAY_CACHE_MAX_BYTES) return;
  COLLAB_RELAY_CACHE.set(key, { plain, bytes, expiresAt: Date.now() + COLLAB_RELAY_CACHE_TTL_MS });
  pruneCollaborationRelayCache();
}

export function collaborationRelayCacheSnapshot() {
  return {
    entries: COLLAB_RELAY_CACHE.size,
    bytes: pruneCollaborationRelayCache(),
    maxEntries: COLLAB_RELAY_CACHE_MAX_ENTRIES,
    maxBytes: COLLAB_RELAY_CACHE_MAX_BYTES,
    ttlMs: COLLAB_RELAY_CACHE_TTL_MS,
  };
}

function nativeRelayModel(services) {
  // The relay must reach the ChatGPT backend - only it can open the opaque
  // collaboration channel - so the model must be a native bare slug. A routed
  // alias like gpt-5.6-luna@opencode-go is never selected: it is not a member
  // of nativeSlugs, and the fallback below only ever picks from that set.
  // Align with the subagent model resolution: modeldock_subagent's `model` is
  // the user's explicit choice (gpt-5.6-luna with model_provider "openai"
  // reaches the native backend), so it is the preferred relay when native.
  const subagentModel = services.subagentModel;
  if (subagentModel && services.nativeSlugs?.has?.(subagentModel)) return subagentModel;
  // Fall back to the last native slug in catalog order; any native member can
  // open the channel, and the last one is a stable, deterministic pick.
  let fallback = null;
  for (const slug of services.nativeSlugs || []) fallback = slug;
  if (fallback) return fallback;
  return null;
}

function parseRelayToolArguments(sseText) {
  let args = "";
  forEachSseEvent(sseText, (event) => {
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      args += event.delta;
    } else if (event.type === "response.output_item.added" && event.item?.type === "function_call" && typeof event.item.arguments === "string" && event.item.arguments) {
      args += event.item.arguments;
    }
  });
  if (!args) return "";
  try {
    const parsed = JSON.parse(args);
    return typeof parsed?.payload === "string" ? parsed.payload : "";
  } catch {
    return args;
  }
}

export async function relayOpaqueCollaboration(input, services, { signal } = {}) {
  const found = hasOpaqueCollaboration(input);
  if (!found) return input;
  const model = nativeRelayModel(services);
  if (!model) {
    console.error("[modeldock] collaboration payload is opaque but no native model is available; leaving it opaque");
    return input;
  }
  let plain;
  const { sessionId } = sessionIdsFrom(services.incomingHeaders);
  const cacheKey = `${sessionId || "unscoped"}:${createHash("sha256").update(found.encrypted).digest("hex")}`;
  plain = getCollaborationRelayCache(cacheKey);
  if (!plain) {
    const target = nativeTarget("/responses", "");
    const body = {
      model,
      stream: true,
      store: false,
      instructions: COLLAB_RELAY_INSTRUCTIONS,
      input: [found.item],
      tools: [{
        type: "function",
        name: COLLAB_RELAY_TOOL,
        description: "Return the decrypted collaboration payload to the gateway.",
        parameters: { type: "object", properties: { payload: { type: "string" } }, required: ["payload"], additionalProperties: false },
        strict: true,
      }],
      tool_choice: { type: "function", name: COLLAB_RELAY_TOOL },
    };
    const upstream = await fetch(target, {
      method: "POST",
      headers: nativeHeaders(services.incomingHeaders),
      body: JSON.stringify(body),
      signal,
    });
    if (!upstream.ok) throw new Error(`Collaboration relay failed: HTTP ${upstream.status}`);
    plain = parseRelayToolArguments(await upstream.text());
    if (!plain) throw new Error("Collaboration relay returned no payload");
    putCollaborationRelayCache(cacheKey, plain);
  }
  // Replace the opaque part with plaintext so the envelope rendering can carry it.
  return input.map((item) => {
    if (item !== found.item) return item;
    return {
      ...item,
      content: (item.content || []).map((part) => (part === found.part ? { type: "input_text", text: plain } : part)),
    };
  });
}

export function normalizeGatewayInput(input) {
  if (!Array.isArray(input)) return input;
  const rewritten = dedupeToolCalls(dropUnpairedToolItems(input))
    .filter((item) => item?.type !== "compaction_trigger")
    .map((item) => {
      if (item?.type !== "compaction") return item;
      const text = compactionSummaryText(item);
      return {
        [CURRENT_TURN_MARKER]: true,
        type: "message",
        role: "user",
        // The label is not decoration. A compaction payload is text a model wrote,
        // and Codex replays the stored item into every later request, so without it
        // the next model sees its own earlier prose delivered as an unmarked user
        // turn and answers it as if the human had typed it - the "my own reasoning
        // came back at me as the user's message" report. The native leg already said
        // this (see normalizeNativeInput); the routed leg was the one pathway that
        // did not, and one shared owner now covers both.
        content: [{ type: "input_text", text: text ? `${SUMMARY_PREFIX}\n\n${text}` : UNREADABLE_COMPACTION }],
      };
    })
    // Codex's collaboration envelope is an item type no provider dialect has, so it is
    // rendered where it already sits: the body reaches the model as a labeled user turn
    // and the envelope keeps its position, so the request prefix and the owning turn_id
    // are unchanged. Nothing is ever appended here - appending a "task" row is how the
    // deleted promoter ended up overwriting the live instruction with prose recovered
    // from history.
    .map((item) => collaborationEnvelopeTurn(item) ?? item);
  return rewritten;
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

// xAI accepts the standard Responses tool-call items but not Codex's
// custom_tool_call dialect. The catalog must keep apply_patch as "freeform" so
// Codex can load it, therefore this is the wire bridge for the xAI leg only.
// The response path restores custom_tool_call before the item reaches Codex.
export function normalizeXaiInput(input) {
  if (!Array.isArray(input)) return input;
  return normalizeGatewayInput(input).map(normalizeStandardToolItem).map(normalizeXaiReasoningItem);
}

// A reasoning item Codex replays carries `content: null`, and xAI reads a null
// there as a different item shape: it tries to decode the item as a compaction
// blob and answers 400 "Could not decode the compaction blob. Ensure it is
// unmodified from the compact response" - a message about a feature the turn
// never used, on a turn whose only fault is a null where an empty list belongs.
//
// Isolated on 2026-08-21 by replaying a real thirteen-item history from a
// session that died on it, against the live endpoint. As captured: 400. The
// same history with this item's content set to []: 200. With content deleted:
// 200. With Codex's private passthrough field removed but the null kept: 400
// again, so the null is the whole of it.
//
// The encrypted reasoning blob is not touched. Dropping it was considered and
// is wrong twice over: xAI replays its own reasoning statelessly without
// complaint - measured across five replay shapes, all 200 - and DeepSeek's
// thinking routes require reasoning to come back at all. Losing a working chain
// of thought to route around a null would be a bad trade in both directions.
//
// Applied on every turn rather than only where a null appears, so the history
// serialises the same way as turns advance and the upstream prefix cache is not
// invalidated: the same reason rewriteHistoricalImages does not gate on the
// current turn.
function normalizeXaiReasoningItem(item) {
  if (item?.type !== "reasoning" || item.content !== null) return item;
  return { ...item, content: [] };
}

// Codex uses this OpenAI-native flag to grant its own backend web access. xAI
// does not implement it and rejects the whole Responses request when it appears
// either at the payload top level or on a hosted-tool descriptor. Its supported
// web_search/x_search tools are handled by the xAI tool policy instead, so
// remove only this incompatible transport option on the xAI leg. Do not recurse
// into a function's parameters: a user tool can legitimately have a parameter
// with this name.
export function normalizeXaiPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const hasPayloadExternalWebAccess = Object.prototype.hasOwnProperty.call(payload, "external_web_access");
  // Codex asks OpenAI for opaque reasoning blobs through this include option.
  // xAI returns a different blob that Codex cannot decode on replay. Its normal
  // reasoning summary still arrives without the option, so omit it on xAI from
  // the first turn rather than stripping a bad blob only after it is persisted.
  const hasInclude = Object.prototype.hasOwnProperty.call(payload, "include");
  const { external_web_access: _externalWebAccess, include: _include, tools, ...normalized } = payload;
  if (!Array.isArray(tools)) return hasPayloadExternalWebAccess || hasInclude ? normalized : payload;
  let changed = hasPayloadExternalWebAccess || hasInclude;
  const xaiTools = tools.map((tool) => {
    if (!tool || typeof tool !== "object" || !Object.prototype.hasOwnProperty.call(tool, "external_web_access")) return tool;
    changed = true;
    const { external_web_access: _toolExternalWebAccess, ...cleanTool } = tool;
    return cleanTool;
  });
  return changed ? { ...normalized, tools: xaiTools } : payload;
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
function splitLocalSystem(input) {
  const texts = [];
  const rest = [];
  for (const item of input) {
    if (item?.role === "system" || item?.role === "developer") {
      const text = Array.isArray(item.content)
        ? item.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n").trim()
        : "";
      if (text) texts.push(text);
      continue;
    }
    rest.push(item);
  }
  return { texts, rest };
}

export function hoistLocalSystem(input) {
  if (!Array.isArray(input)) return input;
  // Codex sends its system guidance as role "developer"; llama.cpp's
  // template treats both developer and system as leading system messages.
  const { texts, rest } = splitLocalSystem(input);
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
    const { texts, rest } = splitLocalSystem(payload.input);
    const input = normalizeOllamaInput(rest);
    return {
      ...payload,
      instructions: texts.length ? [instructions, ...texts].filter(Boolean).join("\n") : instructions,
      input,
    };
  }
  return { ...payload, input: normalizeLocalInput(payload.input) };
}

const SKILLS_BLOCK_RE = /<skills_instructions>[\s\S]*?<\/skills_instructions>/;
// ModelDock's own base instructions are shortened for small local models. The
// long text-only vision preamble is disproportionate for a small context.
const VERBOSE_VISION_GUIDANCE =
  /Vision guidance \(MANDATORY\): you are a TEXT-ONLY model[\s\S]*?(?:view_image is only for showing the human the file\.|act only on the text finding returned by vision_inspect\.)/g;
const VERBOSE_ACTION_RULE =
  /IMPORTANT: To perform any action[\s\S]*?re-emit the call\./g;
const VERBOSE_RESTART =
  /Restarting the gateway: if you need to restart the ModelDock service[\s\S]*?wait for that line before continuing\./g;
const LOCAL_HOST_SAFETY = "LOCAL HOST RULE: This conversation is generated by its local inference server (llama.cpp, vLLM, SGLang, MLX, Ollama, or similar). Never stop, restart, unload, or reconfigure that server as a separate step: it prevents your next turn. Before GPU maintenance, either move this task to a remote/native model or run one self-contained command that stops it, completes the work, then restarts and verifies it before returning.";

function stripSkillsBlock(text) {
  if (typeof text !== "string") return text;
  const block = text.match(SKILLS_BLOCK_RE)?.[0];
  if (!block) return text;
  const compacted = block
    .split("\n")
    .map((line) => (line.match(/^\s*-\s*([A-Za-z0-9._-]+)\s*:/) ? compressSkillLine(line) : line))
    .join("\n");
  if (compacted === block) return text;
  return text.replace(block, compacted);
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

function stripLocalInstructionText(text) {
  if (typeof text !== "string") return text;
  return stripSkillsBlock(text)
    .replace(VERBOSE_VISION_GUIDANCE, "Vision: you cannot see images; use vision_inspect for any visual task.")
    .replace(VERBOSE_ACTION_RULE, "IMPORTANT: perform any action by emitting a function_call in this turn; never describe an action in text.")
    .replace(VERBOSE_RESTART, (match) => {
      const path = match.match(/"([^"]+\\restart\.ps1)"/)?.[1] || "scripts/restart.ps1";
      return `Restarting ModelDock: run powershell -ExecutionPolicy Bypass -File "${path}" and wait for the "verified gateway handoff" line.`;
    });
}

function mapInstructionText(instructions, transform) {
  if (Array.isArray(instructions)) {
    let changed = false;
    const out = instructions.map((part) => {
      if (!part || typeof part !== "object" || typeof part.text !== "string") return part;
      const text = transform(part.text);
      if (text === part.text) return part;
      changed = true;
      return { ...part, text };
    });
    return changed ? out : instructions;
  }
  return typeof instructions === "string" ? transform(instructions) : instructions;
}

// A text-only picker entry may admit an attachment so the gateway can select a
// vision model for a fresh user turn. That one upstream request contains real
// pixels, so forwarding the picker's TEXT-ONLY instruction is contradictory:
// it tells the selected vision model to ignore the very attachment it received.
// Keep the instruction for ordinary and agentic text-model turns, where images
// are deliberately represented by vision_inspect refs instead.
function stripTextOnlyVisionGuidance(instructions) {
  return mapInstructionText(instructions, (text) => text.replace(VERBOSE_VISION_GUIDANCE, ""));
}

// Remove the dead-weight sections from the payload instructions for
// small-context local backends. Codex sends instructions either as a plain
// string or as an array of input_text parts; both shapes are handled and
// unchanged input is returned as-is so the upstream prefix cache is stable.
export function stripLocalInstructions(instructions) {
  return mapInstructionText(instructions, stripLocalInstructionText);
}

function appendLocalHostSafety(instructions) {
  if (Array.isArray(instructions)) {
    if (instructions.some((part) => String(part?.text || "").includes(LOCAL_HOST_SAFETY))) return instructions;
    return [...instructions, { type: "input_text", text: LOCAL_HOST_SAFETY }];
  }
  if (typeof instructions === "string") {
    return instructions.includes(LOCAL_HOST_SAFETY) ? instructions : `${instructions}\n${LOCAL_HOST_SAFETY}`;
  }
  return LOCAL_HOST_SAFETY;
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
  const interleaved = interleaveToolOutputs(normalized);
  const withToolCallIds = fillProToolCallIds(interleaved);
  const withReasoningContent = normalizeOpenCodeReasoningContent(withToolCallIds);
  const withReasoningIds = fillReasoningIds(withReasoningContent);
  const flattened = flattenAssistantContent(withReasoningIds);
  const continued = appendProToolContinuation(flattened);
  return attachProExecutionGuidance(continued);
}

// Which adaptation a route runs is the profile's to declare, not this file's
// to infer from ids: the model entry (or the profile) names a normalizer, and
// these registries map the name to the code. upstreamTargetFor's comment tells
// the story of retiring the target if-chain the same way - this retires the
// normalization one, so adding a provider no longer means editing the relay
// paths here. The functions themselves still live in this file because they
// share its helpers; the *dispatch* is what the profile owns.
export const INPUT_NORMALIZERS = {
  "opencode-pro": normalizeOpenCodeProInput,
  "opencode-flash": normalizeOpenCodeFlashInput,
  xai: normalizeXaiInput,
};

export const PAYLOAD_NORMALIZERS = {
  xai: normalizeXaiPayload,
};

function inputNormalizerFor(config, model) {
  const profile = profileById(providerForModel(config, model));
  const entry = modelEntryFor(config, model);
  return INPUT_NORMALIZERS[entry?.inputNormalizer || profile?.inputNormalizer] || null;
}

// Applied to the outgoing payload (after the generic passes), everywhere a
// request leaves for the upstream - ordinary relays and the compaction
// summarize call alike. Identity when the profile declares nothing.
function normalizePayloadForRoute(config, model, payload) {
  const profile = profileById(providerForModel(config, model));
  const normalize = PAYLOAD_NORMALIZERS[profile?.payloadNormalizer];
  return normalize ? normalize(payload) : payload;
}

// Keep every routed entry point on the same provider/model-specific input
// contract. Both ordinary responses and remote compaction replay Codex history;
// letting either path fall back to generic normalization reintroduces the same
// strict-upstream failures only when a long task crosses that boundary.
function normalizeInputForRoute(config, model, input, localPayload = null) {
  const normalize = inputNormalizerFor(config, model);
  if (normalize) return normalize(input);
  return localPayload ? localPayload.input : normalizeGatewayInput(input);
}

// Compaction and ordinary relay have different image and response contracts,
// but they start from the same provider-owned input. Resolve opaque native
// collaboration first, then build the local payload from that resolved input;
// the old duplicated paths normalized the original payload first, so a local
// route silently discarded the resolved collaboration history.
async function prepareRoutedInput(payload, services, route, signal) {
  const { config } = services;
  const routedProvider = providerForModel(config, route.model);
  let input = payload.input;
  if (hasOpaqueCollaboration(input)) {
    try {
      input = await relayOpaqueCollaboration(input, services, { signal });
    } catch (error) {
      console.error(`[modeldock] collaboration relay failed: ${error.message}`);
    }
  }
  const resolvedPayload = input === payload.input ? payload : { ...payload, input };
  const localPayload = profileById(routedProvider)?.normalizesPayload
    ? normalizeLocalPayload(resolvedPayload)
    : null;
  return {
    routedProvider,
    localPayload,
    normalizedInput: promoteToolOutputImages(normalizeInputForRoute(
      config,
      route.model,
      input,
      localPayload,
    )),
  };
}

// Replace input_image parts with a lightweight image_ref placeholder only when
// the final upstream cannot see images. Text-only histories remain byte-stable,
// while a vision-capable model keeps every image it may need after tool calls or
// compaction. Without a media store the rewrite degrades to a text placeholder.
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

export const RECENT_IMAGE_WINDOW = 20;

// A compact_v2 item can return only text, so image refs are deliberately part
// of its handoff. A visual model gets the current images plus a small recent
// window; older pixels are loaded only through vision_inspect. This keeps a
// screenshot -> edit -> screenshot comparison direct without replaying every
// old attachment on every turn.
const IMAGE_ATTACHMENT_REF_RE = /\[Image attachment (img_[A-Za-z0-9_-]+)(?::|\.)/g;

function imageRefsInText(text) {
  if (typeof text !== "string") return [];
  IMAGE_ATTACHMENT_REF_RE.lastIndex = 0;
  return [...text.matchAll(IMAGE_ATTACHMENT_REF_RE)].map((match) => match[1]);
}

function unavailableImageHint() {
  return "[An earlier image is unavailable by reference. Ask the user to attach it again before making visual claims.]";
}

// Replace pixels in old history with durable refs. `keepRecentImages` is only
// used by visual routes; omitting it preserves the legacy all-pixels behavior
// for callers outside the gateway while they migrate to the bounded contract.
export function rewriteHistoricalImages(input, mediaStore, {
  preserveImages = false,
  keepRecentImages,
  keepCurrentImages = false,
  currentStartIndex,
  resolveExternalSource,
  sessionId,
  onImageRef,
  batched = false,
} = {}) {
  if (!Array.isArray(input)) return input;
  if (preserveImages && keepRecentImages === undefined) return input;
  if (!batched && typeof mediaStore?.batch === "function") {
    return mediaStore.batch(() => rewriteHistoricalImages(input, mediaStore, {
      preserveImages,
      keepRecentImages,
      keepCurrentImages,
      currentStartIndex,
      resolveExternalSource,
      sessionId,
      onImageRef,
      batched: true,
    }));
  }

  const rawRefs = new Map();
  const occurrences = [];
  const referencedRefs = new Set();
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part?.type === "input_image" && typeof part.image_url === "string") {
        let ref = "";
        try {
          ref = mediaStore?.put(part.image_url, { resolveExternalSource, sessionId }) || "";
        } catch {
          // The replacement below explains that this image cannot be reloaded.
        }
        if (ref) {
          rawRefs.set(part, ref);
          occurrences.push({ ref, index });
          onImageRef?.(ref);
        }
      }
      if (part?.type === "input_text") {
        for (const ref of imageRefsInText(part.text)) {
          referencedRefs.add(ref);
          occurrences.push({ ref, index });
        }
      }
    }
  }
  if (typeof mediaStore?.associateMany === "function") mediaStore.associateMany(referencedRefs, sessionId);
  else for (const ref of referencedRefs) mediaStore?.associate?.(ref, sessionId);

  const currentStart = keepCurrentImages
    ? Number.isInteger(currentStartIndex) ? currentStartIndex : currentTurnStartIndex(input)
    : input.length;
  const lastOccurrence = new Map();
  for (const occurrence of occurrences) {
    if (occurrence.index < currentStart) lastOccurrence.set(occurrence.ref, occurrence.index);
  }
  const recentLimit = Math.max(0, Number(keepRecentImages) || 0);
  const recentEntries = [...lastOccurrence.entries()]
    .sort((left, right) => left[1] - right[1]);
  // `slice(-0)` is `slice(0)`, i.e. the entire history. A strict transport
  // route deliberately passes zero here, so spell out the empty case rather
  // than turning "no historical pixels" into "every historical pixel".
  const recentRefs = new Set(
    (recentLimit > 0 ? recentEntries.slice(-recentLimit) : [])
      .map(([ref]) => ref),
  );
  const shouldKeepPixels = (ref, index) => preserveImages && (index >= currentStart || recentRefs.has(ref));

  let changed = false;
  const rewritten = input.map((item, index) => {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
    let itemChanged = false;
    const content = item.content.map((part) => {
      if (part?.type !== "input_image" || typeof part.image_url !== "string") return part;
      const ref = rawRefs.get(part);
      // A visual route must not lose a current image merely because the local
      // reference cache is unavailable. Production always has MediaStore; this
      // fallback preserves correctness for a degraded/test-only service.
      if ((ref && shouldKeepPixels(ref, index)) || (!ref && preserveImages && index >= currentStart)) return part;
      itemChanged = true;
      return ref
        ? { type: "input_text", text: historicalImageSpawnHint(ref) }
        : { type: "input_text", text: unavailableImageHint() };
    });
    if (!itemChanged) return item;
    changed = true;
    return { ...item, content };
  });

  // Textual references that survived a prior compaction do not have raw image
  // parts. Restore only the same bounded window, never every historical ref.
  const hydrated = preserveImages
    ? hydrateImageRefsForVision(rewritten, mediaStore, { refs: recentRefs })
    : rewritten;
  return changed || hydrated !== rewritten ? hydrated : input;
}

export function hydrateImageRefsForVision(input, mediaStore, { refs = null } = {}) {
  if (!Array.isArray(input) || !mediaStore?.get) return input;
  const hydrated = new Set();
  let changed = false;
  const output = input.map((item) => {
    if (!item || typeof item !== "object" || !Array.isArray(item.content)) return item;
    const imageRefs = new Set();
    for (const part of item.content) {
      if (part?.type !== "input_text" || typeof part.text !== "string") continue;
      for (const ref of imageRefsInText(part.text)) {
        if (!refs || refs.has(ref)) imageRefs.add(ref);
      }
    }
    const images = [];
    for (const ref of imageRefs) {
      if (hydrated.has(ref)) continue;
      let media;
      try {
        media = mediaStore.get(ref);
      } catch {
        continue;
      }
      if (typeof media?.imageUrl !== "string" || !media.imageUrl) continue;
      hydrated.add(ref);
      images.push({ type: "input_image", image_url: media.imageUrl });
    }
    if (!images.length) return item;
    changed = true;
    return { ...item, content: [...item.content, ...images] };
  });
  return changed ? output : input;
}

// Codex media-capable custom tools return an array containing input_text and
// input_image blocks inside custom_tool_call_output.output. Chat Completions
// accepts a textual role:tool result plus visual user content; stringifying the
// original array turns a multi-megabyte image into prompt text and can trip a
// provider's input-length validator before the model sees any pixels. Promote
// those images into an ordinary message so the existing ref, history-window,
// and transport-budget machinery handles them exactly like pasted images.
export function promoteToolOutputImages(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const output = [];
  // Canonical normalization already places each group's results contiguously.
  // Delay promoted messages until that run ends, preserving parallel groups
  // without introducing another call/result matcher.
  let pending = null;
  const flushPromotedImages = () => {
    if (pending) {
      output.push(...pending);
      pending = null;
    }
  };
  for (const item of input) {
    if (!isToolOutputItem(item)) {
      flushPromotedImages();
      output.push(item);
      continue;
    }
    if (!Array.isArray(item.output)) {
      output.push(item);
      continue;
    }
    const images = item.output.filter((part) => part?.type === "input_image" && typeof part.image_url === "string");
    if (!images.length) {
      output.push(item);
      continue;
    }
    const text = item.output.filter((part) => part?.type !== "input_image");
    const callId = item.call_id || item.id || "unknown";
    output.push({
      ...item,
      output: text.length
        ? text
        : [{ type: "input_text", text: `[Visual output from tool call ${callId} moved to the following image message.]` }],
    });
    (pending ||= []).push({
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: `[Visual output returned by tool call ${callId}.]` },
        ...images,
      ],
    });
    changed = true;
  }
  flushPromotedImages();
  return changed ? output : input;
}

export function constrainImagesForTransport(input, mediaStore, {
  maxTotalWireBytes,
  resolveExternalSource,
  sessionId,
} = {}) {
  const totalLimit = Math.floor(Number(maxTotalWireBytes));
  if (!Array.isArray(input) || !Number.isSafeInteger(totalLimit) || totalLimit <= 0) return input;
  const images = [];
  for (const item of input) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === "input_image" && typeof part.image_url === "string") {
        images.push({ part, wireBytes: Buffer.byteLength(part.image_url) });
      }
    }
  }
  if (!images.length) return input;
  if (!mediaStore?.put || !mediaStore?.getTransportVariant) {
    throw new Error("The media store is unavailable for image transport compression");
  }

  // The history policy already changed old pixels into durable refs. This
  // stage has one job: fit the current turn into the provider's total image
  // budget. Keep the newest unique images at the encoder's existing quality
  // floor and spill only the excess images back to their canonical refs. A
  // crowded visual turn must not fail just because equal division falls below
  // the useful per-image floor.
  const refByUrl = new Map();
  for (const image of images) {
    let ref = refByUrl.get(image.part.image_url);
    if (!ref) {
      ref = mediaStore.put(image.part.image_url, { resolveExternalSource, sessionId });
      if (ref) refByUrl.set(image.part.image_url, ref);
    }
    image.ref = ref;
  }
  if (images.some((image) => !image.ref)) {
    throw new Error("An image could not be preserved by reference for transport");
  }

  const newestByRef = new Map();
  for (const image of images) {
    newestByRef.delete(image.ref);
    newestByRef.set(image.ref, image);
  }
  const selected = new Set();
  let reservedBytes = 0;
  for (const image of [...newestByRef.values()].reverse()) {
    const minimumBytes = Math.min(image.wireBytes, MIN_IMAGE_TRANSPORT_WIRE_BYTES);
    if (reservedBytes + minimumBytes > totalLimit) continue;
    selected.add(image.part);
    reservedBytes += minimumBytes;
  }

  const selectedImages = images.filter((image) => selected.has(image.part));
  const fixedBytes = selectedImages
    .filter((image) => image.wireBytes <= MIN_IMAGE_TRANSPORT_WIRE_BYTES)
    .reduce((sum, image) => sum + image.wireBytes, 0);
  const compressible = selectedImages.filter((image) => image.wireBytes > MIN_IMAGE_TRANSPORT_WIRE_BYTES);
  const perImageLimit = compressible.length
    ? Math.floor((totalLimit - fixedBytes) / compressible.length)
    : totalLimit;

  const replacements = new Map();
  for (const image of images) {
    if (!selected.has(image.part)) {
      replacements.set(image.part, { type: "input_text", text: historicalImageSpawnHint(image.ref) });
      continue;
    }
    if (image.wireBytes <= perImageLimit) continue;
    try {
      const variant = mediaStore.getTransportVariant(image.ref, { maxWireBytes: perImageLimit, sessionId });
      if (!variant?.imageUrl) throw new Error("transport variant is unavailable");
      if (variant.imageUrl !== image.part.image_url) {
        replacements.set(image.part, { ...image.part, image_url: variant.imageUrl });
      }
    } catch {
      // The canonical original remains available. Losing one hard-to-compress
      // image from this request is preferable to rejecting the entire turn.
      replacements.set(image.part, { type: "input_text", text: historicalImageSpawnHint(image.ref) });
    }
  }
  if (!replacements.size) return input;
  return input.map((item) => {
    if (!Array.isArray(item?.content)) return item;
    let changed = false;
    const content = item.content.map((part) => {
      const replacement = replacements.get(part);
      if (!replacement) return part;
      changed = true;
      return replacement;
    });
    return changed ? { ...item, content } : item;
  });
}

function imageReferenceHandoff(input, mediaStore, resolveExternalSource, sessionId, knownRefs = null) {
  const refs = new Set(knownRefs || []);
  if (!Array.isArray(input)) return "";
  for (const item of input) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === "input_text") {
        for (const ref of imageRefsInText(part.text)) refs.add(ref);
      }
      if (part?.type === "input_image" && typeof part.image_url === "string") {
        // rewriteHistoricalImages already put every raw image on this compact
        // path. Reusing those refs avoids a second base64 decode and SHA-256
        // pass for the current/recent pixels that remain inline for vision.
        if (knownRefs) continue;
        try {
          const ref = mediaStore?.put(part.image_url, { resolveExternalSource, sessionId });
          if (ref) refs.add(ref);
        } catch {
          // An unreferenceable image cannot be promised in a compaction handoff.
        }
      }
    }
  }
  if (!refs.size) return "";
  return `\n\nVISUAL ATTACHMENTS (retrieve only when needed):\n${[...refs].map(historicalImageSpawnHint).join("\n")}`;
}

function codexAttachmentResolver(attachmentIndex, sessionId, threadId) {
  if (!attachmentIndex) return undefined;
  return (image) => attachmentIndex.resolve(sessionId, image) || attachmentIndex.resolve(threadId, image);
}

// OpenCode Go rejects function tools whose parameters schema is missing or not
// type:"object". Codex MCP children often carry inputSchema instead of parameters.
function normalizeFunctionTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  const parameters = tool.parameters ?? tool.inputSchema;
  const validParameters = parameters && typeof parameters === "object" && parameters.type === "object";
  // Most ordinary Codex descriptors are already valid Responses functions.
  // Preserve that object and its schema rather than deep-copying the entire
  // tool package on every turn; the branches below create a fresh wrapper only
  // when the provider wire truly needs a change.
  if (tool.type === "function" && !Object.hasOwn(tool, "inputSchema") && validParameters) return tool;
  const normalized = validParameters ? parameters : { type: "object", properties: {}, additionalProperties: false };
  const next = { ...tool, type: "function", parameters: normalized };
  delete next.inputSchema;
  return next;
}

// Codex is not consistent about whether a namespace name carries its trailing
// separator: the live desktop CLI declares "mcp__modeldock__" while transcripts
// also carry the bare "mcp__node_repl" spelling for the same server. Joining
// blind would emit "mcp__modeldock____recall_memory" (four separators) for the
// first spelling, which is not a name any model reproduces - they normalize it
// back to the two-separator form and then match nothing. Trim, then join.
const trimNamespaceTail = (value) => String(value).replace(/_+$/, "");
const joinNamespace = (namespace, name) => `${trimNamespaceTail(namespace)}__${name}`;

// xAI function names cannot carry Codex's namespace punctuation. Keep MCP's
// established spelling on other routes, but give the xAI wire a stable,
// reversible-safe name for every namespace Codex declares, not only MCP ones.
const safeFunctionNamePart = (value) => String(value)
  .replace(/[^A-Za-z0-9_-]/g, (character) => `_x${character.codePointAt(0).toString(16)}_`);
const safeNamespaceFunctionName = (namespace, name) => `${safeFunctionNamePart(trimNamespaceTail(namespace))}__${safeFunctionNamePart(name)}`;

// OpenAI-compatible upstreams cap a tool name at 64 characters and answer with a
// request-level 400 when one is longer, which ends the whole turn rather than one
// tool call. Codex's flattened plugin tools (`mcp__<server>__<tool>`) do exceed
// it, so the gate shortens any name that cannot fit and restores the original on
// the way back: the upstream sees a legal name, Codex still resolves the call.
const MAX_TOOL_NAME_LENGTH = 64;
const MCP_TOOL_PREFIX = "mcp__";
// Hash widths tried in order until the shortened name is unique in the request.
const TOOL_NAME_HASH_WIDTHS = [6, 8, 12, 20];

// The names one request carries. `renames` is the wire -> original map the
// response path restores from; `used` is every name already spoken for, so a
// shortened name can never shadow a tool the client also declared.
function toolNameLedger() {
  return { renames: new Map(), used: new Set() };
}

function fitToolName(name, hashWidth) {
  const hash = createHash("sha256").update(name).digest("hex").slice(0, hashWidth);
  const budget = MAX_TOOL_NAME_LENGTH - hash.length - 4; // the two "__" separators
  const head = Math.ceil(budget / 2);
  return `${name.slice(0, head)}__${hash}__${name.slice(name.length - (budget - head))}`;
}

// Ladder, cheapest first: fits as-is (byte-stable, so an existing session's
// prompt cache is untouched) -> drop the redundant `mcp__`, which the remaining
// name still spells out -> keep the head and tail and put a hash of the original
// in the middle. Hashing the full original means two tools that share a prefix
// and a suffix still get different names, and one name always shortens the same
// way on every turn of a session.
function toolNameCandidates(name) {
  const stripped = name.startsWith(MCP_TOOL_PREFIX) ? name.slice(MCP_TOOL_PREFIX.length) : name;
  const fits = stripped.length <= MAX_TOOL_NAME_LENGTH;
  const collapsed = TOOL_NAME_HASH_WIDTHS.map((width) => fitToolName(stripped, width));
  return fits ? [stripped, ...collapsed] : collapsed;
}

function capToolName(name, ledger) {
  if (typeof name !== "string" || !name || name.length <= MAX_TOOL_NAME_LENGTH) return name;
  const taken = (candidate) => ledger?.used?.has(candidate) === true
    && ledger.renames.get(candidate) !== name;
  const candidates = toolNameCandidates(name);
  const candidate = candidates.find((value) => !taken(value)) || candidates[candidates.length - 1];
  ledger?.renames?.set(candidate, name);
  ledger?.used?.add(candidate);
  return candidate;
}

function functionForCustomTool(tool) {
  return normalizeFunctionTool({
    type: "function",
    name: tool.name,
    description: tool.description || `Run the ${tool.name} tool. Put its exact custom-tool input in the input field.`,
    parameters: {
      type: "object",
      properties: {
        input: {
          type: "string",
          description: "Exact input for the original custom tool.",
        },
      },
      required: ["input"],
      additionalProperties: false,
    },
  });
}

// Tool policy: keep standard function/custom tools, flatten MCP namespaces so
// text models see plain functions, and strip hosted schemas plus tools the model
// cannot use. Returns the filtered list and a report of what was removed.
// blockedToolTypes: types this upstream refuses outright. It rejects the whole
// request, not the tool, so one unknown variant costs the entire turn - xAI
// answers 422 "unknown variant `custom`" and the session stops. Codex sends
// apply_patch as a `custom` tool whenever the catalog says freeform, and until
// this was wired the field was declared on every profile and read by nothing.
//
// hostedToolTypes: the hosted tools this upstream actually implements. The
// default is to strip all of them, because most upstreams have none; xAI runs
// its own web_search and x_search, and stripping those threw away a capability
// the subscription pays for.
export function applyToolPolicy(tools, {
  hiddenToolNames = TEXT_MODEL_HIDDEN_TOOLS,
  blockedToolTypes,
  hostedToolTypes,
  customToolsAsFunctions,
  flattenAllNamespaces = false,
  safeNamespaceFunctionNames = false,
} = {}) {
  if (!Array.isArray(tools)) return { tools, stripped: { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0, blockedType: 0 }, namespaces: new Map(), customToolNames: new Set(), toolNames: toolNameLedger() };
  const hidden = new Set(hiddenToolNames || []);
  const blocked = new Set(blockedToolTypes || []);
  const hostedOk = new Set(hostedToolTypes || []);
  const customFunctions = new Set(customToolsAsFunctions || []);
  const stripped = { toolSearch: 0, webSearch: 0, otherHosted: 0, hidden: 0, namespaceChildren: 0, blockedType: 0 };
  // Reverse map for the flattening below: flat wire name -> { name, namespace }.
  // Codex resolves an incoming function_call by (namespace, name), so the
  // response path has to undo the flattening with the exact pair it was built
  // from. Splitting the flat name back apart is not possible: the namespace and
  // the tool name both contain "__" separators of their own.
  const namespaces = new Map();
  const customToolNames = new Set();
  // Ledger for the 64-character cap below, seeded with every name this request
  // declares so a shortened name can never land on a tool that was already there.
  const toolNames = toolNameLedger();
  for (const declared of tools) {
    if (typeof declared?.name === "string") toolNames.used.add(declared.name);
  }
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (
      tool.type === "namespace"
      && typeof tool.name === "string"
      && (flattenAllNamespaces || tool.name.startsWith("mcp__") || tool.name.startsWith("namespace:mcp__"))
    ) {
      const children = Array.isArray(tool.tools) ? tool.tools : [];
      for (const child of children) {
        if (!child?.name) continue;
        const flatName = safeNamespaceFunctionNames
          ? safeNamespaceFunctionName(tool.name, child.name)
          : joinNamespace(tool.name, child.name);
        if (hidden.has(child.name) || hidden.has(flatName)) {
          stripped.hidden += 1;
          continue;
        }
        stripped.namespaceChildren += 1;
        // Keyed by the name the upstream is given, which is the flat name unless
        // the cap shortened it: that is what lets the response path and the
        // replayed history both resolve with one lookup.
        const wireName = capToolName(flatName, toolNames);
        namespaces.set(wireName, { name: child.name, namespace: tool.name });
        out.push(normalizeFunctionTool({ ...child, type: "function", name: wireName }));
      }
      continue;
    }
    if (tool.type === "custom" && typeof tool.name === "string" && customFunctions.has(tool.name)) {
      const wireName = capToolName(tool.name, toolNames);
      out.push(functionForCustomTool({ ...tool, name: wireName }));
      customToolNames.add(wireName);
      continue;
    }
    // Hosted tools are decided first, and keep their own counters. Letting a
    // profile's blocked list swallow them would have moved tool_search and
    // web_search into blockedType for opencode-go, which declares both, and the
    // metrics that report how much hosted tooling is being stripped would have
    // started reading zero without anything changing on the wire.
    if (HOSTED_TOOL_TYPES.has(tool.type)) {
      if (hostedOk.has(tool.type)) {
        out.push(tool);
        continue;
      }
      if (tool.type === "tool_search") stripped.toolSearch += 1;
      else if (tool.type === "web_search") stripped.webSearch += 1;
      else stripped.otherHosted += 1;
      continue;
    }
    // Everything else this upstream refuses. Unlike a hosted tool, which is
    // dropped because we know it will not work, this one is dropped because
    // sending it ends the turn: xAI answers 422 on the whole request.
    if (blocked.has(tool.type)) {
      stripped.blockedType += 1;
      continue;
    }
    if (typeof tool.name === "string" && hidden.has(tool.name)) {
      stripped.hidden += 1;
      continue;
    }
    // The two descriptor types an upstream resolves a call by name for. Codex
    // declares its plugin tools flat rather than as namespace children, so this
    // is where a too-long name actually reaches the wire. Hosted tools keep the
    // name the upstream knows them by, and they are short.
    if (typeof tool.name === "string" && (tool.type === "function" || tool.type === "custom")) {
      const wireName = capToolName(tool.name, toolNames);
      if (wireName !== tool.name) {
        out.push(tool.type === "function"
          ? normalizeFunctionTool({ ...tool, name: wireName })
          : { ...tool, name: wireName });
        continue;
      }
    }
    out.push(tool.type === "function" ? normalizeFunctionTool(tool) : tool);
  }
  return { tools: out, stripped, namespaces, customToolNames, toolNames };
}

function isModelDockNamespace(name) {
  return String(name || "")
    .replace(/^namespace:/, "")
    .replace(/__+$/, "") === "mcp__modeldock";
}

// Preserve the native Codex tool dialect byte-for-byte except for ModelDock's
// redundant Exa and delegated-vision declarations. Current clients may send
// either as flattened functions or ModelDock namespace children;
// additional_tools uses the same descriptors and is filtered below as well.
export function stripNativeRedundantTools(tools) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  const out = [];
  for (const tool of tools) {
    if (NATIVE_REDUNDANT_TOOL_NAMES.has(tool?.name)) {
      changed = true;
      continue;
    }
    if (tool?.type === "namespace" && isModelDockNamespace(tool.name) && Array.isArray(tool.tools)) {
      const children = tool.tools.filter((child) => !NATIVE_REDUNDANT_NAMESPACE_CHILDREN.has(child?.name));
      const namespaceChanged = children.length !== tool.tools.length;
      if (namespaceChanged) changed = true;
      if (!children.length) continue;
      out.push(namespaceChanged ? { ...tool, tools: children } : tool);
      continue;
    }
    out.push(tool);
  }
  return changed ? out : tools;
}

function stripNativeRedundantToolsFromInput(input) {
  if (!Array.isArray(input)) return input;
  let changed = false;
  const out = [];
  for (const item of input) {
    if (item?.type !== "additional_tools" || !Array.isArray(item.tools)) {
      out.push(item);
      continue;
    }
    const tools = stripNativeRedundantTools(item.tools);
    if (tools === item.tools) {
      out.push(item);
      continue;
    }
    changed = true;
    if (tools.length) out.push({ ...item, tools });
  }
  return changed ? out : input;
}

export function hiddenToolNamesForModel({ supportsVision = false, modelHiddenToolNames, profileHiddenToolNames } = {}) {
  const configured = modelHiddenToolNames ?? profileHiddenToolNames;
  const hidden = new Set(configured || (supportsVision ? VISION_MODEL_HIDDEN_TOOLS : TEXT_MODEL_HIDDEN_TOOLS));
  if (supportsVision) {
    hidden.delete("view_image");
    hidden.add("vision_inspect");
    hidden.add("mcp__modeldock__vision_inspect");
  } else {
    hidden.add("view_image");
  }
  return hidden;
}

// Codex splits an MCP tool call across two fields: `name` is the bare tool name
// and `namespace` names the owning server (for example name "js", namespace
// "mcp__node_repl__"). Upstreams that only speak plain OpenAI function tools do
// not have that second field, which is why applyToolPolicy flattens the
// declarations into a single qualified name. Both directions of that rename
// have to happen or the call cannot be resolved at the other end.
//
// Inbound (history replay): collapse the pair back into the flat name the
// upstream was given, so a replayed call matches the tool it declared.
//
// The pair is resolved against the declarations this request actually carried,
// so either namespace spelling lands on the one name the upstream was given.
// A replayed call whose flat name is too long for the upstream is shortened the
// same way its declaration was, and so are the tool descriptors Codex adds
// mid-session as `additional_tools` items - they carry the same names.
export function flattenNamespaceCalls(input, namespaces = null, toolNames = null) {
  if (!Array.isArray(input)) return input;
  const byPair = new Map();
  for (const [flatName, split] of namespaces || []) {
    byPair.set(joinNamespace(split.namespace, split.name), flatName);
  }
  let changed = false;
  const out = input.map((item) => {
    if (item?.type === "function_call" && typeof item.namespace === "string" && item.namespace) {
      changed = true;
      const pair = joinNamespace(item.namespace, item.name);
      const next = { ...item, name: byPair.get(pair) || capToolName(pair, toolNames) };
      delete next.namespace;
      return next;
    }
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const name = capToolName(item.name, toolNames);
      if (name === item.name) return item;
      changed = true;
      return { ...item, name };
    }
    if (item?.type === "additional_tools" && Array.isArray(item.tools)) {
      let toolsChanged = false;
      const declared = item.tools.map((tool) => {
        if (!tool || typeof tool !== "object" || typeof tool.name !== "string") return tool;
        if (tool.type !== "function" && tool.type !== "custom") return tool;
        const name = capToolName(tool.name, toolNames);
        if (name === tool.name) return tool;
        toolsChanged = true;
        return { ...tool, name };
      });
      if (!toolsChanged) return item;
      changed = true;
      return { ...item, tools: declared };
    }
    return item;
  });
  return changed ? out : input;
}

// Outbound (model response): restore the pair. Without this Codex looks the flat
// name up in a registry keyed by (namespace, name), finds nothing, and answers
// the model with a synthetic "unsupported call: <name>" instead of running the
// tool - the failure mode that makes every mcp__* tool look dead in a session
// while the built-in shell keeps working.
export function restoreNamespaceCall(item, namespaces) {
  if (!namespaces?.size || item?.type !== "function_call" || typeof item.name !== "string") return item;
  const split = namespaces.get(item.name);
  if (!split) return item;
  return { ...item, name: split.name, namespace: split.namespace };
}

// Apply restoreNamespaceCall across a response.completed output array.
export function restoreNamespaceOutput(output, namespaces) {
  if (!namespaces?.size || !Array.isArray(output)) return output;
  let changed = false;
  const out = output.map((item) => {
    const next = restoreNamespaceCall(item, namespaces);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : output;
}

// Undo a too-long-name shortening on one response item. A namespaced call is
// already covered - restoreNamespaceCall finds it by the shortened name the map
// is keyed by - so this is the other half: a call to a tool the client declared
// flat, which no namespace map knows about.
export function restoreToolName(item, renames) {
  if (!renames?.size) return item;
  if (item?.type !== "function_call" && item?.type !== "custom_tool_call") return item;
  const original = renames.get(item.name);
  if (original === undefined || original === item.name) return item;
  return { ...item, name: original };
}

// Apply restoreToolName across a response.completed output array.
export function restoreToolNames(output, renames) {
  if (!renames?.size || !Array.isArray(output)) return output;
  let changed = false;
  const out = output.map((item) => {
    const next = restoreToolName(item, renames);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? out : output;
}

function customToolInput(argumentsValue) {
  if (typeof argumentsValue !== "string") return JSON.stringify(argumentsValue ?? "");
  try {
    const parsed = JSON.parse(argumentsValue);
    if (parsed && typeof parsed === "object" && Object.hasOwn(parsed, "input")) {
      return typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input);
    }
  } catch {}
  return argumentsValue;
}

// xAI receives a normal function declaration for Codex's freeform patch tool.
// Put its call back into Codex's custom-tool dialect before it leaves the gate,
// or Codex has no grammar/input payload with which to invoke apply_patch.
export function restoreCustomToolCall(item, customToolNames) {
  if (!customToolNames?.has?.(item?.name) || item?.type !== "function_call") return item;
  const next = { ...item, type: "custom_tool_call", input: customToolInput(item.arguments) };
  delete next.arguments;
  return next;
}

export function restoreCustomToolOutput(output, customToolNames) {
  if (!customToolNames?.size || !Array.isArray(output)) return output;
  let changed = false;
  const restored = output.map((item) => {
    const next = restoreCustomToolCall(item, customToolNames);
    if (next !== item) changed = true;
    return next;
  });
  return changed ? restored : output;
}

// Resolve the upstream for a model. The owning provider decides the base URL and
// token; the wire is always Responses. The @provider suffix is stripped before
// the id reaches the upstream.
// Where a request goes and what credential it carries. The answer belongs to
// the provider, so this asks it. The chain of if (provider === ...) that used
// to live here was a second registry maintained by hand, and llamacpp and
// vllm were missing from it while having perfectly good profiles - so they
// fell through to OpenCode Go carrying the OpenCode token.
export { upstreamTargetFor };

export { RouteAffinity };

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
export async function pipeNormalizedStream(upstreamBody, res, tee, onFirstResponse, namespaces = null, customToolNames = null, renames = null) {
  if (!upstreamBody) {
    res.end();
    return { bytes: 0, rewrote: false, terminal: false, failure: "Response body was empty." };
  }
  let bytes = 0;
  let upstreamBytes = 0;
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
  const decoder = new StringDecoder("utf8");
  const pendingWrites = [];
  const writeOut = (text) => {
    if (text) pendingWrites.push(text);
  };
  const sseEvent = (obj) => `data: ${JSON.stringify(obj)}\r\n\r\n`;
  // Restore the (name, namespace) pair and any custom-tool bridge on every
  // event shape that can carry a function_call. Returns the argument unchanged
  // when there is nothing to rewrite.
  const customItemIds = new Set();
  const customCallIds = new Set();
  const restoreCall = (item) => {
    const namespaced = restoreNamespaceCall(item, namespaces);
    const custom = restoreCustomToolCall(namespaced, customToolNames);
    if (custom !== item) {
      if (custom.type === "custom_tool_call") {
        if (custom.id) customItemIds.add(custom.id);
        if (custom.call_id) customCallIds.add(custom.call_id);
      }
      return restoreToolName(custom, renames);
    }
    return restoreToolName(namespaced, renames);
  };
  const restoreOutput = (output) => {
    if (!Array.isArray(output)) return output;
    let changed = false;
    const restored = output.map((item) => {
      const next = restoreCall(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? restored : output;
  };
  const restoreStreamEvent = (event) => {
    if ((!namespaces?.size && !customToolNames?.size && !renames?.size) || !event || typeof event !== "object") return event;
    if (event.item?.type === "function_call" || event.item?.type === "custom_tool_call") {
      const item = restoreCall(event.item);
      if (item !== event.item) return { ...event, item };
    }
    if (Array.isArray(event.response?.output)) {
      const output = restoreOutput(event.response.output);
      if (output !== event.response.output) return { ...event, response: { ...event.response, output } };
    }
    const customCall = customItemIds.has(event.item_id) || customCallIds.has(event.call_id);
    if (customCall && event.type === "response.function_call_arguments.delta") {
      return { ...event, type: "response.custom_tool_call_input.delta" };
    }
    if (customCall && event.type === "response.function_call_arguments.done") {
      const next = { ...event, type: "response.custom_tool_call_input.done", input: customToolInput(event.arguments) };
      delete next.arguments;
      return next;
    }
    return event;
  };
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
      responseFailure = parsed.response?.error?.message || parsed.error?.message || "Response failed.";
      return parsed;
    }
    if (parsed?.type !== "response.completed") return parsed;
    sawTerminal = true;
    if (outputIsDeliverable(parsed.response?.output)) sawDeliverable = true;
    if (!sawDeliverable) {
      responseFailure = "Response completed without an assistant message or tool call.";
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
      // Carried so the reconstructed done/completed items keep the pair Codex
      // needs to resolve the call; the added event was already restored.
      namespace: typeof item.namespace === "string" ? item.namespace : "",
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
        ? { id: entry.itemId, type: "function_call", status: "completed", name: entry.name, ...(entry.namespace ? { namespace: entry.namespace } : {}), call_id: entry.callId, arguments: entry.text }
        : entry.partType === "reasoning_text"
          ? { id: entry.itemId, type: "reasoning", status: "completed", content: [{ type: "reasoning_text", text: entry.text }] }
          : { id: entry.itemId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: entry.text }] };
      if (!entry.itemDone) {
        writeOut(sseEvent({ id: track.respId, type: "response.output_item.done", item: doneItem, response_id: track.respId }));
      }
    }
    const response = parsed?.response || {};
    const output = Array.from(track.items.values()).map((entry, index) => entry.partType === "function_call"
      ? { id: entry.itemId, type: "function_call", status: "completed", name: entry.name, ...(entry.namespace ? { namespace: entry.namespace } : {}), call_id: entry.callId, arguments: entry.text, output_index: index }
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
      let parsed = parseSseData(line);
      if (parsed === undefined) continue;
      // Undo the tool-declaration flattening before the event reaches Codex.
      // When nothing is rewritten `raw` stays the original bytes, so a stream
      // that carries no namespaced tool call is still forwarded verbatim.
      const restored = restoreStreamEvent(parsed);
      let raw = block + delim;
      if (restored !== parsed) {
        parsed = restored;
        raw = sseEvent(parsed);
      }
      if (normal) {
        if (parsed?.type === "response.output_text.delta" && typeof parsed.delta === "string" && parsed.delta.length > 0) {
          sawDeliverable = true;
        }
        if (parsed?.type === "response.output_item.added" && ["function_call", "custom_tool_call"].includes(parsed.item?.type)) {
          sawDeliverable = true;
        }
        const finished = finishEvent(parsed);
        writeOut(finished === parsed ? raw : sseEvent(finished));
        return;
      }
      if (!sawFirstEvent) {
        const kind = parsed?.type;
        if (kind === "response.created" || kind === "response.in_progress") {
          prelude.push(raw);
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
          writeOut(finished === parsed ? raw : sseEvent(finished));
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
  const processBufferedEvents = async (flushWrites) => {
    while (true) {
      const match = sseBuffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = sseBuffer.slice(0, match.index);
      const delim = match[0];
      sseBuffer = sseBuffer.slice(match.index + delim.length);
      processBlock(block, delim);
      if (!await flushWrites()) return false;
    }
    return true;
  };
  let reader;
  let responseError = null;
  const cancelReader = () => reader?.cancel?.().catch(() => {});
  const onClose = () => {
    if (res.writableFinished) return;
    interrupted = true;
    cancelReader();
  };
  const onError = (error) => {
    responseError = error;
    interrupted = true;
    cancelReader();
  };
  const waitForDrain = () => new Promise((resolve, reject) => {
    if (interrupted || res.destroyed) return resolve(false);
    const finish = (value, error) => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onDrainedClose);
      res.removeListener("error", onDrainedError);
      if (error) reject(error);
      else resolve(value);
    };
    const onDrain = () => finish(true);
    const onDrainedClose = () => finish(false);
    const onDrainedError = (error) => finish(false, error);
    res.once("drain", onDrain);
    res.once("close", onDrainedClose);
    res.once("error", onDrainedError);
  });
  const flushWrites = async () => {
    while (pendingWrites.length && !interrupted) {
      const text = pendingWrites.shift();
      bytes += Buffer.byteLength(text);
      if (!res.write(text) && !await waitForDrain()) return false;
    }
    return !interrupted;
  };
  res.once("close", onClose);
  res.once("error", onError);
  try {
    reader = upstreamBody.getReader();
    let firstResponseMarked = false;
    while (!interrupted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!firstResponseMarked) {
        firstResponseMarked = true;
        onFirstResponse?.();
      }
      tee?.push(value);
      const text = typeof value === "string" ? value : decoder.write(Buffer.from(value));
      upstreamBytes += value.byteLength || Buffer.byteLength(value);
      sseBuffer += text;
      if (!await processBufferedEvents(flushWrites)) break;
    }
    if (responseError) throw responseError;
    if (!interrupted) {
      tee?.end?.();
      sseBuffer += decoder.end();
      await processBufferedEvents(flushWrites);
      flushPrelude();
      if (sseBuffer) writeOut(sseBuffer);
      if (!sawTerminal) {
        responseFailure = "Response stream ended before a terminal event.";
        writeOut(sseEvent(failedCompletion(null, responseFailure)));
        sawTerminal = true;
      }
      await flushWrites();
      if (!interrupted) {
        res.end();
        if (!res.writableFinished) {
          await new Promise((resolve, reject) => {
            res.once("finish", resolve);
            res.once("close", resolve);
            res.once("error", reject);
          });
        }
      }
    }
  } finally {
    res.removeListener("close", onClose);
    res.removeListener("error", onError);
    if (interrupted) cancelReader();
  }
  return { bytes, upstreamBytes, rewrote, interrupted, terminal: sawTerminal, failure: responseFailure, completedResponse };
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
  let upstreamBytes = 0;
  let sawOutput = false;
  let holding = false;
  let tail = "";
  let sseBuffer = "";
  let responseId = "";
  let usage;
  let outStream = null;
  const decoder = new StringDecoder("utf8");
  const writeOut = (text) => {
    bytes += Buffer.byteLength(text);
    if (!res.write(text)) outStream?.pause();
  };
  const processBlock = (block, delim) => {
    let completed = false;
    for (const line of block.split(/\r?\n/)) {
      const parsed = parseSseData(line);
      if (parsed === undefined) continue;
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
    const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
    sseBuffer += text;
    while (true) {
      const match = sseBuffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = sseBuffer.slice(0, match.index);
      const delim = match[0];
      sseBuffer = sseBuffer.slice(match.index + delim.length);
      processBlock(block, delim);
    }
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
      upstreamBytes += chunk.byteLength || Buffer.byteLength(chunk);
    });
    stream.once("end", () => {
      tee?.end?.();
      push(decoder.end());
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
  return { bytes, upstreamBytes, empty: holding && !sawOutput, usage };
}

// Every relay records the same envelope on every outcome - which session, how
// long it took, and through which dispatcher - and differs only in the result.
// Binding the envelope once per relay keeps the nine call sites down to what is
// actually specific to them: the status, and the token counts when the upstream
// reported any.
function usageRecorder(services, { startedAt, sessionId, threadId }) {
  const record = services.recordUsage
    || ((fields) => recordUsageEvent({ ...fields, filePath: services.usageEventsFile }));
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
    imageTransfer: null,
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

// One JSON exit for every relay error body. The statusCode/setHeader/end
// triple was spelled out ~15 times across the three relays - and a bookkeeping
// pattern copied that often is where the next change lands in eight places and
// misses the ninth (noTransform above exists for the same reason). Returns
// false when the response already started, so streaming callers can fall back
// to the in-band failure event.
function sendJsonError(res, status, body) {
  if (res.headersSent) return false;
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
  return true;
}

function imageTransportError(res, route, error) {
  const body = { error: { type: "image_transport_error", message: error.message } };
  sendJsonError(res, 413, body);
  return { ok: false, httpStatus: 413, route, error: body };
}

function unavailableTargetError(route, target) {
  if (/^https?:\/\//i.test(String(target?.url || ""))) return null;
  return {
    error: {
      type: "configuration_error",
      message: `No endpoint is configured for ${route?.model || target?.model || "this model"}. It was removed; restart Codex to drop it from the picker.`,
    },
  };
}

function beginUpstreamStream(res, upstream) {
  if (res.headersSent) return;
  res.statusCode = upstream.status;
  res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.flushHeaders();
}

// How long a connected local engine may stay silent before the client gets one
// SSE comment frame. Sized far below Codex's stream idle timeout: a healthy
// 40k-token cold prefill at 300 t/s takes minutes and emits nothing, and
// "idle timeout waiting for SSE" made that compute look like a dead relay.
// Only local providers use it. Hosted silence stays silence under the watchdog
// ruling - a quiet hosted upstream really is a stalled one.
const LOCAL_STREAM_KEEPALIVE_MS = 15_000;

// The relay threw: one exit shape for the client, the telemetry finisher, and
// the returned result. These used to disagree - the client body was redacted
// while finish?.() and the returned result carried error.message raw, so a
// fetch error echoing an Authorization header would land unredacted in the
// metrics records and ~/.modeldock/usage-events.jsonl.
function relayThrowExit(res, error, { finish, resultFields = {}, target = null } = {}) {
  let message = redactBearer(error.message);
  // A dead local engine must not read as "ModelDock itself failed". The raw
  // "fetch failed" text sent users restarting a gateway that was answering
  // perfectly; name the engine, its address, and the one action that helps.
  // The wording of this diagnosis has one owner (error-translation.mjs) because the
  // sentence, not just the status, is the product here: "fetch failed" told users the
  // gateway had died while the gateway was the only thing still talking to them.
  const profile = target ? profileById(target.provider) : null;
  if (profile?.local && isLocalConnectionFailure(`${message} ${error?.cause?.code || ""}`)) {
    message = localEngineDownMessage({
      label: profile.label,
      address: target.baseUrl || target.url || "the configured address",
      action: "start the engine and press Rescan on the Local Hosts page",
    });
  }
  finish?.({ ok: false, error: message });
  if (!sendJsonError(res, 502, { error: { type: "upstream_failed", message } })) {
    endRelayStreamFailure(res, message);
  }
  return { ok: false, httpStatus: 502, error: message, ...resultFields };
}

// Codex re-sends the whole conversation every turn, so measuring a parsed body
// by JSON.stringify() purely for the dashboard creates a second full copy of
// the largest object in the process. Use counts the transport already knows;
// when a chunked or decompressed body has no trustworthy count, report it as
// unknown instead of allocating the conversation again.
function requestByteCounts(headers, ingress = null) {
  if (Number.isFinite(ingress?.wireBytes)) {
    return {
      wireBytes: ingress.wireBytes,
      logicalBytes: Number.isFinite(ingress.logicalBytes) ? ingress.logicalBytes : null,
    };
  }
  const encoding = String(headers?.["content-encoding"] || "identity").toLowerCase();
  const declared = Number(headers?.["content-length"]);
  if (!Number.isFinite(declared) || declared < 0) return { wireBytes: 0, logicalBytes: null };
  return { wireBytes: declared, logicalBytes: encoding === "identity" ? declared : null };
}

function transferMetrics(transfer, {
  streaming = false,
  routeReason,
  upstreamRequestBytes = 0,
} = {}) {
  return {
    bytesIn: transfer.wireBytes,
    wireBytes: transfer.wireBytes,
    logicalBytes: transfer.logicalBytes,
    upstreamRequestBytes,
    streaming,
    routeReason,
  };
}

// Serialize once and keep the string: it is both what goes on the wire and
// what the transfer card counts. Handing fetch() an object makes it serialize
// internally, so measuring the object separately produced the same bytes
// twice - and on the routed path the two copies had drifted, measuring a
// payload without the upstream model override that the sent one carried.
function serializedBody(value) {
  const body = JSON.stringify(value);
  return { body, bytes: Buffer.byteLength(body) };
}

// Native passthrough for a Responses request. Unlike the routed path there is no
// provider-dialect tool policy, historical-image rewrite, or image escalation:
// the native backend owns hosted tools, history images, and its own vision. The
// capability-dedup pass removes ModelDock Exa and delegated vision because the
// native backend owns those jobs; everything else stays in Codex's dialect.
export async function relayNativeResponses(payload, res, services, { signal } = {}) {
  const { incomingHeaders, requestUrl, metrics, ingressBytes } = services;
  const { sessionId, threadId } = sessionIdsFrom(incomingHeaders);
  const native = { ...payload };
  if (Array.isArray(payload.input)) {
    native.input = stripNativeRedundantToolsFromInput(normalizeNativeInput(payload.input, {
      compaction: isCompactV1Request(requestUrl) || isCompactV2Request(payload),
    }));
  }
  if (Array.isArray(payload.tools)) native.tools = stripNativeRedundantTools(payload.tools);
  delete native.previous_response_id;
  const transfer = requestByteCounts(incomingHeaders, ingressBytes);
  const { body: nativeBody, bytes: upstreamBytes } = serializedBody(native);
  const imageTransfer = {
    received: describeImageTransfer(payload.input),
    forwarded: describeImageTransfer(native.input),
  };
  const { pathname, search } = splitRequestUrl(requestUrl);
  const target = nativeTarget(pathname, search);
  const finish = metrics?.begin?.("responses", {
    operation: "native_passthrough",
    model: payload.model,
    upstream: NATIVE_PROVIDER_ID,
    routeReason: "native_passthrough",
    sessionId,
    threadId,
  });
  const markFirstResponse = () => finish?.markFirstResponse?.();
  const startedAt = Date.now();
  const recordUsage = usageRecorder(services, { startedAt, sessionId, threadId });
  const nativeRoute = { model: payload.model, provider: NATIVE_PROVIDER_ID, route: "native_passthrough" };
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
      body: nativeBody,
      signal,
    });
    if (!upstream.ok) {
      markFirstResponse();
      const raw = await upstream.text();
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.end(raw);
      }
      const clientBytes = Buffer.byteLength(raw);
      finish?.({
        ok: false,
        httpStatus: upstream.status,
        upstream: NATIVE_PROVIDER_ID,
        error: redactBearer(raw).slice(0, 400),
        ingressWireBytes: transfer.wireBytes,
        ingressLogicalBytes: transfer.logicalBytes,
        upstreamRequestBytes: upstreamBytes,
        upstreamResponseBytes: clientBytes,
        clientResponseBytes: clientBytes,
        imageTransfer,
      });
      metrics?.recordResponseUsage?.({ bytesOut: clientBytes, upstreamBytes: clientBytes, usage });
      metrics?.recordResponseTransform?.(noTransform({ imageTransfer }), transferMetrics(transfer, { streaming: false, routeReason: "native_passthrough", upstreamRequestBytes: upstreamBytes }));
      recordUsage({ ...nativeRoute, status: upstream.status });
      return { ok: false, httpStatus: upstream.status, route: { model: payload.model, reason: "native_passthrough" }, error: raw.slice(0, 400), upstreamBytes };
    }

    beginUpstreamStream(res, upstream);
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
      upstream: NATIVE_PROVIDER_ID,
      error: interrupted ? "client disconnected" : responseFailure || undefined,
      bytesOut,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      // Same fields as the relay path so the dashboard's token waveforms
      // (context, cache rate, reasoning) also sample native passthrough calls.
      cachedTokens: usage?.input_tokens_details?.cached_tokens || 0,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens || 0,
      ingressWireBytes: transfer.wireBytes,
      ingressLogicalBytes: transfer.logicalBytes,
      upstreamRequestBytes: upstreamBytes,
      upstreamResponseBytes: piped.bytes,
      clientResponseBytes: bytesOut,
      imageTransfer,
    });
    metrics?.recordResponseUsage?.({ bytesOut, upstreamBytes: piped.bytes, usage });
    metrics?.recordResponseTransform?.(noTransform({ imageTransfer }), transferMetrics(transfer, { streaming: payload.stream !== false, routeReason: "native_passthrough", upstreamRequestBytes: upstreamBytes }));
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
      upstream: NATIVE_PROVIDER_ID,
    };
  } catch (error) {
    return relayThrowExit(res, error, { finish, resultFields: { route: { model: payload.model, reason: "native_passthrough" } } });
  }
}

// Native passthrough for auxiliary endpoints used by client-owned tools such as
// web__run and image_gen. The openai_base_url redirect lands them here, so the
// body and response must cross unchanged; the native backend and the client's
// subscription own their protocol.
export async function relayNativeAuxiliary(payload, res, services, { signal } = {}) {
  const { incomingHeaders, requestUrl } = services;
  const method = String(services.method || "POST").toUpperCase();
  const { pathname, search } = splitRequestUrl(requestUrl);
  const target = nativeTarget(pathname, search);
  const auth = services.codexHome ? readCodexAuth(services.codexHome) : null;
  const canHaveBody = method !== "GET" && method !== "HEAD";
  const body = !canHaveBody || payload === undefined
    ? undefined
    : (typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
  let forwardedBytes = 0;
  try {
    const request = {
      method,
      headers: nativeHeaders(incomingHeaders, auth),
      signal,
    };
    if (body !== undefined) request.body = body;
    const upstream = await fetch(target, request);
    if (!upstream.ok) {
      const raw = await upstream.text();
      if (!res.headersSent) {
        res.statusCode = upstream.status;
        copyNativeResponseHeaders(upstream, res);
        if (!res.getHeader?.("Content-Type")) res.setHeader("Content-Type", "application/json");
        res.end(raw);
      }
      return { ok: false, httpStatus: upstream.status, error: raw.slice(0, 400) };
    }
    if (!res.headersSent) {
      res.statusCode = upstream.status;
      copyNativeResponseHeaders(upstream, res);
      if (!res.getHeader?.("Content-Type")) res.setHeader("Content-Type", "application/json");
      if (!res.getHeader?.("Cache-Control")) res.setHeader("Cache-Control", "no-cache, no-transform");
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
    if (!sendJsonError(res, 502, { error: { type: "upstream_failed", message: redactBearer(error.message) } })) {
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
  let bytes = 0;
  events.forEach(([type, data], sequence) => {
    const event = `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...data })}\n\n`;
    bytes += Buffer.byteLength(event);
    res.write(event);
  });
  const done = "data: [DONE]\n\n";
  bytes += Buffer.byteLength(done);
  res.end(done);
  return bytes;
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
    const responseModel = codexModelRef(payload.model);
    if (payload.stream === false) {
      const body = JSON.stringify(compactionSnapshot(responseModel, compactionItem(summary), null));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(body);
      return Buffer.byteLength(body);
    }
    return writeCompactionSse(res, responseModel, summary);
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
  const { config, metrics, mediaStore, routeAffinity, knownModels, incomingHeaders, attachmentIndex, ingressBytes } = services;
  const { sessionId, threadId } = sessionIdsFrom(incomingHeaders);
  mediaStore?.touchSession?.(sessionId);
  const requestedModel = normalizeLegacySlug(typeof payload.model === "string" ? payload.model : "", knownModels);
  if (requestedModel !== payload.model && requestedModel) payload = { ...payload, model: requestedModel };
  const mainModel = mainModelFor(services, sessionId);
  // A compact is a handoff for the model the user selected, not a new vision
  // escalation. Keeping a selected vision model matters: it can summarize the
  // visual evidence in its own long-running conversation.
  const compactModel = requestedModel && knownModels?.has(requestedModel)
    ? requestedModel
    : mainModel;
  const route = {
    model: compactModel,
    reason: "compact_summarize",
    directVision: false,
  };
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
  const { routedProvider, localPayload, normalizedInput } = await prepareRoutedInput(
    payload,
    services,
    route,
    signal,
  );
  const localBackend = isLocalBackend(config, route.model);
  const compactModelEntry = modelEntryFor(config, route.model);
  const targetSupportsVision = Boolean(compactModelEntry?.supportsVision);
  const imageTransportLimit = Number(compactModelEntry?.imageTransportMaxWireBytes) || 0;
  // A compaction must carry image refs forward, not raw pixels. The selected
  // visual model can still see the 20 newest attachments while it summarizes;
  // every older image survives in the returned text handoff as an img_ref.
  const resolveExternalSource = codexAttachmentResolver(attachmentIndex, sessionId, threadId);
  const compactImageRefs = new Set();
  let summarizeInput = rewriteHistoricalImages(
    normalizedInput,
    mediaStore,
    {
      preserveImages: !localBackend && targetSupportsVision,
      keepRecentImages: !localBackend && targetSupportsVision
        ? imageTransportLimit ? 0 : RECENT_IMAGE_WINDOW
        : 0,
      resolveExternalSource,
      sessionId,
      onImageRef: (ref) => compactImageRefs.add(ref),
    },
  );
  if (imageTransportLimit) {
    try {
      summarizeInput = constrainImagesForTransport(summarizeInput, mediaStore, {
        maxTotalWireBytes: imageTransportLimit,
        resolveExternalSource,
        sessionId,
      });
    } catch (error) {
      return imageTransportError(res, route, error);
    }
  }
  const imageHandoff = imageReferenceHandoff(summarizeInput, mediaStore, resolveExternalSource, sessionId, compactImageRefs);
  const summarizeBody = {
    ...(localPayload || payload),
    model: route.model,
    stream: false,
    tools: [],
    tool_choice: "none",
    input: [
      ...adaptImageUrlShape(
        summarizeInput,
        compactModelEntry?.imageUrlShape,
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
  if (localBackend) {
    const compressed = compressConversation(summarizeInput);
    if (compressed.compressedChars < compressed.originalChars * 0.95) {
      compressionInfo = { fromChars: compressed.originalChars, toChars: compressed.compressedChars };
    }
    directSummary = `${compressed.text}${imageHandoff}`;
  }
  // Small-context local backends do not need the heavy creative skills; drop
  // their entries from the instructions so the summarize call (which replays
  // the full history) carries less dead weight.
  if (localBackend) {
    summarizeBody.instructions = stripLocalInstructions(summarizeBody.instructions);
  }
  delete summarizeBody.previous_response_id;
  delete summarizeBody.client_metadata;
  const upstreamSummarizeBody = normalizePayloadForRoute(config, route.model, summarizeBody);
  const transfer = requestByteCounts(incomingHeaders, ingressBytes);

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
      metrics?.recordResponseUsage?.({ bytesOut, upstreamBytes: 0 });
      metrics?.recordResponseTransform?.(noTransform(), transferMetrics(transfer, { streaming: payload.stream !== false, routeReason: operation }));
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
    // Nothing serves this model any more: the endpoint that did was removed,
    // and Codex still lists it because its catalog is read at startup. Without
    // this the URL is "/responses" with no host and fetch fails as if the
    // network were at fault.
    const gone = unavailableTargetError(route, target);
    if (gone) {
      sendJsonError(res, 503, gone);
      return { ok: false, httpStatus: 503, route, error: gone };
    }
    if (!target.token && target.tokenRequired !== false) {
      const body = JSON.stringify({
        error: {
          type: "configuration_error",
          message: `No API token configured for provider ${target.provider}.`,
        },
      });
      sendJsonError(res, 503, body);
      finish?.({ ok: false, httpStatus: 503, error: `No API token configured for provider ${target.provider}.` });
      recordUsage({ ...compactRoute, status: 503 });
      return { ok: false, httpStatus: 503, route, error: body };
    }
    if (config.debug?.dumpAll && config.debug?.dumpDir) {
      dumpRequestBody(config.debug.dumpDir, { ...summarizeBody, model: upstreamModel });
    }
    const chatSummary = target.transport === "chat"
      ? responsesToChat(upstreamSummarizeBody, {
        toolArgumentsAsObjects: target.toolArgumentsAsObjects,
        mediaMarker: target.mediaMarker,
        cachePrompt: Boolean(target.cachePrompt),
      }).payload
      : null;
    const upstreamRequest = serializedBody({ ...(chatSummary || upstreamSummarizeBody), model: upstreamModel });
    const upstream = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders(target, { incomingHeaders }),
      body: upstreamRequest.body,
      signal,
    });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_COMPACT_RESPONSE_BYTES) {
      const body = JSON.stringify({ error: { type: "upstream_failed", message: "Compact response is too large." } });
      sendJsonError(res, 502, body);
      finish?.({ ok: false, httpStatus: 502, error: "Compact response is too large." });
      recordUsage({ ...compactRoute, status: 502 });
      return { ok: false, httpStatus: 502, route, error: "Compact response is too large." };
    }
    if (!upstream.ok) {
      // Translate before parsing: a non-JSON upstream error (e.g. a proxy's HTML
      // 502) must reach translateUpstreamError and writeCompactFailureReport, not
      // throw out of a JSON.parse into the generic catch below.
      const translated = translateUpstreamError({ provider: target.provider, status: upstream.status, bodyText: redactBearer(bytes.toString("utf8")), free: target.free });
      const fallbackModel = NATIVE_COMPACTION_FALLBACK_CLASSES.has(translated.classification)
        ? nativeFallbackModel(services)
        : "";
      if (fallbackModel) {
        // The selected model remains unchanged. Only this compact request moves
        // to native Luna, once, so an expired routed subscription cannot trap a
        // long task before the user's newly selected native turn can begin.
        finish?.({
          ok: false,
          httpStatus: upstream.status,
          upstream: target.provider,
          error: translated.body.error.message.slice(0, 400),
          requestShape: describeInputShape(payload.input),
          compression: compressionInfo,
          fallbackModel,
        });
        metrics?.recordResponseTransform?.(noTransform(), transferMetrics(transfer, { streaming: false, routeReason: operation, upstreamRequestBytes: upstreamRequest.bytes }));
        recordUsage({ ...compactRoute, status: upstream.status });
        return relayNativeResponses(
          {
            ...payload,
            model: fallbackModel,
          },
          res,
          services,
          { signal },
        );
      }
      writeCompactFailureReport(
        compactFailureReport(
          { ...summarizeBody, model: upstreamModel },
          { status: upstream.status, upstreamError: translated.body.error.message },
        ),
      );
      const body = JSON.stringify(translated.body);
      sendJsonError(res, upstream.status, body);
      finish?.({
        ok: false,
        httpStatus: upstream.status,
        upstream: target.provider,
        error: translated.body.error.message.slice(0, 400),
        requestShape: describeInputShape(payload.input),
        compression: compressionInfo,
      });
      metrics?.recordResponseTransform?.(noTransform(), transferMetrics(transfer, { streaming: false, routeReason: operation, upstreamRequestBytes: upstreamRequest.bytes }));
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
      sendJsonError(res, 502, translated.body);
      finish?.({ ok: false, httpStatus: 502, upstream: target.provider, error: translated.body.error.message.slice(0, 400) });
      recordUsage({ ...compactRoute, status: 502 });
      return { ok: false, httpStatus: 502, route, error: translated.body.error.message.slice(0, 400), upstreamBytes: bytes.length };
    }
    const normalizedSummary = chatSummary ? chatCompletionToResponse(parsed) : parsed;
    usage = extractResponseUsage(normalizedSummary);
    const summary = `${extractResponseText(normalizedSummary)}${imageHandoff}`;
    let clientBytes;
    if (v2) {
      const responseModel = codexModelRef(payload.model);
      if (payload.stream === false) {
        const body = JSON.stringify(compactionSnapshot(responseModel, compactionItem(summary), usage));
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(body);
        clientBytes = Buffer.byteLength(body);
      } else {
        clientBytes = writeCompactionSse(res, responseModel, summary);
      }
    } else {
      const body = JSON.stringify({ output: compactOutput(payload.input, summary) });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(body);
      clientBytes = Buffer.byteLength(body);
    }
    finish?.({
      ok: true,
      httpStatus: 200,
      upstream: target.provider,
      bytesOut: clientBytes,
      upstreamResponseBytes: bytes.length,
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      compression: compressionInfo,
    });
    metrics?.recordResponseUsage?.({ bytesOut: clientBytes, upstreamBytes: bytes.length, usage });
    metrics?.recordResponseTransform?.(noTransform(), transferMetrics(transfer, { streaming: payload.stream !== false, routeReason: operation, upstreamRequestBytes: upstreamRequest.bytes }));
    recordUsage({ ...compactRoute, status: 200, ...usageTokens(usage) });
    return {
      ok: true,
      httpStatus: 200,
      route,
      usage,
      bytesOut: clientBytes,
      latencyMs: Date.now() - startedAt,
      upstream: target.provider,
    };
  } catch (error) {
    return relayThrowExit(res, error, { finish, resultFields: { route }, target });
  }
}

// Relay one Responses request: normalize, route (with image escalation and
// affinity), apply tool policy, choose upstream, forward, pipe, and tee.
// `services` carries { config, metrics, mediaStore, routeAffinity, modelSelection,
// knownModels, visionModelOf } so the caller decides wiring.
export async function relayResponses(payload, res, services, { signal } = {}) {
  const { config, metrics, mediaStore, routeAffinity, knownModels, incomingHeaders, attachmentIndex, ingressBytes } = services;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    const error = {
      error: {
        type: "bad_request",
        message: "Expected a JSON Responses request body.",
      },
    };
    sendJsonError(res, 400, error);
    return { ok: false, httpStatus: 400, route: { model: "", reason: "bad_request" }, error };
  }
  const { sessionId, threadId } = sessionIdsFrom(incomingHeaders);
  mediaStore?.touchSession?.(sessionId);
  const requestedModel = normalizeLegacySlug(typeof payload.model === "string" ? payload.model : "", knownModels);
  if (requestedModel !== payload.model && requestedModel) payload = { ...payload, model: requestedModel };
  if (isNativeModel(requestedModel, knownModels, services.nativeSlugs)) {
    recordDerivedFallback(services, sessionId, { model: requestedModel, reason: "native_passthrough" });
    return relayNativeResponses(payload, res, services, { signal });
  }
  // No speculative guard here. An `@provider` address missing from `knownModels` does
  // not mean its endpoint was removed: the picker Codex holds comes from the persisted
  // catalog file while `knownModels` is rebuilt in memory, so right after a restart -
  // or while a model refresh is failing - the two disagree and the address still
  // resolves perfectly well upstream. Answering 503 there reported a configuration
  // fault that did not exist and told the user to restart Codex, which deleted a
  // working model from their picker. The provider's real absence is caught below by
  // the target lookup, which has evidence for it, and a model that genuinely leaves a
  // provider is already taken out of the picker by the dynamic tidy pass.

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
  const modelSupportsVision = (model) => Boolean(modelEntryFor(config, model)?.supportsVision);
  const route = routeResponsesRequest(payload, {
    mainModel,
    visionModel,
    affinity: routeAffinity,
    mainModelSupportsVision: modelSupportsVision(mainModel),
    modelSupportsVision,
  });
  // Vision=None is an explicit supported setup. Never forward an image to a
  // text-only model, and never serialize an empty model id to an upstream.
  // This also catches an image added mid-tool-loop, where the router correctly
  // avoids a whole-history model swap but no vision service exists to inspect it.
  if (currentTurnHasImage(payload.input) && !modelSupportsVision(route.model) && !visionModel) {
    const error = {
      error: {
        type: "configuration_error",
        message: "This is a text-only model and no vision model is configured. Select a vision-capable model in ModelDock Settings before sending an image.",
      },
    };
    sendJsonError(res, 503, error);
    return { ok: false, httpStatus: 503, route, error };
  }
  recordDerivedFallback(services, sessionId, route);
  // A no-model request can fall back to the current Codex catalog's native
  // default until the session has seen a routed main request. That model must
  // reach ChatGPT like any other native slug, not the external upstream.
  const routedNative = !payload.model
    && isNativeModel(route.model, knownModels, services.nativeSlugs);
  if (routedNative) {
    return relayNativeResponses({ ...payload, model: route.model }, res, services, { signal });
  }

  // OpenCode Go's paid DeepSeek routes both require replayable reasoning_text.
  // Pro additionally needs the id, assistant-content, tool-history and stream
  // repairs; official and custom routes keep the generic path.
  const { routedProvider, localPayload, normalizedInput } = await prepareRoutedInput(
    payload,
    services,
    route,
    signal,
  );
  const routedModelEntry = modelEntryFor(config, route.model);
  const imageTransportLimit = Number(routedModelEntry?.imageTransportMaxWireBytes) || 0;
  const resolveExternalSource = codexAttachmentResolver(attachmentIndex, sessionId, threadId);
  let routedInput = rewriteHistoricalImages(normalizedInput, mediaStore, {
    preserveImages: modelSupportsVision(route.model),
    keepRecentImages: modelSupportsVision(route.model)
      ? imageTransportLimit ? 0 : RECENT_IMAGE_WINDOW
      : 0,
    keepCurrentImages: true,
    currentStartIndex: currentTurnStartIndex(normalizedInput),
    resolveExternalSource,
    sessionId,
  });
  if (imageTransportLimit) {
    try {
      routedInput = constrainImagesForTransport(routedInput, mediaStore, {
        maxTotalWireBytes: imageTransportLimit,
        resolveExternalSource,
        sessionId,
      });
    } catch (error) {
      return imageTransportError(res, route, error);
    }
  }
  let normalizedPayload = {
    ...(localPayload || payload),
    input: adaptImageUrlShape(
      routedInput,
      routedModelEntry?.imageUrlShape,
    ),
    model: route.model,
  };
  // llama.cpp's jinja template accepts only xhigh/medium/low and
  // raises on "high" (Codex's default). Keep valid efforts, map "high" to the
  // closest accepted value, and drop anything else so local routes never trip
  // the template validator.
  if (profileById(routedProvider)?.normalizesPayload) {
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
  normalizedPayload = normalizePayloadForRoute(config, route.model, normalizedPayload);
  const target = upstreamTargetFor(config, normalizedPayload.model);

  const transfer = requestByteCounts(incomingHeaders, ingressBytes);
  const imageTransfer = {
    received: describeImageTransfer(payload.input),
    forwarded: describeImageTransfer(normalizedPayload.input),
  };

  // Local backends keep the complete callable tool surface. They still receive
  // a compacted instruction envelope and the protocol/modality denylist below.
  const localBackend = isLocalBackend(config, route.model);
  const routedProfile = profileById(routedProvider) || {};
  // A mixed provider can expose models backed by different downstream APIs.
  // Let a measured model narrow its tool dialect without weakening the other
  // models on the same provider. Undefined fields inherit the provider policy.
  const modelToolPolicy = routedModelEntry || {};
  const { tools, stripped, namespaces, customToolNames, toolNames } = applyToolPolicy(normalizedPayload.tools, {
    // What this upstream refuses, and what it runs itself. Both are the
    // profile's to declare: the gate cannot know from the model id that xAI
    // rejects `custom` and serves its own web_search.
    hiddenToolNames: hiddenToolNamesForModel({
      supportsVision: modelSupportsVision(route.model),
      modelHiddenToolNames: modelToolPolicy.hiddenToolNames,
      profileHiddenToolNames: routedProfile.hiddenToolNames,
    }),
    blockedToolTypes: modelToolPolicy.blockedToolTypes ?? routedProfile.blockedToolTypes,
    hostedToolTypes: modelToolPolicy.hostedToolTypes ?? routedProfile.hostedToolTypes,
    customToolsAsFunctions: modelToolPolicy.customToolsAsFunctions ?? routedProfile.customToolsAsFunctions,
    // Chat Completions has no namespace descriptor. A Go profile can mix
    // Responses and Chat models, so this follows the chosen model's target,
    // never a provider-wide transport flag.
    flattenAllNamespaces: (modelToolPolicy.flattenAllNamespaces ?? routedProfile.flattenAllNamespaces) || target.transport === "chat",
    safeNamespaceFunctionNames: modelToolPolicy.safeNamespaceFunctionNames ?? routedProfile.safeNamespaceFunctionNames,
  });
  if (tools !== normalizedPayload.tools) normalizedPayload.tools = tools;
  // The declarations above were flattened; the replayed history has to use the
  // same flat names or the upstream sees calls for tools it was never given.
  // Same for the 64-character cap: a replayed call for a tool whose declaration
  // was shortened has to carry the shortened name, or it names a tool the
  // upstream was never given.
  normalizedPayload.input = flattenNamespaceCalls(normalizedPayload.input, namespaces, toolNames);
  // Compress repeated prose without removing the instructions that govern the
  // tools now visible to the local model.
  if (localBackend) {
    normalizedPayload.instructions = appendLocalHostSafety(stripLocalInstructions(normalizedPayload.instructions));
  }
  if (route.reason === "current_turn_image" && route.directVision) {
    normalizedPayload.instructions = stripTextOnlyVisionGuidance(normalizedPayload.instructions);
  }
  // applyToolPolicy can preserve hosted tool descriptors verbatim. Normalize
  // again after that policy so Codex's web_search { external_web_access: true }
  // option never reaches xAI on the final wire.
  normalizedPayload = normalizePayloadForRoute(config, route.model, normalizedPayload);
  // Tool policy and namespace flattening change declarations/history, not image
  // parts. The image report above remains the exact before/after visual payload.
  const transformReport = () => noTransform({
    blocked: { tool_search: stripped.toolSearch, web_search: stripped.webSearch },
    directVision: route.directVision,
    imageTransfer,
  });

  // The upstream sees the bare model id; the route model (possibly owner-suffixed)
  // stays in the response and affinity so provider resolution keeps working on
  // continuation requests.
  const upstreamModel = target.model;
  if (config.debug?.dumpAll && config.debug?.dumpDir) {
    dumpRequestBody(config.debug.dumpDir, { ...normalizedPayload, model: upstreamModel });
  }
  // Nothing serves this model any more: the endpoint that did was removed,
  // and Codex still lists it because its catalog is read at startup. Without
  // this the URL is "/responses" with no host and fetch fails as if the
  // network were at fault.
  const gone = unavailableTargetError(route, target);
  if (gone) {
    sendJsonError(res, 503, gone);
    return { ok: false, httpStatus: 503, route, error: gone };
  }
  if (!target.token && target.tokenRequired !== false) {
    const error = {
      error: {
        type: "configuration_error",
        message: `No API token configured for provider ${target.provider}.`,
      },
    };
    sendJsonError(res, 503, error);
    metrics?.recordResponseTransform?.(transformReport(), transferMetrics(transfer, { streaming: false, routeReason: route.reason }));
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
  const startedAt = Date.now();
  let firstResponseLatencyMs = 0;
  const markFirstResponse = () => {
    if (!firstResponseLatencyMs) firstResponseLatencyMs = Math.max(0, Date.now() - startedAt);
    finish?.markFirstResponse?.();
  };
  const recordUsage = usageRecorder(services, { startedAt, sessionId, threadId });
  const relayRoute = { model: normalizedPayload.model, provider: target.provider, route: route.reason };
  let usage;
  let bytesOut = 0;
  let upstreamResponseBytes = 0;
  let completedResponse;
  let llamaTimings;
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
      responseFailure = event.response?.error?.message || event.error?.message || "Response failed.";
    }
  });

  const relayPayload = normalizedPayload;
  // One attempt per request. The managed runtime used to wrap this call in a slot
  // lease that pinned id_slot and annotated the KV tier the request rode in on; with
  // no slot management there is nothing to lease, so llama.cpp's own scheduler picks
  // the slot and the engine's own prefix cache is the only cache in play.
  const executeRelay = async ({ signal: requestSignal = signal } = {}) => {
    // llama.cpp's Responses compatibility endpoint cannot reuse a restored KV
    // slot for Qwen hybrid contexts. Its Chat endpoint can, while retaining the
    // engine-owned template and function-call parser. This is selected by the
    // local profile only; every other provider keeps the exact Responses wire.
    const chatBridge = target.transport === "chat"
      ? responsesToChat(normalizedPayload, {
        toolArgumentsAsObjects: target.toolArgumentsAsObjects,
        mediaMarker: target.mediaMarker,
        cachePrompt: Boolean(target.cachePrompt),
      })
      : null;
    // An item this transport cannot represent is folded into the transcript rather
    // than ending the turn, but the fold must leave a trace: without this the one
    // thing that was wrong about a request is exactly what nobody could see.
    if (chatBridge?.degraded?.length) {
      finish?.annotate?.({ chatBridgeFolded: chatBridge.degraded.slice(0, 12) });
      console.error(`[modeldock] chat bridge folded ${chatBridge.degraded.length} item(s) this transport cannot encode for ${upstreamModel}: ${chatBridge.degraded.slice(0, 3).join(", ")}`);
    }
    const localChatPayload = chatBridge ? chatBridge.payload : null;
    const localCustomToolNames = chatBridge
      ? new Set([...customToolNames, ...chatBridge.customToolNames])
      : customToolNames;
    // Undo the two name rewrites in the order their declarations were made: the
    // namespace pair and the custom-tool bridge are keyed by the shortened name,
    // so the flat rename goes last.
    const restoreChatCall = (item) => restoreToolName(
      restoreCustomToolCall(
        restoreNamespaceCall(item, namespaces),
        localCustomToolNames,
      ),
      toolNames.renames,
    );
    let localStreamKeepAlive = null;
    try {
    const routed = serializedBody({ ...(localChatPayload || normalizedPayload), model: upstreamModel });
    const upstreamBytes = routed.bytes;
    const upstreamController = new AbortController();
    const upstreamSignal = requestSignal
      ? AbortSignal.any([requestSignal, upstreamController.signal])
      : upstreamController.signal;
    const upstream = await fetch(target.url, {
      method: "POST",
      headers: upstreamHeaders(target, { incomingHeaders }),
      body: routed.body,
      signal: upstreamSignal,
    });
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
      sendJsonError(res, upstream.status, body);
      finish?.({
        ok: false,
        httpStatus: upstream.status,
        upstream: target.provider,
        error: translated.body.error.message.slice(0, 400),
        requestShape: describeInputShape(normalizedPayload.input),
        ingressWireBytes: transfer.wireBytes,
        ingressLogicalBytes: transfer.logicalBytes,
        upstreamRequestBytes: upstreamBytes,
      });
      metrics?.recordResponseTransform?.(transformReport(), transferMetrics(transfer, { streaming: false, routeReason: route.reason, upstreamRequestBytes: upstreamBytes }));
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
        sendJsonError(res, errorStatus, errorBody);
        finish?.({
          ok: false,
          httpStatus: errorStatus,
          upstream: target.provider,
          error: translated.body.error.message.slice(0, 400),
          requestShape: describeInputShape(normalizedPayload.input),
          ingressWireBytes: transfer.wireBytes,
          ingressLogicalBytes: transfer.logicalBytes,
          upstreamRequestBytes: upstreamBytes,
        });
        metrics?.recordResponseTransform?.(transformReport(), transferMetrics(transfer, { streaming: false, routeReason: route.reason, upstreamRequestBytes: upstreamBytes }));
        return { ok: false, httpStatus: errorStatus, route, error: translated.body.error.message.slice(0, 400), upstreamBytes };
      }
      // Real non-stream free response: rebuild the body as a web stream so the
      // shared pipe below handles framing, usage and affinity unchanged.
      upstreamBody = Readable.toWeb(Readable.from([Buffer.from(raw)]));
    }

    beginUpstreamStream(res, upstream);
    // Local silence is honest compute (cold prefill of a full Codex prompt),
    // not a stall: reset the client's byte-level idle timer with comment
    // frames while the engine is quiet. Attached after beginUpstreamStream so
    // the first keepalive can never flush the headers before the upstream's
    // real status and content type are set.
    if (normalizedPayload.stream === true && profileById(target.provider)?.local) {
      // Injectable interval for tests, same convention as the lease watchdog.
      const keepAliveMs = Number(services.localStreamKeepAliveMs) > 0
        ? Number(services.localStreamKeepAliveMs)
        : LOCAL_STREAM_KEEPALIVE_MS;
      localStreamKeepAlive = attachSseKeepAlive(res, keepAliveMs);
    }
    if (chatBridge) {
      if (normalizedPayload.stream === true) {
        const piped = await pipeChatCompletionStream(upstreamBody, res, {
          onEvent: (event) => tee.push(Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`)),
          onFirstResponse: markFirstResponse,
          restoreCall: restoreChatCall,
          signal: requestSignal,
          completeOnFinishReason: target.provider === "llamacpp",
          onTerminal: () => upstreamController.abort(),
        });
        tee.end();
        bytesOut = piped.bytes;
        upstreamResponseBytes = piped.upstreamBytes || piped.bytes;
        if (piped.completedResponse) completedResponse = piped.completedResponse;
        llamaTimings = piped.llamaTimings;
        if (piped.failure) responseFailure = piped.failure;
        interrupted = piped.interrupted && !responseCompleted;
      } else {
        const raw = await upstream.text();
        upstreamResponseBytes = Buffer.byteLength(raw);
        let chatCompletion;
        try {
          chatCompletion = JSON.parse(raw);
        } catch {
          throw new Error("Local Chat upstream returned invalid JSON.");
        }
        const response = chatCompletionToResponse(chatCompletion, { restoreCall: restoreChatCall });
        llamaTimings = normalizeLlamaServerTimings(chatCompletion.timings);
        const body = JSON.stringify(response);
        completedResponse = response;
        tee.push(Buffer.from(body));
        tee.end();
        bytesOut = Buffer.byteLength(body);
        markFirstResponse();
        res.end(body);
      }
    } else if (target.free && normalizedPayload.stream === true) {
      const result = await pipeFreeStream(upstreamBody, res, tee, freeEmptyError?.body.error.message, markFirstResponse);
      bytesOut = result.bytes;
      upstreamResponseBytes = result.upstreamBytes || result.bytes;
      freeEmpty = result.empty;
      if (result.usage) usage = result.usage;
    } else {
      // Codex points openai_base_url at this gate, so every picker model
      // (Go, Official, Z.AI, Kimi, custom) arrives here. The pipe inspects the
      // SSE shape: a sparse/bare tool stream is re-framed; a full Responses
      // lifecycle passes through event-for-event. Do not key this on provider.
      if (normalizedPayload.stream !== true && (customToolNames.size || namespaces.size || toolNames.renames.size)) {
        const raw = await upstream.text();
        upstreamResponseBytes = Buffer.byteLength(raw);
        try {
          const parsed = JSON.parse(raw);
          const restoredNamespaces = restoreNamespaceOutput(parsed?.output, namespaces);
          const restoredCustom = restoreCustomToolOutput(restoredNamespaces, customToolNames);
          const restored = restoreToolNames(restoredCustom, toolNames.renames);
          if (restored !== parsed?.output) {
            upstreamBody = Readable.toWeb(Readable.from([Buffer.from(JSON.stringify({ ...parsed, output: restored }))]));
          } else {
            upstreamBody = Readable.toWeb(Readable.from([Buffer.from(raw)]));
          }
        } catch {
          upstreamBody = Readable.toWeb(Readable.from([Buffer.from(raw)]));
        }
      }
      const piped = normalizedPayload.stream === true
        ? await pipeNormalizedStream(upstreamBody, res, tee, markFirstResponse, namespaces, customToolNames, toolNames.renames)
        : await pipeGatewayStream(upstreamBody, res, tee, markFirstResponse);
      bytesOut = piped.bytes;
      upstreamResponseBytes ||= piped.upstreamBytes || piped.bytes;
      if (piped.completedResponse) completedResponse = piped.completedResponse;
      if (piped.failure) responseFailure = piped.failure;
      interrupted = piped.interrupted && !responseCompleted;
    }
    localStreamKeepAlive?.();
    localStreamKeepAlive = null;
    markFirstResponse();
    if (completedResponse && routeAffinity && (!chatBridge || completedResponse.status === "completed")) {
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
        ingressWireBytes: transfer.wireBytes,
        ingressLogicalBytes: transfer.logicalBytes,
        upstreamRequestBytes: upstreamBytes,
        upstreamResponseBytes,
        clientResponseBytes: bytesOut,
        imageTransfer,
      });
      metrics?.recordResponseTransform?.(transformReport(), transferMetrics(transfer, { streaming: true, routeReason: route.reason, upstreamRequestBytes: upstreamBytes }));
      metrics?.recordResponseUsage?.({ bytesOut, upstreamBytes: upstreamResponseBytes, usage: traceUsage });
      recordUsage({ ...relayRoute, status: 429, ...usageTokens(traceUsage) });
      return { ok: false, httpStatus: 429, route, error: errorMessage.slice(0, 400), usage: traceUsage, bytesOut, upstreamBytes, latencyMs: Date.now() - startedAt, upstream: target.provider };
    }
    // inputTokens/outputTokens ride on the trace record: the dashboard's
    // context-token waveform plots recent[].inputTokens per completed call.
    const semanticFailed = Boolean(responseFailure);
    // A cancellation that *we* started - a reclaimed lease or a gateway restart -
    // stops the pipe on the abort and leaves the response open, so the caller
    // waits forever for an event that will never arrive. That is the state that
    // looks like "ModelDock turned itself off and nothing was returned": the
    // gateway had finished with the turn, Codex had not. End it with the terminal
    // event the client understands, and report the reason instead of pretending
    // the caller left. A caller that really did go away has a closed response and
    // is left alone.
    const hostCancelled = interrupted && !res.writableEnded && !res.destroyed;
    const cancelReason = hostCancelled
      ? (requestSignal?.reason?.message || "Local model request was cancelled by ModelDock.")
      : "";
    // Dispatch on the negotiated content type: a streaming turn must end with a
    // response.failed event, a JSON turn cannot carry SSE framing at all.
    if (hostCancelled) endRelayFailure(res, cancelReason, bytesOut > 0);
    finish?.({
      ok: !interrupted && !semanticFailed,
      httpStatus: interrupted ? (hostCancelled ? 503 : 499) : upstream.status,
      upstream: target.provider,
      error: interrupted ? (hostCancelled ? cancelReason : "client disconnected") : responseFailure || undefined,
      bytesOut,
      inputTokens: traceUsage?.input_tokens || 0,
      outputTokens: traceUsage?.output_tokens || 0,
      // Both upstreams report prompt-cache hits and reasoning spend in the
      // standard details objects (verified live on go and deepseek-official);
      // the dashboard's cache-rate wave reads these off the trace records.
      cachedTokens: traceUsage?.input_tokens_details?.cached_tokens || 0,
      reasoningTokens: traceUsage?.output_tokens_details?.reasoning_tokens || 0,
      ingressWireBytes: transfer.wireBytes,
      ingressLogicalBytes: transfer.logicalBytes,
      upstreamRequestBytes: upstreamBytes,
      upstreamResponseBytes,
      clientResponseBytes: bytesOut,
      imageTransfer,
      ...(llamaTimings ? { llamaTimings } : {}),
    });
    metrics?.recordResponseTransform?.(transformReport(), transferMetrics(transfer, { streaming: true, routeReason: route.reason, upstreamRequestBytes: upstreamBytes }));
    metrics?.recordResponseUsage?.({ bytesOut, upstreamBytes: upstreamResponseBytes, usage: traceUsage });
    // Injectable so unit tests do not append to the real ~/.modeldock file.
    recordUsage({
      ...relayRoute,
      status: interrupted ? (hostCancelled ? 503 : 499) : semanticFailed ? "error" : upstream.status,
      ...usageTokens(traceUsage),
    });
    return {
      ok: !interrupted && !semanticFailed,
      httpStatus: interrupted ? (hostCancelled ? 503 : 499) : upstream.status,
      route,
      error: responseFailure || undefined,
      usage: traceUsage,
      bytesOut,
      upstreamBytes,
      firstResponseLatencyMs,
      latencyMs: Date.now() - startedAt,
      upstream: target.provider,
      llamaTimings,
    };
    } catch (error) {
      localStreamKeepAlive?.();
      return relayThrowExit(res, error, { finish, resultFields: { route }, target });
    }
  };
  try {
    return await executeRelay();
  } catch (error) {
    return relayThrowExit(res, error, { finish, resultFields: { route }, target });
  }
}

// Controlled acceptance probe for a live local llama.cpp host.
//
// It deliberately combines the LocalHostScheduler skeleton with a complete
// captured Codex request on the first stream. The original request shape,
// input history, tools, and options are preserved; only the selected routed
// model and a bounded output limit are changed. Set
// MODELDOCK_LOCAL_PROBE_REASONING_EFFORT only to run a separate deliberate
// reasoning-budget experiment. Output content is never logged.
//
// Usage:
//   node scripts/local-host-live-probe.mjs --confirm
//
// The probe refuses an already-processing slot. It sends one bounded streamed
// request, queues and cancels a second before any network request, then sends
// one small non-stream request. It does not restart, reconfigure, erase, or
// expose the engine.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalHostScheduler } from "../src/local-host-scheduler.mjs";

const args = new Set(process.argv.slice(2));
if (!args.has("--confirm")) {
  throw new Error("Refusing to use a live local host without --confirm.");
}

const llamaBase = String(process.env.MODELDOCK_LOCAL_PROBE_LLAMA_BASE || "http://127.0.0.1:11435").replace(/\/+$/, "");
const gatewayBase = String(process.env.MODELDOCK_LOCAL_PROBE_GATEWAY_BASE || "http://127.0.0.1:4097").replace(/\/+$/, "");
const requestedTargetModel = String(process.env.MODELDOCK_LOCAL_PROBE_MODEL || "").trim();
const requestedReasoningEffort = String(process.env.MODELDOCK_LOCAL_PROBE_REASONING_EFFORT || "").trim();
const requestedMaxOutputTokens = Number(process.env.MODELDOCK_LOCAL_PROBE_MAX_OUTPUT_TOKENS || 256);
const disableThinking = process.env.MODELDOCK_LOCAL_PROBE_DISABLE_THINKING === "1";
const dumpDirectory = process.env.MODELDOCK_DUMP_DIR || "D:/modeldock-dumps";
const callerKeyPath = process.env.MODELDOCK_CALLER_KEY_FILE || path.join(os.homedir(), ".modeldock", "caller-key");
const catalogPath = process.env.MODELDOCK_LOCAL_PROBE_CATALOG_FILE || path.join(os.homedir(), ".modeldock", "codex-model-catalog.json");
const reportPath = String(process.env.MODELDOCK_LOCAL_PROBE_REPORT || "").trim();

function requireText(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function boundedOutputTokens(value) {
  if (!Number.isSafeInteger(value) || value < 16 || value > 4096) {
    throw new Error("MODELDOCK_LOCAL_PROBE_MAX_OUTPUT_TOKENS must be an integer from 16 through 4096.");
  }
  return value;
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  return response.json();
}

async function latestCapture(directory) {
  const { readdir, stat } = await import("node:fs/promises");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  if (!names.length) throw new Error(`No captured Codex request is available in ${directory}.`);
  const dated = await Promise.all(names.map(async (name) => ({ name, modified: (await stat(path.join(directory, name))).mtimeMs })));
  const file = path.join(directory, dated.sort((left, right) => right.modified - left.modified)[0].name);
  const capture = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(capture?.input) || !Array.isArray(capture?.tools)) {
    throw new Error("Latest capture is not a complete Codex Responses package.");
  }
  return { file, capture };
}

async function publishedLocalModel(file, requested) {
  if (requested) return { slug: requested, catalogContextTokens: null };
  const catalog = JSON.parse(await readFile(file, "utf8"));
  const local = (catalog?.models || []).filter((model) => String(model?.slug || "").endsWith("@llamacpp"));
  if (local.length !== 1) {
    throw new Error(`Expected exactly one published llama.cpp model, found ${local.length}; set MODELDOCK_LOCAL_PROBE_MODEL explicitly.`);
  }
  return { slug: local[0].slug, catalogContextTokens: Number(local[0].context_window) || null };
}

async function readSse(response) {
  if (!response.body) throw new Error("Stream response had no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let events = 0;
  let bytes = 0;
  let buffer = "";
  let currentEvent = "message";
  const eventTypes = {};
  let doneMarker = false;
  let failureMessage = "";
  const consume = (line) => {
    if (line.startsWith("event:")) {
      currentEvent = line.slice("event:".length).trim() || "message";
    } else if (line.startsWith("data:")) {
      events += 1;
      const data = line.slice("data:".length).trim();
      if (data === "[DONE]") {
        doneMarker = true;
        eventTypes.done = (eventTypes.done || 0) + 1;
        return;
      }
      let dataType = currentEvent;
      try {
        const parsed = JSON.parse(data);
        dataType = String(parsed?.type || currentEvent);
        if (dataType === "response.failed") {
          failureMessage = String(parsed?.response?.error?.message || parsed?.error?.message || "response.failed").slice(0, 240);
        }
      } catch {
        // The count still proves a byte-level event without retaining content.
      }
      eventTypes[dataType] = (eventTypes[dataType] || 0) + 1;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    lines.forEach(consume);
  }
  if (buffer) consume(buffer);
  if (eventTypes["response.failed"]) throw new Error(`Stream ended with response.failed: ${failureMessage || "no error message"}`);
  if (!eventTypes["response.completed"] && !doneMarker) throw new Error("Stream ended without a completion event or DONE marker.");
  return { events, bytes, eventTypes, terminal: eventTypes["response.completed"] ? "response.completed" : "done_marker" };
}

async function postGateway({ key, payload, label, transmitted }) {
  transmitted.push(label);
  const started = Date.now();
  const response = await fetch(`${gatewayBase}/c/${encodeURIComponent(key)}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} received HTTP ${response.status}: ${body.slice(0, 240)}`);
  }
  if (payload.stream === false) {
    const body = await response.json();
    if (body?.error) throw new Error(`${label} returned an error response.`);
    return { label, stream: false, elapsedMs: Date.now() - started, outputItems: Array.isArray(body?.output) ? body.output.length : 0 };
  }
  const stream = await readSse(response);
  if (!stream.events) throw new Error(`${label} returned no SSE events.`);
  return { label, stream: true, elapsedMs: Date.now() - started, ...stream };
}

const [health, props, slots, captureInfo, callerKey, publishedModel] = await Promise.all([
  json(`${llamaBase}/health`),
  json(`${llamaBase}/props`),
  json(`${llamaBase}/slots`),
  latestCapture(dumpDirectory),
  readFile(callerKeyPath, "utf8"),
  publishedLocalModel(catalogPath, requestedTargetModel),
]);
if (health?.status !== "ok") throw new Error("Local llama health check did not report ok.");
if (!Array.isArray(slots) || slots.some((slot) => slot?.is_processing)) {
  throw new Error("Refusing to probe while a local llama slot is processing.");
}
const key = requireText(callerKey, "ModelDock caller key");
const totalSlots = Number(props?.total_slots);
if (!Number.isSafeInteger(totalSlots) || totalSlots < 1) throw new Error("Local llama server reported no usable slots.");
const targetModel = publishedModel.slug;
const maxOutputTokens = boundedOutputTokens(requestedMaxOutputTokens);

const fullCapture = {
  ...captureInfo.capture,
  model: targetModel,
  stream: true,
  max_output_tokens: maxOutputTokens,
  ...(requestedReasoningEffort
    ? { reasoning: { ...(captureInfo.capture.reasoning || {}), effort: requestedReasoningEffort } }
    : {}),
  ...(disableThinking
    ? { chat_template_kwargs: { ...(captureInfo.capture.chat_template_kwargs || {}), enable_thinking: false } }
    : {}),
};
const smallRequest = {
  model: targetModel,
  stream: false,
  max_output_tokens: 16,
  instructions: "Reply with exactly LOCAL_PROBE_OK. Do not call tools.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Return the required marker." }] }],
  tools: [],
};

// This verifies the conservative Focus policy independently of the server's
// configured ceiling. Wider calibrated profiles are a later test, never an
// assumption made by this probe.
const scheduler = new LocalHostScheduler({ hostId: "live-llamacpp", maxActiveRequests: 1 });
const transmitted = [];
const first = scheduler.enqueue({
  principalId: "local-probe",
  conversationId: "full-capture-stream",
  run: () => postGateway({ key, payload: fullCapture, label: "full-capture-stream", transmitted }),
});
const firstOutcome = first.then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, error }),
);
while (!transmitted.includes("full-capture-stream")) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const cancelled = new AbortController();
const cancelledRequest = scheduler.enqueue({
  principalId: "local-probe",
  conversationId: "cancelled-before-admission",
  signal: cancelled.signal,
  run: () => postGateway({ key, payload: smallRequest, label: "cancelled-before-admission", transmitted }),
});
cancelled.abort();
const second = scheduler.enqueue({
  principalId: "local-probe",
  conversationId: "non-stream-after-drain",
  run: () => postGateway({ key, payload: smallRequest, label: "non-stream-after-drain", transmitted }),
});
const secondOutcome = second.then(
  (value) => ({ ok: true, value }),
  (error) => ({ ok: false, error }),
);

const cancelledResult = await cancelledRequest.then(
  () => ({ cancelled: false }),
  (error) => ({ cancelled: error?.name === "AbortError" }),
);
if (!cancelledResult.cancelled) throw new Error("Waiting request did not cancel with AbortError.");
const [firstResult, secondResult] = await Promise.all([firstOutcome, secondOutcome]);
if (!firstResult.ok) throw firstResult.error;
if (!secondResult.ok) throw secondResult.error;
if (transmitted.includes("cancelled-before-admission")) throw new Error("Cancelled request reached the gateway.");
const finalSlots = await json(`${llamaBase}/slots`);
if (!Array.isArray(finalSlots) || finalSlots.some((slot) => slot?.is_processing)) {
  throw new Error("Local llama still reports an active slot after the probe.");
}

const report = {
  verdict: "passed",
  host: {
    liveContextTokens: props?.default_generation_settings?.params?.n_ctx,
    catalogContextTokens: publishedModel.catalogContextTokens,
    catalogDoesNotOverstateLiveContext: publishedModel.catalogContextTokens === null
      ? null
      : publishedModel.catalogContextTokens <= props?.default_generation_settings?.params?.n_ctx,
    configuredSlots: totalSlots,
    initialCachedPromptTokens: slots.map((slot) => Number(slot?.n_prompt_tokens || 0)),
    finalCachedPromptTokens: finalSlots.map((slot) => Number(slot?.n_prompt_tokens || 0)),
  },
  fullCapture: {
    file: path.basename(captureInfo.file),
    inputItems: fullCapture.input.length,
    tools: fullCapture.tools.length,
    maxOutputTokens: fullCapture.max_output_tokens,
    reasoningEffort: fullCapture.reasoning?.effort || null,
    thinkingDisabled: disableThinking,
  },
  scheduler: {
    capacity: 1,
    cancelledBeforeTransmission: true,
    transmittedOrder: transmitted,
    final: scheduler.snapshot(),
  },
  results: [firstResult.value, secondResult.value],
};
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) await writeFile(reportPath, serializedReport, "utf8");
console.log(serializedReport);

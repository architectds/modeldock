function inputItems(input) {
  if (typeof input === "string") return [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }];
  return Array.isArray(input) ? input : [];
}

// The end of the previous assistant turn. In the Responses history an assistant
// turn is NOT always a role:"assistant" message - an agentic turn is frequently
// just a function_call / reasoning item with no text. If we only look for
// role:"assistant", a tool-driven turn leaves lastMarker at -1 and the "current
// turn" swallows the entire history, so a stale image (or a stale tool call) from
// many turns ago keeps re-triggering vision routing on every request.
export function isAssistantMarker(item) {
  if (!item || typeof item !== "object") return false;
  if (item.role === "assistant") return true;
  return item.type === "function_call"
    || item.type === "custom_tool_call"
    || item.type === "reasoning";
}

function currentTurnItems(input) {
  const items = inputItems(input);
  let lastMarker = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (isAssistantMarker(items[index])) lastMarker = index;
  }
  return items.slice(lastMarker + 1);
}

function parts(item) {
  return Array.isArray(item?.content) ? item.content : [];
}

function hasImage(items) {
  return items.some((item) => parts(item).some((part) => part?.type === "input_image" && typeof part.image_url === "string"));
}

function continuationCallIds(items) {
  return items
    .filter((item) => item?.type === "function_call_output" || item?.type === "custom_tool_call_output")
    .map((item) => item.call_id)
    .filter((callId) => typeof callId === "string" && callId.length > 0);
}

export class RouteAffinity {
  constructor({ ttlMs = 15 * 60_000 } = {}) {
    this.ttlMs = ttlMs;
    this.calls = new Map();
  }

  register(callId, model) {
    if (!callId || !model) return;
    this.calls.set(callId, { model, expiresAt: Date.now() + this.ttlMs });
  }

  registerResponse(response, model) {
    for (const item of response?.output || []) {
      if ((item?.type === "function_call" || item?.type === "custom_tool_call") && item.call_id) {
        this.register(item.call_id, model);
      }
    }
  }

  consumeFrom(items) {
    const now = Date.now();
    for (const [callId, entry] of this.calls) {
      if (entry.expiresAt <= now) this.calls.delete(callId);
    }
    for (const callId of continuationCallIds(items)) {
      const entry = this.calls.get(callId);
      if (!entry) continue;
      this.calls.delete(callId);
      return { callId, model: entry.model };
    }
    return null;
  }

  snapshot() {
    return { activeCallIds: this.calls.size, ttlMs: this.ttlMs };
  }
}

export function routeResponsesRequest(source, { mainModel, visionModel, affinity, knownModels, mainModelSupportsVision = false }) {
  const current = currentTurnItems(source?.input);
  const requested = source?.model;
  const pinned = affinity?.consumeFrom(current);
  // An explicit, known client model reclaims the wheel from a stale cross-model
  // pin. Without this, one visual turn routed to the vision model (e.g. Luna) pins
  // that model, and every following tool continuation cascades onto it - never
  // returning to the model the user actually selected. When the client sends the
  // same model or no known model, the pin still holds, so a single model's own
  // multi-step tool loop stays coherent.
  const clientOverridesPin = pinned && requested && requested !== pinned.model && knownModels?.has(requested);
  if (pinned && !clientOverridesPin) {
    // A continuation carries no new image, so directVision here only matters when a
    // vision-capable main model is itself the pinned model (its own multi-step loop
    // still hands it the image bytes rather than a rewritten ref).
    const directVision = pinned.model === visionModel
      || (mainModelSupportsVision && pinned.model === mainModel);
    return { model: pinned.model, reason: "tool_continuation", directVision, pinnedCallId: pinned.callId };
  }
  if (source?.model === visionModel && source?.model !== mainModel) {
    return { model: visionModel, reason: "vision_model_requested", directVision: true };
  }
  if (hasImage(current)) {
    if (mainModelSupportsVision) {
      return { model: mainModel, reason: "current_turn_image", directVision: true };
    }
    return { model: visionModel, reason: "current_turn_image", directVision: true };
  }
  // Codex's own model picker is populated from the catalog this gate publishes, so a
  // model id we recognise is a deliberate choice by the user in that picker - honour it
  // and let the caller sync the dashboard to match. Anything unrecognised (a stale id, a
  // provider default) falls back to the dashboard selection rather than being forwarded
  // to an upstream that would reject it.
  if (requested && requested !== mainModel && knownModels?.has(requested)) {
    return { model: requested, reason: "client_selected", directVision: false };
  }
  return { model: mainModel, reason: "default_main", directVision: false };
}

export const routerInternals = { currentTurnItems, hasImage, continuationCallIds };

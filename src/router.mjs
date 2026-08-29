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
    || item.type === "reasoning"
    // Compact replaces the assistant/tool loop with a checkpoint item. Codex
    // then keeps older user messages (screenshots included) in the replayed
    // history. If compaction is not a boundary, lastMarker stays -1 and those
    // leftover images look like the current turn forever.
    || item.type === "compaction"
    || item[CURRENT_TURN_MARKER] === true;
}

// Internal only: gateway normalization turns compaction into a user message
// for providers that cannot read Codex's private compaction item. Retain the
// turn boundary without serializing a provider-visible field.
export const CURRENT_TURN_MARKER = Symbol("modeldock.currentTurnMarker");

function codexTurnId(item) {
  const value = item?.internal_chat_message_metadata_passthrough?.turn_id;
  return typeof value === "string" && value ? value : "";
}

export function currentTurnStartIndex(input) {
  const items = inputItems(input);
  // Current Codex items already carry the owning turn. Prefer that durable
  // boundary over reconstructing a turn from assistant/tool markers: an
  // interrupted turn can end on a tool image with no final assistant message,
  // and the next user turn must not inherit those pixels as current. Older
  // clients and hand-authored API requests still use the marker fallback.
  const currentTurnId = items.findLast(codexTurnId)
    ?.internal_chat_message_metadata_passthrough?.turn_id;
  if (currentTurnId) {
    const firstCurrent = items.findIndex((item) => codexTurnId(item) === currentTurnId);
    if (firstCurrent >= 0) return firstCurrent;
  }
  let lastMarker = -1;
  for (let index = 0; index < items.length; index += 1) {
    if (isAssistantMarker(items[index])) lastMarker = index;
  }
  return lastMarker + 1;
}

function currentTurnItems(input) {
  const items = inputItems(input);
  return items.slice(currentTurnStartIndex(items));
}

function parts(item) {
  if (Array.isArray(item?.content)) return item.content;
  // Codex media tools keep image parts inside the tool output until the
  // gateway has paired and ordered that output. The router must still see the
  // image before gateway normalization; promoting it earlier would detach the
  // pixels when the paired output is relocated beside its call.
  if ((item?.type === "function_call_output" || item?.type === "custom_tool_call_output") && Array.isArray(item.output)) {
    return item.output;
  }
  return [];
}

function hasImage(items) {
  return items.some((item) => parts(item).some((part) => part?.type === "input_image" && typeof part.image_url === "string"));
}

export function currentTurnHasImage(input) {
  return hasImage(currentTurnItems(input));
}

// An agentic Responses payload already has tool/reasoning items. Escalating that
// whole history onto the vision model is not how "see" works: pasted-image chat
// can swap models, but a coding loop must stay on the text model and inspect
// via vision_inspect. Presence of agent items is the test, not payload length.
const AGENTIC_ITEM_TYPES = new Set([
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "reasoning",
]);

function isAgenticHistory(input) {
  return inputItems(input).some((item) => AGENTIC_ITEM_TYPES.has(item?.type));
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

export function routeResponsesRequest(source, { mainModel, visionModel, affinity, knownModels, mainModelSupportsVision = false, modelSupportsVision } = {}) {
  const current = currentTurnItems(source?.input);
  const requested = source?.model;
  const supportsVision = (model) => {
    if (typeof modelSupportsVision === "function") return Boolean(modelSupportsVision(model));
    return model === visionModel || (mainModelSupportsVision && model === mainModel);
  };
  const requestedKnown = Boolean(requested && knownModels?.has(requested));
  const pinned = affinity?.consumeFrom(current);
  // An explicit, known client model reclaims the wheel from a stale cross-model
  // pin. Without this, one visual turn routed to the vision model (e.g. Luna) pins
  // that model, and every following tool continuation cascades onto it - never
  // returning to the model the user actually selected. When the client sends the
  // same model or no known model, the pin still holds, so a single model's own
  // multi-step tool loop stays coherent.
  const clientOverridesPin = pinned && requestedKnown && requested !== pinned.model;
  if (pinned && !clientOverridesPin) {
    const directVision = supportsVision(pinned.model);
    return { model: pinned.model, reason: "tool_continuation", directVision, pinnedCallId: pinned.callId };
  }
  if (source?.model === visionModel && source?.model !== mainModel) {
    return { model: visionModel, reason: "vision_model_requested", directVision: true };
  }
  if (hasImage(current) && !isAgenticHistory(source?.input)) {
    // A picker selection wins when it can read the attached image. A text-only
    // selection still escalates to the configured vision model below.
    if (requestedKnown && supportsVision(requested)) {
      return { model: requested, reason: "current_turn_image", directVision: true };
    }
    if (mainModelSupportsVision) {
      return { model: mainModel, reason: "current_turn_image", directVision: true };
    }
    if (!visionModel) {
      return { model: mainModel, reason: "vision_unavailable", directVision: false };
    }
    return { model: visionModel, reason: "current_turn_image", directVision: true };
  }
  // Codex's own model picker is populated from the catalog this gate publishes, so a
  // model id we recognise is a deliberate choice by the user in that picker - honour it
  // and let the caller sync the dashboard to match. Anything unrecognised (a stale id, a
  // provider default) falls back to the dashboard selection rather than being forwarded
  // to an upstream that would reject it.
  if (requestedKnown && requested !== mainModel) {
    return { model: requested, reason: "client_selected", directVision: false };
  }
  return { model: mainModel, reason: "default_main", directVision: false };
}


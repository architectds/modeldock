// Pure hot/SSD/cold residency planning for a fixed local-host lane profile.
//
// The planner never starts an engine, saves a file, or restores a slot. It
// leases one numbered lane and returns the required adapter actions. The
// caller performs them transactionally with the existing KV state store, then
// commits or abandons the lease after the model response ends.

import { LOCAL_HOST_MAX_LANES } from "./local-host-profile.mjs";

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function timestamp(value, label) {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return result;
}

function sessionKey(value) {
  const key = text(value, "A local host session key");
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new TypeError("A local host session key must be a SHA-256 digest.");
  return key.toLowerCase();
}

function compareLeastRecent(a, b) {
  const time = Date.parse(a.lastAccessedAt) - Date.parse(b.lastAccessedAt);
  return time || a.slot - b.slot;
}

function normalizeLane(value, slot, fingerprint) {
  const state = value?.state || "empty";
  if (!["empty", "hot", "active"].includes(state)) throw new TypeError("A local host lane state must be empty, hot, or active.");
  if (value?.slot !== undefined && value.slot !== slot) throw new TypeError("Local host lanes must be stored in slot order.");
  if (state === "empty") return Object.freeze({ slot, state, sessionKey: "", fingerprint: "", lastAccessedAt: "" });
  return Object.freeze({
    slot,
    state,
    sessionKey: sessionKey(value?.sessionKey),
    fingerprint: text(value?.fingerprint, "A local host lane fingerprint"),
    lastAccessedAt: timestamp(value?.lastAccessedAt, "A local host lane access timestamp"),
  });
}

function normalizeLanes(laneCount, lanes, fingerprint) {
  if (!Array.isArray(lanes)) throw new TypeError("Local host residency lanes must be an array.");
  if (lanes.length > laneCount) throw new TypeError("Local host residency cannot contain more lanes than its profile.");
  const normalized = [];
  for (let slot = 0; slot < laneCount; slot += 1) normalized.push(normalizeLane(lanes[slot], slot, fingerprint));
  return normalized;
}

function freezeResidency(value) {
  return Object.freeze({ ...value, lanes: Object.freeze(value.lanes.map((lane) => Object.freeze({ ...lane }))) });
}

export function createLocalHostResidency({ laneCount, fingerprint = "", lanes = [] } = {}) {
  const count = positiveInteger(laneCount, "A local host lane count");
  if (count > LOCAL_HOST_MAX_LANES) throw new TypeError(`A local host supports at most ${LOCAL_HOST_MAX_LANES} GPU lanes.`);
  const normalizedFingerprint = fingerprint ? text(fingerprint, "A local host fingerprint") : "";
  const normalizedLanes = normalizeLanes(count, lanes, normalizedFingerprint);
  if (normalizedLanes.some((lane) => lane.state !== "empty" && lane.fingerprint !== normalizedFingerprint)) {
    throw new TypeError("Every non-empty local host lane must match the residency fingerprint.");
  }
  return freezeResidency({
    version: 1,
    laneCount: count,
    fingerprint: normalizedFingerprint,
    lanes: normalizedLanes,
  });
}

function withLane(residency, slot, next) {
  return createLocalHostResidency({
    ...residency,
    lanes: residency.lanes.map((lane) => (lane.slot === slot ? next : lane)),
  });
}

function emptyLane(slot) {
  return { slot, state: "empty", sessionKey: "", fingerprint: "", lastAccessedAt: "" };
}

function activeLane(slot, key, fingerprint, at) {
  return { slot, state: "active", sessionKey: key, fingerprint, lastAccessedAt: at };
}

function hotLane(slot, key, fingerprint, at) {
  return { slot, state: "hot", sessionKey: key, fingerprint, lastAccessedAt: at };
}

function action(type, details = {}) {
  return Object.freeze({ type, ...details });
}

function resetForFingerprint(residency, fingerprint) {
  if (residency.fingerprint === fingerprint) return { residency, actions: [] };
  if (!residency.fingerprint) {
    return {
      residency: createLocalHostResidency({ laneCount: residency.laneCount, fingerprint, lanes: residency.lanes }),
      actions: [],
    };
  }
  if (residency.lanes.some((lane) => lane.state === "active")) {
    throw new Error("Cannot change a local host fingerprint while a lane is active.");
  }
  return {
    residency: createLocalHostResidency({ laneCount: residency.laneCount, fingerprint }),
    actions: [action("invalidate_ssd", { fingerprint }), ...residency.lanes.filter((lane) => lane.state === "hot").map((lane) => action("erase_slot", { slot: lane.slot }))],
  };
}

// `hasSsdState` comes from the durable KV manifest. The planner does not read
// it itself, which keeps all disk IO and state size accounting in the store.
export function leaseLocalHostResidency(residency, {
  sessionKey: requestedSessionKey,
  fingerprint,
  hasSsdState = false,
  forceCold = false,
  at = new Date().toISOString(),
} = {}) {
  const current = createLocalHostResidency(residency);
  const key = sessionKey(requestedSessionKey);
  const wantedFingerprint = text(fingerprint, "A local host fingerprint");
  const accessedAt = timestamp(at, "A local host lease timestamp");
  if (typeof hasSsdState !== "boolean") throw new TypeError("hasSsdState must be a boolean.");
  if (typeof forceCold !== "boolean") throw new TypeError("Local host forceCold must be a boolean.");
  const reset = resetForFingerprint(current, wantedFingerprint);
  const base = reset.residency;
  const inheritedActions = reset.actions;
  const matching = base.lanes.find((lane) => lane.sessionKey === key && lane.fingerprint === wantedFingerprint);
  if (matching?.state === "hot" && forceCold) {
    const next = withLane(base, matching.slot, activeLane(matching.slot, key, wantedFingerprint, accessedAt));
    return Object.freeze({
      kind: "cold",
      slot: matching.slot,
      // cold_prefill already erases the slot in the coordinator. Do it once:
      // another slot call would add latency without making the reset safer.
      actions: Object.freeze([...inheritedActions, action("cold_prefill", { slot: matching.slot, sessionKey: key, fingerprint: wantedFingerprint })]),
      residency: next,
    });
  }
  if (matching?.state === "hot") {
    const next = withLane(base, matching.slot, activeLane(matching.slot, key, wantedFingerprint, accessedAt));
    return Object.freeze({
      kind: "gpu",
      slot: matching.slot,
      actions: Object.freeze([...inheritedActions, action("use_gpu", { slot: matching.slot })]),
      residency: next,
    });
  }
  if (matching?.state === "active") {
    return Object.freeze({ kind: "queue", slot: -1, actions: Object.freeze(inheritedActions), residency: base });
  }
  const available = base.lanes.find((lane) => lane.state === "empty");
  const victim = available || [...base.lanes].filter((lane) => lane.state === "hot").sort(compareLeastRecent)[0] || null;
  if (!victim) return Object.freeze({ kind: "queue", slot: -1, actions: Object.freeze(inheritedActions), residency: base });
  const next = withLane(base, victim.slot, activeLane(victim.slot, key, wantedFingerprint, accessedAt));
  const actions = [...inheritedActions];
  if (victim.state === "hot") actions.push(action("save_lru_to_ssd", { slot: victim.slot, sessionKey: victim.sessionKey, fingerprint: victim.fingerprint }));
  actions.push(action(hasSsdState ? "restore_ssd" : "cold_prefill", { slot: victim.slot, sessionKey: key, fingerprint: wantedFingerprint }));
  return Object.freeze({ kind: hasSsdState ? "ssd" : "cold", slot: victim.slot, actions: Object.freeze(actions), residency: next });
}

// A successful response makes its leased state GPU-hot. A failed request is
// discarded rather than being saved as an incomplete continuation state.
export function completeLocalHostResidency(residency, {
  slot,
  sessionKey: requestedSessionKey,
  fingerprint,
  success,
  at = new Date().toISOString(),
} = {}) {
  const current = createLocalHostResidency(residency);
  const laneSlot = Number(slot);
  if (!Number.isSafeInteger(laneSlot) || laneSlot < 0 || laneSlot >= current.laneCount) throw new TypeError("A valid local host slot is required.");
  const key = sessionKey(requestedSessionKey);
  const wantedFingerprint = text(fingerprint, "A local host fingerprint");
  const completedAt = timestamp(at, "A local host completion timestamp");
  if (typeof success !== "boolean") throw new TypeError("Local host completion success must be a boolean.");
  const lane = current.lanes[laneSlot];
  if (lane.state !== "active" || lane.sessionKey !== key || lane.fingerprint !== wantedFingerprint) {
    throw new Error("Local host completion does not own this active lane.");
  }
  return withLane(current, laneSlot, success ? hotLane(laneSlot, key, wantedFingerprint, completedAt) : emptyLane(laneSlot));
}

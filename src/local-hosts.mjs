// Local Host management starts with durable facts, not guessed launch flags.
// This module is deliberately pure: hardware adapters and the server lifecycle
// runner will use these records later, but importing it cannot inspect, stop,
// start, or reconfigure an engine.

import { createLocalHostKvStorage } from "./local-host-kv-state.mjs";

export const LOCAL_HOST_ADAPTERS = Object.freeze({
  "llamacpp-nvidia": Object.freeze({
    id: "llamacpp-nvidia",
    label: "llama.cpp (NVIDIA)",
    hardwareFamily: "nvidia",
    engine: "llamacpp",
    profileSelection: "static_per_gpu_allocation",
  }),
  "mlx-apple": Object.freeze({
    id: "mlx-apple",
    label: "MLX (Apple)",
    hardwareFamily: "apple",
    engine: "mlx",
    profileSelection: "static_unified_memory_allocation",
  }),
});

export const LOCAL_HOST_POLICIES = Object.freeze([
  "automatic",
  "focus",
  "elastic",
  "workers",
]);

export const LOCAL_HOST_STATES = Object.freeze([
  "observed",
  "ready",
  "draining",
  "applying",
  "verifying",
  "recovering",
  "degraded",
  "stopped",
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function copy(value) {
  return structuredClone(value);
}

function assertHostId(value) {
  const id = text(value);
  if (!id) throw new TypeError("A local host id is required.");
  return id;
}

function assertAdapterId(value) {
  const id = text(value);
  if (!LOCAL_HOST_ADAPTERS[id]) throw new TypeError(`Unsupported local host adapter: ${id || "(empty)"}.`);
  return id;
}

function assertPolicy(value) {
  const policy = text(value) || "automatic";
  if (!LOCAL_HOST_POLICIES.includes(policy)) throw new TypeError(`Unsupported local host policy: ${policy}.`);
  return policy;
}

function assertState(value) {
  const state = text(value);
  if (!LOCAL_HOST_STATES.includes(state)) throw new TypeError(`Unsupported local host state: ${state || "(empty)"}.`);
  return state;
}

export function normalizeLaunchSpec(value) {
  const binary = text(value?.binary);
  if (!binary) throw new TypeError("A managed local host needs an executable path.");
  if (!Array.isArray(value?.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("A managed local host needs argv as a string array.");
  }
  return { binary, args: [...value.args] };
}

function normalizeLaneProfile(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("A managed local host lane profile must be an object.");
  }
  const laneCount = Number(value.laneCount);
  const laneContextTokens = Number(value.laneContextTokens);
  const totalContextTokens = Number(value.totalContextTokens);
  if (!Number.isSafeInteger(laneCount) || laneCount < 1 || laneCount > 3) {
    throw new TypeError("A managed local host lane profile needs one through three lanes.");
  }
  if (!Number.isSafeInteger(laneContextTokens) || laneContextTokens <= 0) {
    throw new TypeError("A managed local host lane profile needs a positive per-lane context.");
  }
  if (totalContextTokens !== laneCount * laneContextTokens) {
    throw new TypeError("A managed local host lane profile total must equal lanes times per-lane context.");
  }
  const adapterId = text(value.adapterId);
  const modelId = text(value.modelId);
  const profileId = text(value.profileId);
  if (!adapterId || !modelId || !profileId) throw new TypeError("A managed local host lane profile needs adapter, model, and profile ids.");
  return copy({ ...value, adapterId, modelId, profileId, laneCount, laneContextTokens, totalContextTokens });
}

// A discovery record does not grant ModelDock authority over the process. Its
// observed launch spec remains the comparison point even after later managed
// configuration changes.
export function createObservedHost({ id, adapterId, endpoint, launch, capabilities = {}, observedAt = new Date().toISOString() } = {}) {
  return {
    version: 2,
    id: assertHostId(id),
    adapterId: assertAdapterId(adapterId),
    endpoint: text(endpoint),
    observedSpec: normalizeLaunchSpec(launch),
    preTakeoverSpec: null,
    desiredSpec: null,
    activeSpec: null,
    recoverySpec: null,
    desiredProfile: null,
    activeProfile: null,
    kvState: null,
    capabilities: copy(capabilities),
    policy: "automatic",
    state: "observed",
    observedAt: text(observedAt) || new Date().toISOString(),
    managedAt: "",
    updatedAt: text(observedAt) || new Date().toISOString(),
    recoveryReason: "",
    failure: "",
  };
}

// This is the serialization boundary used by the durable registry. It accepts
// no operational authority: validation only copies a stored record into the
// canonical in-memory shape.
export function normalizeLocalHostRecord(record) {
  const base = createObservedHost({
    id: record?.id,
    adapterId: record?.adapterId,
    endpoint: record?.endpoint,
    launch: record?.observedSpec,
    capabilities: record?.capabilities || {},
    observedAt: record?.observedAt,
  });
  const state = assertState(record?.state || "observed");
  const preTakeoverSpec = record?.preTakeoverSpec ? normalizeLaunchSpec(record.preTakeoverSpec) : null;
  const desiredSpec = record?.desiredSpec ? normalizeLaunchSpec(record.desiredSpec) : null;
  const activeSpec = record?.activeSpec ? normalizeLaunchSpec(record.activeSpec) : null;
  const recoverySpec = record?.recoverySpec ? normalizeLaunchSpec(record.recoverySpec) : null;
  const desiredProfile = normalizeLaneProfile(record?.desiredProfile);
  const activeProfile = normalizeLaneProfile(record?.activeProfile);
  const kvState = record?.kvState ? createLocalHostKvStorage(record.kvState) : null;
  if (state !== "observed" && (!preTakeoverSpec || !desiredSpec)) {
    throw new TypeError("A managed local host needs its pre-takeover and desired launch specifications.");
  }
  if (state === "observed" && (preTakeoverSpec || desiredSpec || activeSpec || recoverySpec || desiredProfile || activeProfile)) {
    throw new TypeError("An observed local host cannot have managed launch specifications.");
  }
  if (state === "observed" && kvState) throw new TypeError("An observed local host cannot have managed KV state storage.");
  if (state !== "observed" && base.adapterId === "llamacpp-nvidia" && !kvState) {
    throw new TypeError("A managed NVIDIA llama.cpp host requires an explicit KV state disk budget.");
  }
  if (kvState && base.adapterId !== "llamacpp-nvidia") {
    throw new TypeError("SSD KV state storage is currently supported only for managed NVIDIA llama.cpp hosts.");
  }
  return {
    ...base,
    version: 2,
    policy: assertPolicy(record?.policy),
    state,
    preTakeoverSpec,
    desiredSpec,
    activeSpec,
    recoverySpec,
    desiredProfile,
    activeProfile,
    kvState,
    managedAt: text(record?.managedAt),
    updatedAt: text(record?.updatedAt) || base.updatedAt,
    recoveryReason: text(record?.recoveryReason),
    failure: text(record?.failure),
  };
}

function managedRecord(record, patch = {}) {
  const preTakeoverSpec = patch.preTakeoverSpec === undefined ? record.preTakeoverSpec : patch.preTakeoverSpec;
  const desiredSpec = patch.desiredSpec === undefined ? record.desiredSpec : patch.desiredSpec;
  const activeSpec = patch.activeSpec === undefined ? record.activeSpec : patch.activeSpec;
  const recoverySpec = patch.recoverySpec === undefined ? record.recoverySpec : patch.recoverySpec;
  const desiredProfile = patch.desiredProfile === undefined ? record.desiredProfile : patch.desiredProfile;
  const activeProfile = patch.activeProfile === undefined ? record.activeProfile : patch.activeProfile;
  const kvState = patch.kvState === undefined ? record.kvState : patch.kvState;
  return {
    ...record,
    ...patch,
    observedSpec: normalizeLaunchSpec(patch.observedSpec || record.observedSpec),
    preTakeoverSpec: preTakeoverSpec === null ? null : normalizeLaunchSpec(preTakeoverSpec),
    desiredSpec: desiredSpec === null ? null : normalizeLaunchSpec(desiredSpec),
    activeSpec: activeSpec === null ? null : normalizeLaunchSpec(activeSpec),
    recoverySpec: recoverySpec === null ? null : normalizeLaunchSpec(recoverySpec),
    desiredProfile: normalizeLaneProfile(desiredProfile),
    activeProfile: normalizeLaneProfile(activeProfile),
    kvState: kvState === null ? null : createLocalHostKvStorage(kvState),
    capabilities: copy(patch.capabilities || record.capabilities || {}),
  };
}

// The explicit takeover transition grants automation permission. It does not
// restart the host; the observed running specification becomes the initial
// desired and active specification only after the lifecycle runner verifies it
// on a real host. preTakeoverSpec is immutable for the lifetime of this grant:
// every failed managed replacement returns to exactly what the user last ran.
export function takeOverHost(record, { policy = "automatic", kvState, at = new Date().toISOString() } = {}) {
  if (assertState(record?.state) !== "observed") throw new TypeError("Only an observed host can be taken over.");
  const desired = normalizeLaunchSpec(record.observedSpec);
  if (record.adapterId === "llamacpp-nvidia" && !kvState) {
    throw new TypeError("A managed NVIDIA llama.cpp host requires an explicit KV state disk budget.");
  }
  const storage = record.adapterId === "llamacpp-nvidia" ? createLocalHostKvStorage(kvState) : null;
  if (kvState && record.adapterId !== "llamacpp-nvidia") {
    throw new TypeError("SSD KV state storage is currently supported only for managed NVIDIA llama.cpp hosts.");
  }
  return managedRecord(record, {
    policy: assertPolicy(policy),
    state: "verifying",
    preTakeoverSpec: desired,
    desiredSpec: desired,
    activeSpec: null,
    recoverySpec: null,
    desiredProfile: null,
    activeProfile: null,
    kvState: storage,
    managedAt: text(at) || new Date().toISOString(),
    updatedAt: text(at) || new Date().toISOString(),
    failure: "",
  });
}

// Planning a change is distinct from applying it. The server may persist this
// record before draining the old process, so a crash leaves an unambiguous
// desired target and an untouched pre-takeover fallback.
export function beginHostApply(record, { desiredSpec, desiredProfile = null, policy, at = new Date().toISOString() } = {}) {
  const state = assertState(record?.state);
  if (!["ready", "degraded"].includes(state)) throw new TypeError(`Cannot apply a host configuration while state is ${state}.`);
  return managedRecord(record, {
    desiredSpec: normalizeLaunchSpec(desiredSpec),
    desiredProfile: normalizeLaneProfile(desiredProfile),
    recoverySpec: null,
    policy: policy === undefined ? record.policy : assertPolicy(policy),
    state: "draining",
    updatedAt: text(at) || new Date().toISOString(),
    failure: "",
  });
}

export function markHostApplying(record, { at = new Date().toISOString() } = {}) {
  if (assertState(record?.state) !== "draining") throw new TypeError("A host must drain before it can apply a configuration.");
  return managedRecord(record, { state: "applying", updatedAt: text(at) || new Date().toISOString() });
}

export function markHostVerifying(record, { at = new Date().toISOString() } = {}) {
  if (!["applying", "recovering"].includes(assertState(record?.state))) {
    throw new TypeError("A host must apply or recover a configuration before verification.");
  }
  return managedRecord(record, { state: "verifying", updatedAt: text(at) || new Date().toISOString() });
}

export function markHostVerified(record, { capabilities, at = new Date().toISOString() } = {}) {
  if (assertState(record?.state) !== "verifying") throw new TypeError("Only a verifying host can become ready.");
  return managedRecord(record, {
    state: "ready",
    activeSpec: normalizeLaunchSpec(record.desiredSpec),
    activeProfile: normalizeLaneProfile(record.desiredProfile),
    recoverySpec: null,
    capabilities: capabilities ? copy(capabilities) : record.capabilities,
    updatedAt: text(at) || new Date().toISOString(),
    failure: "",
    recoveryReason: "",
  });
}

export function beginHostRecovery(record, { reason, at = new Date().toISOString() } = {}) {
  if (!record?.preTakeoverSpec) throw new TypeError("A host without a pre-takeover specification cannot recover automatically.");
  return managedRecord(record, {
    recoverySpec: normalizeLaunchSpec(record.desiredSpec),
    desiredSpec: normalizeLaunchSpec(record.preTakeoverSpec),
    desiredProfile: null,
    state: "recovering",
    updatedAt: text(at) || new Date().toISOString(),
    recoveryReason: text(reason) || "verification_failed",
  });
}

// Draining can fail before ModelDock has stopped the old process. In that case
// the runner leaves the already-verified service alone instead of restarting
// it merely to clean up a failed reconfiguration attempt.
export function abortHostApply(record, { failure, at = new Date().toISOString() } = {}) {
  if (assertState(record?.state) !== "draining") throw new TypeError("Only a draining host can abandon an unapplied configuration.");
  if (!record.activeSpec) throw new TypeError("A host without an active specification cannot abandon an apply safely.");
  return managedRecord(record, {
    desiredSpec: normalizeLaunchSpec(record.activeSpec),
    desiredProfile: normalizeLaneProfile(record.activeProfile),
    recoverySpec: null,
    state: "ready",
    updatedAt: text(at) || new Date().toISOString(),
    failure: text(failure) || "Local host drain failed before replacement.",
  });
}

export function markHostDegraded(record, { failure, at = new Date().toISOString() } = {}) {
  const state = assertState(record?.state);
  if (!["draining", "applying", "verifying", "recovering"].includes(state)) throw new TypeError(`Cannot degrade a host while state is ${state}.`);
  return managedRecord(record, {
    state: "degraded",
    updatedAt: text(at) || new Date().toISOString(),
    failure: text(failure) || "Local host verification failed.",
  });
}

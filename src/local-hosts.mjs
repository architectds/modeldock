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
    candidateProfiles: "calibration_required",
  }),
  "mlx-apple": Object.freeze({
    id: "mlx-apple",
    label: "MLX (Apple)",
    hardwareFamily: "apple",
    engine: "mlx",
    candidateProfiles: "hardware_validation_required",
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

// A discovery record does not grant ModelDock authority over the process. Its
// observed launch spec remains the comparison point even after later managed
// configuration changes.
export function createObservedHost({ id, adapterId, endpoint, launch, capabilities = {}, observedAt = new Date().toISOString() } = {}) {
  return {
    version: 1,
    id: assertHostId(id),
    adapterId: assertAdapterId(adapterId),
    endpoint: text(endpoint),
    observedSpec: normalizeLaunchSpec(launch),
    desiredSpec: null,
    lastKnownGoodSpec: null,
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
  const desiredSpec = record?.desiredSpec ? normalizeLaunchSpec(record.desiredSpec) : null;
  const lastKnownGoodSpec = record?.lastKnownGoodSpec ? normalizeLaunchSpec(record.lastKnownGoodSpec) : null;
  const kvState = record?.kvState ? createLocalHostKvStorage(record.kvState) : null;
  if (state !== "observed" && !desiredSpec) {
    throw new TypeError("A managed local host needs a desired launch specification.");
  }
  if (state === "observed" && (desiredSpec || lastKnownGoodSpec)) {
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
    version: 1,
    policy: assertPolicy(record?.policy),
    state,
    desiredSpec,
    lastKnownGoodSpec,
    kvState,
    managedAt: text(record?.managedAt),
    updatedAt: text(record?.updatedAt) || base.updatedAt,
    recoveryReason: text(record?.recoveryReason),
    failure: text(record?.failure),
  };
}

function managedRecord(record, patch = {}) {
  const desiredSpec = patch.desiredSpec === undefined ? record.desiredSpec : patch.desiredSpec;
  const lastKnownGoodSpec = patch.lastKnownGoodSpec === undefined ? record.lastKnownGoodSpec : patch.lastKnownGoodSpec;
  const kvState = patch.kvState === undefined ? record.kvState : patch.kvState;
  return {
    ...record,
    ...patch,
    observedSpec: normalizeLaunchSpec(patch.observedSpec || record.observedSpec),
    desiredSpec: desiredSpec === null ? null : normalizeLaunchSpec(desiredSpec),
    lastKnownGoodSpec: lastKnownGoodSpec === null ? null : normalizeLaunchSpec(lastKnownGoodSpec),
    kvState: kvState === null ? null : createLocalHostKvStorage(kvState),
    capabilities: copy(patch.capabilities || record.capabilities || {}),
  };
}

// The explicit takeover transition grants automation permission. It does not
// restart the host; the observed running specification becomes the initial
// desired and known-good specification only after the lifecycle runner verifies
// it on a real host.
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
    desiredSpec: desired,
    lastKnownGoodSpec: null,
    kvState: storage,
    managedAt: text(at) || new Date().toISOString(),
    updatedAt: text(at) || new Date().toISOString(),
    failure: "",
  });
}

// Planning a change is distinct from applying it. The server may persist this
// record before draining the old process, so a crash leaves an unambiguous
// desired target and an untouched last-known-good fallback.
export function beginHostApply(record, { desiredSpec, policy, at = new Date().toISOString() } = {}) {
  const state = assertState(record?.state);
  if (!["ready", "degraded"].includes(state)) throw new TypeError(`Cannot apply a host configuration while state is ${state}.`);
  return managedRecord(record, {
    desiredSpec: normalizeLaunchSpec(desiredSpec),
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

export function markHostVerified(record, { at = new Date().toISOString() } = {}) {
  if (assertState(record?.state) !== "verifying") throw new TypeError("Only a verifying host can become ready.");
  return managedRecord(record, {
    state: "ready",
    lastKnownGoodSpec: normalizeLaunchSpec(record.desiredSpec),
    updatedAt: text(at) || new Date().toISOString(),
    failure: "",
    recoveryReason: "",
  });
}

export function beginHostRecovery(record, { reason, at = new Date().toISOString() } = {}) {
  if (!record?.lastKnownGoodSpec) throw new TypeError("A host without a known-good specification cannot recover automatically.");
  return managedRecord(record, {
    desiredSpec: normalizeLaunchSpec(record.lastKnownGoodSpec),
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
  if (!record.lastKnownGoodSpec) throw new TypeError("A host without a known-good specification cannot abandon an apply safely.");
  return managedRecord(record, {
    desiredSpec: normalizeLaunchSpec(record.lastKnownGoodSpec),
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

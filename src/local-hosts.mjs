// Local Host management starts with durable facts, not guessed launch flags.
// This module is deliberately pure: hardware adapters and the server lifecycle
// runner will use these records later, but importing it cannot inspect, stop,
// start, or reconfigure an engine.

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

function managedRecord(record, patch = {}) {
  return {
    ...record,
    ...patch,
    observedSpec: normalizeLaunchSpec(patch.observedSpec || record.observedSpec),
    desiredSpec: patch.desiredSpec === null ? null : normalizeLaunchSpec(patch.desiredSpec || record.desiredSpec),
    lastKnownGoodSpec: patch.lastKnownGoodSpec === null
      ? null
      : normalizeLaunchSpec(patch.lastKnownGoodSpec || record.lastKnownGoodSpec),
    capabilities: copy(patch.capabilities || record.capabilities || {}),
  };
}

// The explicit takeover transition grants automation permission. It does not
// restart the host; the observed running specification becomes the initial
// desired and known-good specification only after the lifecycle runner verifies
// it on a real host.
export function takeOverHost(record, { policy = "automatic", at = new Date().toISOString() } = {}) {
  if (assertState(record?.state) !== "observed") throw new TypeError("Only an observed host can be taken over.");
  const desired = normalizeLaunchSpec(record.observedSpec);
  return managedRecord(record, {
    policy: assertPolicy(policy),
    state: "verifying",
    desiredSpec: desired,
    lastKnownGoodSpec: null,
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
  if (assertState(record?.state) !== "applying") throw new TypeError("A host must apply a configuration before verification.");
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

export function markHostDegraded(record, { failure, at = new Date().toISOString() } = {}) {
  const state = assertState(record?.state);
  if (!["applying", "verifying", "recovering"].includes(state)) throw new TypeError(`Cannot degrade a host while state is ${state}.`);
  return managedRecord(record, {
    state: "degraded",
    updatedAt: text(at) || new Date().toISOString(),
    failure: text(failure) || "Local host verification failed.",
  });
}

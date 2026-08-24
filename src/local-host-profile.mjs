// Static local-host profile selection.
//
// A managed host never discovers its lane count by starting candidate servers
// or benchmarking user prompts. The adapter supplies an allocation ledger for
// each physical GPU: model/fixed-runtime bytes and that card's share of one KV
// token. This module applies the product policy to that ledger.

import { LOCAL_HOST_ADAPTERS } from "./local-hosts.mjs";

export const LOCAL_HOST_MAX_LANES = 3;
export const LOCAL_HOST_MIN_LANE_CONTEXT_RATIO = 0.75;
export const LOCAL_HOST_MIN_HEADROOM_BYTES = 1 * 1024 ** 3;
// Managed mode has one physical operating-reserve contract: 1 GiB per card.
// A second hidden "preferred" threshold quietly reduced promised context and
// contradicted the user-visible policy, so retain the export only as its exact
// alias for existing readers.
export const LOCAL_HOST_PREFERRED_HEADROOM_BYTES = LOCAL_HOST_MIN_HEADROOM_BYTES;

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}

function ratio(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`${label} must be greater than zero and at most one.`);
  }
  return value;
}

function freezeGpu(gpu) {
  return Object.freeze({ ...gpu });
}

function freezeCandidate(candidate) {
  return Object.freeze({
    ...candidate,
    gpus: Object.freeze(candidate.gpus.map(freezeGpu)),
  });
}

export function createLocalHostGpuAllocation({
  id,
  totalBytes,
  staticBytes,
  kvBytesPerToken,
  usedBytes = 0,
  currentKvBytes = 0,
  weightBytes = 0,
  projectorBytes = 0,
  systemReserveBytes = 0,
  runtimeReserveBytes = 0,
} = {}) {
  const total = positiveInteger(totalBytes, "A GPU total byte count");
  const fixed = nonNegativeInteger(staticBytes, "A GPU static allocation byte count");
  if (fixed >= total) throw new TypeError("A GPU static allocation must leave some VRAM.");
  return Object.freeze({
    id: text(id, "A GPU id"),
    totalBytes: total,
    staticBytes: fixed,
    kvBytesPerToken: positiveInteger(kvBytesPerToken, "A GPU KV byte-per-token allocation"),
    usedBytes: nonNegativeInteger(usedBytes, "A GPU observed used byte count"),
    currentKvBytes: nonNegativeInteger(currentKvBytes, "A GPU current KV byte count"),
    weightBytes: nonNegativeInteger(weightBytes, "A GPU weight byte count"),
    projectorBytes: nonNegativeInteger(projectorBytes, "A GPU projector byte count"),
    systemReserveBytes: nonNegativeInteger(systemReserveBytes, "A GPU system reserve byte count"),
    runtimeReserveBytes: nonNegativeInteger(runtimeReserveBytes, "A GPU runtime reserve byte count"),
  });
}

// `staticBytes` is adapter-owned: it includes that physical card's model shard
// and fixed runtime allocations. `kvBytesPerToken` is also per-card, so tensor
// split asymmetry is preserved rather than averaged across installed VRAM.
export function createLocalHostProfileInput({
  adapterId,
  modelId,
  modelMaxContextTokens,
  gpus,
  minimumHeadroomBytes = LOCAL_HOST_MIN_HEADROOM_BYTES,
  preferredHeadroomBytes = LOCAL_HOST_PREFERRED_HEADROOM_BYTES,
  minimumLaneContextRatio = LOCAL_HOST_MIN_LANE_CONTEXT_RATIO,
  contextQuantumTokens = 1_000,
} = {}) {
  const normalizedAdapterId = text(adapterId, "A local host adapter id");
  if (!LOCAL_HOST_ADAPTERS[normalizedAdapterId]) throw new TypeError(`Unsupported local host adapter: ${normalizedAdapterId}.`);
  if (!Array.isArray(gpus) || !gpus.length) throw new TypeError("A local host profile needs at least one GPU allocation.");
  const normalizedGpus = gpus.map(createLocalHostGpuAllocation);
  const ids = new Set(normalizedGpus.map((gpu) => gpu.id));
  if (ids.size !== normalizedGpus.length) throw new TypeError("Local host GPU ids must be unique.");
  const minimum = positiveInteger(minimumHeadroomBytes, "Minimum GPU headroom bytes");
  const preferred = positiveInteger(preferredHeadroomBytes, "Preferred GPU headroom bytes");
  if (preferred < minimum) throw new TypeError("Preferred GPU headroom cannot be below minimum headroom.");
  return Object.freeze({
    version: 1,
    adapterId: normalizedAdapterId,
    modelId: text(modelId, "A local model id"),
    modelMaxContextTokens: positiveInteger(modelMaxContextTokens, "A model maximum context window"),
    gpus: Object.freeze(normalizedGpus),
    minimumHeadroomBytes: minimum,
    preferredHeadroomBytes: preferred,
    minimumLaneContextRatio: ratio(minimumLaneContextRatio, "Minimum lane context ratio"),
    contextQuantumTokens: positiveInteger(contextQuantumTokens, "Context quantum tokens"),
  });
}

function roundedContext(ceiling, input) {
  if (ceiling >= input.modelMaxContextTokens) return input.modelMaxContextTokens;
  return Math.max(0, Math.floor(ceiling / input.contextQuantumTokens) * input.contextQuantumTokens);
}

function maxLaneContext(input, laneCount, headroomBytes) {
  let ceiling = input.modelMaxContextTokens;
  for (const gpu of input.gpus) {
    const availableKvBytes = gpu.totalBytes - gpu.staticBytes - headroomBytes;
    const perLaneBytes = laneCount * gpu.kvBytesPerToken;
    ceiling = Math.min(ceiling, availableKvBytes > 0 ? Math.floor(availableKvBytes / perLaneBytes) : 0);
  }
  return roundedContext(ceiling, input);
}

function gpuCandidate(input, gpu, laneCount, laneContextTokens) {
  const kvBytes = laneCount * laneContextTokens * gpu.kvBytesPerToken;
  const allocatedBytes = gpu.staticBytes + kvBytes;
  const remainingBytes = gpu.totalBytes - allocatedBytes;
  return {
    id: gpu.id,
    totalBytes: gpu.totalBytes,
    staticBytes: gpu.staticBytes,
    usedBytes: gpu.usedBytes,
    currentKvBytes: gpu.currentKvBytes,
    weightBytes: gpu.weightBytes,
    projectorBytes: gpu.projectorBytes,
    systemReserveBytes: gpu.systemReserveBytes,
    runtimeReserveBytes: gpu.runtimeReserveBytes,
    kvBytesPerToken: gpu.kvBytesPerToken,
    kvBytes,
    allocatedBytes,
    remainingBytes,
    meetsMinimumHeadroom: remainingBytes >= input.minimumHeadroomBytes,
    meetsPreferredHeadroom: remainingBytes >= input.preferredHeadroomBytes,
  };
}

export function evaluateLocalHostLaneProfile(input, laneCount) {
  const normalized = createLocalHostProfileInput(input);
  const lanes = positiveInteger(laneCount, "A local host lane count");
  if (lanes > LOCAL_HOST_MAX_LANES) throw new TypeError(`A local host supports at most ${LOCAL_HOST_MAX_LANES} GPU lanes.`);
  const minimumLaneContextTokens = maxLaneContext(normalized, lanes, normalized.minimumHeadroomBytes);
  const preferredLaneContextTokens = maxLaneContext(normalized, lanes, normalized.preferredHeadroomBytes);
  const minimumLongContextTokens = Math.ceil(normalized.modelMaxContextTokens * normalized.minimumLaneContextRatio);
  // Prefer more operating room when it still preserves the promised long
  // context. Otherwise retain the minimum safe reserve rather than throwing
  // away an otherwise valid higher-lane profile.
  const laneContextTokens = preferredLaneContextTokens >= minimumLongContextTokens
    ? preferredLaneContextTokens
    : minimumLaneContextTokens;
  const gpus = normalized.gpus.map((gpu) => gpuCandidate(normalized, gpu, lanes, laneContextTokens));
  const allocationFits = laneContextTokens > 0 && gpus.every((gpu) => gpu.meetsMinimumHeadroom);
  return freezeCandidate({
    version: 1,
    adapterId: normalized.adapterId,
    modelId: normalized.modelId,
    laneCount: lanes,
    laneContextTokens,
    totalContextTokens: laneContextTokens * lanes,
    minimumLaneContextTokens,
    preferredLaneContextTokens,
    minimumLongContextTokens,
    allocationFits,
    meetsLongContextFloor: laneContextTokens >= minimumLongContextTokens,
    headroomLevel: gpus.every((gpu) => gpu.meetsPreferredHeadroom) ? "preferred" : (allocationFits ? "minimum" : "insufficient"),
    gpus,
  });
}

export function selectLocalHostLaneProfile(input) {
  const normalized = createLocalHostProfileInput(input);
  const candidates = [];
  for (let lanes = LOCAL_HOST_MAX_LANES; lanes >= 1; lanes -= 1) {
    const candidate = evaluateLocalHostLaneProfile(normalized, lanes);
    candidates.push(candidate);
  }
  // Never trade two full-size conversations for three smaller ones merely
  // because P3 clears the 75% floor. First keep the model's complete window
  // on the greatest lane count that can actually retain it; only then use a
  // reduced two-lane plan when it still gives each session a long window.
  const fullWindow = candidates.find((candidate) => candidate.laneCount > 1
    && candidate.allocationFits
    && candidate.laneContextTokens === normalized.modelMaxContextTokens);
  const longTwoLane = candidates.find((candidate) => candidate.laneCount === 2
    && candidate.allocationFits
    && candidate.meetsLongContextFloor);
  const oneLane = candidates.find((candidate) => candidate.laneCount === 1 && candidate.allocationFits);
  const selected = fullWindow || longTwoLane || oneLane;
  if (selected) {
    return Object.freeze({
      ...selected,
      profileId: `static-p${selected.laneCount}-c${selected.laneContextTokens}`,
      candidates: Object.freeze(candidates),
    });
  }
  return Object.freeze({
    version: 1,
    adapterId: normalized.adapterId,
    modelId: normalized.modelId,
    profileId: "",
    laneCount: 0,
    laneContextTokens: 0,
    totalContextTokens: 0,
    minimumLongContextTokens: Math.ceil(normalized.modelMaxContextTokens * normalized.minimumLaneContextRatio),
    candidates: Object.freeze(candidates),
  });
}

function sameProfileIdentity(current, target) {
  return current.adapterId === target.adapterId && current.modelId === target.modelId;
}

// Catalog order is a protocol safety property. A smaller declaration must
// reach Codex before the server becomes smaller; a larger declaration can only
// reach Codex after the larger server is ready. Lane-only changes retain the
// same declared context and therefore never require a catalog mutation.
export function planLocalHostProfileTransition({ current = null, target } = {}) {
  if (!target || typeof target !== "object" || !positiveInteger(target.laneCount, "A target lane count") || !positiveInteger(target.laneContextTokens, "A target lane context")) {
    throw new TypeError("A complete target local host lane profile is required.");
  }
  if (target.laneCount > LOCAL_HOST_MAX_LANES) throw new TypeError(`A local host supports at most ${LOCAL_HOST_MAX_LANES} GPU lanes.`);
  if (!current) {
    return Object.freeze({
      kind: "initial",
      requiresCodexRestart: true,
      steps: Object.freeze(["restart_and_verify_server", "publish_catalog", "require_codex_restart"]),
    });
  }
  if (!sameProfileIdentity(current, target)) throw new TypeError("A local host profile transition must retain adapter and model identity.");
  if (current.laneCount === target.laneCount && current.laneContextTokens === target.laneContextTokens) {
    return Object.freeze({ kind: "none", requiresCodexRestart: false, steps: Object.freeze([]) });
  }
  if (target.laneContextTokens < current.laneContextTokens) {
    return Object.freeze({
      kind: "smaller_context",
      requiresCodexRestart: true,
      steps: Object.freeze(["publish_catalog", "require_codex_restart", "drain", "restart_and_verify_server"]),
    });
  }
  if (target.laneContextTokens > current.laneContextTokens) {
    return Object.freeze({
      kind: "larger_context",
      requiresCodexRestart: true,
      steps: Object.freeze(["drain", "restart_and_verify_server", "publish_catalog", "require_codex_restart"]),
    });
  }
  return Object.freeze({
    kind: "lane_only",
    requiresCodexRestart: false,
    steps: Object.freeze(["drain", "restart_and_verify_server"]),
  });
}

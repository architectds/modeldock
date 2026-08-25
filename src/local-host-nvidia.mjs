// NVIDIA llama.cpp adapter for the managed-host capacity policy.
//
// Capacity is calculated forward from the target GGUF and physical cards. The
// pre-takeover process may be wrong, so its context, slots, cache contents,
// model footprint and nvidia-smi usage are not capacity inputs. Its argv is
// retained elsewhere only as the immutable rollback specification.

import path from "node:path";
import { KV_ELEMENT_BYTES } from "./gguf.mjs";
import {
  LOCAL_HOST_MIN_HEADROOM_BYTES,
  selectLocalHostLaneProfile,
} from "./local-host-profile.mjs";

const GiB = 1024 ** 3;

// Windows WDDM, the compositor and fixed CUDA runtime allocations do not live
// in a GGUF. Reserve them before the generic profile selector applies its
// separate 1 GiB operating headroom. A later target bootstrap can replace this
// conservative policy with a measured target-specific baseline.
export const LOCAL_HOST_NVIDIA_SYSTEM_RESERVE_BYTES = GiB;
export const LOCAL_HOST_NVIDIA_RUNTIME_RESERVE_BYTES = Math.round(0.5 * GiB);
export const LOCAL_HOST_NVIDIA_CALIBRATION_CONTEXT_TOKENS = 8_192;
// The second calibration point must be large enough to expose the target's
// actual KV allocation, but not become a minutes-long prefill on slower cards.
// 8K -> 16K is a bounded, model-only measurement; the calculated profile then
// carries a 10% buffer and is still verified on its real final context.
export const LOCAL_HOST_NVIDIA_SLOPE_CONTEXT_TOKENS = 16_384;
export const LOCAL_HOST_NVIDIA_CONTEXT_SAFETY_RATIO = 0.9;

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return number;
}

function cacheElementBytes(value) {
  return KV_ELEMENT_BYTES[String(value || "f16")] || KV_ELEMENT_BYTES.f16;
}

export function localHostKvBytesPerToken(facts, { cacheTypeK = "f16", cacheTypeV = "f16" } = {}) {
  if (!facts?.attentionLayers || !facts?.headCountKv) throw new TypeError("Managed NVIDIA planning needs model KV shape facts.");
  return Math.round(
    facts.attentionLayers
      * facts.headCountKv
      * ((facts.keyLength * cacheElementBytes(cacheTypeK)) + (facts.valueLength * cacheElementBytes(cacheTypeV))),
  );
}

function targetSplitRatios(gpus, {
  systemReserveBytes,
  runtimeReserveBytes,
  projectorBytes,
} = {}) {
  // Managed mode owns tensor placement. Its ratios are based on target-device
  // capacity after fixed reservations, not on an old --tensor-split.
  const weights = gpus.map((gpu, index) => Math.max(1,
    positiveInteger(gpu.totalBytes, "A physical GPU byte count")
      - systemReserveBytes
      - runtimeReserveBytes
      - (index === 0 ? projectorBytes : 0)
      - LOCAL_HOST_MIN_HEADROOM_BYTES,
  ));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => value / total);
}

export function createNvidiaProfileInput({
  gpus,
  targetModelFacts,
  targetModelId = "",
  cacheTypeK = "q4_0",
  cacheTypeV = "q4_0",
  visionProjectorBytes = 0,
  systemReserveBytes = LOCAL_HOST_NVIDIA_SYSTEM_RESERVE_BYTES,
  runtimeReserveBytes = LOCAL_HOST_NVIDIA_RUNTIME_RESERVE_BYTES,
} = {}) {
  const allNvidia = (Array.isArray(gpus) ? gpus : []).filter((gpu) => gpu?.vendor === "nvidia" && gpu.totalBytes);
  if (!allNvidia.length) throw new TypeError("Managed NVIDIA planning needs physical capacity for at least one NVIDIA card.");
  if (!targetModelFacts) throw new TypeError("Managed NVIDIA planning needs target GGUF facts.");
  const modelBytes = positiveInteger(targetModelFacts.weightBytes || targetModelFacts.fileBytes, "Target model bytes");
  const modelMaxContextTokens = positiveInteger(targetModelFacts.trainedContext, "The target model context window");
  const projector = Number(visionProjectorBytes);
  if (!Number.isSafeInteger(projector) || projector < 0) throw new TypeError("Vision projector bytes must be a non-negative integer.");
  const system = positiveInteger(systemReserveBytes, "The Windows GPU reserve");
  const runtime = positiveInteger(runtimeReserveBytes, "The llama.cpp GPU runtime reserve");
  const ratios = targetSplitRatios(allNvidia, {
    systemReserveBytes: system,
    runtimeReserveBytes: runtime,
    projectorBytes: projector,
  });
  const totalKvBytesPerToken = localHostKvBytesPerToken(targetModelFacts, { cacheTypeK, cacheTypeV });
  const allocations = allNvidia.map((gpu, index) => {
    const ratio = ratios[index];
    const weightBytes = Math.round(modelBytes * ratio);
    const projectorAllocationBytes = index === 0 ? projector : 0;
    return {
      id: gpu.uuid || `nvidia-${Number.isInteger(gpu.index) ? gpu.index : index}`,
      totalBytes: Math.round(gpu.totalBytes),
      staticBytes: weightBytes + projectorAllocationBytes + system + runtime,
      kvBytesPerToken: Math.max(1, Math.round(totalKvBytesPerToken * ratio)),
      weightBytes,
      projectorBytes: projectorAllocationBytes,
      systemReserveBytes: system,
      runtimeReserveBytes: runtime,
    };
  });

  return {
    adapterId: "llamacpp-nvidia",
    modelId: String(targetModelId || "").trim() || path.basename(String(targetModelFacts.path || "local-model")),
    modelMaxContextTokens,
    // llama.cpp rounds a slot window to a 256-token boundary. Emit that
    // boundary directly so lifecycle verification can require exact reality.
    contextQuantumTokens: 256,
    gpus: allocations,
    deviceIndices: Object.freeze(allNvidia.map((gpu, index) => Number.isInteger(gpu.index) ? gpu.index : index)),
    tensorSplit: Object.freeze(ratios),
  };
}

function sampleGpuById(sample, allocation) {
  const id = String(allocation?.id || "");
  const found = (Array.isArray(sample) ? sample : []).find((gpu, index) => {
    const candidate = gpu?.uuid || `nvidia-${Number.isInteger(gpu?.index) ? gpu.index : index}`;
    return candidate === id;
  });
  const used = Number(found?.usedBytes);
  if (!Number.isSafeInteger(used) || used < 0) {
    throw new TypeError(`Target calibration is missing a physical usage sample for ${id}.`);
  }
  return found;
}

function sampleUsedBytes(sample, allocation) {
  return Number(sampleGpuById(sample, allocation).usedBytes);
}

function sampleFreeBytes(sample, allocation) {
  const gpu = sampleGpuById(sample, allocation);
  const reported = Number(gpu?.freeBytes);
  if (Number.isSafeInteger(reported) && reported >= 0) return reported;
  return Math.max(0, Number(gpu.totalBytes || allocation.totalBytes) - Number(gpu.usedBytes));
}

function sampleCapacityBytes(sample, allocation) {
  const gpu = sampleGpuById(sample, allocation);
  const free = Number(gpu?.freeBytes);
  const used = Number(gpu?.usedBytes);
  if (Number.isSafeInteger(free) && free >= 0 && Number.isSafeInteger(used) && used >= 0) {
    return free + used;
  }
  return allocation.totalBytes;
}

function roundContext(contextTokens, target) {
  const quantum = positiveInteger(target.contextQuantumTokens, "A context quantum");
  const bounded = Math.max(quantum, Math.min(target.modelMaxContextTokens, Math.floor(contextTokens)));
  return Math.floor(bounded / quantum) * quantum;
}

function runtimeProfile(target, laneCount, laneContextTokens, profileId, evidence) {
  const lanes = positiveInteger(laneCount, "A lane count");
  const context = roundContext(laneContextTokens, target);
  return Object.freeze({
    adapterId: target.adapterId,
    modelId: target.modelId,
    profileId,
    laneCount: lanes,
    laneContextTokens: context,
    totalContextTokens: lanes * context,
    deviceIndices: target.deviceIndices,
    tensorSplit: target.tensorSplit,
    gpus: Object.freeze(target.gpus.map((gpu) => Object.freeze({ id: gpu.id }))),
    evidence: Object.freeze(evidence),
  });
}

function runtimeEvidence(estimate, lane, strategy) {
  return {
    strategy,
    lane,
    perGpu: estimate.gpus.map((gpu) => ({
      id: gpu.id,
      fixedReserveBytes: gpu.fixedReserveBytes,
      bytesPerToken: gpu.bytesPerToken,
      bootstrapFreeBytes: gpu.bootstrapFreeBytes,
      slopeFreeBytes: gpu.slopeFreeBytes,
    })),
  };
}

// Stop the previous server, measure each card's real Windows/desktop baseline,
// then load the target at a fixed small context. That gives the target model,
// projector and llama.cpp runtime footprint without accepting any old launch
// parameter as evidence. KV bytes come from the selected cache format and are
// only about 128 MiB at this fixed 8K calibration window.
export function createCalibratedNvidiaProfileInput({
  target,
  baselineSample,
  calibrationContextTokens = LOCAL_HOST_NVIDIA_CALIBRATION_CONTEXT_TOKENS,
  calibrationSample,
} = {}) {
  if (!target || typeof target !== "object" || !Array.isArray(target.gpus) || !target.gpus.length) {
    throw new TypeError("Target calibration needs a target NVIDIA capacity ledger.");
  }
  const contextTokens = positiveInteger(calibrationContextTokens, "The calibration context");
  const gpus = target.gpus.map((allocation) => {
    const baselineUsedBytes = sampleUsedBytes(baselineSample, allocation);
    const calibrationUsedBytes = sampleUsedBytes(calibrationSample, allocation);
    const kvBytesPerToken = allocation.kvBytesPerToken;
    const expectedWithoutRuntime = baselineUsedBytes
      + allocation.weightBytes
      + allocation.projectorBytes
      + (contextTokens * kvBytesPerToken);
    const runtimeReserveBytes = calibrationUsedBytes - expectedWithoutRuntime;
    const staticBytes = baselineUsedBytes
      + allocation.weightBytes
      + allocation.projectorBytes
      + runtimeReserveBytes;
    if (!Number.isSafeInteger(staticBytes) || staticBytes <= 0 || staticBytes >= allocation.totalBytes) {
      throw new TypeError(`Target calibration produced an invalid fixed footprint for ${allocation.id}.`);
    }
    if (!Number.isSafeInteger(runtimeReserveBytes) || runtimeReserveBytes < 0) {
      throw new TypeError(`Target calibration undercounted the expected target footprint for ${allocation.id}.`);
    }
    return {
      ...allocation,
      staticBytes,
      systemReserveBytes: baselineUsedBytes,
      runtimeReserveBytes,
      calibration: Object.freeze({ baselineUsedBytes, calibrationUsedBytes, calibrationContextTokens: contextTokens }),
    };
  });
  return Object.freeze({
    ...target,
    gpus: Object.freeze(gpus),
  });
}

// This is the actual capacity calculator. A target P1 bootstrap tells us what
// does not come from GGUF metadata; a second, known-high P1 context measures
// the real per-token cost (KV plus CUDA graph/workspace growth). P2/P3 only
// need their own tiny-slot probe to capture their extra fixed slot overhead.
// The result is a continuous per-GPU calculation, not a list of guessed P/C
// rungs to launch one after another.
export function estimateNvidiaRuntimeCapacity({
  target,
  bootstrapSample,
  slopeSample,
  slopeContextTokens = LOCAL_HOST_NVIDIA_SLOPE_CONTEXT_TOKENS,
  parallelSamples = {},
  bootstrapContextTokens = LOCAL_HOST_NVIDIA_CALIBRATION_CONTEXT_TOKENS,
  headroomBytes = LOCAL_HOST_MIN_HEADROOM_BYTES,
} = {}) {
  if (!target?.gpus?.length) throw new TypeError("Runtime capacity needs a target NVIDIA ledger.");
  const bootstrap = positiveInteger(bootstrapContextTokens, "The bootstrap context");
  const slopeContext = positiveInteger(slopeContextTokens, "The slope calibration context");
  if (slopeContext <= bootstrap) throw new TypeError("The slope calibration context must exceed the bootstrap context.");
  const headroom = positiveInteger(headroomBytes, "The GPU headroom");
  const perGpu = target.gpus.map((allocation) => {
    const bootstrapFreeBytes = sampleFreeBytes(bootstrapSample, allocation);
    const slopeFreeBytes = sampleFreeBytes(slopeSample, allocation);
    const capacityBytes = sampleCapacityBytes(bootstrapSample, allocation);
    const observedSlope = Math.ceil((bootstrapFreeBytes - slopeFreeBytes) / (slopeContext - bootstrap));
    // A desktop can become quieter during a measurement. Never let that make
    // the model appear cheaper than its GGUF-derived Q4 KV lower bound.
    const bytesPerToken = Math.max(allocation.kvBytesPerToken, observedSlope);
    const fixedReserveBytes = capacityBytes
      - bootstrapFreeBytes
      - allocation.weightBytes
      - allocation.projectorBytes
      - (bootstrap * allocation.kvBytesPerToken);
    if (!Number.isSafeInteger(fixedReserveBytes) || fixedReserveBytes < 0) {
      throw new TypeError(`Runtime calibration produced an invalid fixed reserve for ${allocation.id}.`);
    }
    return Object.freeze({
      ...allocation,
      capacityBytes,
      bootstrapFreeBytes,
      slopeFreeBytes,
      fixedReserveBytes,
      bytesPerToken,
    });
  });
  const estimateForLanes = (lanes) => {
    const sample = lanes === 1 ? bootstrapSample : parallelSamples[lanes];
    if (!sample) return null;
    const nominal = Math.min(...perGpu.map((allocation) => {
      const freeAtBootstrap = sampleFreeBytes(sample, allocation);
      const available = freeAtBootstrap - headroom;
      const addedPerLane = lanes * allocation.bytesPerToken;
      return bootstrap + Math.floor(Math.max(0, available) / addedPerLane);
    }));
    const nominalContextTokens = roundContext(nominal, target);
    const safeContextTokens = roundContext(Math.floor(nominalContextTokens * LOCAL_HOST_NVIDIA_CONTEXT_SAFETY_RATIO), target);
    return Object.freeze({
      laneCount: lanes,
      nominalContextTokens,
      safeContextTokens,
      bootstrapFreeBytes: Object.freeze(perGpu.map((allocation) => sampleFreeBytes(sample, allocation))),
    });
  };
  return Object.freeze({
    target,
    bootstrapContextTokens: bootstrap,
    slopeContextTokens: slopeContext,
    headroomBytes: headroom,
    gpus: Object.freeze(perGpu),
    lanes: Object.freeze([1, 2, 3].map(estimateForLanes)),
  });
}

// Before a second slot is started, its fixed graph overhead is unknown. This
// deliberately optimistic upper bound assumes that overhead is zero. If even
// this bound cannot meet the product's long-context floor, P2 is impossible
// and the runner must not start it merely to learn that fact.
export function optimisticNvidiaParallelContext(estimate, laneCount) {
  const lanes = positiveInteger(laneCount, "A lane count");
  const target = estimate?.target;
  if (!target?.gpus?.length) throw new TypeError("A runtime capacity estimate is required.");
  const context = Math.min(...estimate.gpus.map((gpu) => {
    const available = gpu.bootstrapFreeBytes - estimate.headroomBytes;
    return estimate.bootstrapContextTokens + Math.floor(Math.max(0, available) / (lanes * gpu.bytesPerToken));
  }));
  return roundContext(context, target);
}

export function selectNvidiaRuntimeProfile(estimate) {
  const { target } = estimate || {};
  if (!target?.modelMaxContextTokens) throw new TypeError("A runtime capacity estimate is required.");
  const lane = (count) => estimate.lanes.find((candidate) => candidate?.laneCount === count) || null;
  const p3 = lane(3);
  const p2 = lane(2);
  const p1 = lane(1);
  const longFloor = Math.ceil(target.modelMaxContextTokens * 0.75);
  if (p3 && p3.nominalContextTokens >= target.modelMaxContextTokens) {
    return runtimeProfile(target, 3, target.modelMaxContextTokens, `calculated-p3-c${target.modelMaxContextTokens}`, runtimeEvidence(estimate, p3, "three_full"));
  }
  if (p2 && p2.safeContextTokens >= longFloor) {
    return runtimeProfile(target, 2, p2.safeContextTokens, `calculated-p2-c${p2.safeContextTokens}`, runtimeEvidence(estimate, p2, "two_long"));
  }
  if (!p1 || p1.safeContextTokens < LOCAL_HOST_NVIDIA_CALIBRATION_CONTEXT_TOKENS) {
    throw new TypeError("No calculated P1 NVIDIA profile retains the required operating headroom.");
  }
  return runtimeProfile(target, 1, p1.safeContextTokens, `calculated-p1-c${p1.safeContextTokens}`, runtimeEvidence(estimate, p1, "one_long"));
}

export function backoffNvidiaRuntimeProfile(estimate, current) {
  if (!current?.laneCount || !current?.laneContextTokens) throw new TypeError("A calculated runtime profile is required for backoff.");
  const target = estimate?.target;
  if (current.laneCount === 3) return selectNvidiaRuntimeProfile({
    ...estimate,
    lanes: estimate.lanes.map((lane) => lane?.laneCount === 3 ? { ...lane, nominalContextTokens: 0, safeContextTokens: 0 } : lane),
  });
  const context = roundContext(Math.floor(current.laneContextTokens * LOCAL_HOST_NVIDIA_CONTEXT_SAFETY_RATIO), target);
  const longFloor = Math.ceil(target.modelMaxContextTokens * 0.75);
  if (current.laneCount > 1 && context < longFloor) return selectNvidiaRuntimeProfile({ ...estimate, lanes: estimate.lanes.map((lane) => lane?.laneCount === 2 ? { ...lane, safeContextTokens: 0 } : lane) });
  return runtimeProfile(target, current.laneCount, context, `calculated-p${current.laneCount}-c${context}-backoff`, {
    ...runtimeEvidence(estimate, estimate.lanes.find((lane) => lane?.laneCount === current.laneCount), "nearby_backoff"),
    from: current.profileId,
  });
}

export function selectNvidiaManagedProfile(options = {}) {
  const input = createNvidiaProfileInput(options);
  return selectNvidiaProfileFromInput(input);
}

export function selectNvidiaProfileFromInput(input) {
  const profile = selectLocalHostLaneProfile(input);
  if (!profile.laneCount) throw new TypeError("No managed llama.cpp profile fits the selected NVIDIA cards with the required operating reserve.");
  return Object.freeze({
    ...profile,
    deviceIndices: input.deviceIndices,
    tensorSplit: input.tensorSplit,
  });
}

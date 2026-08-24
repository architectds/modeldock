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
  return used;
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
    const baselineUsedBytes = sampleGpuById(baselineSample, allocation);
    const calibrationUsedBytes = sampleGpuById(calibrationSample, allocation);
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

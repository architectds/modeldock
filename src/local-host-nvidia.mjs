// NVIDIA llama.cpp adapter for the static managed-host policy.
//
// The running engine is the measurement boundary. nvidia-smi reports each
// physical card's current allocation; the adapter subtracts only the KV bytes
// attributable to the observed -c and retains every other byte as fixed load.
// This automatically includes model shards, recurrent state, draft buffers,
// desktop use and other GPU consumers without pretending they can be separated
// reliably under Windows WDDM.

import path from "node:path";
import { KV_ELEMENT_BYTES } from "./gguf.mjs";
import {
  LOCAL_HOST_MIN_HEADROOM_BYTES,
  selectLocalHostLaneProfile,
} from "./local-host-profile.mjs";

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

function selectedDeviceIndices(launch, gpus) {
  if (String(launch?.splitMode || "").toLowerCase() === "none") {
    const main = Number.isInteger(Number(launch?.mainGpu)) ? Number(launch.mainGpu) : 0;
    return new Set([main]);
  }
  const device = String(launch?.device || "").trim();
  if (!device) return new Set(gpus.map((gpu, index) => Number.isInteger(gpu.index) ? gpu.index : index));
  const parsed = device.split(",").map((entry) => {
    const match = /(?:CUDA)?(\d+)$/i.exec(entry.trim());
    return match ? Number(match[1]) : -1;
  }).filter((index) => index >= 0);
  return parsed.length ? new Set(parsed) : new Set(gpus.map((gpu, index) => Number.isInteger(gpu.index) ? gpu.index : index));
}

function splitRatios(launch, gpus) {
  const explicit = String(launch?.tensorSplit || "").split(/[,/;]/)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  const weights = explicit.length === gpus.length
    ? explicit
    : gpus.map((gpu) => positiveInteger(gpu.totalBytes, "A physical GPU byte count"));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => value / total);
}

function gpuIdentity(gpu, index) {
  if (gpu?.uuid) return `uuid:${gpu.uuid}`;
  if (Number.isInteger(gpu?.index)) return `index:${gpu.index}`;
  return `position:${index}`;
}

// WDDM can evict and re-reside hundreds of MiB while the dashboard is open.
// A takeover is a durable choice, so it uses the highest observed allocation
// per physical card across a short sample window instead of treating one idle
// instant as permanent capacity.
export function conservativeNvidiaGpuSample(samples) {
  if (!Array.isArray(samples) || !samples.length) throw new TypeError("Managed NVIDIA planning needs at least one GPU sample.");
  const merged = new Map();
  for (const sample of samples) {
    if (!Array.isArray(sample)) throw new TypeError("Every managed NVIDIA GPU sample must be an array.");
    sample.forEach((gpu, index) => {
      const key = gpuIdentity(gpu, index);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, { ...gpu });
        return;
      }
      merged.set(key, {
        ...current,
        ...gpu,
        usedBytes: Math.max(Number(current.usedBytes) || 0, Number(gpu.usedBytes) || 0),
        totalBytes: Math.min(Number(current.totalBytes) || Number.MAX_SAFE_INTEGER, Number(gpu.totalBytes) || Number.MAX_SAFE_INTEGER),
      });
    });
  }
  return [...merged.values()];
}

export function createNvidiaProfileInput({ engine, gpus, targetModelFacts, targetModelId = "" } = {}) {
  if (!engine?.launch || !engine?.modelFacts) throw new TypeError("Managed NVIDIA planning needs an attributed running llama.cpp engine.");
  const allNvidia = (Array.isArray(gpus) ? gpus : []).filter((gpu) => gpu?.vendor === "nvidia" && gpu.totalBytes && gpu.usedBytes !== undefined);
  if (!allNvidia.length) throw new TypeError("Managed NVIDIA planning needs live nvidia-smi capacity and usage for every selected card.");
  const selected = selectedDeviceIndices(engine.launch, allNvidia);
  const participants = allNvidia.filter((gpu, index) => selected.has(Number.isInteger(gpu.index) ? gpu.index : index));
  if (!participants.length) throw new TypeError("The llama.cpp launch does not name a usable NVIDIA device.");

  const ratios = splitRatios(engine.launch, participants);
  const runningFacts = engine.modelFacts;
  const facts = targetModelFacts || runningFacts;
  const modelBytes = positiveInteger(facts.weightBytes || facts.fileBytes, "Target model bytes");
  const runningModelBytes = positiveInteger(runningFacts.weightBytes || runningFacts.fileBytes, "Running model bytes");
  const currentContextTokens = positiveInteger(engine.launch.ctxSize, "The running llama.cpp context");
  const runningKvBytesPerToken = localHostKvBytesPerToken(runningFacts, engine.launch);
  const totalKvBytesPerToken = localHostKvBytesPerToken(facts, engine.launch);
  const modelMaxContextTokens = positiveInteger(facts.trainedContext || currentContextTokens, "The model context window");
  const allocations = participants.map((gpu, index) => {
    const ratio = ratios[index];
    const currentKvBytes = Math.round(currentContextTokens * runningKvBytesPerToken * ratio);
    const weightBytes = Math.round(modelBytes * ratio);
    // The 1.2 GiB operating reserve is already resident inside nvidia-smi's
    // used figure. Subtract it once here and let the profile calculator add it
    // back as headroom. Algebraically, the observed process remains the exact
    // baseline while extra KV can consume only genuinely free VRAM.
    const runningWeightBytes = Math.round(runningModelBytes * ratio);
    const observedFixed = Math.max(0, Math.round(gpu.usedBytes - currentKvBytes - LOCAL_HOST_MIN_HEADROOM_BYTES));
    // Project only the model's own shard into the target launch. Everything
    // else that nvidia-smi observed remains charged: WDDM, desktop use, draft
    // buffers, and llama.cpp's fixed runtime allocations do not disappear just
    // because the user selected a smaller GGUF.
    const staticBytes = Math.max(weightBytes, observedFixed - runningWeightBytes + weightBytes);
    return {
      id: gpu.uuid || `nvidia-${Number.isInteger(gpu.index) ? gpu.index : index}`,
      totalBytes: Math.round(gpu.totalBytes),
      staticBytes,
      kvBytesPerToken: Math.max(1, Math.round(totalKvBytesPerToken * ratio)),
      usedBytes: Math.round(gpu.usedBytes),
      currentKvBytes,
      weightBytes,
      runtimeReserveBytes: LOCAL_HOST_MIN_HEADROOM_BYTES,
    };
  });

  return {
    adapterId: "llamacpp-nvidia",
    // The slot-affinity probe uses this exact wire id immediately after the
    // managed restart. A selected GGUF may replace the endpoint's old id, so
    // never retain the observed model id when the caller supplied a target.
    modelId: String(targetModelId || "").trim() || engine.models?.[0] || path.basename(String(engine.launch.model || "local-model")),
    modelMaxContextTokens,
    gpus: allocations,
  };
}

export function selectNvidiaManagedProfile(options = {}) {
  const input = createNvidiaProfileInput(options);
  const profile = selectLocalHostLaneProfile(input);
  if (!profile.laneCount) throw new TypeError("No managed llama.cpp profile fits the selected NVIDIA cards with the required operating reserve.");
  return profile;
}

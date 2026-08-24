import assert from "node:assert/strict";
import test from "node:test";
import { conservativeNvidiaGpuSample, selectNvidiaManagedProfile } from "../src/local-host-nvidia.mjs";

const GiB = 1024 ** 3;

const ENGINE = {
  engine: "llamacpp",
  models: ["qwen3.8:27b"],
  launch: {
    model: "D:/models/qwen.gguf",
    ctxSize: 262_144,
    parallel: 1,
    splitMode: "tensor",
    cacheTypeK: "q4_0",
    cacheTypeV: "q4_0",
  },
  modelFacts: {
    weightBytes: 17_559_178_144,
    attentionLayers: 16,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    trainedContext: 262_144,
  },
};

test("the measured dual-5060-Ti ledger selects one full 262K lane", () => {
  const profile = selectNvidiaManagedProfile({
    engine: ENGINE,
    gpus: [
      { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 17_103_323_136, usedBytes: 16_408_117_248 },
      { index: 1, uuid: "gpu-1", vendor: "nvidia", totalBytes: 17_103_323_136, usedBytes: 14_426_308_608 },
    ],
  });
  assert.equal(profile.profileId, "static-p1-c262144");
  assert.equal(profile.laneCount, 1);
  assert.equal(profile.laneContextTokens, 262_144);
  assert.equal(profile.gpus.length, 2);
});

test("a smaller selected GGUF replaces only its weight shard in the live ledger", () => {
  const profile = selectNvidiaManagedProfile({
    engine: ENGINE,
    targetModelFacts: {
      ...ENGINE.modelFacts,
      weightBytes: 13_575_223_296,
      modelName: "Qwen3.8-27B",
      modelSlug: "Qwen3.8-27B",
    },
    targetModelId: "D:/models/Qwen3.8-27B-Q3_K_M.gguf",
    gpus: [
      { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 17_103_323_136, usedBytes: 16_110_321_664 },
      { index: 1, uuid: "gpu-1", vendor: "nvidia", totalBytes: 17_103_323_136, usedBytes: 14_428_405_760 },
    ],
  });
  assert.equal(profile.profileId, "static-p2-c262144");
  assert.equal(profile.laneCount, 2);
  assert.equal(profile.laneContextTokens, 262_144);
  assert.equal(profile.modelId, "D:/models/Qwen3.8-27B-Q3_K_M.gguf", "the post-restart slot probe targets the selected model, not the previous server id");
  assert.ok(profile.gpus.every((gpu) => gpu.meetsPreferredHeadroom), "the smaller GGUF does not erase observed WDDM/runtime allocation");
});

test("a single larger card can expose more equal lanes without exceeding three", () => {
  const profile = selectNvidiaManagedProfile({
    engine: { ...ENGINE, launch: { ...ENGINE.launch, splitMode: "none", mainGpu: 0 } },
    gpus: [{ index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 32 * GiB, usedBytes: 24 * GiB }],
  });
  assert.ok(profile.laneCount >= 2);
  assert.ok(profile.laneCount <= 3);
  assert.ok(profile.laneContextTokens >= Math.ceil(262_144 * 0.75));
});

test("managed selection keeps each card's highest observed WDDM allocation", () => {
  const selected = conservativeNvidiaGpuSample([
    [
      { index: 0, uuid: "gpu-0", totalBytes: 16 * GiB, usedBytes: 13 * GiB },
      { index: 1, uuid: "gpu-1", totalBytes: 16 * GiB, usedBytes: 14 * GiB },
    ],
    [
      { index: 0, uuid: "gpu-0", totalBytes: 16 * GiB, usedBytes: 15 * GiB },
      { index: 1, uuid: "gpu-1", totalBytes: 16 * GiB, usedBytes: 12 * GiB },
    ],
  ]);
  assert.equal(selected[0].usedBytes, 15 * GiB);
  assert.equal(selected[1].usedBytes, 14 * GiB);
});

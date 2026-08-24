import assert from "node:assert/strict";
import test from "node:test";
import {
  createCalibratedNvidiaProfileInput,
  createNvidiaProfileInput,
  LOCAL_HOST_NVIDIA_RUNTIME_RESERVE_BYTES,
  LOCAL_HOST_NVIDIA_SYSTEM_RESERVE_BYTES,
  selectNvidiaProfileFromInput,
  selectNvidiaManagedProfile,
} from "../src/local-host-nvidia.mjs";

const GiB = 1024 ** 3;

const TARGET = {
  weightBytes: 4 * GiB,
  attentionLayers: 16,
  headCountKv: 4,
  keyLength: 256,
  valueLength: 256,
  trainedContext: 262_144,
};

function singleGpuWithKvBudget(kvBudgetGiB) {
  return [{
    index: 0,
    uuid: "gpu-0",
    vendor: "nvidia",
    totalBytes: TARGET.weightBytes
      + LOCAL_HOST_NVIDIA_SYSTEM_RESERVE_BYTES
      + LOCAL_HOST_NVIDIA_RUNTIME_RESERVE_BYTES
      + GiB
      + kvBudgetGiB * GiB,
  }];
}

test("target-first capacity turns available KV bytes into P and context", () => {
  const twoGiB = selectNvidiaManagedProfile({ gpus: singleGpuWithKvBudget(2), targetModelFacts: TARGET });
  assert.equal(twoGiB.profileId, "static-p1-c131072", "2 GiB at 16 KiB/token is 131K for one session");

  const fiveGiB = selectNvidiaManagedProfile({ gpus: singleGpuWithKvBudget(5), targetModelFacts: TARGET });
  assert.equal(fiveGiB.profileId, "static-p1-c262144", "5 GiB reaches the model's full P1 window");

  const sevenGiB = selectNvidiaManagedProfile({ gpus: singleGpuWithKvBudget(7), targetModelFacts: TARGET });
  assert.equal(sevenGiB.profileId, "static-p2-c229376", "7 GiB is two long equal sessions, not an unsafe P3");

  const tenGiB = selectNvidiaManagedProfile({ gpus: singleGpuWithKvBudget(10), targetModelFacts: TARGET });
  assert.equal(tenGiB.profileId, "static-p2-c262144", "two full windows beat three reduced windows");
});

test("target ledger ignores all old-process context and observed usage", () => {
  const gpus = [
    { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 16 * GiB, usedBytes: 15.9 * GiB },
    { index: 1, uuid: "gpu-1", vendor: "nvidia", totalBytes: 16 * GiB, usedBytes: 2 * GiB },
  ];
  const first = createNvidiaProfileInput({
    gpus,
    targetModelFacts: TARGET,
    targetModelId: "D:/models/target.gguf",
    // These are deliberately irrelevant stale process fields. Passing them
    // cannot affect the pure target calculator.
    engine: { launch: { ctxSize: 262_144, parallel: 1 }, modelFacts: { weightBytes: 99 * GiB } },
  });
  const second = createNvidiaProfileInput({
    gpus: gpus.map((gpu) => ({ ...gpu, usedBytes: 0 })),
    targetModelFacts: TARGET,
    targetModelId: "D:/models/target.gguf",
    engine: { launch: { ctxSize: 4_096, parallel: 3 }, modelFacts: { weightBytes: GiB } },
  });
  assert.deepEqual(first, second);
  assert.ok(first.gpus.every((gpu) => gpu.staticBytes === gpu.weightBytes + gpu.systemReserveBytes + gpu.runtimeReserveBytes));
});

test("target calibration measures the real Windows baseline and llama footprint", () => {
  const target = createNvidiaProfileInput({
    gpus: [{ index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 16 * GiB }],
    targetModelFacts: TARGET,
    visionProjectorBytes: GiB,
  });
  const allocation = target.gpus[0];
  const baselineUsedBytes = Math.round(1.25 * GiB);
  const measuredRuntimeBytes = Math.round(2.5 * GiB);
  const calibrationContextTokens = 8_192;
  const calibrationUsedBytes = baselineUsedBytes
    + allocation.weightBytes
    + allocation.projectorBytes
    + measuredRuntimeBytes
    + (calibrationContextTokens * allocation.kvBytesPerToken);
  const calibrated = createCalibratedNvidiaProfileInput({
    target,
    baselineSample: [{ index: 0, uuid: "gpu-0", usedBytes: baselineUsedBytes }],
    calibrationContextTokens,
    calibrationSample: [{ index: 0, uuid: "gpu-0", usedBytes: calibrationUsedBytes }],
  });
  assert.equal(calibrated.gpus[0].systemReserveBytes, baselineUsedBytes);
  assert.equal(calibrated.gpus[0].runtimeReserveBytes, measuredRuntimeBytes);
  assert.equal(
    calibrated.gpus[0].staticBytes,
    baselineUsedBytes + allocation.weightBytes + allocation.projectorBytes + measuredRuntimeBytes,
  );
  const profile = selectNvidiaProfileFromInput(calibrated);
  assert.ok(profile.gpus[0].remainingBytes >= GiB, "final selection keeps the separate one GiB headroom after measured fixed costs");
});

test("a zero-use secondary GPU is a valid calibration baseline", () => {
  const target = createNvidiaProfileInput({
    gpus: [{ index: 1, uuid: "gpu-1", vendor: "nvidia", totalBytes: 16 * GiB }],
    targetModelFacts: TARGET,
  });
  const allocation = target.gpus[0];
  const calibrationContextTokens = 8_192;
  const runtimeReserveBytes = 2 * GiB;
  const calibrated = createCalibratedNvidiaProfileInput({
    target,
    baselineSample: [{ index: 1, uuid: "gpu-1", usedBytes: 0 }],
    calibrationContextTokens,
    calibrationSample: [{
      index: 1,
      uuid: "gpu-1",
      usedBytes: allocation.weightBytes + runtimeReserveBytes + (calibrationContextTokens * allocation.kvBytesPerToken),
    }],
  });
  assert.equal(calibrated.gpus[0].systemReserveBytes, 0);
  assert.equal(calibrated.gpus[0].runtimeReserveBytes, runtimeReserveBytes);
});

test("projector is charged to its primary card and constrains an asymmetric pair", () => {
  const withoutVision = selectNvidiaManagedProfile({
    gpus: [
      { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 12 * GiB },
      { index: 1, uuid: "gpu-1", vendor: "nvidia", totalBytes: 16 * GiB },
    ],
    targetModelFacts: TARGET,
  });
  const withVision = selectNvidiaManagedProfile({
    gpus: [
      { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 12 * GiB },
      { index: 1, uuid: "gpu-1", vendor: "nvidia", totalBytes: 16 * GiB },
    ],
    targetModelFacts: TARGET,
    visionProjectorBytes: GiB,
  });
  assert.equal(withVision.gpus[0].projectorBytes, GiB);
  assert.equal(withVision.gpus[1].projectorBytes, 0);
  assert.ok(withVision.gpus[0].remainingBytes < withVision.gpus[1].remainingBytes, "the more constrained primary card remains the binding ledger entry");
  assert.ok(withoutVision.gpus.every((gpu) => gpu.remainingBytes >= GiB));
});

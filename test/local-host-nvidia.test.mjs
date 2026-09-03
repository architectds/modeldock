import assert from "node:assert/strict";
import test from "node:test";
import {
  createCalibratedNvidiaProfileInput,
  createNvidiaProfileInput,
  estimateNvidiaRuntimeCapacity,
  optimisticNvidiaParallelContext,
  selectNvidiaRuntimeProfile,
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

function targetForGpus(gpus, options = {}) {
  return createNvidiaProfileInput({
    gpus: gpus.map((totalBytes, index) => ({
      index,
      uuid: `gpu-${index}`,
      vendor: "nvidia",
      totalBytes,
    })),
    targetModelFacts: TARGET,
    ...options,
  });
}

function sampleAt(target, fixedBytes, contextTokens, laneCount = 1) {
  return target.gpus.map((allocation, index) => {
    const fixed = Array.isArray(fixedBytes) ? fixedBytes[index] : fixedBytes;
    const usedBytes = allocation.weightBytes
      + allocation.projectorBytes
      + fixed
      + (contextTokens * allocation.kvBytesPerToken * laneCount);
    return {
      uuid: allocation.id,
      usedBytes,
      freeBytes: allocation.totalBytes - usedBytes,
    };
  });
}

function calibratedEstimate(target, fixedBytes, { parallel = [] } = {}) {
  const bootstrapContext = 8_192;
  const slopeContext = 16_384;
  const parallelSamples = {};
  for (const laneCount of parallel) {
    parallelSamples[laneCount] = sampleAt(target, fixedBytes, bootstrapContext, laneCount);
  }
  return estimateNvidiaRuntimeCapacity({
    target,
    bootstrapSample: sampleAt(target, fixedBytes, bootstrapContext),
    slopeSample: sampleAt(target, fixedBytes, slopeContext),
    parallelSamples,
  });
}

function safeContext(nominal) {
  return Math.floor(Math.floor(nominal * 0.9) / 256) * 256;
}

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
  assert.ok(calibrated.gpus[0].staticBytes < calibrated.gpus[0].totalBytes, "calibration keeps the measured fixed footprint below card capacity");
});

test("runtime calibration calculates one profile instead of scanning P/C rungs", () => {
  const target = createNvidiaProfileInput({
    gpus: [{ index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 16 * GiB }],
    targetModelFacts: TARGET,
  });
  const allocation = target.gpus[0];
  const bootstrapContext = 8_192;
  const slopeContext = 16_384;
  const fixedReserve = 4 * GiB;
  const bootstrapKv = bootstrapContext * allocation.kvBytesPerToken;
  const bootstrapUsed = allocation.weightBytes + fixedReserve + bootstrapKv;
  const bootstrapFree = 16 * GiB - bootstrapUsed;
  const runtimeSlope = 20 * 1024;
  const slopeUsed = bootstrapUsed + ((slopeContext - bootstrapContext) * runtimeSlope);
  const slopeFree = 16 * GiB - slopeUsed;
  const estimate = estimateNvidiaRuntimeCapacity({
    target,
    bootstrapSample: [{ index: 0, uuid: "gpu-0", usedBytes: bootstrapUsed, freeBytes: bootstrapFree }],
    slopeSample: [{ index: 0, uuid: "gpu-0", usedBytes: slopeUsed, freeBytes: slopeFree }],
    parallelSamples: { 2: [{
      index: 0,
      uuid: "gpu-0",
      usedBytes: bootstrapUsed + (128 * 1024 ** 2),
      freeBytes: bootstrapFree - (128 * 1024 ** 2),
    }] },
  });
  assert.equal(estimate.gpus[0].fixedReserveBytes, fixedReserve);
  assert.ok(optimisticNvidiaParallelContext(estimate, 2) < Math.ceil(TARGET.trainedContext * 0.75));
  const profile = selectNvidiaRuntimeProfile(estimate);
  assert.equal(profile.laneCount, 1);
  assert.equal(profile.laneContextTokens, 235_776, "the calculator selects one conservative 90% profile");
});

test("calibrated capacity derives context from the target card, not a static P/C table", () => {
  const twoGiB = targetForGpus([16 * GiB]);
  const twoGiBEstimate = calibratedEstimate(twoGiB, 9 * GiB);
  assert.equal(twoGiBEstimate.lanes[0].nominalContextTokens, 131_072);
  assert.equal(twoGiBEstimate.lanes[0].safeContextTokens, safeContext(131_072));
  assert.equal(selectNvidiaRuntimeProfile(twoGiBEstimate).laneCount, 1);

  const fiveGiB = targetForGpus([16 * GiB]);
  const fiveGiBEstimate = calibratedEstimate(fiveGiB, 6 * GiB);
  assert.equal(fiveGiBEstimate.lanes[0].nominalContextTokens, TARGET.trainedContext);
  assert.equal(selectNvidiaRuntimeProfile(fiveGiBEstimate).laneContextTokens, 235_776);

  const sevenGiB = targetForGpus([16 * GiB]);
  const sevenGiBEstimate = calibratedEstimate(sevenGiB, 4 * GiB, { parallel: [2] });
  assert.equal(sevenGiBEstimate.lanes[1].nominalContextTokens, 229_376);
  assert.equal(sevenGiBEstimate.lanes[1].safeContextTokens, safeContext(229_376));
  assert.equal(selectNvidiaRuntimeProfile(sevenGiBEstimate).laneCount, 2,
    "two lanes are selected only after the measured safe window clears the long-context floor");
});

test("the weakest physical card binds an equal-lane pair", () => {
  const target = targetForGpus([16 * GiB, 16 * GiB]);
  const estimate = calibratedEstimate(target, [10 * GiB, 12 * GiB], { parallel: [2] });
  assert.equal(estimate.lanes[1].nominalContextTokens, 65_536,
    "the card with the smaller free budget determines P2 context");
  assert.equal(estimate.lanes[1].safeContextTokens, safeContext(65_536));
  assert.equal(selectNvidiaRuntimeProfile(estimate).laneCount, 1,
    "P2 is rejected when its weakest-card safe context is below 75 percent");
  assert.ok(estimate.lanes[1].bootstrapFreeBytes[0] > estimate.lanes[1].bootstrapFreeBytes[1]);
});

test("measured P2 and P3 samples preserve the lane policy and three-lane ceiling", () => {
  const longPair = targetForGpus([24 * GiB, 24 * GiB]);
  const pairEstimate = calibratedEstimate(longPair, [17 * GiB, 17 * GiB], { parallel: [2] });
  const pairProfile = selectNvidiaRuntimeProfile(pairEstimate);
  assert.equal(pairProfile.laneCount, 2);
  assert.equal(pairProfile.laneContextTokens, 235_776);
  assert.equal(pairProfile.totalContextTokens, 471_552);

  const largePair = targetForGpus([64 * GiB, 64 * GiB]);
  const threeLaneEstimate = calibratedEstimate(largePair, [18 * GiB, 18 * GiB], { parallel: [2, 3] });
  const threeLaneProfile = selectNvidiaRuntimeProfile(threeLaneEstimate);
  assert.equal(threeLaneProfile.laneCount, 3);
  assert.equal(threeLaneProfile.laneContextTokens, TARGET.trainedContext);
  assert.equal(threeLaneProfile.totalContextTokens, 3 * TARGET.trainedContext);
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

test("the target projector is charged to one physical card before splitting weights", () => {
  const withoutVision = targetForGpus([12 * GiB, 16 * GiB]);
  const withVision = targetForGpus([12 * GiB, 16 * GiB], { visionProjectorBytes: GiB });
  assert.equal(withVision.gpus[0].projectorBytes, GiB);
  assert.equal(withVision.gpus[1].projectorBytes, 0);
  assert.ok(withVision.tensorSplit[0] < withoutVision.tensorSplit[0],
    "the projector reduces the primary card's target tensor capacity");
  assert.ok(withVision.gpus[0].staticBytes > withVision.gpus[1].staticBytes,
    "the projector remains visible in the primary card's fixed ledger");
});

test("the NVIDIA calculator rejects missing physical or target facts", () => {
  assert.throws(() => createNvidiaProfileInput({ gpus: [], targetModelFacts: TARGET }), /physical capacity/);
  assert.throws(() => createNvidiaProfileInput({
    gpus: [{ index: 0, uuid: "gpu-0", vendor: "amd", totalBytes: 16 * GiB }],
    targetModelFacts: TARGET,
  }), /physical capacity/);
  assert.throws(() => createNvidiaProfileInput({
    gpus: [{ index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 16 * GiB }],
  }), /target GGUF facts/);
  const target = targetForGpus([16 * GiB, 16 * GiB]);
  const sample = sampleAt(target, 9 * GiB, 8_192);
  assert.throws(() => estimateNvidiaRuntimeCapacity({
    target,
    bootstrapSample: sample,
    slopeSample: [sample[0]],
  }), /missing a physical usage sample/);
});

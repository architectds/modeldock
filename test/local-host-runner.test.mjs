import assert from "node:assert/strict";
import test from "node:test";
import { beginHostApply, createObservedHost, markHostApplying, markHostVerified, markHostVerifying, takeOverHost } from "../src/local-hosts.mjs";
import { applyLocalHostPlan, calibrateAndApplyLocalHostPlan, reconcileInterruptedLocalHost, verifyLocalHost } from "../src/local-host-runner.mjs";

const OBSERVED = {
  id: "host-qwen",
  adapterId: "llamacpp-nvidia",
  endpoint: "http://127.0.0.1:11435/v1",
  launch: { binary: "D:/llama-cpp/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] },
  observedAt: "2026-08-23T00:00:00.000Z",
};

const KV_STATE = { directory: "D:/ModelDock/KV", budgetBytes: 64 * 1024 ** 3 };

function readyHost() {
  return markHostVerified(takeOverHost(createObservedHost(OBSERVED), { kvState: KV_STATE }));
}

function operations({ drainError, stopError, verifyResults = [true] } = {}) {
  const calls = [];
  let verifyIndex = 0;
  return {
    calls,
    async persist(record) { calls.push(`persist:${record.state}`); },
    async drain() {
      calls.push("drain");
      if (drainError) throw new Error(drainError);
    },
    async stop() {
      calls.push("stop");
      if (stopError) throw new Error(stopError);
    },
    async start(spec) { calls.push(`start:${spec.args.at(-1)}`); },
    async verify() {
      calls.push("verify");
      return verifyResults[verifyIndex++] ?? false;
    },
  };
}

const REPLACEMENT = { binary: OBSERVED.launch.binary, args: [...OBSERVED.launch.args, "--parallel", "2"] };

test("takeover verification never restarts an observed process", async () => {
  const takenOver = takeOverHost(createObservedHost(OBSERVED), { kvState: KV_STATE });
  const fake = operations({ verifyResults: [true] });
  const result = await verifyLocalHost(takenOver, fake);
  assert.equal(result.outcome, "verified");
  assert.equal(result.record.state, "ready");
  assert.deepEqual(fake.calls, ["verify", "persist:ready"]);

  const failed = await verifyLocalHost(takeOverHost(createObservedHost(OBSERVED), { kvState: KV_STATE }), operations({ verifyResults: [false] }));
  assert.equal(failed.outcome, "degraded");
  assert.equal(failed.record.state, "degraded");
});

test("a degraded host that never replaced its original survives a failing drain as degraded", async () => {
  // Reproduced live: first takeover verification failed (record degraded,
  // activeSpec still null), a retry or release then hit a failing drain, and
  // abortHostApply - which requires an activeSpec to return to - threw an
  // unstructured TypeError with the record already persisted as "draining".
  // Every later apply and unmanage refused that state until a gateway restart.
  const degraded = (await verifyLocalHost(
    takeOverHost(createObservedHost(OBSERVED), { kvState: KV_STATE }),
    operations({ verifyResults: [false] }),
  )).record;
  assert.equal(degraded.activeSpec, null, "a failed first takeover has no active specification");
  const fake = operations({ drainError: "engine is still serving" });
  const result = await applyLocalHostPlan(degraded, { desiredSpec: REPLACEMENT }, fake);
  assert.equal(result.outcome, "degraded");
  assert.equal(result.record.state, "degraded");
  assert.equal(fake.calls.at(-1), "persist:degraded", "the durable record must not rest in draining");
});

test("runner persists each lifecycle boundary and promotes a verified replacement", async () => {
  const fake = operations();
  const result = await applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT, policy: "workers" }, fake);
  assert.equal(result.outcome, "applied");
  assert.equal(result.record.state, "ready");
  assert.deepEqual(result.record.activeSpec, REPLACEMENT);
  assert.deepEqual(result.record.preTakeoverSpec, OBSERVED.launch);
  assert.deepEqual(fake.calls, [
    "persist:draining", "drain", "persist:applying", "stop", "start:2", "persist:verifying", "verify", "persist:ready",
  ]);
});

test("target calibration samples baseline only after stop, then applies its derived final profile", async () => {
  const fake = operations({ verifyResults: [true, true] });
  const calibrationSpec = { binary: OBSERVED.launch.binary, args: [...OBSERVED.launch.args, "-c", "8192"] };
  const finalProfile = {
    adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "static-p2-c200000",
    laneCount: 2, laneContextTokens: 200_000, totalContextTokens: 400_000,
  };
  const result = await calibrateAndApplyLocalHostPlan(readyHost(), {
    calibrationSpec,
    calibrationProfile: {
      adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calibration-p1-c8192",
      laneCount: 1, laneContextTokens: 8_192, totalContextTokens: 8_192,
    },
    measureBaseline: async () => {
      assert.ok(fake.calls.includes("stop"), "baseline cannot be sampled while the old llama process remains resident");
      return { gpu0: 123 };
    },
    measureCalibration: async () => ({ gpu0: 456 }),
    targetCapabilities: { model: "D:/models/target.gguf", visionProjectorPath: "D:/models/mmproj.gguf" },
    createFinalPlan: async ({ baseline, target }) => {
      assert.deepEqual(baseline, { gpu0: 123 });
      assert.deepEqual(target, { gpu0: 456 });
      return { desiredSpec: REPLACEMENT, desiredProfile: finalProfile };
    },
  }, fake);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(result.record.activeProfile, finalProfile);
  assert.equal(result.record.capabilities.visionProjectorPath, "D:/models/mmproj.gguf");
  assert.equal(fake.calls.filter((entry) => entry === "stop").length, 2);
});

test("named calibration measures the formula inputs and skips an impossible P2 probe", async () => {
  const fake = operations({ verifyResults: [true, true, true] });
  const profiles = {
    bootstrap: { adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calibration-bootstrap-p1-c8192", laneCount: 1, laneContextTokens: 8_192, totalContextTokens: 8_192 },
    slope: { adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calibration-slope-p1-c16384", laneCount: 1, laneContextTokens: 16_384, totalContextTokens: 16_384 },
    p2: { adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calibration-p2-p2-c8192", laneCount: 2, laneContextTokens: 8_192, totalContextTokens: 16_384 },
    final: { adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calculated-p1-c235776", laneCount: 1, laneContextTokens: 235_776, totalContextTokens: 235_776 },
  };
  const spec = (name) => ({ binary: OBSERVED.launch.binary, args: [...OBSERVED.launch.args, name] });
  const result = await calibrateAndApplyLocalHostPlan(readyHost(), {
    calibrationSteps: [
      { id: "bootstrap", desiredSpec: spec("bootstrap"), desiredProfile: profiles.bootstrap },
      { id: "slope", desiredSpec: spec("slope"), desiredProfile: profiles.slope },
      { id: "p2", desiredSpec: spec("p2"), desiredProfile: profiles.p2, optional: true, shouldRun: () => false },
    ],
    measureBaseline: async () => ({ gpu0: "baseline" }),
    measureCalibration: async (_record, step) => ({ step: step.id }),
    createFinalPlan: async ({ baseline, measurements }) => {
      assert.deepEqual(baseline, { gpu0: "baseline" });
      assert.deepEqual(measurements, { bootstrap: { step: "bootstrap" }, slope: { step: "slope" } });
      return { desiredSpec: spec("final"), desiredProfile: profiles.final };
    },
  }, fake);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(result.record.activeProfile, profiles.final);
  assert.deepEqual(fake.calls.filter((entry) => entry.startsWith("start:")), ["start:bootstrap", "start:slope", "start:final"]);
});

test("a calculated final profile gets one nearby backoff instead of a P/C scan", async () => {
  const fake = operations({ verifyResults: [true, false, true, true] });
  const calibrationSpec = { binary: OBSERVED.launch.binary, args: [...OBSERVED.launch.args, "-c", "8192"] };
  const calculated = { adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calculated-p1-c235776", laneCount: 1, laneContextTokens: 235_776, totalContextTokens: 235_776 };
  const fallback = { adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calculated-p1-c212096-backoff", laneCount: 1, laneContextTokens: 212_096, totalContextTokens: 212_096 };
  const calculatedSpec = { binary: OBSERVED.launch.binary, args: [...OBSERVED.launch.args, "-c", String(calculated.totalContextTokens)] };
  const fallbackSpec = { binary: OBSERVED.launch.binary, args: [...OBSERVED.launch.args, "-c", String(fallback.totalContextTokens)] };
  const result = await calibrateAndApplyLocalHostPlan(readyHost(), {
    calibrationSpec,
    calibrationProfile: { adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calibration-p1-c8192", laneCount: 1, laneContextTokens: 8_192, totalContextTokens: 8_192 },
    measureBaseline: async () => ({ gpu0: 1 }),
    measureCalibration: async () => ({ gpu0: 2 }),
    createFinalPlan: async () => ({ desiredSpec: calculatedSpec, desiredProfile: calculated }),
    createFallbackPlan: async () => ({ desiredSpec: fallbackSpec, desiredProfile: fallback }),
  }, fake);
  assert.equal(result.outcome, "applied");
  assert.deepEqual(result.record.activeProfile, fallback);
  assert.equal(fake.calls.filter((entry) => entry === "stop").length, 4, "bootstrap, calculated attempt, recovery, nearby backoff");
});

test("a target-calibration derivation failure restores the immutable pre-takeover argv", async () => {
  const fake = operations({ verifyResults: [true, true] });
  const calibrationSpec = { binary: OBSERVED.launch.binary, args: [...OBSERVED.launch.args, "-c", "8192"] };
  const result = await calibrateAndApplyLocalHostPlan(readyHost(), {
    calibrationSpec,
    calibrationProfile: {
      adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "calibration-p1-c8192",
      laneCount: 1, laneContextTokens: 8_192, totalContextTokens: 8_192,
    },
    measureBaseline: async () => ({ gpu0: 1 }),
    measureCalibration: async () => ({ gpu0: 2 }),
    createFinalPlan: async () => { throw new Error("calibration slope invalid"); },
  }, fake);
  assert.equal(result.outcome, "recovered");
  assert.deepEqual(result.record.activeSpec, OBSERVED.launch);
  assert.match(result.failure, /calibration slope invalid/);
});

test("runner restores the immutable pre-takeover launch after replacement verification fails", async () => {
  const fake = operations({ verifyResults: [false, true] });
  const result = await applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT }, fake);
  assert.equal(result.outcome, "recovered");
  assert.equal(result.record.state, "ready");
  assert.deepEqual(result.record.activeSpec, OBSERVED.launch);
  assert.deepEqual(result.record.preTakeoverSpec, OBSERVED.launch);
  assert.deepEqual(result.record.desiredSpec, OBSERVED.launch);
  assert.deepEqual(fake.calls, [
    "persist:draining", "drain", "persist:applying", "stop", "start:2", "persist:verifying", "verify",
    "persist:recovering", "stop", "start:262144", "persist:verifying", "verify", "persist:ready",
  ]);
});

test("runner leaves a verified service alone when drain failed before stop", async () => {
  const fake = operations({ drainError: "still serving a request" });
  const result = await applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT }, fake);
  assert.equal(result.outcome, "unchanged");
  assert.equal(result.record.state, "ready");
  assert.deepEqual(result.record.desiredSpec, OBSERVED.launch);
  assert.match(result.record.failure, /still serving/);
  assert.deepEqual(fake.calls, ["persist:draining", "drain", "persist:ready"]);
});

test("an uncertain stop is treated as a replacement attempt and recovers the known-good host", async () => {
  const fake = operations();
  let stops = 0;
  fake.stop = async () => {
    fake.calls.push("stop");
    if (stops++ === 0) throw new Error("stop timed out after signalling process");
  };
  const result = await applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT }, fake);
  assert.equal(result.outcome, "recovered");
  assert.deepEqual(result.record.desiredSpec, OBSERVED.launch);
  assert.ok(fake.calls.includes("persist:recovering"));
});

test("runner reports degraded only after both replacement and recovery fail", async () => {
  const fake = operations({ verifyResults: [false, false] });
  const result = await applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT }, fake);
  assert.equal(result.outcome, "degraded");
  assert.equal(result.record.state, "degraded");
  assert.match(result.record.failure, /verification did not report success/);
  assert.equal(fake.calls.at(-1), "persist:degraded");
});

test("runner requires every injected lifecycle operation", async () => {
  await assert.rejects(
    () => applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT }, { persist: async () => {} }),
    /needs a drain operation/,
  );
});

test("boot reconciliation restores pre-takeover argv after an interrupted replacement", async () => {
  let interrupted = beginHostApply(readyHost(), { desiredSpec: REPLACEMENT });
  interrupted = markHostApplying(interrupted);
  interrupted = markHostVerifying(interrupted);
  const fake = operations({ verifyResults: [false, true] });
  const result = await reconcileInterruptedLocalHost(interrupted, fake);
  assert.equal(result.outcome, "recovered");
  assert.deepEqual(result.record.activeSpec, OBSERVED.launch);
  assert.deepEqual(result.record.preTakeoverSpec, OBSERVED.launch);
  assert.ok(fake.calls.includes("persist:recovering"));
});

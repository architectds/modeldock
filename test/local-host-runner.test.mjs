import assert from "node:assert/strict";
import test from "node:test";
import { createObservedHost, markHostVerified, takeOverHost } from "../src/local-hosts.mjs";
import { applyLocalHostPlan, verifyLocalHost } from "../src/local-host-runner.mjs";

const OBSERVED = {
  id: "host-qwen",
  adapterId: "llamacpp-nvidia",
  endpoint: "http://127.0.0.1:11435/v1",
  launch: { binary: "D:/llama-cpp/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] },
  observedAt: "2026-08-23T00:00:00.000Z",
};

function readyHost() {
  return markHostVerified(takeOverHost(createObservedHost(OBSERVED)));
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
  const takenOver = takeOverHost(createObservedHost(OBSERVED));
  const fake = operations({ verifyResults: [true] });
  const result = await verifyLocalHost(takenOver, fake);
  assert.equal(result.outcome, "verified");
  assert.equal(result.record.state, "ready");
  assert.deepEqual(fake.calls, ["verify", "persist:ready"]);

  const failed = await verifyLocalHost(takeOverHost(createObservedHost(OBSERVED)), operations({ verifyResults: [false] }));
  assert.equal(failed.outcome, "degraded");
  assert.equal(failed.record.state, "degraded");
});

test("runner persists each lifecycle boundary and promotes a verified replacement", async () => {
  const fake = operations();
  const result = await applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT, policy: "workers" }, fake);
  assert.equal(result.outcome, "applied");
  assert.equal(result.record.state, "ready");
  assert.deepEqual(result.record.lastKnownGoodSpec, REPLACEMENT);
  assert.deepEqual(fake.calls, [
    "persist:draining", "drain", "persist:applying", "stop", "start:2", "persist:verifying", "verify", "persist:ready",
  ]);
});

test("runner restores the persisted known-good launch after replacement verification fails", async () => {
  const fake = operations({ verifyResults: [false, true] });
  const result = await applyLocalHostPlan(readyHost(), { desiredSpec: REPLACEMENT }, fake);
  assert.equal(result.outcome, "recovered");
  assert.equal(result.record.state, "ready");
  assert.deepEqual(result.record.lastKnownGoodSpec, OBSERVED.launch);
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

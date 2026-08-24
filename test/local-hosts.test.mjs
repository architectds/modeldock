import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_HOST_ADAPTERS,
  LOCAL_HOST_POLICIES,
  beginHostApply,
  beginHostRecovery,
  createObservedHost,
  markHostApplying,
  markHostDegraded,
  markHostVerified,
  markHostVerifying,
  normalizeLaunchSpec,
  takeOverHost,
} from "../src/local-hosts.mjs";

const OBSERVED = {
  id: "host-qwen",
  adapterId: "llamacpp-nvidia",
  endpoint: "http://127.0.0.1:11435/v1",
  launch: {
    binary: "D:/llama-cpp-cuda/bin/llama-server.exe",
    args: ["-m", "D:/models/qwen.gguf", "-c", "262144", "--parallel", "1"],
  },
  capabilities: { build: "b10549", gpuCount: 2 },
  observedAt: "2026-08-23T00:00:00.000Z",
};

const KV_STATE = { directory: "D:/ModelDock/KV", budgetBytes: 64 * 1024 ** 3 };

test("the initial managed-host scope is NVIDIA llama.cpp and Apple MLX only", () => {
  assert.deepEqual(Object.keys(LOCAL_HOST_ADAPTERS).sort(), ["llamacpp-nvidia", "mlx-apple"]);
  assert.equal(LOCAL_HOST_ADAPTERS["llamacpp-nvidia"].candidateProfiles, "calibration_required");
  assert.equal(LOCAL_HOST_ADAPTERS["mlx-apple"].candidateProfiles, "hardware_validation_required");
  assert.deepEqual(LOCAL_HOST_POLICIES, ["automatic", "focus", "elastic", "workers"]);
});

test("an observed host carries facts but grants no lifecycle authority", () => {
  const observed = createObservedHost(OBSERVED);
  assert.equal(observed.state, "observed");
  assert.equal(observed.desiredSpec, null);
  assert.equal(observed.lastKnownGoodSpec, null);
  assert.deepEqual(observed.observedSpec, OBSERVED.launch);
  assert.deepEqual(observed.capabilities, OBSERVED.capabilities);
});

test("takeover records a desired spec but requires verification before it is known good", () => {
  const observed = createObservedHost(OBSERVED);
  const taken = takeOverHost(observed, { policy: "elastic", kvState: KV_STATE, at: "2026-08-23T00:01:00.000Z" });
  assert.equal(taken.state, "verifying");
  assert.equal(taken.policy, "elastic");
  assert.deepEqual(taken.desiredSpec, OBSERVED.launch);
  assert.deepEqual(taken.kvState, { version: 1, ...KV_STATE });
  assert.equal(taken.lastKnownGoodSpec, null);
  assert.equal(observed.state, "observed", "takeover is immutable");
  assert.throws(() => takeOverHost(taken), /Only an observed host/);
});

test("a verified apply promotes only the verified desired spec to last known good", () => {
  let record = takeOverHost(createObservedHost(OBSERVED), { kvState: KV_STATE });
  record = markHostVerified(record, { at: "2026-08-23T00:02:00.000Z" });
  const original = record.lastKnownGoodSpec;
  record = beginHostApply(record, {
    desiredSpec: { ...OBSERVED.launch, args: [...OBSERVED.launch.args.slice(0, -1), "4"] },
    policy: "workers",
    at: "2026-08-23T00:03:00.000Z",
  });
  assert.equal(record.state, "draining");
  assert.deepEqual(record.lastKnownGoodSpec, original, "planning must not overwrite the recovery target");
  record = markHostApplying(record);
  record = markHostVerifying(record);
  record = markHostVerified(record, { at: "2026-08-23T00:04:00.000Z" });
  assert.equal(record.state, "ready");
  assert.equal(record.policy, "workers");
  assert.equal(record.lastKnownGoodSpec.args.at(-1), "4");
});

test("a failed replacement returns to the last known good spec before a host can degrade", () => {
  let record = takeOverHost(createObservedHost(OBSERVED), { kvState: KV_STATE });
  record = markHostVerified(record);
  const original = record.lastKnownGoodSpec;
  record = beginHostApply(record, {
    desiredSpec: { ...OBSERVED.launch, args: [...OBSERVED.launch.args, "--bad-flag"] },
  });
  record = markHostApplying(record);
  record = markHostVerifying(record);
  record = beginHostRecovery(record, { reason: "replacement_did_not_verify" });
  assert.equal(record.state, "recovering");
  assert.deepEqual(record.desiredSpec, original);
  const degraded = markHostDegraded(record, { failure: "known-good process would not start" });
  assert.equal(degraded.state, "degraded");
  assert.match(degraded.failure, /known-good process/);
});

test("host records reject guessed adapters, malformed argv, and invalid transitions", () => {
  assert.throws(() => createObservedHost({ ...OBSERVED, adapterId: "ollama" }), /Unsupported local host adapter/);
  assert.throws(() => takeOverHost(createObservedHost(OBSERVED)), /explicit KV state disk budget/);
  assert.throws(() => normalizeLaunchSpec({ binary: "x", args: "--bad" }), /string array/);
  assert.throws(() => beginHostApply(createObservedHost(OBSERVED), { desiredSpec: OBSERVED.launch }), /state is observed/);
});

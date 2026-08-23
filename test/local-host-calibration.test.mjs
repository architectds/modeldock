import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalHostCalibrationPlan,
  recordLocalHostCalibrationResult,
  selectVerifiedCalibrationProfile,
} from "../src/local-host-calibration.mjs";

const CANDIDATE = {
  id: "dual-gpu-focus",
  modelId: "qwen3.8:27b",
  launchSpec: { binary: "D:/llama-cpp/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] },
};

const CAPACITY = {
  adapterId: "llamacpp-nvidia",
  modelId: "qwen3.8:27b",
  profileId: "dual-gpu-focus",
  maxSingleRequestTokens: 262_144,
  outputReserveTokens: 16_384,
  maxActiveRequests: 1,
};

test("calibration stores only injected candidates and numeric measurements", () => {
  let plan = createLocalHostCalibrationPlan({ hostId: "host-qwen", adapterId: "llamacpp-nvidia", candidates: [CANDIDATE] });
  plan = recordLocalHostCalibrationResult(plan, {
    candidateId: "dual-gpu-focus",
    success: true,
    metrics: { firstTokenMs: 420, decodeTokensPerSecond: 31.5, headroomBytes: 2_000_000_000 },
    capacity: CAPACITY,
  });
  assert.equal(plan.results[0].success, true);
  assert.equal(plan.results[0].capacity.maxSingleRequestTokens, 262_144);
  assert.deepEqual(selectVerifiedCalibrationProfile(plan, (left, right) => left.metrics.decodeTokensPerSecond - right.metrics.decodeTokensPerSecond), plan.results[0]);
  assert.throws(() => recordLocalHostCalibrationResult(plan, {
    candidateId: "dual-gpu-focus", success: true, metrics: { prompt: 1 }, capacity: CAPACITY,
  }), /Unsupported calibration metric/);
});

test("MLX gets no guessed candidate and cannot publish an unmeasured profile", () => {
  const plan = createLocalHostCalibrationPlan({ hostId: "mac-host", adapterId: "mlx-apple" });
  assert.deepEqual(plan.candidates, []);
  assert.equal(selectVerifiedCalibrationProfile(plan, () => 0), null);
  assert.throws(() => recordLocalHostCalibrationResult(plan, { candidateId: "invented", success: true, capacity: CAPACITY }), /Unknown calibration candidate/);
});

test("calibration rejects result/capacity mismatches and hidden selection rules", () => {
  const plan = createLocalHostCalibrationPlan({ hostId: "host-qwen", adapterId: "llamacpp-nvidia", candidates: [CANDIDATE] });
  assert.throws(() => selectVerifiedCalibrationProfile(plan), /explicit comparator/);
  assert.throws(() => recordLocalHostCalibrationResult(plan, {
    candidateId: "dual-gpu-focus", success: true, capacity: { ...CAPACITY, profileId: "other" },
  }), /must describe/);
  assert.throws(() => recordLocalHostCalibrationResult(plan, {
    candidateId: "dual-gpu-focus", success: false, capacity: CAPACITY,
  }), /failed calibration/);
});

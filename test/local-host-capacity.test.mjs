import assert from "node:assert/strict";
import test from "node:test";
import { admissionBudgetFromCapacity, catalogContextFromCapacity, createLocalHostCapacityContract } from "../src/local-host-capacity.mjs";

const CONTRACT = {
  adapterId: "llamacpp-nvidia",
  modelId: "qwen3.8:27b",
  profileId: "dual-5060ti-q3-focus",
  maxSingleRequestTokens: 262_144,
  outputReserveTokens: 16_384,
  maxActiveRequests: 1,
};

test("a calibrated capacity contract publishes a single-request catalog window with output reserve", () => {
  const contract = createLocalHostCapacityContract(CONTRACT);
  const catalog = catalogContextFromCapacity(contract);
  const admission = admissionBudgetFromCapacity(contract);
  assert.equal(catalog.context_window, 262_144);
  assert.equal(catalog.max_context_window, 262_144);
  assert.equal(catalog.output_reserve_tokens, undefined, "only known Codex catalog fields are projected");
  assert.equal(admission.outputReserveTokens, 16_384);
  assert.equal(admission.maxInputTokens, 245_760);
  assert.equal(catalog.auto_compact_token_limit, Math.floor((262_144 - 16_384) * 0.8));
  assert.ok(catalog.auto_compact_token_limit < admission.maxInputTokens);
  assert.equal(contract.maxActiveRequests, 1, "scheduler capacity stays out of the client catalog");
});

test("contracts reject guessed adapters and impossible token budgets", () => {
  assert.throws(() => createLocalHostCapacityContract({ ...CONTRACT, adapterId: "ollama" }), /Unsupported local host adapter/);
  assert.throws(() => createLocalHostCapacityContract({ ...CONTRACT, outputReserveTokens: 262_144 }), /leave room for input/);
  assert.throws(() => createLocalHostCapacityContract({ ...CONTRACT, maxActiveRequests: 0 }), /positive integer/);
  assert.throws(() => createLocalHostCapacityContract({ ...CONTRACT, autoCompactRatio: 1 }), /less than one/);
});

test("Apple MLX can carry a measured capacity contract without inventing an MLX launch profile", () => {
  const mlx = createLocalHostCapacityContract({ ...CONTRACT, adapterId: "mlx-apple", profileId: "validated-on-apple-host" });
  assert.equal(mlx.adapterId, "mlx-apple");
  assert.equal(mlx.profileId, "validated-on-apple-host");
});

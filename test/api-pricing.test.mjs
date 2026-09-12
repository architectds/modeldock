import test from "node:test";
import assert from "node:assert/strict";
import { apiRate, estimateApiCost } from "../src/api-pricing.mjs";

test("the pricing snapshot carries current OpenCode Go base rates", () => {
  assert.deepEqual(apiRate("deepseek-v4-flash", "opencode-go"), {
    input: 0.22,
    cached: 0.007,
    output: 0.66,
  });
  assert.deepEqual(apiRate("qwen3.8-flash", "opencode-go"), {
    input: 0.15,
    cached: 0.016,
    output: 0.47,
  });
  assert.deepEqual(apiRate("Qwen/Qwen3.8-Flash", "commandcode"), {
    input: 0.15,
    cached: 0.016,
    output: 0.47,
  });
  assert.deepEqual(apiRate("hy4-preview", "opencode-go"), {
    input: 0.834,
    cached: 0.042,
    output: 2.501,
  });
});

test("native Sol uses OpenAI direct pricing rather than an OpenRouter promotion", () => {
  assert.deepEqual(apiRate("gpt-5.6-sol", "openai"), {
    input: 4,
    cached: 0.4,
    output: 20,
  });
});

test("native Astra uses OpenAI direct standard short-context pricing", () => {
  assert.deepEqual(apiRate("gpt-6-astra", "openai"), {
    input: 10,
    cached: 1,
    output: 50,
  });
});

test("Qwen 3.8 27B uses its cheapest normalized provider offer", () => {
  assert.deepEqual(apiRate("Qwen3.8-27B", "llamacpp"), {
    input: 0.4,
    cached: 0.04,
    output: 3,
  });
});

test("equivalent pricing follows canonical model identity across providers", () => {
  const local = estimateApiCost({
    model: "Qwen3.8-27B",
    provider: "llamacpp",
    inputTokens: 1_000_000,
    cachedTokens: 800_000,
    outputTokens: 100_000,
  });
  const commandCode = estimateApiCost({
    model: "Qwen/Qwen3.8-27B",
    provider: "commandcode",
    inputTokens: 1_000_000,
    cachedTokens: 800_000,
    outputTokens: 100_000,
  });
  assert.deepEqual(local, commandCode);
  assert.equal(local.usd, 0.412);
  assert.equal(local.pricedTokens, 1_100_000);
  assert.equal(local.unpricedTokens, 0);
});

test("equivalent cost discounts cached input separately from new input", () => {
  const result = estimateApiCost({
    model: "gpt-5.6-sol",
    provider: "openai",
    inputTokens: 1_000_000,
    cachedTokens: 800_000,
    outputTokens: 100_000,
  });
  assert.equal(result.usd, 3.12);
  assert.equal(result.pricedTokens, 1_100_000);
  assert.equal(result.unpricedTokens, 0);
});

test("an unknown price remains visible as unpriced usage", () => {
  const result = estimateApiCost({
    model: "unknown-model",
    provider: "unknown-provider",
    inputTokens: 900,
    cachedTokens: 600,
    outputTokens: 100,
  });
  assert.deepEqual(result, { usd: 0, pricedTokens: 0, unpricedTokens: 1000 });
});

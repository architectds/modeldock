import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  DEFAULT_OVERHEAD_BYTES,
  estimateVramBudget,
  kvBytesPerToken,
  maxContextFor,
  modelShape,
  readGgufMetadata,
} from "../src/gguf.mjs";

const GiB = 1024 ** 3;

// Read from D:\models\Qwen3.8-27B-Q3_K_M.gguf on 2026-08-19. Kept as a fixture
// so the arithmetic is testable without a 12 GiB file.
const QWEN38 = {
  "general.architecture": "qwen35",
  "qwen35.block_count": 65,
  "qwen35.nextn_predict_layers": 1,
  "qwen35.full_attention_interval": 4,
  "qwen35.attention.head_count": 24,
  "qwen35.attention.head_count_kv": 4,
  "qwen35.attention.key_length": 256,
  "qwen35.attention.value_length": 256,
  "qwen35.embedding_length": 5120,
  "qwen35.context_length": 262144,
};
const QWEN38_WEIGHTS = 12.87 * GiB;
const CARD = 19.1 * GiB;

// --- the calculation this module exists for --------------------------------

test("a hybrid model pays KV on only its attention layers", () => {
  const shape = modelShape({ meta: QWEN38 });
  // 65 blocks minus the MTP block, one attention layer in every four.
  assert.equal(shape.layers, 64);
  assert.equal(shape.attentionLayers, 16);
  assert.equal(shape.hybrid, true);
  assert.equal(kvBytesPerToken(shape, "f16"), 64 * 1024, "64 KiB per token, not 260");
});

test("the naive per-block formula is the failure this replaces", () => {
  const shape = modelShape({ meta: QWEN38 });
  const naive = shape.blockCount * shape.headCountKv * (shape.keyLength + shape.valueLength) * 2;
  assert.equal(naive, 260 * 1024);
  // It concludes an 80K context needs more than the whole card, so a budget
  // built on it refuses a configuration that demonstrably runs.
  assert.ok(naive * 81920 > CARD, "naive says 80K does not fit; the machine says it does");
});

test("the budget reconciles with what the card actually reported", () => {
  // Measured on this machine: llama-server at 80K occupied 18.7 of 19.1 GiB.
  const shape = modelShape({ meta: QWEN38 });
  const budget = estimateVramBudget({
    shape,
    weightsBytes: QWEN38_WEIGHTS,
    contextTokens: 81920,
    cardBytes: CARD,
  });
  assert.equal(Math.round(budget.kv / GiB * 100) / 100, 5);
  assert.equal(Math.round(budget.total / GiB * 100) / 100, 18.7);
  assert.equal(budget.fits, true);
  // Fits, but with 0.4 GiB spare - which is why it gets evicted the moment
  // anything else on the desktop wants memory.
  assert.ok(budget.headroom < 0.5 * GiB);
});

test("the recommended context leaves real headroom", () => {
  const shape = modelShape({ meta: QWEN38 });
  const tokens = maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: CARD });
  assert.equal(tokens, 48000, "the 48K rung: the largest that still leaves 2 GiB");
  const budget = estimateVramBudget({ shape, weightsBytes: QWEN38_WEIGHTS, contextTokens: tokens, cardBytes: CARD });
  assert.ok(budget.headroom >= 2 * GiB, "the whole point of the recommendation");
});

test("the recommendation never exceeds what the model was trained for", () => {
  const shape = modelShape({ meta: { ...QWEN38, "qwen35.context_length": 131072 } });
  const tokens = maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: 80 * GiB });
  // A card with room to spare is still held to the model's own limit, and then
  // to the largest rung at or below it: 131072 is not offered because it is not
  // a rung, so the answer is the 128K one under it.
  assert.equal(tokens, 128000);
  assert.ok(tokens <= 131072, "a big card does not license a context the model cannot use");
});

test("a model trained below the ladder still gets its own length, not zero", () => {
  // The rungs start at 16K because smaller windows have no working room left
  // after the fixed overhead. A model trained for 8K has no rung of its own,
  // and snapping it to zero would report that a working model cannot run.
  const shape = modelShape({ meta: { ...QWEN38, "qwen35.context_length": 8192 } });
  assert.equal(maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: 80 * GiB }), 8192);
});

test("cheaper KV precision buys context at a fixed ratio", () => {
  const shape = modelShape({ meta: QWEN38 });
  const f16 = kvBytesPerToken(shape, "f16");
  assert.equal(kvBytesPerToken(shape, "q8_0"), f16 / 2);
  assert.equal(kvBytesPerToken(shape, "q4_0"), f16 / 4);
  // This is the lever that does not exist on the AMD stack, so the estimator
  // has to be able to answer for it before the UI can offer or lock it.
  const wide = maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: CARD, kvType: "q8_0" });
  const narrow = maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: CARD, kvType: "f16" });
  assert.ok(wide > narrow * 1.8, `q8 should roughly double the window: ${narrow} -> ${wide}`);
});

// --- ordinary dense models still work --------------------------------------

test("a plain dense model counts every layer", () => {
  const shape = modelShape({
    meta: {
      "general.architecture": "llama",
      "llama.block_count": 32,
      "llama.attention.head_count": 32,
      "llama.attention.head_count_kv": 8,
      "llama.embedding_length": 4096,
    },
  });
  assert.equal(shape.attentionLayers, 32, "no interval declared means no layer is skipped");
  assert.equal(shape.hybrid, false);
  // key/value length are implied by embedding / head_count when not stated.
  assert.equal(shape.keyLength, 128);
  assert.equal(kvBytesPerToken(shape, "f16"), 32 * 8 * 256 * 2);
});

test("a model that declares no KV heads is plain multi-head", () => {
  const shape = modelShape({
    meta: {
      "general.architecture": "llama",
      "llama.block_count": 4,
      "llama.attention.head_count": 16,
      "llama.embedding_length": 2048,
    },
  });
  assert.equal(shape.headCountKv, 16);
});

test("metadata without an architecture yields nothing rather than a guess", () => {
  assert.equal(modelShape({ meta: {} }), null);
  assert.equal(modelShape({ meta: { "general.architecture": "llama" } }), null, "no block_count");
  assert.equal(modelShape({}), null);
  assert.equal(kvBytesPerToken(null), 0);
});

test("the budget degrades to arithmetic rather than throwing on a missing card size", () => {
  const shape = modelShape({ meta: QWEN38 });
  const budget = estimateVramBudget({ shape, weightsBytes: QWEN38_WEIGHTS, contextTokens: 4096 });
  assert.equal(budget.headroom, null);
  assert.equal(budget.fits, null);
  assert.ok(budget.total > 0);
  assert.equal(budget.overhead, DEFAULT_OVERHEAD_BYTES);
});

// --- the reader ------------------------------------------------------------

// Build a GGUF header by hand so the parser is exercised without shipping a
// model file: magic, version, counts, then typed key/value pairs.
function ggufFile(pairs) {
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const str = (v) => { const s = Buffer.from(v, "utf8"); return Buffer.concat([u64(s.length), s]); };
  parts.push(Buffer.from("GGUF", "latin1"), u32(3), u64(0), u64(pairs.length));
  for (const [key, type, value] of pairs) {
    parts.push(str(key), u32(type));
    if (type === 8) parts.push(str(value));
    else if (type === 4) parts.push(u32(value));
    else if (type === 9) {
      // array: inner type, count, then the elements
      parts.push(u32(8), u64(value.length));
      for (const item of value) parts.push(str(item));
    }
  }
  return Buffer.concat(parts);
}

test("the reader pulls typed values out of a real header layout", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-gguf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "tiny.gguf");
  await writeFile(file, ggufFile([
    ["general.architecture", 8, "llama"],
    ["llama.block_count", 4, 32],
    ["llama.attention.head_count", 4, 32],
    ["llama.attention.head_count_kv", 4, 8],
    ["llama.embedding_length", 4, 4096],
    // A vocabulary-sized array is walked past, not materialised.
    ["tokenizer.ggml.tokens", 9, ["a", "b", "c"]],
    ["general.name", 8, "Tiny"],
  ]));
  const { version, meta } = readGgufMetadata(file);
  assert.equal(version, 3);
  assert.equal(meta["general.architecture"], "llama");
  assert.equal(meta["llama.block_count"], 32);
  assert.equal(meta["general.name"], "Tiny", "a key after the array is still read");
  assert.equal(meta["tokenizer.ggml.tokens"], null, "arrays are skipped, not kept");
  const shape = modelShape({ meta });
  assert.equal(shape.attentionLayers, 32);
});

test("a file that is not GGUF is refused by name, not by crash", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-gguf-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "not-a-model.bin");
  await writeFile(file, Buffer.from("this is not a model file at all"));
  assert.throws(() => readGgufMetadata(file), /not a GGUF file/);
});

test("what we recommend and how far the slider goes are different numbers", async () => {
  const { MINIMUM_HEADROOM_BYTES, RECOMMENDED_HEADROOM_BYTES } = await import("../src/gguf.mjs");
  const shape = modelShape({ meta: QWEN38 });
  const usable = 19.1 * GiB;
  const recommended = maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: usable });
  const ceiling = maxContextFor({
    shape,
    weightsBytes: QWEN38_WEIGHTS,
    cardBytes: usable,
    headroomBytes: MINIMUM_HEADROOM_BYTES,
  });
  assert.ok(MINIMUM_HEADROOM_BYTES < RECOMMENDED_HEADROOM_BYTES);
  assert.ok(ceiling > recommended, "the slider must be able to enter the band it warns about");
  // Measured shape of this card: recommend the 48K rung, allow up to 64K, and
  // the 80K that actually got evicted is past even the ceiling.
  assert.equal(recommended, 48000);
  assert.equal(ceiling, 64000);
  assert.ok(81920 > ceiling, "the configuration that failed is not reachable by dragging");
  // Decimal rungs so the product's one display base renders them exactly:
  // a binary 65536 would read as "66K" beside a Models page saying the same.
  assert.equal(Math.round(ceiling / 1000), 64);
  const atCeiling = estimateVramBudget({ shape, weightsBytes: QWEN38_WEIGHTS, contextTokens: ceiling, cardBytes: usable });
  assert.ok(atCeiling.headroom >= MINIMUM_HEADROOM_BYTES);
});

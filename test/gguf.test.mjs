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
  tensorWeights,
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
// The tensors the backend loads, not the file's own size. Read off the real
// file: 13,818,690,528 bytes on disk, of which 232,470,528 sit in the fifteen
// blk.64.* multi-token-prediction tensors the backend logs as "-- ignoring",
// and about 11 MB is header, metadata and alignment that never reaches the GPU.
// The measured total is unchanged - the overhead constant carries the same
// 221.7 MB in the other direction, because both come out of one measurement.
const QWEN38_WEIGHTS = 12.6429 * GiB;
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

test("a card that cannot reach the smallest rung says so, instead of naming the largest", () => {
  // 12 GiB card, 8 GiB of weights: about 2,400 tokens actually fit, which is
  // below the ladder's first rung. The answer is zero.
  //
  // It used to be 128,000. `affordable || trainedCap` read a zero budget as
  // "no opinion" and fell through to the model's own trained length, so the
  // tightest cards received the largest recommendation - and the advice line,
  // which only appears when the suggestion is below the running context, stayed
  // hidden exactly when the bar had gone red.
  const shape = modelShape({
    meta: {
      "general.architecture": "llama",
      "llama.block_count": 32,
      "llama.attention.head_count": 32,
      "llama.attention.head_count_kv": 32,
      "llama.embedding_length": 4096,
      "llama.context_length": 128000,
    },
  });
  assert.equal(maxContextFor({ shape, weightsBytes: 8 * GiB, cardBytes: 12 * GiB }), 0);
  // Cheaper KV is a real escape from that zero rather than a rounding of it,
  // which is what lets the drawer keep the precision control on screen after
  // the context slider has run out of rungs to offer.
  //
  // Same card, precision the only difference. The card is 14 GiB rather than
  // the 13 this asked for while the overhead constant was 0.83 GiB: at 13 the
  // q4_0 case landed 85 tokens above the 16K rung, so re-deriving the constant
  // to 1.0571 pushed it under and the pair stopped demonstrating anything. The
  // claim is the same claim; the fixture is off the boundary it was sitting on.
  assert.equal(maxContextFor({ shape, weightsBytes: 8 * GiB, cardBytes: 14 * GiB }), 0);
  assert.equal(maxContextFor({ shape, weightsBytes: 8 * GiB, cardBytes: 14 * GiB, kvType: "q4_0" }), 24000);
});

test("a model trained below the ladder still has to fit before it is offered", () => {
  const shape = modelShape({ meta: { ...QWEN38, "qwen35.context_length": 8192 } });
  assert.equal(maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: 80 * GiB }), 8192);
  // Same model, a card with no room left: its trained length is not a licence.
  assert.equal(maxContextFor({ shape, weightsBytes: QWEN38_WEIGHTS, cardBytes: 14 * GiB }), 0);
});

test("every model gets a ladder with at least one rung on it", async () => {
  const { contextLadderFor, CONTEXT_LADDER } = await import("../src/gguf.mjs");
  // Filtering the ladder by a trained length leaves nothing at all for a 4K or
  // 8K model - and 4K and 8K GGUFs are ordinary. The empty array reached the
  // slider as `rungs[index] === undefined`, which rendered as the string
  // "undefined" and made the whole budget NaN.
  assert.deepEqual(contextLadderFor(4096), [4096]);
  assert.deepEqual(contextLadderFor(8192), [8192]);
  assert.deepEqual(contextLadderFor(0), CONTEXT_LADDER, "an unknown length is not a limit");
  assert.deepEqual(contextLadderFor(32000), [16000, 24000, 32000]);
  assert.ok(contextLadderFor(262144).length >= 5, "a long-context model gets the whole ladder");
  for (const trained of [0, 4096, 8192, 16000, 32000, 131072, 262144]) {
    assert.ok(contextLadderFor(trained).length > 0, `${trained} left the slider with no rungs`);
  }
});

// The weights term is what the card holds, and that is not the file's size.
//
// A GGUF that carries multi-token-prediction blocks ships them in the file and
// the backend logs "-- ignoring" and never loads them. Charging the card for
// them overstates the baseline by their size - 221.7 MB on the model this was
// measured against - which is the direction that refuses a context that runs.
test("the blocks a backend skips are not charged to the card", () => {
  const tensors = [
    { name: "token_embd.weight", bytes: 1000 },
    { name: "blk.0.attn_q.weight", bytes: 200 },
    { name: "blk.63.ffn_down.weight", bytes: 300 },
    { name: "blk.64.attn_q.weight", bytes: 40 },
    { name: "blk.64.nextn.eh_proj.weight", bytes: 60 },
    { name: "output_norm.weight", bytes: 5 },
  ];
  // 64 loaded layers, so blocks numbered 64 and up are the ones left in the file.
  const split = tensorWeights(tensors, 64);
  assert.equal(split.loaded, 1505);
  assert.equal(split.ignored, 100);
  // Nothing outside a blk.N. prefix is ever treated as skippable: the embedding
  // and the output norm belong to the model whatever the block count says.
  assert.equal(split.loaded + split.ignored, 1605);
});

test("an unreadable tensor ledger falls back to the file size rather than to zero", () => {
  // A newer quantization than the type table knows returns tensors: null, and
  // a zero weights term would report that a 12 GiB model costs nothing.
  assert.equal(tensorWeights(null, 64), null);
  assert.equal(tensorWeights([{ name: "blk.0.x", bytes: 1 }], 0), null);
});

// What a model file costs on a card, answered from the file's own header.
//
// This exists because the obvious formula is wrong by a large factor on any
// model that is not plain dense attention. Qwen3.8-27B declares
// `full_attention_interval = 4` and a set of `ssm.*` keys: only every fourth
// layer keeps a growing KV cache, the rest hold a fixed-size recurrent state.
// Counting all 65 blocks gives 260 KiB/token and concludes an 80K context needs
// 20.3 GiB - more than the card - so a budget built on it would refuse a
// configuration that demonstrably runs. Counting the 16 attention layers gives
// 64 KiB/token, and the whole budget then reconciles with what the card
// actually reports. Hybrid architectures are now common (sliding-window,
// SSM/attention mixes, MLA), so this is the normal case, not an exotic one.
//
// Reading is cheap and does not load the model: the header sits at the front of
// the file, so a 12 GB GGUF costs a few hundred KB of IO.
import { closeSync, openSync, readSync, statSync } from "node:fs";

// GGUF value type tags, in the order the format defines them.
const T_UINT8 = 0, T_INT8 = 1, T_UINT16 = 2, T_INT16 = 3, T_UINT32 = 4;
const T_INT32 = 5, T_FLOAT32 = 6, T_BOOL = 7, T_STRING = 8, T_ARRAY = 9;
const T_UINT64 = 10, T_INT64 = 11, T_FLOAT64 = 12;

export class GgufError extends Error {
  constructor(message) {
    super(message);
    this.name = "GgufError";
  }
}

// A cursor that pulls more of the file only when a read runs past what it holds.
function fileCursor(fd) {
  const buf = Buffer.alloc(1 << 20);
  let pos = 0;
  let base = 0;
  let have = 0;
  const ensure = (n) => {
    if (n > buf.length) throw new GgufError(`metadata value too large (${n} bytes)`);
    if (pos - base + n <= have) return;
    base = pos;
    have = readSync(fd, buf, 0, buf.length, pos);
    if (have < n) throw new GgufError("file ended inside the metadata header");
  };
  const at = () => pos - base;
  return {
    tell: () => pos,
    u8: () => { ensure(1); const v = buf.readUInt8(at()); pos += 1; return v; },
    i8: () => { ensure(1); const v = buf.readInt8(at()); pos += 1; return v; },
    u16: () => { ensure(2); const v = buf.readUInt16LE(at()); pos += 2; return v; },
    i16: () => { ensure(2); const v = buf.readInt16LE(at()); pos += 2; return v; },
    u32: () => { ensure(4); const v = buf.readUInt32LE(at()); pos += 4; return v; },
    i32: () => { ensure(4); const v = buf.readInt32LE(at()); pos += 4; return v; },
    f32: () => { ensure(4); const v = buf.readFloatLE(at()); pos += 4; return v; },
    f64: () => { ensure(8); const v = buf.readDoubleLE(at()); pos += 8; return v; },
    u64: () => { ensure(8); const v = Number(buf.readBigUInt64LE(at())); pos += 8; return v; },
    i64: () => { ensure(8); const v = Number(buf.readBigInt64LE(at())); pos += 8; return v; },
    // Strings are length-prefixed; callers read the length then the bytes.
    raw: (n) => { ensure(n); const v = buf.toString("utf8", at(), at() + n); pos += n; return v; },
  };
}

function readValue(c, type) {
  switch (type) {
    case T_UINT8: return c.u8();
    case T_INT8: return c.i8();
    case T_UINT16: return c.u16();
    case T_INT16: return c.i16();
    case T_UINT32: return c.u32();
    case T_INT32: return c.i32();
    case T_FLOAT32: return c.f32();
    case T_BOOL: return c.u8() !== 0;
    case T_STRING: return c.raw(c.u64());
    case T_UINT64: return c.u64();
    case T_INT64: return c.i64();
    case T_FLOAT64: return c.f64();
    case T_ARRAY: {
      // Arrays are walked but not kept: the tokenizer vocabulary is a
      // six-figure array of strings and nothing here needs it.
      const inner = c.u32();
      const count = c.u64();
      for (let i = 0; i < count; i += 1) readValue(c, inner);
      return null;
    }
    default:
      throw new GgufError(`unknown metadata value type ${type}`);
  }
}

// Every key/value pair in the header. Values that are arrays come back null.
export function readGgufMetadata(file) {
  const fd = openSync(file, "r");
  try {
    const c = fileCursor(fd);
    if (c.raw(4) !== "GGUF") throw new GgufError("not a GGUF file");
    const version = c.u32();
    const tensorCount = c.u64();
    const kvCount = c.u64();
    if (kvCount > 100_000) throw new GgufError(`implausible metadata count ${kvCount}`);
    const meta = {};
    for (let i = 0; i < kvCount; i += 1) {
      const key = c.raw(c.u64());
      meta[key] = readValue(c, c.u32());
    }
    return { version, tensorCount, meta };
  } finally {
    closeSync(fd);
  }
}

// Bytes per element of a KV cache entry. The block-quantized types carry a
// small per-block scale on top of this; it is under 7% and is ignored, which
// keeps the estimate slightly conservative rather than optimistic.
export const KV_ELEMENT_BYTES = { f16: 2, q8_0: 1, q4_0: 0.5 };

// The shape that decides KV cost, pulled out of the raw metadata so the rest of
// this module is pure arithmetic that tests can drive without a file.
export function modelShape({ meta } = {}) {
  if (!meta || typeof meta !== "object") return null;
  const arch = String(meta["general.architecture"] || "").trim();
  if (!arch) return null;
  const num = (suffix) => {
    const value = meta[`${arch}.${suffix}`];
    return Number.isFinite(value) ? Number(value) : 0;
  };
  const blockCount = num("block_count");
  if (!blockCount) return null;
  const headCount = num("attention.head_count");
  const embedding = num("embedding_length");
  // Multi-query and grouped-query models declare fewer KV heads than query
  // heads; a model that declares none is plain multi-head.
  const headCountKv = num("attention.head_count_kv") || headCount;
  // Some architectures state key/value lengths outright; the rest imply them
  // from the embedding split across the query heads.
  const headDim = headCount ? Math.round(embedding / headCount) : 0;
  const keyLength = num("attention.key_length") || headDim;
  const valueLength = num("attention.value_length") || headDim;
  // The multi-token-prediction block carries weights but no KV cache, so it is
  // not one of the layers that pays per token.
  const layers = blockCount - num("nextn_predict_layers");
  // Hybrid models keep a growing KV cache on only some layers. Everything else
  // holds a fixed-size state that does not scale with context.
  const interval = num("full_attention_interval");
  const attentionLayers = interval > 1 ? Math.ceil(layers / interval) : layers;
  return {
    arch,
    blockCount,
    layers,
    attentionLayers,
    fullAttentionInterval: interval || 0,
    headCount,
    headCountKv,
    keyLength,
    valueLength,
    trainedContext: num("context_length"),
    hybrid: interval > 1,
  };
}

// Bytes of KV cache one token occupies. This is the number the naive formula
// gets wrong, and the one every other figure here is built on.
export function kvBytesPerToken(shape, kvType = "f16") {
  if (!shape?.attentionLayers || !shape.headCountKv) return 0;
  const element = KV_ELEMENT_BYTES[kvType];
  if (!element) throw new GgufError(`unknown KV cache type ${kvType}`);
  return shape.attentionLayers * shape.headCountKv * (shape.keyLength + shape.valueLength) * element;
}

// Compute buffers plus, on a hybrid model, the fixed recurrent state. Unlike
// the KV figure this is NOT derived from the header - the metadata does not
// carry enough to compute it - so it is an observed constant, taken from this
// machine: a measured 18.70 GiB total at 80K, against 12.87 GiB of weights (the
// file's own size) and 5.00 GiB of computed KV, leaves 0.83 GiB. Callers can
// override it as better measurements land.
//
// This constant was briefly 1.71 GiB, from a hand calculation that read the
// weights as 12.87 decimal GB and converted them a second time into 11.99 GiB.
// The estimator surfaced the error by overshooting a total that had previously
// looked exact: two compensating mistakes agree with each other right up until
// one of them is computed properly.
//
// Worth being clear about what this does and does not weaken: the ABSOLUTE
// total carries this constant's error, but the DELTA as the context slider
// moves is pure KV and therefore exact. The slider is honest even where the
// baseline is approximate.
export const DEFAULT_OVERHEAD_BYTES = Math.round(0.83 * 1024 ** 3);

export function estimateVramBudget({
  shape,
  weightsBytes,
  contextTokens,
  kvType = "f16",
  overheadBytes = DEFAULT_OVERHEAD_BYTES,
  cardBytes = 0,
} = {}) {
  const perToken = kvBytesPerToken(shape, kvType);
  const kv = Math.round(perToken * Math.max(0, contextTokens || 0));
  const weights = Math.max(0, Math.round(weightsBytes || 0));
  const overhead = Math.max(0, Math.round(overheadBytes || 0));
  const total = weights + kv + overhead;
  return {
    perToken,
    weights,
    kv,
    overhead,
    total,
    cardBytes: cardBytes || 0,
    headroom: cardBytes ? cardBytes - total : null,
    fits: cardBytes ? total <= cardBytes : null,
  };
}

// The largest context that still leaves the requested headroom. This is the
// recommendation the drawer offers when a configuration is too tight: the
// answer to "then what should it be", not just "that is too big".
// Two different questions, and conflating them was a bug: what we RECOMMEND and
// how far the slider LETS you go are not the same number.
//
// The recommendation keeps a real cushion, because the failure it avoids is not
// "allocation refused" but "something else on the desktop wanted memory an hour
// later and the weights got paged out". The slider ceiling is looser: a user who
// understands the trade may want the extra window, and the honest limit is the
// point past which it certainly breaks, not the point where we stop being
// comfortable. Between the two the headroom segment reads as tight - that band
// is the warning, and it only means anything if the slider can enter it.
export const RECOMMENDED_HEADROOM_BYTES = 2 * 1024 ** 3;
export const MINIMUM_HEADROOM_BYTES = Math.round(1.2 * 1024 ** 3);

// Context is offered as a fixed ladder rather than a computed step. Two reasons:
// the overhead term is an observed constant, so finer resolution would be false
// precision, and a ladder needs no arithmetic to stay on round numbers that
// people already say out loud. A card shows the rungs it can reach - five to
// eight of them in practice - and nothing below 16K, because after the ~10K
// per-turn fixed overhead a smaller window has no working room left.
//
// Decimal, not binary. llama.cpp takes any -c, so the rungs are free to be
// round in whichever base the product reads windows in - and that base is
// decimal, because most published windows are (272000, 200000, 1000000) and the
// Models column is also an input. A binary ladder would have rendered 65536 as
// "66K" beside a Models page calling the same number 66K, which is the drift
// this avoids rather than a rounding nicety.
export const CONTEXT_LADDER = [16000, 24000, 32000, 48000, 64000, 96000, 128000, 192000, 256000];

// The largest rung at or below a computed ceiling.
export function snapContext(tokens) {
  let best = 0;
  for (const rung of CONTEXT_LADDER) {
    if (rung <= tokens) best = rung;
  }
  return best;
}

export function maxContextFor({
  shape,
  weightsBytes,
  cardBytes,
  kvType = "f16",
  overheadBytes = DEFAULT_OVERHEAD_BYTES,
  headroomBytes = RECOMMENDED_HEADROOM_BYTES,
} = {}) {
  const perToken = kvBytesPerToken(shape, kvType);
  if (!perToken || !cardBytes) return 0;
  const spare = cardBytes - headroomBytes - (weightsBytes || 0) - overheadBytes;
  if (spare <= 0) return 0;
  // Snap to a rung a person would actually type, and never past the context the
  // model was trained for.
  const budget = Math.floor(spare / perToken);
  const trained = shape.trainedContext || 0;
  // A model trained below the ladder's first rung has no rung of its own, and
  // its trained length is then the only sensible answer - snapping it to zero
  // would report that a working model cannot run at all. It still has to fit:
  // "the model is small" and "the card has room for it" are separate claims.
  if (trained && trained < CONTEXT_LADDER[0]) return budget >= trained ? trained : 0;
  // Zero means the card cannot reach even the smallest rung. That is an answer,
  // not a missing one - the earlier `affordable || trainedCap` read it as "no
  // opinion" and replied with the model's full trained context, so the tightest
  // cards got the largest recommendation, and the advice line, which only shows
  // when the suggestion is BELOW the running context, went quiet exactly when
  // the bar was red.
  return snapContext(trained ? Math.min(budget, trained) : budget);
}

// The rungs to offer for a model, before any card is consulted. Kept here so
// the server and the page cannot disagree about what the ladder is: filtering
// CONTEXT_LADDER by a trained length yields nothing at all for a 4K or 8K
// model, and an empty ladder reached the slider as `undefined`.
export function contextLadderFor(trainedContext) {
  const trained = Number(trainedContext) || 0;
  if (trained && trained < CONTEXT_LADDER[0]) return [trained];
  return CONTEXT_LADDER.filter((rung) => !trained || rung <= trained);
}

// Everything about one model file, in the shape the snapshot stores. Keyed on
// size and mtime so a re-quantized file under the same path is re-read.
export function readModelFacts(file) {
  const stat = statSync(file);
  const { meta } = readGgufMetadata(file);
  const shape = modelShape({ meta });
  if (!shape) throw new GgufError("GGUF header carries no usable architecture");
  return {
    path: file,
    fileBytes: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    ...shape,
    kvBytesPerToken: kvBytesPerToken(shape, "f16"),
  };
}

export function modelFactsAreStale(facts, file) {
  if (!facts || facts.path !== file) return true;
  try {
    const stat = statSync(file);
    return facts.fileBytes !== stat.size || facts.mtimeMs !== Math.round(stat.mtimeMs);
  } catch {
    // Unreadable now: keep what we remembered rather than dropping the ledger.
    return false;
  }
}

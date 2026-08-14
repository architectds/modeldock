import test from "node:test";
import assert from "node:assert/strict";
import { createVisionCache, visionCacheKey } from "../src/vision-cache.mjs";

test("visionCacheKey is stable per content and distinct per content", () => {
  assert.equal(visionCacheKey({ images: ["a"], question: "q" }), visionCacheKey({ images: ["a"], question: "q" }));
  assert.notEqual(visionCacheKey({ images: ["a"], question: "q" }), visionCacheKey({ images: ["a"], question: "r" }));
  assert.notEqual(visionCacheKey({ images: ["a"], question: "q" }), visionCacheKey({ images: ["b"], question: "q" }));
});

test("cached answers expire after the TTL", () => {
  let now = 1_000;
  const cache = createVisionCache({ ttlMs: 60_000, now: () => now });
  const key = visionCacheKey({ images: ["a"], question: "q" });
  cache.set(key, "evidence");
  assert.equal(cache.get(key), "evidence", "a fresh entry is returned");
  now = 1_000 + 60_001;
  assert.equal(cache.get(key), undefined, "the entry expires past the TTL");
  assert.equal(cache.size, 0, "expired entries are evicted");
});

test("the LRU discipline evicts the oldest entry first", () => {
  const cache = createVisionCache({ ttlMs: 3_600_000, maxEntries: 2 });
  const keyA = visionCacheKey({ images: ["a"], question: "q" });
  const keyB = visionCacheKey({ images: ["b"], question: "q" });
  const keyC = visionCacheKey({ images: ["c"], question: "q" });
  cache.set(keyA, "a");
  cache.set(keyB, "b");
  assert.equal(cache.get(keyA), "a", "reading A refreshes its recency");
  cache.set(keyC, "c");
  assert.equal(cache.get(keyA), "a", "A survived because it was touched last");
  assert.equal(cache.get(keyB), undefined, "B was the least recently used and was evicted");
  assert.equal(cache.size, 2);
});

test("the byte cap bounds the cache", () => {
  const cache = createVisionCache({ ttlMs: 3_600_000, maxBytes: 30 });
  cache.set(visionCacheKey({ n: 1 }), "1234567890123456"); // 16 bytes
  cache.set(visionCacheKey({ n: 2 }), "12345678901234567890"); // 20 bytes
  assert.ok(cache.byteCount <= 30, `bytes stay under the cap (${cache.byteCount})`);
  assert.ok(cache.size <= 2);
});

test("re-setting the same key replaces and re-bills bytes", () => {
  const cache = createVisionCache({ ttlMs: 3_600_000 });
  const key = visionCacheKey({ n: 1 });
  cache.set(key, "short");
  const before = cache.byteCount;
  cache.set(key, "a much longer transcription that replaces the short one");
  assert.ok(cache.byteCount > before, "the replaced entry re-bills its bytes");
  assert.equal(cache.size, 1);
  assert.equal(cache.get(key), "a much longer transcription that replaces the short one");
});

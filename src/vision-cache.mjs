// Vision evidence cache: one expensive vision transcription per image+question
// per hour. Multi-turn sessions re-read the same screenshot constantly; without
// a cache every turn re-pays the vision model. Same design as codex-router's
// evidence cache: SHA-256 key, TTL, LRU-ish eviction (Map insertion order),
// and a byte cap so a long transcription cannot blow the process heap.
import { createHash } from "node:crypto";

const VISION_CACHE_TTL_MS = 60 * 60 * 1_000;
const VISION_CACHE_MAX_ENTRIES = 128;
const VISION_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export function visionCacheKey(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

export function createVisionCache({
  ttlMs = VISION_CACHE_TTL_MS,
  maxEntries = VISION_CACHE_MAX_ENTRIES,
  maxBytes = VISION_CACHE_MAX_BYTES,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  let bytes = 0;
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        bytes -= entry.bytes;
        return undefined;
      }
      // Refresh recency: re-inserting at the tail keeps the LRU discipline
      // simple (Map iterates in insertion order).
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      const existing = entries.get(key);
      if (existing) bytes -= existing.bytes;
      const size = Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
      entries.set(key, { value, bytes: size, expiresAt: now() + ttlMs });
      bytes += size;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        bytes -= entries.get(oldestKey).bytes;
        entries.delete(oldestKey);
      }
      return value;
    },
    get size() {
      return entries.size;
    },
    get byteCount() {
      return bytes;
    },
    clear() {
      entries.clear();
      bytes = 0;
    },
  };
}

export const visionEvidenceCache = createVisionCache();

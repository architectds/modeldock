import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MediaStore } from "../src/media-store.mjs";

function makeStore(overrides = {}) {
  return new MediaStore({
    ttlMs: 60_000,
    maxBytes: 10 * 1024 * 1024,
    maxEntries: 8,
    ...overrides,
  });
}

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const DATA_URL_OTHER = "data:image/jpeg;base64,AAAABBBBCCCCDDDD=";

test("stores a data url and returns a stable img_ ref", () => {
  const store = makeStore();
  const ref = store.put(DATA_URL);
  assert.match(ref, /^img_[0-9a-f]{20}$/);
  assert.equal(store.put(DATA_URL), ref);
  const item = store.get(ref);
  assert.equal(item.imageUrl, DATA_URL);
  assert.equal(item.mime, "image/png");
  assert.ok(item.size > 0);
});

test("refs are deterministic for identical content", () => {
  const store = makeStore();
  const ref1 = store.put(DATA_URL);
  const ref2 = store.put(DATA_URL);
  assert.equal(ref1, ref2);
});

test("different images get different refs", () => {
  const store = makeStore();
  assert.notEqual(store.put(DATA_URL), store.put(DATA_URL_OTHER));
});

test("accepts https remote urls", () => {
  const store = makeStore();
  const ref = store.put("https://example.com/image.png");
  assert.equal(store.get(ref).mime, "remote");
});

test("rejects empty and non-string image urls", () => {
  const store = makeStore();
  assert.throws(() => store.put(""), /non-empty string/);
  assert.throws(() => store.put(123), /non-empty string/);
  assert.throws(() => store.put(null), /non-empty string/);
});

test("rejects http remote urls", () => {
  const store = makeStore();
  assert.throws(() => store.put("http://example.com/image.png"), /Only image data URLs and public HTTPS URLs/);
});

test("rejects loopback urls", () => {
  const store = makeStore();
  for (const url of [
    "https://localhost/x.png",
    "https://127.0.0.1/x.png",
    "https://[::1]/x.png",
    "https://localhost:8080/x.png",
  ]) {
    assert.throws(() => store.put(url), /Local image URLs are not accepted/);
  }
});

test("rejects oversized data urls", () => {
  const store = makeStore({ maxBytes: 16 });
  assert.throws(() => store.put("data:image/png;base64," + "A".repeat(40)), /exceeds the 16-byte limit/);
});

test("expires entries after ttl since last access", () => {
  const store = makeStore({ ttlMs: 100 });
  const ref = store.put(DATA_URL);
  assert.ok(store.get(ref));
  store.cleanup(Date.now() + 101);
  assert.equal(store.get(ref), undefined);
});

test("get refreshes lastAccessAt so the entry survives another ttl window", () => {
  const store = makeStore({ ttlMs: 100 });
  const ref = store.put(DATA_URL);
  store.get(ref);
  store.cleanup(Date.now() + 90);
  assert.ok(store.get(ref));
  store.cleanup(Date.now() + 190);
  assert.equal(store.get(ref), undefined);
});

test("evicts least recently accessed entries beyond maxEntries", () => {
  const store = makeStore({ maxEntries: 3 });
  const r1 = store.put(DATA_URL);
  const r2 = store.put(DATA_URL_OTHER);
  const r3 = store.put("data:image/png;base64,CCCC");
  assert.ok(store.get(r1));
  assert.ok(store.get(r2));
  assert.ok(store.get(r3));
  const r4 = store.put("data:image/png;base64,DDDD");
  assert.ok(store.get(r4));
  assert.equal(store.get(r1), undefined, "r1 was least recently used and must be evicted");
  assert.ok(store.get(r2));
  assert.ok(store.get(r3));
});

test("evicts expired entries by lastAccessAt not createdAt", async () => {
  const store = makeStore({ ttlMs: 100, maxEntries: 2 });
  const r1 = store.put(DATA_URL);
  const r2 = store.put(DATA_URL_OTHER);
  await new Promise((resolve) => setTimeout(resolve, 60));
  store.get(r1);
  await new Promise((resolve) => setTimeout(resolve, 60));
  store.cleanup();
  assert.ok(store.get(r1), "r1 was accessed recently so must survive");
  assert.equal(store.get(r2), undefined, "r2 expired and must be gone");
  const r3 = store.put("data:image/png;base64,EEEE");
  assert.ok(store.get(r3));
});

test("snapshot reports entry count and bytes", () => {
  const store = makeStore();
  store.put(DATA_URL);
  store.put(DATA_URL_OTHER);
  const snap = store.snapshot();
  assert.equal(snap.entries, 2);
  assert.ok(snap.bytes > 0);
  assert.equal(snap.maxBytesPerImage, 10 * 1024 * 1024);
});

test("get on unknown ref returns undefined", () => {
  const store = makeStore();
  assert.equal(store.get("img_deadbeef"), undefined);
});

test("private-range urls are currently accepted (audit finding)", () => {
  const store = makeStore();
  const ref = store.put("https://192.168.1.5/x.png");
  assert.ok(ref.startsWith("img_"), "internal URLs are not rejected today");
});

test("persists data images so refs survive a store restart", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-media-"));
  try {
    const first = makeStore({ stateDir });
    const ref = first.put(DATA_URL);
    assert.ok(readFileSync(path.join(stateDir, `${ref}.bin`)).length > 0);
    const second = makeStore({ stateDir });
    const item = second.get(ref);
    assert.equal(item.imageUrl, DATA_URL);
    assert.equal(item.mime, "image/png");
    assert.equal(item.storage, "file");
    assert.match(readFileSync(path.join(stateDir, "index.json"), "utf8"), new RegExp(ref));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("persists remote image URLs across a store restart", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-media-"));
  try {
    const first = makeStore({ stateDir });
    const ref = first.put("https://example.com/image.png");
    const second = makeStore({ stateDir });
    assert.equal(second.get(ref).imageUrl, "https://example.com/image.png");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("removes persisted files when entries expire", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-media-"));
  try {
    const store = makeStore({ stateDir, ttlMs: 100 });
    const ref = store.put(DATA_URL);
    store.cleanup(Date.now() + 101);
    assert.equal(store.get(ref), undefined);
    assert.throws(() => readFileSync(path.join(stateDir, `${ref}.bin`)), /ENOENT/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

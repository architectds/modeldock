import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { encode as encodePng } from "fast-png";
import { createTransportImage } from "../src/image-transport.mjs";
import { MediaStore } from "../src/media-store.mjs";

const LIMIT = 320 * 1024;

function largePngDataUrl() {
  const width = 900;
  const height = 600;
  const data = new Uint8Array(width * height * 3);
  let state = 0x12345678;
  for (let index = 0; index < data.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[index] = state >>> 24;
  }
  const bytes = encodePng({ width, height, channels: 3, depth: 8, data });
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
}

function storeAt(stateDir) {
  return new MediaStore({
    ttlMs: 60_000,
    maxBytes: 10 * 1024 * 1024,
    maxEntries: 16,
    maxStoredBytes: 16 * 1024 * 1024,
    stateDir,
  });
}

test("creates a bounded JPEG transport copy without changing the original", () => {
  const original = largePngDataUrl();
  assert.ok(Buffer.byteLength(original) > LIMIT);
  const converted = createTransportImage(original, { maxWireBytes: LIMIT });
  assert.equal(converted.transformed, true);
  assert.match(converted.imageUrl, /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.byteLength(converted.imageUrl) <= LIMIT);
  assert.equal(converted.originalWireBytes, Buffer.byteLength(original));
  assert.equal(original.startsWith("data:image/png;base64,"), true, "the caller's canonical bytes remain untouched");
});

test("MediaStore persists an internal derivative while the canonical ref stays exact", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-image-transport-"));
  try {
    const original = largePngDataUrl();
    const store = storeAt(root);
    const ref = store.put(original, { sessionId: "session-image-transport" });
    const first = store.getTransportVariant(ref, { maxWireBytes: LIMIT, sessionId: "session-image-transport" });
    assert.equal(first.ref, ref, "the public identity remains the original ref");
    assert.notEqual(first.transportRef, ref, "the derivative has an internal content hash");
    assert.equal(store.get(ref).imageUrl, original, "the original pixels were not replaced");
    assert.ok(Buffer.byteLength(first.imageUrl) <= LIMIT);
    assert.equal(store.snapshot().derivedEntries, 1);

    const restored = storeAt(root);
    const second = restored.getTransportVariant(ref, { maxWireBytes: LIMIT, sessionId: "session-image-transport" });
    assert.equal(second.transportRef, first.transportRef);
    assert.equal(second.cached, true, "a gateway restart reuses the stored derivative");
    assert.equal(restored.get(ref).imageUrl, original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaves an already-small image byte-identical", () => {
  const original = "data:image/png;base64,AAAA";
  const converted = createTransportImage(original, { maxWireBytes: LIMIT });
  assert.equal(converted.transformed, false);
  assert.equal(converted.imageUrl, original);
});

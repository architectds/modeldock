import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import {
  createScreenshotPreview,
  SCREENSHOT_PREVIEW_HARD_MAX_BYTES,
  SCREENSHOT_PREVIEW_PREFERRED_MIN_BYTES,
  SCREENSHOT_PREVIEW_TARGET_BYTES,
} from "../src/image-transport.mjs";
import { previewLocalImages } from "../src/image-preview.mjs";
import { describeImageUrl, MediaStore } from "../src/media-store.mjs";

const BUILT_PREVIEW_WORKER = fileURLToPath(new URL("../dist/mcp-standalone.mjs", import.meta.url));

function noisyPng(width = 1200, height = 800) {
  const data = new Uint8Array(width * height * 3);
  let state = 0x5eeda11;
  for (let index = 0; index < data.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[index] = state >>> 24;
  }
  return Buffer.from(encodePng({ width, height, channels: 3, depth: 8, data }));
}

function storeAt(stateDir) {
  return new MediaStore({
    ttlMs: 60_000,
    maxBytes: 10 * 1024 * 1024,
    maxEntries: 64,
    maxStoredBytes: 32 * 1024 * 1024,
    stateDir,
  });
}

test("screenshot previews preserve the source and stay inside the preferred range", () => {
  const original = noisyPng();
  const imageUrl = `data:image/png;base64,${original.toString("base64")}`;
  const preview = createScreenshotPreview(imageUrl);
  assert.equal(preview.transformed, true);
  assert.equal(preview.originalBytes, original.byteLength);
  assert.ok(preview.previewBytes >= SCREENSHOT_PREVIEW_PREFERRED_MIN_BYTES, `${preview.previewBytes} should retain useful screenshot detail`);
  assert.ok(preview.previewBytes <= SCREENSHOT_PREVIEW_TARGET_BYTES);
  assert.ok(preview.previewBytes <= SCREENSHOT_PREVIEW_HARD_MAX_BYTES);
  assert.equal(imageUrl, `data:image/png;base64,${original.toString("base64")}`, "the canonical source is untouched");
});

test("an already-small screenshot is not enlarged to the preferred floor", () => {
  const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const imageUrl = `data:image/png;base64,${original.toString("base64")}`;
  const preview = createScreenshotPreview(imageUrl);
  assert.equal(preview.transformed, false);
  assert.equal(preview.previewBytes, original.byteLength);
  assert.ok(preview.previewBytes < SCREENSHOT_PREVIEW_PREFERRED_MIN_BYTES);
  assert.equal(preview.imageUrl, imageUrl);
});

test("preview_images returns bounded image blocks while the original ref stays exact", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-preview-"));
  const source = path.join(root, "dashboard.png");
  const media = path.join(root, "media");
  const original = noisyPng();
  writeFileSync(source, original);
  try {
    const store = storeAt(media);
    const result = await previewLocalImages({ paths: [source] }, { mediaStore: store });
    assert.equal(result.content.length, 2);
    const manifest = JSON.parse(result.content[0].text);
    const image = result.content[1];
    assert.equal(manifest.kind, "screenshot_previews");
    assert.equal(manifest.images.length, 1);
    assert.match(manifest.images[0].original_ref, /^img_/);
    assert.equal(image.type, "image");
    assert.equal(Buffer.from(image.data, "base64").byteLength, manifest.images[0].preview_bytes);
    assert.ok(manifest.images[0].preview_bytes <= SCREENSHOT_PREVIEW_TARGET_BYTES);
    const canonical = store.get(manifest.images[0].original_ref);
    assert.deepEqual(describeImageUrl(canonical.imageUrl).bytes, original);
    assert.deepEqual(readFileSync(source), original, "the source file is never overwritten");

    const restored = storeAt(media);
    const secondResult = await previewLocalImages({ paths: [source] }, { mediaStore: restored });
    const second = JSON.parse(secondResult.content[0].text).images[0];
    assert.equal(second.cached, true, "a restart reuses the bounded derivative");
    assert.ok(second.preview_bytes <= SCREENSHOT_PREVIEW_TARGET_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch of screenshots returns one bounded preview per source", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-preview-batch-"));
  const media = path.join(root, "media");
  const original = noisyPng(900, 600);
  const paths = Array.from({ length: 12 }, (_, index) => {
    const file = path.join(root, `shot-${index + 1}.png`);
    writeFileSync(file, original);
    return file;
  });
  try {
    const result = await previewLocalImages({ paths }, { mediaStore: storeAt(media) });
    const images = result.content.filter((item) => item.type === "image");
    assert.equal(images.length, 12);
    for (const image of images) {
      assert.ok(Buffer.from(image.data, "base64").byteLength <= SCREENSHOT_PREVIEW_TARGET_BYTES);
      assert.ok(Buffer.from(image.data, "base64").byteLength <= SCREENSHOT_PREVIEW_HARD_MAX_BYTES);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one bad screenshot does not discard the rest of a batch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-preview-partial-"));
  const source = path.join(root, "good.png");
  writeFileSync(source, noisyPng(600, 400));
  try {
    const result = await previewLocalImages({
      paths: [path.join(root, "missing.png"), source],
    }, { mediaStore: storeAt(path.join(root, "media")) });
    const manifest = JSON.parse(result.content[0].text);
    assert.equal(manifest.images.length, 1);
    assert.equal(manifest.skipped.length, 1);
    assert.equal(result.content.filter((item) => item.type === "image").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped MCP bundle carries the off-thread preview worker", {
  skip: !existsSync(BUILT_PREVIEW_WORKER) && "build the bundle before this coupling check",
}, () => {
  const original = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const worker = spawnSync(process.execPath, [BUILT_PREVIEW_WORKER, "--image-preview-worker"], {
    input: JSON.stringify({
      imageUrl: `data:image/png;base64,${original.toString("base64")}`,
      targetBytes: SCREENSHOT_PREVIEW_TARGET_BYTES,
      hardMaxBytes: SCREENSHOT_PREVIEW_HARD_MAX_BYTES,
    }),
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(worker.status, 0, worker.stderr);
  const result = JSON.parse(worker.stdout);
  assert.equal(result.previewBytes, original.byteLength);
  assert.equal(result.transformed, false);
});

test("large preview encoding does not block the gateway event loop", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-preview-yield-"));
  const source = path.join(root, "large.png");
  writeFileSync(source, noisyPng());
  try {
    const startedAt = Date.now();
    const work = previewLocalImages({ paths: [source] }, { mediaStore: storeAt(path.join(root, "media")) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(Date.now() - startedAt < 250, "the event loop remains responsive while the child encodes JPEG");
    await work;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CLOUD_COMPACT_IMAGE_WIRE_BUDGET_BYTES,
  DEFAULT_CLOUD_IMAGE_WIRE_BUDGET_BYTES,
  constrainImagesForTransport,
  imageWireBudgetFor,
} from "../src/gateway.mjs";

const MB = 1024 * 1024;

function dataUrl(bytes) {
  return `data:image/png;base64,${"A".repeat(bytes - 22)}`;
}

function fakeMediaStore() {
  const byUrl = new Map();
  const byRef = new Map();
  let next = 0;
  return {
    put(url) {
      if (!byUrl.has(url)) {
        const ref = `img_budget${String(++next).padStart(4, "0")}`;
        byUrl.set(url, ref);
        byRef.set(ref, url);
      }
      return byUrl.get(url);
    },
    getTransportVariant(ref, { maxWireBytes } = {}) {
      const url = byRef.get(ref);
      if (!url) throw new Error("no variant");
      const limit = Number(maxWireBytes);
      if (!Number.isFinite(limit) || Buffer.byteLength(url) <= limit) return { imageUrl: url };
      const prefix = "data:image/jpeg;base64,";
      return { imageUrl: prefix + "B".repeat(Math.max(0, limit - prefix.length)) };
    },
  };
}

function turnWithImages(sizes) {
  return [{
    type: "message",
    role: "user",
    content: sizes.map((bytes) => ({ type: "input_image", image_url: dataUrl(bytes) })),
  }];
}

function forwardedImageBytes(input) {
  let total = 0;
  for (const item of input) {
    for (const part of item?.content || []) {
      if (part?.type === "input_image") total += Buffer.byteLength(part.image_url);
    }
  }
  return total;
}

test("cloud vision models get a byte budget; local and text-only models do not", () => {
  assert.equal(
    imageWireBudgetFor({ entry: { supportsVision: true }, supportsVision: true, localBackend: false }),
    DEFAULT_CLOUD_IMAGE_WIRE_BUDGET_BYTES,
  );
  assert.equal(
    imageWireBudgetFor({ entry: { supportsVision: true }, supportsVision: true, localBackend: false, compaction: true }),
    DEFAULT_CLOUD_COMPACT_IMAGE_WIRE_BUDGET_BYTES,
  );
  assert.ok(DEFAULT_CLOUD_COMPACT_IMAGE_WIRE_BUDGET_BYTES < DEFAULT_CLOUD_IMAGE_WIRE_BUDGET_BYTES);
  // A provider-declared limit still wins over the cloud default.
  assert.equal(
    imageWireBudgetFor({ entry: { supportsVision: true, imageTransportMaxWireBytes: 320 * 1024 }, supportsVision: true, localBackend: false }),
    320 * 1024,
  );
  // Local backends are not body-capped by a remote edge.
  assert.equal(
    imageWireBudgetFor({ entry: { supportsVision: true }, supportsVision: true, localBackend: true }),
    0,
  );
  // Text-only routes already turn every image into a ref before this stage.
  assert.equal(
    imageWireBudgetFor({ entry: {}, supportsVision: false, localBackend: false }),
    0,
  );
});

test("a screenshot-heavy turn is trimmed to the byte budget and keeps the newest pixels", () => {
  const newest = dataUrl(3 * MB);
  const input = turnWithImages([
    2 * MB, 2 * MB, 2 * MB, 2 * MB, 2 * MB, 2 * MB, 2 * MB, 2 * MB,
  ]);
  input[0].content.push({ type: "input_image", image_url: newest });

  const forwarded = constrainImagesForTransport(input, fakeMediaStore(), {
    maxTotalWireBytes: DEFAULT_CLOUD_IMAGE_WIRE_BUDGET_BYTES,
  });

  assert.ok(
    forwardedImageBytes(forwarded) <= DEFAULT_CLOUD_IMAGE_WIRE_BUDGET_BYTES,
    `forwarded ${forwardedImageBytes(forwarded)} bytes`,
  );
  const lastContent = forwarded[0].content;
  assert.equal(lastContent.at(-1).type, "input_image");
  assert.equal(lastContent.at(-1).image_url, newest);
  assert.ok(
    lastContent.some((part) => part.type === "input_text" && /Image attachment img_budget/.test(part.text)),
    "older pixels become durable refs",
  );
});

test("the compact budget is small enough that a compaction request always fits", () => {
  const input = turnWithImages(Array.from({ length: 12 }, () => MB));
  const forwarded = constrainImagesForTransport(input, fakeMediaStore(), {
    maxTotalWireBytes: DEFAULT_CLOUD_COMPACT_IMAGE_WIRE_BUDGET_BYTES,
  });
  assert.ok(
    forwardedImageBytes(forwarded) <= DEFAULT_CLOUD_COMPACT_IMAGE_WIRE_BUDGET_BYTES,
    `forwarded ${forwardedImageBytes(forwarded)} bytes`,
  );
});

test("images already inside the budget are untouched", () => {
  const input = turnWithImages([200 * 1024, 300 * 1024]);
  const store = fakeMediaStore();
  const forwarded = constrainImagesForTransport(input, store, {
    maxTotalWireBytes: DEFAULT_CLOUD_IMAGE_WIRE_BUDGET_BYTES,
  });
  assert.equal(forwardedImageBytes(forwarded), forwardedImageBytes(input));
  assert.equal(forwarded[0].content.length, 2);
});

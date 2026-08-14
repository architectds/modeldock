import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { callerBasePath, callerKeyEqual, loadOrCreateCallerKey, validCallerKey } from "../src/caller-key.mjs";

test("mints a persistent key on first load and reuses it after", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-key-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "caller-key");
  const first = loadOrCreateCallerKey(file);
  assert.equal(validCallerKey(first), true);
  assert.equal(readFileSync(file, "utf8").trim(), first);
  const second = loadOrCreateCallerKey(file);
  assert.equal(second, first, "the persisted key is reused");
});

test("rejects short or malformed keys", () => {
  assert.equal(validCallerKey("short"), false);
  assert.equal(validCallerKey("has spaces ".repeat(4)), false);
  assert.equal(validCallerKey("a".repeat(32)), true);
});

test("callerKeyEqual is length-safe and exact", () => {
  const key = "k".repeat(43);
  assert.equal(callerKeyEqual(key, key), true);
  assert.equal(callerKeyEqual(key, `${key}x`), false);
  assert.equal(callerKeyEqual(undefined, key), false);
});

test("callerBasePath shapes the URL segment", () => {
  assert.equal(callerBasePath("abc"), "/c/abc/v1");
});

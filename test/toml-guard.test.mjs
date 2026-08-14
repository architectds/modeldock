import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { duplicateKeys, assertConfigWriteSafe, appendConfigManifest } from "../src/toml-guard.mjs";

const CLEAN = [
  'model = "gpt-5.6-sol"',
  "",
  "[model_providers.opencode]",
  'experimental_bearer_token = "token"',
].join("\n");

test("duplicateKeys finds duplicated top-level keys", () => {
  const source = 'model = "a"\nmodel = "b"\nprofile = "x"\n';
  assert.deepEqual(duplicateKeys(source), ["model"]);
});

test("duplicateKeys finds duplicated in-table keys", () => {
  const source = [
    "[mcp_servers.modeldock]",
    'url = "http://a"',
    'url = "http://b"',
  ].join("\n");
  assert.deepEqual(duplicateKeys(source), ["mcp_servers.modeldock.url"]);
});

test("duplicateKeys ignores comments, blank lines, and repeated array-of-tables entries", () => {
  const source = [
    "# model = \"commented\"",
    'model = "a"',
    "",
    "[[providers]]",
    'name = "one"',
    "[[providers]]",
    'name = "two"',
  ].join("\n");
  assert.deepEqual(duplicateKeys(source), []);
});

test("duplicateKeys returns [] for a clean config", () => {
  assert.deepEqual(duplicateKeys(CLEAN), []);
});

test("assertConfigWriteSafe throws with DUPLICATE_TOML_KEY and leaves the decision to the caller", () => {
  const source = 'model = "a"\nmodel = "b"\n';
  assert.throws(
    () => assertConfigWriteSafe(source),
    (error) => error.code === "DUPLICATE_TOML_KEY" && /duplicate key\(s\): model/.test(error.message),
  );
  assert.doesNotThrow(() => assertConfigWriteSafe(CLEAN));
});

test("appendConfigManifest appends one JSON line per entry and never throws", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-manifest-"));
  try {
    const first = await appendConfigManifest(dir, { operation: "enable", reason: "test" });
    const second = await appendConfigManifest(dir, { operation: "disable", reason: "test" });
    assert.equal(first, true);
    assert.equal(second, true);
    const lines = readFileSync(path.join(dir, "config-manifest.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const [a, b] = lines.map((line) => JSON.parse(line));
    assert.equal(a.operation, "enable");
    assert.equal(b.operation, "disable");
    assert.ok(a.at && b.at, "entries carry a timestamp");
    const sorted = [a.at, b.at].sort();
    assert.deepEqual([a.at, b.at], sorted, "entries are append-ordered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

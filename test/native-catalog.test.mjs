import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { desktopCodexCandidates, nativeCatalogPath, nativeModelSlugs, readNativeCatalog } from "../src/native-catalog.mjs";

function writeCapture(file, models) {
  writeFileSync(file, JSON.stringify({ captured_with: "0.1.0", models }), "utf8");
}

test("readNativeCatalog returns null for a missing cache and a corrupt cache", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const missing = path.join(dir, "missing.json");
    assert.equal(readNativeCatalog({ nativeCatalogFile: missing }), null);
    const corrupt = path.join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json", "utf8");
    assert.equal(readNativeCatalog({ nativeCatalogFile: corrupt }), null);
    const wrongShape = path.join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ models: "nope" }), "utf8");
    assert.equal(readNativeCatalog({ nativeCatalogFile: wrongShape }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nativeCatalogPath honors the config override and otherwise defaults under ~/.modeldock", () => {
  const override = path.join(os.tmpdir(), "modeldock-native-override.json");
  assert.equal(nativeCatalogPath({ nativeCatalogFile: override }), override);
  assert.equal(
    nativeCatalogPath({}),
    path.join(os.homedir(), ".modeldock", "native-catalog.json"),
  );
});

test("nativeModelSlugs includes every captured slug, hidden or not", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "gpt-5.4-mini", visibility: "hide" },
      { slug: "codex-auto-review", visibility: "hide" },
    ]);
    const slugs = nativeModelSlugs({ nativeCatalogFile: file });
    assert.deepEqual([...slugs].sort(), ["codex-auto-review", "gpt-5.4-mini", "gpt-5.6-sol"]);
    assert.equal(nativeModelSlugs({ nativeCatalogFile: path.join(dir, "missing.json") }).size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktopCodexCandidates covers the bundled Windows and macOS CLIs", () => {
  const mac = desktopCodexCandidates("darwin");
  assert.ok(
    mac.some((candidate) => candidate.endsWith(path.join("ChatGPT.app", "Contents", "Resources", "codex"))),
    "macOS must include the ChatGPT.app bundled Codex CLI",
  );

  const win = desktopCodexCandidates("win32");
  assert.ok(win.every((candidate) => candidate.endsWith("codex.exe")), "Windows candidates must point at codex.exe");
});

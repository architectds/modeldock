import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import {
  codexAppCandidates,
  desktopCodexCandidates,
  nativeCatalogPath,
  nativeModelSlugs,
  nativeSelectableModelSlugs,
  nativeVisionModelSlugs,
  parseCodexVersion,
  readNativeCatalog,
} from "../src/native-catalog.mjs";
import { applyNativeVisionDefault } from "../src/services.mjs";

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

test("an unchanged native catalog is parsed once and a replaced file invalidates it", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-cache-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [{ slug: "gpt-cache-one", visibility: "list" }]);
    const config = { nativeCatalogFile: file };
    const first = readNativeCatalog(config);
    const second = readNativeCatalog(config);
    assert.equal(second, first, "the unchanged file returns the cached parsed object");

    writeCapture(file, [
      { slug: "gpt-cache-one", visibility: "list" },
      { slug: "gpt-cache-two", visibility: "list" },
    ]);
    const replaced = readNativeCatalog(config);
    assert.notEqual(replaced, first, "a new file version invalidates the parsed object");
    assert.deepEqual(replaced.models.map((model) => model.slug), ["gpt-cache-one", "gpt-cache-two"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native selectable and vision projections come from the captured catalog", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [
      { slug: "gpt-future-text", visibility: "list", input_modalities: ["text"] },
      { slug: "gpt-future-vision", visibility: "list", input_modalities: ["text", "image"] },
      { slug: "gpt-future-hidden", visibility: "hide", input_modalities: ["text", "image"] },
    ]);
    const config = { nativeCatalogFile: file };
    assert.deepEqual(nativeSelectableModelSlugs(config), ["gpt-future-text", "gpt-future-vision"]);
    assert.deepEqual(nativeVisionModelSlugs(config), ["gpt-future-vision"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a first-boot native refresh fills vision once without replacing a saved choice", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-default-"));
  try {
    const file = path.join(dir, "native-catalog.json");
    writeCapture(file, [
      { slug: "gpt-future-text", visibility: "list", input_modalities: ["text"] },
      { slug: "gpt-future-vision", visibility: "list", input_modalities: ["text", "image"] },
    ]);
    const freshConfig = {
      nativeCatalogFile: file,
      nativeMerge: true,
      visionModelConfigured: false,
      visionModel: "",
    };
    const freshSelection = { visionModel: "" };
    assert.equal(applyNativeVisionDefault(freshConfig, freshSelection), true);
    assert.equal(freshConfig.visionModel, "gpt-future-vision");
    assert.equal(freshSelection.visionModel, "gpt-future-vision");

    const savedConfig = {
      nativeCatalogFile: file,
      nativeMerge: true,
      visionModelConfigured: true,
      visionModel: "gpt-saved-vision",
    };
    const savedSelection = { visionModel: "gpt-saved-vision" };
    assert.equal(applyNativeVisionDefault(savedConfig, savedSelection), false);
    assert.equal(savedSelection.visionModel, "gpt-saved-vision");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktopCodexCandidates covers the bundled Windows and macOS CLIs", () => {
  const mac = desktopCodexCandidates("darwin");
  assert.ok(
    mac.some((candidate) => candidate.endsWith(path.join("Codex.app", "Contents", "Resources", "codex"))),
    "macOS must include the current Codex.app bundled CLI",
  );
  assert.ok(
    mac.some((candidate) => candidate.endsWith(path.join("ChatGPT.app", "Contents", "Resources", "codex"))),
    "macOS must retain the legacy ChatGPT.app bundled CLI",
  );

  const win = desktopCodexCandidates("win32");
  assert.ok(win.every((candidate) => candidate.endsWith("codex.exe")), "Windows candidates must point at codex.exe");
});

test("codexAppCandidates discovers a renamed macOS app without a source update", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mac-apps-"));
  try {
    const binary = path.join(dir, "Future OpenAI Agent.app", "Contents", "Resources", "codex");
    mkdirSync(path.dirname(binary), { recursive: true });
    writeFileSync(binary, "placeholder", "utf8");
    assert.deepEqual(codexAppCandidates(dir), [binary]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCodexVersion reads the version out of the CLI banner", () => {
  assert.equal(parseCodexVersion("codex-cli 0.145.0"), "0.145.0");
  assert.equal(parseCodexVersion("codex-cli 0.145.0\n"), "0.145.0");
  assert.equal(parseCodexVersion("0.130.0"), "0.130.0", "a bare version still parses");
  assert.equal(parseCodexVersion("codex-cli 0.148.0-alpha.9"), "0.148.0-alpha.9", "prereleases are kept whole");
  assert.equal(parseCodexVersion("codex-cli 0.142.5 (abc1234)"), "0.142.5", "trailing build metadata is ignored");
});

test("parseCodexVersion returns empty for anything it cannot read", () => {
  // "" means "unknown", which is a usable answer; a wrong version is not.
  for (const input of ["", "   ", "codex-cli", "not a version", null, undefined]) {
    assert.equal(parseCodexVersion(input), "", `expected "" for ${JSON.stringify(input)}`);
  }
});

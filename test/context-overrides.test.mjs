// An override is the one number in the catalog a user can set, so it has to
// survive a restart, lose to nothing, and never accept a typo.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  MAX_CONTEXT_WINDOW,
  MIN_CONTEXT_WINDOW,
  applyContextOverrides,
  readContextOverrides,
  validateContextWindow,
  writeContextOverrides,
} from "../src/context-overrides.mjs";

const publishedSlugFor = (provider, id) => (id.includes("@") ? id : `${id}@${provider}`);

function tmpFile(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ctx-override-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "context-overrides.json");
}

test("an override survives the round trip", (t) => {
  const file = tmpFile(t);
  assert.deepEqual(readContextOverrides(file), {}, "no file reads as no overrides");
  writeContextOverrides(file, { "kimi-k3@opencode-go": 500_000 });
  assert.deepEqual(readContextOverrides(file), { "kimi-k3@opencode-go": 500_000 });
});

test("clearing the last override removes the file rather than leaving an empty one", (t) => {
  const file = tmpFile(t);
  writeContextOverrides(file, { "a@b": 100_000 });
  writeContextOverrides(file, {});
  assert.deepEqual(readContextOverrides(file), {});
});

test("a corrupt or out-of-range entry is dropped, not trusted", (t) => {
  const file = tmpFile(t);
  writeContextOverrides(file, { good: 200_000 });
  // Hand-edited files happen; a value nobody could have meant is not a value.
  writeFileSync(file, JSON.stringify({ good: 200_000, tiny: 10, huge: 99_000_000, junk: "many" }), "utf8");
  assert.deepEqual(readContextOverrides(file), { good: 200_000 });
});

test("validation catches the digit slips", () => {
  assert.equal(validateContextWindow(262_144).ok, true);
  assert.equal(validateContextWindow(MIN_CONTEXT_WINDOW).ok, true);
  assert.equal(validateContextWindow(MAX_CONTEXT_WINDOW).ok, true);
  // A dropped zero and an extra one are the two mistakes worth catching.
  assert.equal(validateContextWindow(100).ok, false);
  assert.equal(validateContextWindow(MAX_CONTEXT_WINDOW + 1).ok, false);
  assert.equal(validateContextWindow(0).ok, false);
  assert.equal(validateContextWindow(-1).ok, false);
  assert.equal(validateContextWindow("nonsense").ok, false);
  assert.equal(validateContextWindow(262_144.7).value, 262_145, "a fraction rounds rather than failing");
});

test("an override wins over the shipped catalog and says it was edited", () => {
  const profile = {
    id: "opencode-go",
    availableModels: [
      { id: "kimi-k3", contextWindow: 1_048_576, contextSource: "vendor" },
      { id: "grok-4.5", contextWindow: 500_000, contextSource: "vendor" },
    ],
  };
  const applied = applyContextOverrides([profile], { "kimi-k3@opencode-go": 262_144 }, { publishedSlugFor });
  assert.equal(applied, 1);
  const [kimi, grok] = profile.availableModels;
  assert.equal(kimi.contextWindow, 262_144);
  // Not "vendor": the roster has to be able to show an edited number as edited.
  assert.equal(kimi.contextSource, "user");
  assert.equal(grok.contextWindow, 500_000, "an untouched model keeps its shipped value");
  assert.equal(grok.contextSource, "vendor");
});

test("an override for a model that no longer exists is simply ignored", () => {
  const profile = { id: "opencode-go", availableModels: [{ id: "kimi-k3", contextWindow: 1_048_576 }] };
  const applied = applyContextOverrides([profile], { "retired-model@opencode-go": 100_000 }, { publishedSlugFor });
  assert.equal(applied, 0);
  assert.equal(profile.availableModels[0].contextWindow, 1_048_576);
});

test("the same model name under two providers is overridden separately", () => {
  const go = { id: "opencode-go", availableModels: [{ id: "deepseek-v4-flash", contextWindow: 1_000_000 }] };
  const ds = { id: "deepseek-official", availableModels: [{ id: "deepseek-v4-flash", contextWindow: 1_000_000 }] };
  applyContextOverrides([go, ds], { "deepseek-v4-flash@opencode-go": 400_000 }, { publishedSlugFor });
  assert.equal(go.availableModels[0].contextWindow, 400_000);
  assert.equal(ds.availableModels[0].contextWindow, 1_000_000, "the other provider is untouched");
});

test("clearing an override restores the shipped value", () => {
  // The catalog is a module literal edited in place, so the first version of
  // this pass overwrote the shipped figure with no copy kept: clearing left the
  // correction in place forever. Applying the current override set has to be
  // enough to get every entry right, in either direction.
  const profile = {
    id: "opencode-go",
    availableModels: [{ id: "kimi-k3", contextWindow: 1_048_576, contextSource: "vendor" }],
  };
  const model = profile.availableModels[0];

  applyContextOverrides([profile], { "kimi-k3@opencode-go": 262_144 }, { publishedSlugFor });
  assert.equal(model.contextWindow, 262_144);
  assert.equal(model.contextSource, "user");

  applyContextOverrides([profile], {}, { publishedSlugFor });
  assert.equal(model.contextWindow, 1_048_576, "the shipped window comes back");
  assert.equal(model.contextSource, "vendor", "and so does where it came from");
  assert.equal(model.shippedContextWindow, undefined, "the copy is not left behind");
});

test("applying the same override twice is not applying it twice", () => {
  const profile = {
    id: "opencode-go",
    availableModels: [{ id: "kimi-k3", contextWindow: 1_048_576, contextSource: "vendor" }],
  };
  const overrides = { "kimi-k3@opencode-go": 262_144 };
  applyContextOverrides([profile], overrides, { publishedSlugFor });
  applyContextOverrides([profile], overrides, { publishedSlugFor });
  // The second pass must not record 262,144 as the shipped value.
  applyContextOverrides([profile], {}, { publishedSlugFor });
  assert.equal(profile.availableModels[0].contextWindow, 1_048_576);
});

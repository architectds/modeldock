import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { baseInstructionsFor, catalogFor, enabledProvidersFor, mergeNativeCatalog } from "./catalog.mjs";
import { OPENCODE_GO_PROFILE } from "./profiles.mjs";
import { isNativeModel } from "./gateway.mjs";

function configStub() {
  return {
    profile: OPENCODE_GO_PROFILE,
    profileId: "opencode-go",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    goToken: "go-token",
    tokens: { "opencode-go": "go-token", "deepseek-official": "" },
    // Never read a real ~/.modeldock/native-catalog.json capture in tests.
    nativeCatalogFile: path.join(os.tmpdir(), "modeldock-test-native-missing.json"),
  };
}

test("catalogFor declares image input for the text-only main model (image escalation)", () => {
  const catalog = catalogFor(configStub());
  const main = catalog.models.find((entry) => entry.slug === "deepseek-v4-flash");
  assert.ok(main, "main model entry exists");
  assert.deepEqual(main.input_modalities, ["text", "image"], "endpoint handles images by escalating to the vision model");
  assert.equal(main.supports_search_tool, false, "search is the MCP tool, not a hosted schema");
  assert.equal(main.supports_parallel_tool_calls, false);
  assert.equal(main.reasoning_summary_format, "experimental");
});

test("catalogFor keeps the main model first with the profile comp hash", () => {
  const catalog = catalogFor(configStub());
  assert.equal(catalog.models[0].slug, "deepseek-v4-flash");
  assert.equal(catalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(catalog.models[0].context_window, 400_000, "deepseek-v4-flash declares 400k so Codex compacts at 320k");
  assert.equal(catalog.models[0].auto_compact_token_limit, 320_000);
});

test("catalogFor covers every available model", () => {
  const catalog = catalogFor(configStub());
  const available = OPENCODE_GO_PROFILE.availableModels.filter((model) => model.status !== "unavailable").length;
  assert.ok(catalog.models.length >= available, `catalog lists at least the ${available} available models`);
  for (const entry of catalog.models) {
    assert.deepEqual(entry.input_modalities, ["text", "image"], `${entry.slug} declares image input at the endpoint`);
  }
});

test("baseInstructionsFor includes the vision and restart guidance", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /TEXT-ONLY model and CANNOT see images/);
  assert.match(instructions, /call vision_inspect/);
  assert.match(instructions, /restart\.ps1/);
});

test("baseInstructionsFor includes the design-first workflow", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /Design-first workflow \(MANDATORY for frontend\/UI work\)/);
  assert.match(instructions, /run image_gen first/);
  assert.match(instructions, /read the output with vision_inspect/);
  assert.match(instructions, /implement by translating structure, palette, and hierarchy/);
});

test("baseInstructionsFor includes the memory lookup guidance", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /MEMORY\.md/);
  assert.match(instructions, /applies_to matches the current working directory/);
});

test("baseInstructionsFor pushes memory use when the vault is enabled", () => {
  const instructions = baseInstructionsFor({ ...configStub(), memoryEnabled: true });
  assert.match(instructions, /Memory \(MANDATORY\)/);
  assert.match(instructions, /call recall_memory once/);
  assert.match(instructions, /Call store_memory as soon as/);
});

test("baseInstructionsFor omits the memory push when the vault is disabled", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.doesNotMatch(instructions, /Memory \(MANDATORY\)/);
});

test("enabledProvidersFor includes the active profile and any provider with a token", () => {
  const ids = enabledProvidersFor(configStub());
  assert.deepEqual([...ids].sort(), ["opencode-go"]);

  const withDeepSeek = {
    ...configStub(),
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
  };
  assert.deepEqual([...enabledProvidersFor(withDeepSeek)].sort(), ["deepseek-official", "opencode-go"]);
});

test("catalogFor publishes only models owned by enabled providers", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash"));
  assert.ok(!slugs.some((slug) => slug.endsWith("@deepseek-official")), "DeepSeek official models are hidden without a token");

  const withDeepSeek = {
    ...configStub(),
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
  };
  const withDeepSeekCatalog = catalogFor(withDeepSeek);
  assert.ok(withDeepSeekCatalog.models.some((entry) => entry.slug === "deepseek-v4-flash@deepseek-official"));
});

test("the bare gpt-5.6-luna slot stays reserved for the native GPT pipeline", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("gpt-5.6-luna@opencode-go"), "our Luna is published under the owner suffix");
  assert.ok(!slugs.includes("gpt-5.6-luna"), "the bare id stays free for the native backend's GPT-5.6-Luna");
  const known = new Set(slugs);
  assert.equal(isNativeModel("gpt-5.6-luna", known), true, "a native request for the bare id passes through to ChatGPT");
  assert.equal(isNativeModel("gpt-5.6-luna@opencode-go", known), false, "our qualified slug stays on the routed path");
});

test("mergeNativeCatalog publishes picker-visible native models grouped with their provider", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 },
      { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "hide", priority: 23 },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
    ],
  }), "utf8");
  try {
    const merged = mergeNativeCatalog(catalogFor(configStub()), { ...configStub(), nativeCatalogFile: file });
    const slugs = merged.models.map((entry) => entry.slug);
    const native = merged.models.find((entry) => entry.slug === "gpt-5.6-luna");
    assert.ok(native, "list-visible native model is published");
    assert.equal(native.display_name, "OpenAI - GPT-5.6-Luna", "native entries use the Provider - Model picker name");
    assert.equal(native.provider, "openai", "native entries are tagged for provider grouping");
    assert.ok(!slugs.includes("gpt-5.4-mini"), "picker-hidden native model stays out of the catalog");
    assert.ok(!slugs.includes("codex-auto-review"), "hidden native models stay out of the catalog");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor with nativeMerge=false skips the native GPT merge for non-subscribers", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-nomerge-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 }],
  }), "utf8");
  try {
    const catalog = catalogFor({ ...configStub(), nativeCatalogFile: file, nativeMerge: false });
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("deepseek-v4-flash"), "curated Go models stay published");
    const nativeIdentity = catalog.models.find((entry) => String(entry.display_name).startsWith("OpenAI -"));
    assert.ok(!nativeIdentity, "no native GPT identity is published (no 'OpenAI -' entry)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor login-free aliasing republishes external models under native slug slots", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-alias-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1 },
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 },
      { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
    ],
  }), "utf8");
  try {
    const catalog = catalogFor({ ...configStub(), nativeCatalogFile: file, nativeMerge: false });
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(slugs.includes("gpt-5.6-sol"), "the first native slot is occupied by an aliased external model");
    assert.ok(slugs.includes("gpt-5.6-luna"), "the second native slot is occupied by an aliased external model");
    assert.ok(!slugs.includes("codex-auto-review"), "the reserved auto-review slot is never aliased");
    const aliased = catalog.models.find((entry) => entry.slug === "gpt-5.6-sol");
    assert.ok(aliased, "aliased entry exists");
    assert.match(aliased.display_name, /OpenCode Go/, "the external model's own display name is kept");
    assert.equal(aliased.visibility, "list", "aliased entries stay picker-visible");
    const canonical = catalog.models.find((entry) => entry.slug === "deepseek-v4-flash");
    assert.equal(canonical?.visibility, "hide", "the canonical external slug stays published but hidden for routing");
    assert.ok(catalog.aliases && catalog.aliases["gpt-5.6-sol"] === "deepseek-v4-flash", "the alias map points the native slot at the external model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor login-free aliasing honors MODELDOCK_NATIVE_ALIAS=0 opt-out", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-alias-off-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1 }],
  }), "utf8");
  try {
    const catalog = catalogFor({ ...configStub(), nativeCatalogFile: file, nativeMerge: false, nativeAlias: false });
    const slugs = catalog.models.map((entry) => entry.slug);
    assert.ok(!slugs.includes("gpt-5.6-sol"), "native slot is not occupied when aliasing is disabled");
    assert.ok(!catalog.aliases, "no alias map when aliasing is disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor in trial mode publishes only the fixed free pair and never merges native", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-trial-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 }],
  }), "utf8");
  try {
    const trial = catalogFor({
      ...configStub(),
      trialMode: true,
      mainModel: "deepseek-v4-flash-free",
      visionModel: "mimo-v2.5-free",
      nativeCatalogFile: file,
    });
    assert.deepEqual(trial.models.map((entry) => entry.slug).sort(), ["deepseek-v4-flash-free", "mimo-v2.5-free"]);
    assert.equal(trial.models[0].slug, "deepseek-v4-flash-free", "the fixed trial main model leads");
    assert.ok(!trial.models.some((entry) => entry.slug === "gpt-5.6-luna"), "trial never merges native GPT models");

    // The same native capture outside trial publishes the native model.
    const normal = catalogFor({ ...configStub(), nativeCatalogFile: file });
    assert.ok(normal.models.some((entry) => entry.slug === "gpt-5.6-luna"), "native model appears outside trial");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor outside trial still publishes the free models alongside the paid ones", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash-free"));
  assert.ok(slugs.includes("mimo-v2.5-free"));
});

test("mergeNativeCatalog caps native reasoning levels to the published enum", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      priority: 1,
      default_reasoning_level: "max",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
        { effort: "ultra", description: "Ultra" },
      ],
    }],
  }), "utf8");
  try {
    const merged = mergeNativeCatalog(catalogFor(configStub()), { ...configStub(), nativeCatalogFile: file });
    const entry = merged.models.find((model) => model.slug === "gpt-5.6-sol");
    assert.ok(entry, "native entry is published");
    assert.deepEqual(
      entry.supported_reasoning_levels.map((level) => level.effort),
      ["low", "high"],
      "max/ultra are filtered to the enum the installed CLI accepts",
    );
    assert.equal(entry.default_reasoning_level, "low", "default clamps to an allowed effort");
    assert.equal(entry.supports_reasoning_summaries, true, "required field is defaulted for older CLI parsers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor groups models by provider label with sequential priorities", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [
      { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 7 },
      { slug: "gpt-5.2", display_name: "GPT-5.2", visibility: "list", priority: 29 },
    ],
  }), "utf8");
  try {
    const catalog = catalogFor({
      ...configStub(),
      tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
      nativeCatalogFile: file,
    });
    const groups = [];
    for (const entry of catalog.models) {
      const label = entry.display_name.split(" - ")[0];
      if (groups.at(-1)?.label !== label) groups.push({ label, slugs: [] });
      groups.at(-1).slugs.push(entry.slug);
    }
    assert.deepEqual(groups.map((group) => group.label), ["DeepSeek Official", "OpenAI", "OpenCode Go"], "groups are ordered by provider label");
    assert.deepEqual(groups[1].slugs, ["gpt-5.5", "gpt-5.2"], "native entries keep their captured order within the group");
    assert.ok(groups[2].slugs[0].includes("deepseek-v4-flash") || groups[2].slugs[0] === "deepseek-v4-flash", "the curated main model opens the OpenCode Go group");
    catalog.models.forEach((entry, index) => {
      assert.equal(entry.priority, index + 1, `${entry.slug} carries a sequential picker priority`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a published native slug routes to the native leg despite being in the catalog", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" }],
  }), "utf8");
  try {
    const catalog = catalogFor({ ...configStub(), nativeCatalogFile: file });
    const known = new Set(catalog.models.map((entry) => entry.slug));
    const nativeSlugs = new Set(["gpt-5.6-luna"]);
    assert.ok(known.has("gpt-5.6-luna"), "bare native slug is now published so the picker lists it");
    assert.equal(isNativeModel("gpt-5.6-luna", known, nativeSlugs), true, "native slug stays on the native leg");
    assert.equal(isNativeModel("gpt-5.6-luna@opencode-go", known, nativeSlugs), false, "our qualified Luna stays routed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor never publishes chat-dialect models even if marked available", () => {
  const profile = {
    ...OPENCODE_GO_PROFILE,
    availableModels: [
      ...OPENCODE_GO_PROFILE.availableModels.filter((m) => m.id !== "qwen3.8-max"),
      { id: "qwen3.8-max", label: "Qwen 3.8 Max", endpoint: "chat", supportsVision: true, visionScore: 9, visionMaxScore: 9, visionTier: "strong", quota5h: 160, speedTier: "medium", status: "available" },
    ],
  };
  const catalog = catalogFor({ ...configStub(), profile });
  assert.ok(!catalog.models.some((entry) => entry.slug === "qwen3.8-max"), "chat vision model must not be published");
});

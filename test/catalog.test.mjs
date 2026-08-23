import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { allowedEffortsFor, baseInstructionsFor, catalogFor, enabledProvidersFor, mergeNativeCatalog } from "../src/catalog.mjs";
import { DEEPSEEK_OFFICIAL_PROFILE, modelEntryFor, OPENCODE_GO_PROFILE } from "../src/profiles.mjs";
import { isNativeModel } from "../src/gateway.mjs";
import { RouteAffinity, routeResponsesRequest } from "../src/router.mjs";
import { emptyRollup, rollupTotals } from "../src/usage-rollup.mjs";

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

function staleNativeEntry() {
  // Start with a complete generated schema, then remove exactly the field that
  // older native-catalog files lack. This isolates the migration behavior from
  // unrelated omissions; it is not a captured Codex catalog.
  const entry = structuredClone(catalogFor(configStub()).models[0]);
  entry.slug = "gpt-5.6-sol";
  entry.display_name = "GPT-5.6 Sol";
  delete entry.supports_parallel_tool_calls;
  return entry;
}

test("DeepSeek Flash and Pro admit images through a configured visual fallback", () => {
  const config = {
    ...configStub(),
    nativeMerge: false,
    tokens: { "opencode-go": "go-token", "deepseek-official": "deepseek-token" },
  };
  const catalog = catalogFor(config);
  const mediated = [
    "deepseek-v4-flash@opencode-go",
    "deepseek-v4-pro@opencode-go",
    "deepseek-v4-flash@deepseek-official",
    "deepseek-v4-pro@deepseek-official",
  ];
  for (const slug of mediated) {
    const entry = catalog.models.find((model) => model.slug === slug);
    assert.deepEqual(entry?.input_modalities, ["text", "image"], `${slug} admits an attachment through ModelDock`);
    assert.equal(modelEntryFor(config, slug)?.supportsVision, false, `${slug} itself remains text-only`);
    assert.equal(modelEntryFor(config, slug)?.acceptsImagesViaGateway, true, `${slug} delegates vision to ModelDock`);
    assert.ok(entry?.base_instructions.includes("TEXT-ONLY"), `${slug} retains vision_inspect guidance`);
  }
  const route = routeResponsesRequest({
    model: "deepseek-v4-flash@opencode-go",
    input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  }, {
    mainModel: config.mainModel,
    visionModel: config.visionModel,
    knownModels: new Set(catalog.models.map((entry) => entry.slug)),
    affinity: new RouteAffinity(),
    modelSupportsVision: (model) => Boolean(modelEntryFor(config, model)?.supportsVision),
  });
  assert.deepEqual(route, { model: config.visionModel, reason: "current_turn_image", directVision: true });
});

test("DeepSeek text routes do not admit images when Vision is None", () => {
  const catalog = catalogFor({
    ...configStub(),
    visionModel: "",
    nativeMerge: false,
    tokens: { "opencode-go": "go-token", "deepseek-official": "deepseek-token" },
  });
  for (const slug of [
    "deepseek-v4-flash@opencode-go",
    "deepseek-v4-pro@opencode-go",
    "deepseek-v4-flash@deepseek-official",
    "deepseek-v4-pro@deepseek-official",
  ]) {
    assert.deepEqual(catalog.models.find((entry) => entry.slug === slug)?.input_modalities, ["text"], `${slug} refuses images without a fallback`);
  }
});

test("catalogFor writes per-model base instructions for vision capability", () => {
  const catalog = catalogFor(configStub());
  const text = catalog.models.find((entry) => entry.slug === "deepseek-v4-flash@opencode-go");
  const vision = catalog.models.find((entry) => entry.slug === "gpt-5.6-luna@opencode-go");
  const flashVision = catalog.models.find((entry) => entry.slug === "deepseek-v4-flash-vision-exp@opencode-go");
  assert.ok(text && vision && flashVision, "both DeepSeek Flash variants and a vision-capable entry are published");
  assert.deepEqual(text.input_modalities, ["text", "image"], "Flash accepts attachments through the visual fallback");
  assert.ok(text.base_instructions.includes("TEXT-ONLY"), "text-only models keep the vision_inspect rule");
  assert.ok(!vision.base_instructions.includes("TEXT-ONLY"), "vision-capable models are not told they are text-only");
  assert.deepEqual(flashVision.input_modalities, ["text", "image"], "OpenCode Go Flash Vision Exp declares image input");
  assert.ok(!flashVision.base_instructions.includes("TEXT-ONLY"), "OpenCode Go Flash Vision Exp receives direct-vision instructions");
});

test("a native catalog entry missing an older field is upgraded to the current schema", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-catalog-"));
  const nativeCatalogFile = path.join(dir, "native-catalog.json");
  writeFileSync(nativeCatalogFile, JSON.stringify({
    captured_with: "0.149.0",
    models: [staleNativeEntry()],
  }), "utf8");
  try {
    const catalog = catalogFor({ ...configStub(), nativeCatalogFile });
    const native = catalog.models.find((entry) => entry.slug === "gpt-5.6-sol");
    assert.equal(native?.supports_parallel_tool_calls, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the generated catalog is accepted by the installed Codex parser", (t) => {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (probe.error?.code === "ENOENT") {
    t.skip("Codex is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-codex-catalog-"));
  const catalogFile = path.join(home, "model-catalog.json");
  const nativeCatalogFile = path.join(home, "native-catalog.json");
  writeFileSync(nativeCatalogFile, JSON.stringify({
    captured_with: "0.149.0",
    models: [staleNativeEntry()],
  }), "utf8");
  writeFileSync(catalogFile, JSON.stringify(catalogFor({ ...configStub(), nativeCatalogFile })), "utf8");
  writeFileSync(
    path.join(home, "config.toml"),
    `model = "gpt-5.6-sol"\nmodel_catalog_json = ${JSON.stringify(catalogFile.replace(/\\/g, "/"))}\n`,
    "utf8",
  );
  try {
    const parsed = spawnSync("codex", ["debug", "models"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, CODEX_HOME: home },
    });
    assert.equal(parsed.status, 0, parsed.stderr || parsed.stdout);
    const models = JSON.parse(parsed.stdout).models || [];
    assert.ok(models.some((model) => model.slug === "deepseek-v4-flash@opencode-go"));
    assert.ok(models.some((model) => model.slug === "gpt-5.6-sol"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("catalogFor keeps the main model first with the profile comp hash", () => {
  const catalog = catalogFor(configStub());
  assert.equal(catalog.models[0].slug, "deepseek-v4-flash@opencode-go");
  assert.equal(catalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(catalog.models[0].context_window, 1_000_000, "deepseek-v4-flash declares its self-reported 1M window");
  assert.equal(catalog.models[0].auto_compact_token_limit, 800_000);
});

test("catalogFor covers every available model", () => {
  const catalog = catalogFor(configStub());
  const available = OPENCODE_GO_PROFILE.availableModels.filter((model) => model.status !== "unavailable").length;
  assert.ok(catalog.models.length >= available, `catalog lists at least the ${available} available models`);
  for (const entry of catalog.models) {
    const declared = OPENCODE_GO_PROFILE.availableModels.find((model) => model.id === entry.slug.replace(/@.*$/, ""));
    const expected = declared?.supportsVision || declared?.acceptsImagesViaGateway ? ["text", "image"] : ["text"];
    assert.deepEqual(entry.input_modalities, expected, `${entry.slug} declares its direct or mediated image capability`);
  }
});

test("baseInstructionsFor includes the vision and restart guidance", () => {
  const instructions = baseInstructionsFor(configStub());
  assert.match(instructions, /TEXT-ONLY model and CANNOT see images/);
  assert.match(instructions, /call vision_inspect/);
  if (process.platform === "win32") {
    assert.match(instructions, /restart\.ps1/);
    assert.match(instructions, /powershell -ExecutionPolicy Bypass/);
  } else {
    assert.match(instructions, /restart\.sh/);
    assert.match(instructions, /sh "/);
  }
});

test("baseInstructionsFor matches Codex v2 spawn_agent args that text models can see", () => {
  const text = baseInstructionsFor(configStub());
  const vision = baseInstructionsFor(configStub(), { supportsVision: true });
  for (const instructions of [text, vision]) {
    assert.match(instructions, /spawn_agent's `message`/);
    assert.match(instructions, /followup_task/);
    assert.match(instructions, /omit fork_turns or use "all"/i);
    assert.doesNotMatch(instructions, /spawn_agent's prompt/);
    assert.match(instructions, /fork_turns="none" delivers NEW_TASK/);
  }
});

test("baseInstructionsFor takes the vision capability explicitly, not from mainModel", () => {
  const text = baseInstructionsFor(configStub());
  const vision = baseInstructionsFor(configStub(), { supportsVision: true });
  assert.match(text, /TEXT-ONLY model and CANNOT see images/);
  assert.doesNotMatch(vision, /TEXT-ONLY model and CANNOT see images/);
});

test("baseInstructionsFor matches design review to visual capability", () => {
  // image_gen posts to the native ChatGPT backend, so the rule is only emitted
  // for a signed-in install (see the logged-out case below).
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-catalog-auth-"));
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "tok" } }), "utf8");
  try {
    const text = baseInstructionsFor({ ...configStub(), codexHome: home });
    const vision = baseInstructionsFor({ ...configStub(), codexHome: home }, { supportsVision: true });
    for (const instructions of [text, vision]) {
      assert.match(instructions, /Design-first workflow \(MANDATORY for frontend\/UI work\)/);
      assert.match(instructions, /run image_gen first/);
      assert.match(instructions, /implement by translating structure, palette, and hierarchy/);
      assert.match(instructions, /`image <prompt> \[size\]`/, "the shell fallback lists image generation too");
    }
    assert.match(text, /read the output with vision_inspect/);
    assert.match(text, /read it with vision_inspect instead/);
    assert.match(vision, /inspect the output directly/);
    assert.match(vision, /inspect it directly instead/);
    assert.doesNotMatch(vision, /read the output with vision_inspect/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("baseInstructionsFor drops the design-first workflow without a Codex sign-in", () => {
  // A MANDATORY rule that opens every frontend task with an impossible tool call
  // is worse than no rule, and it landed hardest on DeepSeek-only and local-model
  // users - the ones least likely to be signed in to ChatGPT.
  const instructions = baseInstructionsFor({
    ...configStub(),
    codexHome: path.join(os.tmpdir(), "modeldock-catalog-no-auth"),
  });
  assert.doesNotMatch(instructions, /Design-first workflow/);
  assert.doesNotMatch(instructions, /image <prompt>/);
  assert.match(instructions, /vision_inspect/, "vision guidance does not depend on a sign-in");
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
  assert.ok(slugs.includes("deepseek-v4-flash@opencode-go"));
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
  assert.ok(slugs.includes("deepseek-v4-flash@opencode-go"), "curated Go models stay published");
    assert.ok(!slugs.includes("gpt-5.6-luna"), "native GPT models are hidden without a subscription (nativeMerge=false)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor publishes the free models alongside the paid ones", () => {
  const catalog = catalogFor(configStub());
  const slugs = catalog.models.map((entry) => entry.slug);
  assert.ok(slugs.includes("deepseek-v4-flash-free@opencode-go"));
  assert.ok(slugs.includes("mimo-v2.5-free@opencode-go"));
});

test("mergeNativeCatalog caps native reasoning levels for an old catalog version", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.130.0",
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
      "pre-0.138 captures withhold max and ultra so the catalog stays parseable",
    );
    assert.equal(entry.default_reasoning_level, "high", "default clamps to the top surviving rung");
    assert.equal(entry.supports_reasoning_summaries, true, "required field is defaulted for older CLI parsers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeNativeCatalog keeps max but withholds ultra on catalog versions 0.138-0.143", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.140.0",
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
    const entry = mergeNativeCatalog(catalogFor(configStub()), { ...configStub(), nativeCatalogFile: file })
      .models.find((model) => model.slug === "gpt-5.6-sol");
    assert.ok(entry, "native entry is published");
    assert.deepEqual(
      entry.supported_reasoning_levels.map((level) => level.effort),
      ["low", "high", "max"],
      "0.138+ keeps max while ultra waits for 0.144",
    );
    assert.equal(entry.default_reasoning_level, "max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeNativeCatalog publishes native max and ultra on a current catalog version", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-test-"));
  const file = path.join(dir, "native-catalog.json");
  writeFileSync(file, JSON.stringify({
    captured_with: "0.145.0",
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
    const entry = mergeNativeCatalog(catalogFor(configStub()), { ...configStub(), nativeCatalogFile: file })
      .models.find((model) => model.slug === "gpt-5.6-sol");
    assert.ok(entry, "native entry is published");
    assert.deepEqual(
      entry.supported_reasoning_levels.map((level) => level.effort),
      ["low", "high", "max", "ultra"],
      "current captures publish the full native ladder",
    );
    assert.equal(entry.default_reasoning_level, "max");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowedEffortsFor gates max at 0.138 and ultra at 0.144", () => {
  assert.ok(!allowedEffortsFor("0.137.9").has("max"));
  assert.ok(!allowedEffortsFor("0.137.9").has("ultra"));
  assert.ok(!allowedEffortsFor("0.138.0-alpha.1").has("max"), "a prerelease sorts below its release");
  assert.ok(allowedEffortsFor("0.138.0").has("max"));
  assert.ok(!allowedEffortsFor("0.138.0").has("ultra"));
  assert.ok(!allowedEffortsFor("0.143.9").has("ultra"));
  assert.ok(allowedEffortsFor("0.144.0").has("ultra"));
  assert.ok(allowedEffortsFor("0.145.0").has("ultra"));
});

test("catalogFor orders the picker by use, with sequential priorities", () => {
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
    // Renumbering is what the picker needs: native entries arrive carrying
    // their own priorities (7, 29) and would otherwise scatter through the list.
    catalog.models.forEach((entry, index) => {
      assert.equal(entry.priority, index + 1, `${entry.slug} carries a sequential picker priority`);
    });
    // With no usage recorded, nothing has a claim on the top, so every model
    // keeps the position it arrived in - a catalog that reshuffled itself on
    // each write would move the picker under the user for no reason.
    const unused = catalog.models.map((entry) => entry.slug);
    const again = catalogFor({
      ...configStub(),
      tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
      nativeCatalogFile: file,
    }).models.map((entry) => entry.slug);
    assert.deepEqual(again, unused, "the order is stable when nothing has been used");

    // Traffic promotes within the half we own. The native section above the
    // divider is Codex's arrangement, and our counts do not reorder it.
    const ordered = catalogFor({
      ...configStub(),
      tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
      nativeCatalogFile: file,
      usageByModel: { "deepseek-v4-pro@opencode-go": { requests: 4000 } },
    }).models.map((entry) => entry.slug);
    const natives = ordered.filter((slug) => !slug.includes("@"));
    const routed = ordered.filter((slug) => slug.includes("@"));
    assert.deepEqual(ordered.slice(0, natives.length), natives, "every native entry sits above the divider");
    assert.equal(routed[0], "deepseek-v4-pro@opencode-go", "the most-used routed model opens the lower half");
    assert.deepEqual(
      routed.slice(1),
      unused.filter((slug) => slug.includes("@") && slug !== "deepseek-v4-pro@opencode-go"),
      "and the untouched tail keeps its previous order",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalogFor ranks by rollup heat, not 30-day popularity", () => {
  const rollup = emptyRollup();
  rollup.days["2026-08-18"] = { "deepseek-v4-flash@opencode-go": { requests: 10 } };
  rollup.days["2026-07-21"] = { "deepseek-v4-pro@opencode-go": { requests: 100 } };
  const catalog = catalogFor({
    ...configStub(),
    usageByModel: rollupTotals(rollup, "2026-08-18T12:00:00.000Z"),
  });
  const routed = catalog.models.map((entry) => entry.slug).filter((slug) => slug.includes("@"));
  assert.equal(routed[0], "deepseek-v4-flash@opencode-go", "the recent, high-heat model opens the routed half");
  assert.ok(
    routed.indexOf("deepseek-v4-flash@opencode-go") < routed.indexOf("deepseek-v4-pro@opencode-go"),
    "heat outranks a model with more 30-day popularity",
  );
});

test("catalogFor falls back to popularity when heat is absent", () => {
  const catalog = catalogFor({
    ...configStub(),
    usageByModel: {
      "deepseek-v4-flash@opencode-go": { popularity: 10 },
      "deepseek-v4-pro@opencode-go": { popularity: 100 },
    },
  });
  const routed = catalog.models.map((entry) => entry.slug).filter((slug) => slug.includes("@"));
  assert.equal(routed[0], "deepseek-v4-pro@opencode-go", "without heat the 30-day popularity decides");
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

// The convention that keeps the Models page honest: a model that only speaks
// chat/completions can never reach the picker, because the relay Codex talks to
// speaks Responses and nothing converts between them. Marking such a model
// `status: "unavailable"` is how that is expressed today, and it is what stops
// the roster from listing a row whose switch would do nothing - the roster
// filters on status alone. Nothing enforced the pairing, so this does.
test("a chat-only model is also marked unavailable, so it never reaches a picker", () => {
  for (const profile of [OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE]) {
    const chatOnly = (profile.availableModels || []).filter((model) => model.endpoint === "chat");
    const published = chatOnly.filter((model) => model.status !== "unavailable");
    assert.deepEqual(
      published.map((model) => model.id),
      [],
      `${profile.id}: a chat-only model must carry status "unavailable" as well`,
    );
  }
});

test("the native section keeps Codex's own order, not ours", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-native-section-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "native-catalog.json");
  // Captured order is sol, then terra. Terra carries far more of our traffic;
  // the picker must still show them the way Codex arranged them, because that
  // section is drawn above the divider as a set the App owns.
  writeFileSync(file, JSON.stringify({
    captured_with: "0.1.0",
    models: [
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1 },
      { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 2 },
    ],
  }), "utf8");

  const order = catalogFor({
    ...configStub(),
    tokens: { "opencode-go": "go-token" },
    nativeCatalogFile: file,
    // Keyed the way the ordering reads it, so that a rule sorting natives by
    // traffic would visibly move terra ahead of sol and this would catch it.
    usageByModel: {
      "gpt-5.6-terra": { requests: 9000 },
      "deepseek-v4-pro@opencode-go": { requests: 5000 },
    },
  }).models.map((entry) => entry.slug);

  assert.deepEqual(order.slice(0, 2), ["gpt-5.6-sol", "gpt-5.6-terra"], "captured order survives our traffic counts");
  assert.equal(order[2], "deepseek-v4-pro@opencode-go", "the busiest routed model opens the lower half");
  assert.ok(!order.slice(2).some((slug) => !slug.includes("@")), "no native entry falls below the divider");
});

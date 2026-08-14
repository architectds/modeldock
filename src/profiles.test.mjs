import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_GO_PROFILE,
  DEEPSEEK_OFFICIAL_PROFILE,
  publishedSlugFor,
  profileById,
  profileOptions,
  applyCustomProfile,
  applyOllamaProfile,
  OLLAMA_PROFILE,
  CONTEXT_WINDOW,
  DEEPSEEK_CONTEXT_WINDOW,
  OPENCODE_GO_DEEPSEEK_CONTEXT_WINDOW,
  SELF_DECLARED_CONTEXT_WINDOWS,
  AUTO_COMPACT_PERCENT,
  AUTO_COMPACT_TOKEN_LIMIT,
} from "./profiles.mjs";

test("publishedSlugFor owner-qualifies every owned model", () => {
  const luna = OPENCODE_GO_PROFILE.availableModels.find((model) => model.id === "gpt-5.6-luna");
  assert.equal(luna.ownerQualified, true, "our Luna must stay out of the bare native gpt-5.6-luna slot");
  assert.equal(publishedSlugFor("opencode-go", luna), "gpt-5.6-luna@opencode-go");
  assert.equal(publishedSlugFor("opencode-go", "gpt-5.6-luna"), "gpt-5.6-luna@opencode-go", "string ids resolve through the profile entry too");
  assert.equal(publishedSlugFor("opencode-go", "deepseek-v4-flash"), "deepseek-v4-flash@opencode-go", "the default provider qualifies its own models too");
  assert.equal(
    publishedSlugFor("deepseek-official", "deepseek-v4-flash"),
    "deepseek-v4-flash@deepseek-official",
    "a duplicate in another provider is owner-qualified",
  );
  assert.equal(publishedSlugFor("opencode-go", "gpt-5.6-sol"), "gpt-5.6-sol", "an id no profile owns passes through untouched (native GPT)");
});

test("exposes every registered profile through the registry", () => {
  assert.equal(profileById("opencode-go"), OPENCODE_GO_PROFILE);
  assert.equal(profileById("deepseek-official"), DEEPSEEK_OFFICIAL_PROFILE);
  assert.equal(profileById("unknown-profile"), OPENCODE_GO_PROFILE, "unknown ids fall back to opencode-go");
});

test("lists all profiles as selectable options", () => {
  const options = profileOptions();
  assert.deepEqual(options.map((option) => option.id), ["opencode-go", "deepseek-official", "custom", "ollama"]);
  assert.ok(options.every((option) => typeof option.label === "string" && option.label.length > 0));
});

test("ollama profile is empty until connected and fills from the snapshot", () => {
  const empty = applyOllamaProfile({}, null);
  assert.equal(empty.availableModels.length, 0);
  const filled = applyOllamaProfile({}, {
    baseUrl: "http://127.0.0.1:11434",
    models: [
      { id: "qwen3.8-27b", upstreamId: "qwen3.8:27b", label: "qwen3.8:27b", supportsVision: true, contextWindow: 262144 },
    ],
  });
  assert.equal(filled.id, "ollama");
  assert.equal(filled.baseUrl, "http://127.0.0.1:11434");
  assert.deepEqual(filled.availableModels, [
    {
      id: "qwen3.8-27b",
      upstreamId: "qwen3.8:27b",
      label: "qwen3.8:27b",
      endpoint: "responses",
      supportsVision: true,
      contextWindow: 262144,
      ownerQualified: true,
      status: "available",
    },
  ]);
  assert.equal(publishedSlugFor("ollama", "qwen3.8-27b"), "qwen3.8-27b@ollama", "a connected Ollama model is owner-qualified");
  assert.equal(profileById("ollama"), OLLAMA_PROFILE, "the profile is registered for routing");
});

test("custom profile is empty until configured and fills from config", () => {
  const empty = applyCustomProfile({ customModel: "", customBaseUrl: "" });
  assert.equal(empty.availableModels.length, 0);
  const filled = applyCustomProfile({ customModel: "vendor/model-x", customBaseUrl: "https://vendor.example/v1", customVision: true });
  assert.equal(filled.id, "custom");
  assert.equal(filled.label, "Custom");
  assert.deepEqual(filled.availableModels, [
    { id: "vendor/model-x", label: "vendor/model-x", endpoint: "responses", supportsVision: true, ownerQualified: true, status: "available" },
  ]);
});

test("opencode-go profile keeps the Go-specific hardening flags", () => {
  assert.equal(OPENCODE_GO_PROFILE.blockedToolTypes.has("tool_search"), true);
  assert.equal(OPENCODE_GO_PROFILE.blockedToolTypes.has("web_search"), true);
  assert.equal(OPENCODE_GO_PROFILE.compactCompletedToolHistory, undefined, "legacy transform flags are gone");
  assert.equal(OPENCODE_GO_PROFILE.toolSearchAsFunction, undefined, "legacy transform flags are gone");
  assert.equal(OPENCODE_GO_PROFILE.harnessTools, undefined, "harness tool fields are gone");
});

test("deepseek-official profile routes the main model on DeepSeek with harness on the Go camp", () => {
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.blockedToolTypes.size, 0, "official API accepts every Codex local tool as type function");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.compactCompletedToolHistory, undefined, "legacy transform flags are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.stripSyntheticReasoningPlaceholder, undefined, "legacy transform flags are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.harnessTools, undefined, "harness tool fields are gone");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.baseUrl, "https://api.deepseek.com");
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.tokenEnvName, "DEEPSEEK_API_KEY");
  assert.deepEqual(DEEPSEEK_OFFICIAL_PROFILE.availableModels.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(DEEPSEEK_OFFICIAL_PROFILE.availableModels.every((model) => model.endpoint === "responses"), true);
});

test("caps only OpenCode Go DeepSeek models at 600k", () => {
  for (const id of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    const goModel = OPENCODE_GO_PROFILE.availableModels.find((model) => model.id === id);
    const officialModel = DEEPSEEK_OFFICIAL_PROFILE.availableModels.find((model) => model.id === id);
    assert.equal(goModel.contextWindow, OPENCODE_GO_DEEPSEEK_CONTEXT_WINDOW, `${id}@opencode-go is capped at 600k`);
    assert.equal(officialModel.contextWindow, DEEPSEEK_CONTEXT_WINDOW, `${id}@deepseek-official stays at 1M`);
  }
});

test("model catalog is generated per profile with distinct comp hashes", () => {
  const instructions = "base";
  const goCatalog = OPENCODE_GO_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", baseInstructions: instructions });
  const officialCatalog = DEEPSEEK_OFFICIAL_PROFILE.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: instructions });
  assert.ok(goCatalog.models.length >= 1, "catalog includes the main model plus every available model");
  assert.equal(goCatalog.models[0].slug, "deepseek-v4-flash@opencode-go");
  assert.equal(goCatalog.models[0].comp_hash, "modeldock-opencode-go-v1");
  assert.equal(goCatalog.models[0].supports_search_tool, false);
  assert.equal(goCatalog.models[0].default_reasoning_level, "high");
  assert.deepEqual(goCatalog.models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "xhigh"]);
  assert.equal(officialCatalog.models[0].comp_hash, "modeldock-deepseek-official-v1");
  assert.equal(officialCatalog.models[0].supports_search_tool, false);
  assert.equal(officialCatalog.models[0].default_reasoning_level, "medium", "DeepSeek official defaults to medium thinking");
  assert.deepEqual(
    officialCatalog.models[0].supported_reasoning_levels.map((level) => level.effort),
    ["none", "minimal", "low", "medium", "high", "xhigh"],
    "DeepSeek official accepts its full reasoning effort ladder",
  );
  assert.notEqual(goCatalog.models[0].comp_hash, officialCatalog.models[0].comp_hash);
});

test("every profile compacts at 80% of the model context window", () => {
  const expected = Math.floor(CONTEXT_WINDOW * AUTO_COMPACT_PERCENT);
  assert.equal(AUTO_COMPACT_TOKEN_LIMIT, expected);
  for (const profile of [OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE]) {
    const catalog = profile.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: "base" });
    const model = catalog.models[0];
    const declared = SELF_DECLARED_CONTEXT_WINDOWS["deepseek-v4-flash"];
    const expectedWindow = profile.id === "opencode-go" ? 600_000 : declared;
    assert.equal(model.context_window, expectedWindow, `${profile.id} declares deepseek-v4-flash at its published window`);
    assert.equal(model.max_context_window, expectedWindow);
    assert.equal(model.auto_compact_token_limit, Math.floor(expectedWindow * AUTO_COMPACT_PERCENT), `${profile.id} must auto-compact at 80% of its published window`);
  }
});

test("every published model declares its own self-reported context window", () => {
  for (const profile of [OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE]) {
    const catalog = profile.modelCatalog({ mainModel: "deepseek-v4-flash", baseInstructions: "base" });
    for (const model of profile.availableModels.filter((entry) => entry.status !== "unavailable")) {
      const declared = SELF_DECLARED_CONTEXT_WINDOWS[model.id];
      const slug = publishedSlugFor(profile.id, model);
      const entry = catalog.models.find((candidate) => candidate.slug === slug);
      assert.ok(declared, `${model.id} has a self-reported context window`);
      assert.ok(entry, `${slug} is present in the published catalog`);
      // An explicit contextWindow on the profile entry wins over the shared
      // self-declared table: OpenCode Go's paid DeepSeek pair declares a
      // conservative 600k even though the upstream advertises 1M.
      const expected = model.contextWindow ?? declared;
      assert.equal(entry.context_window, expected, `${model.id} declares its published window`);
      assert.equal(entry.max_context_window, expected, `${model.id} max window matches its published window`);
      assert.equal(entry.auto_compact_token_limit, Math.floor(expected * AUTO_COMPACT_PERCENT), `${model.id} compacts at 80% of its published window`);
    }
  }
  // Spot-check the curated entries that used to be pinned to the 250k default.
  const byId = (id) => OPENCODE_GO_PROFILE.availableModels.find((model) => model.id === id);
  assert.equal(byId("glm-5.2").contextWindow, 1_000_000, "GLM-5.2 self-declares 1M");
  assert.equal(byId("glm-5").contextWindow, 202_752, "GLM-5 self-declares 202752");
  assert.equal(byId("kimi-k2.7-code").contextWindow, 262_144, "Kimi K2.7 Code self-declares 262144");
  assert.equal(byId("kimi-k3").contextWindow, 1_048_576, "Kimi K3 self-declares 1048576");
  assert.equal(byId("grok-4.5").contextWindow, 500_000, "Grok 4.5 self-declares 500k");
  assert.equal(byId("minimax-m2.7").contextWindow, 204_800, "MiniMax M2.7 self-declares 204800");
  assert.equal(byId("gpt-5.6-luna").contextWindow, 1_050_000, "GPT-5.6 Luna self-declares 1.05M");
  assert.equal(byId("deepseek-v4-flash-free").contextWindow, 200_000, "zen free DeepSeek self-declares 200k");
  assert.equal(byId("mimo-v2.5-free").contextWindow, 200_000, "zen free MiMo self-declares 200k");
  assert.equal(byId("nemotron-3-ultra-free").contextWindow, 1_000_000, "zen free Nemotron self-declares 1M");
});


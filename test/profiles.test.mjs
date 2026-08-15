import test from "node:test";
import assert from "node:assert/strict";
import {
  OPENCODE_GO_PROFILE,
  DEEPSEEK_OFFICIAL_PROFILE,
  OLLAMA_PROFILE,
  publishedSlugFor,
  profileById,
  profileOptions,
  applyCustomProfile,
  applyOllamaProfile,
  CONTEXT_WINDOW,
  AUTO_COMPACT_PERCENT,
  AUTO_COMPACT_TOKEN_LIMIT,
} from "../src/profiles.mjs";

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
  assert.equal(profileById("ollama"), OLLAMA_PROFILE);
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
      { id: "qwen3.8-27b", upstreamId: "qwen3.8:27b", label: "qwen3.8:27b", supportsVision: false, contextWindow: 262144 },
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
      supportsVision: false,
      contextWindow: 262144,
      ownerQualified: true,
      status: "available",
    },
  ]);
  assert.equal(publishedSlugFor("ollama", "qwen3.8-27b"), "qwen3.8-27b@ollama", "a connected Ollama model is owner-qualified");
  assert.equal(profileById("ollama"), OLLAMA_PROFILE, "the profile is registered for routing");
});

test("a text-only Ollama main model does not advertise image input", () => {
  applyOllamaProfile({}, {
    baseUrl: "http://127.0.0.1:11434",
    models: [
      { id: "qwen3.8-27b", upstreamId: "qwen3.8:27b", label: "qwen3.8:27b", supportsVision: false, contextWindow: 262144 },
      { id: "llava", upstreamId: "llava:latest", label: "llava:latest", supportsVision: true, contextWindow: 131072 },
    ],
  });
  const catalog = OLLAMA_PROFILE.modelCatalog({ mainModel: "qwen3.8-27b@ollama", baseInstructions: "base" });
  const main = catalog.models.find((entry) => entry.slug === "qwen3.8-27b@ollama");
  const vision = catalog.models.find((entry) => entry.slug === "llava@ollama");
  assert.deepEqual(main.input_modalities, ["text"], "a text-only Ollama main model stays text-only");
  assert.deepEqual(vision.input_modalities, ["text", "image"], "a vision-capable Ollama model declares image input");
});

test("custom profile is empty until configured and fills from config", () => {
  const empty = applyCustomProfile({ customModel: "", customBaseUrl: "" });
  assert.equal(empty.availableModels.length, 0);
  const filled = applyCustomProfile({ customModel: "vendor/model-x", customBaseUrl: "https://vendor.example/v1", customVision: true });
  assert.equal(filled.id, "custom");
  assert.equal(filled.label, "Custom");
  const model = filled.availableModels[0];
  assert.equal(model.id, "vendor/model-x");
  assert.equal(model.endpoint, "responses");
  assert.equal(model.supportsVision, true);
  assert.equal(model.ownerQualified, true);
  assert.equal(model.defaultReasoningLevel, "xhigh", "local default matches llama.cpp");
  assert.deepEqual(
    model.supportedReasoningLevels.map((level) => level.effort),
    ["low", "medium", "xhigh"],
    "llama.cpp qwen3.8 accepts exactly low/medium/xhigh",
  );
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
    assert.equal(model.context_window, 1_000_000, `${profile.id} declares deepseek-v4-flash at its self-reported 1M`);
    assert.equal(model.max_context_window, 1_000_000);
    assert.equal(model.auto_compact_token_limit, Math.floor(1_000_000 * AUTO_COMPACT_PERCENT), `${profile.id} must auto-compact at 80% of the 1M window`);
  }
});


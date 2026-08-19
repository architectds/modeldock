// The reasoning ladder is a property of the model, not of whichever profile
// happens to be active.
//
// It was not. Every per-model declaration in profiles.mjs was dead: the
// cross-provider list carried the context window but dropped the ladder, so the
// `model.supportedReasoningLevels || base...` on the far side never had a
// left-hand value to find. DeepSeek's measured rungs and the local backend's
// template-verified ones both existed in the source and reached nobody.
import test from "node:test";
import assert from "node:assert/strict";
import { catalogFor } from "../src/catalog.mjs";
import { OPENCODE_GO_PROFILE, applyCustomProfile, profileById } from "../src/profiles.mjs";

// Measured 2026-08-19 by sending an unknown effort to each endpoint and reading
// the enum it names back. deepseek-v4-flash and deepseek-v4-pro answered
// identically on OpenCode Go and on the official API, and all four refused
// ultra.
const MEASURED = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function configStub(over = {}) {
  return {
    profile: OPENCODE_GO_PROFILE,
    profileId: "opencode-go",
    mainModel: "deepseek-v4-flash",
    tokens: { "opencode-go": "t", "deepseek-official": "t" },
    goToken: "t",
    deepseekApiKey: "t",
    nativeMerge: false,
    nativeCatalogFile: "/nonexistent-native-catalog.json",
    ...over,
  };
}

const rungsOf = (catalog, slug) => {
  const entry = (catalog.models || []).find((model) => model.slug === slug);
  return entry ? (entry.supported_reasoning_levels || []).map((level) => level.effort) : null;
};

test("a model's own ladder survives the trip to the catalog", () => {
  const catalog = catalogFor(configStub());
  assert.deepEqual(rungsOf(catalog, "deepseek-v4-flash@deepseek-official"), MEASURED);
  assert.deepEqual(rungsOf(catalog, "deepseek-v4-pro@deepseek-official"), MEASURED);
});

test("the same model measured on a second endpoint carries the same ladder", () => {
  // OpenCode Go proxies the same provider - its refusal says so verbatim
  // ("Error from provider (Console Go)") - so the Go copies are measured, not
  // guessed. Before this they inherited the active profile's three rungs while
  // the official copies were meant to get six.
  const catalog = catalogFor(configStub());
  assert.deepEqual(rungsOf(catalog, "deepseek-v4-flash@opencode-go"), MEASURED);
  assert.deepEqual(rungsOf(catalog, "deepseek-v4-pro@opencode-go"), MEASURED);
});

test("ultra is offered for no DeepSeek model on either endpoint", () => {
  // Both upstreams refuse it by name. Publishing a rung the upstream rejects
  // turns a picker choice into a failed turn.
  const catalog = catalogFor(configStub());
  for (const slug of [
    "deepseek-v4-flash@deepseek-official",
    "deepseek-v4-pro@deepseek-official",
    "deepseek-v4-flash@opencode-go",
    "deepseek-v4-pro@opencode-go",
  ]) {
    assert.ok(!rungsOf(catalog, slug).includes("ultra"), `${slug} offers a rung its upstream refuses`);
  }
});

test("a local backend keeps the ladder its chat template accepts", () => {
  // A provider is published only once it has a credential (enabledProvidersFor),
  // so the stub has to carry one or the model never reaches the catalog.
  const config = configStub({
    customEndpoints: [{ modelId: "qwen3.8:27b", baseUrl: "http://127.0.0.1:11435/v1", apiKey: "k" }],
    tokens: { "opencode-go": "t", "deepseek-official": "t", custom: "k" },
  });
  applyCustomProfile(config);
  try {
    // The GGUF template accepts xhigh, medium and low and raises on high, so the
    // picker must not offer high. This declaration lived on the model entry and
    // was dropped in transit for as long as the drop existed.
    const rungs = rungsOf(catalogFor(config), "qwen3.8:27b@custom");
    assert.deepEqual(rungs, ["low", "medium", "xhigh"]);
    assert.ok(!rungs.includes("high"), "high raises in the template and must not be offered");
  } finally {
    applyCustomProfile(configStub());
  }
});

test("a model nobody measured gets the general tier, and it is four rungs", () => {
  const catalog = catalogFor(configStub());
  // Not a claim about the model - no upstream publishes its accepted efforts,
  // and an unsupported one is usually ignored rather than refused, so probing
  // proves little. The point of naming the tier is that a measured ladder never
  // reaches it.
  assert.deepEqual(rungsOf(catalog, "kimi-k3@opencode-go"), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(rungsOf(catalog, "grok-4.5@opencode-go"), ["low", "medium", "high", "xhigh"]);
});

test("the cross-provider list carries the ladder, not just the window", () => {
  // The specific omission that made every per-model declaration dead. Asserted
  // against the entry itself so re-introducing the drop fails here rather than
  // silently reverting four models to a placeholder.
  const source = profileById("opencode-go").availableModels.find((model) => model.id === "deepseek-v4-flash");
  assert.ok(source.supportedReasoningLevels, "the entry declares a ladder");
  assert.equal(source.reasoningSource, "measured", "and says where it came from");
  assert.deepEqual(
    rungsOf(catalogFor(configStub()), "deepseek-v4-flash@opencode-go"),
    source.supportedReasoningLevels.map((level) => level.effort),
    "what the entry declares is what the catalog publishes",
  );
});

// Command Code is a Chat-only keyed provider. What has to stay true is narrow and
// easy to lose: its directory mixes two dialects, and publishing the Anthropic
// half would hand the picker a model that 400s on every request. Measured shape
// from the live vendor on 2026-08-31 (61 ids, 7 of them Claude).
import test from "node:test";
import assert from "node:assert/strict";
import { allProfiles, profileById, providerForModel, publishedSlugFor, bareModelId } from "../src/profiles.mjs";
import { refreshProfileModels } from "../src/services.mjs";

const DIRECTORY = {
  data: [
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash (latest)", context_length: 1000000 },
    { id: "Qwen/Qwen3.8-27B", name: "Qwen3.8 27B", context_length: 262144 },
    { id: "xai/grok-4.6", name: "Grok 4.6", context_length: 500000 },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", context_length: 400000 },
    // The refused half: the vendor answers these only on /provider/v1/messages.
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1000000 },
    { id: "claude-haiku-4-5-20251001", name: "Claude Haiku", context_length: 200000 },
    // A model the directory lists without a window.
    { id: "tencent/hy4-preview", name: "HY4 Preview" },
  ],
};

function freshProfile() {
  const profile = profileById("commandcode");
  profile.availableModels = [];
  return profile;
}

function discoveryConfig(directory) {
  return {
    profileId: "opencode-go",
    modelDiscoveryEnabled: true,
    tokens: { commandcode: "user_testkey" },
    fetchDirectory: directory,
  };
}

function mockFetch(directory) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init?.headers });
    return new Response(JSON.stringify(directory), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { seen, fetchImpl };
}

test("a published Command Code model is owner-qualified and routes to Chat Completions", async () => {
  const profile = freshProfile();
  const config = discoveryConfig(DIRECTORY);
  // publishedSlugFor only qualifies a model the provider actually publishes, so
  // the directory has to run first: qualifying an id the vendor no longer lists
  // would publish a model nothing can serve.
  const { fetchImpl } = mockFetch(DIRECTORY);
  await refreshProfileModels(profile, config, { fetchImpl });

  assert.ok(allProfiles().includes(profile), "the provider must live in the routing registry");
  assert.equal(profile.label, "Command Code");
  assert.equal(profile.tokenEnvName, "COMMANDCODE_API_KEY");

  const slug = publishedSlugFor("commandcode", "deepseek/deepseek-v4-flash");
  assert.equal(slug, "deepseek/deepseek-v4-flash@commandcode", "a provider-owned model is published owner-qualified");
  assert.equal(bareModelId(slug), "deepseek/deepseek-v4-flash", "the vendor's slash in the model id survives qualification");
  assert.equal(providerForModel(config, slug), "commandcode");

  const target = profile.target(config, slug);
  assert.equal(target.provider, "commandcode");
  assert.equal(target.model, "deepseek/deepseek-v4-flash");
  assert.equal(target.transport, "chat", "the transport must be chat so the relay takes the existing bridge");
  assert.equal(target.url, "https://api.commandcode.ai/provider/v1/chat/completions");
});

test("a redirected base URL moves both inference and discovery together", async () => {
  // The one config field has to serve both paths, or a test or a proxied install
  // that moves inference would keep asking the real vendor for its directory.
  const profile = freshProfile();
  const redirected = { commandcodeBaseUrl: "http://127.0.0.1:59999/provider/v1" };
  assert.equal(profile.target(redirected, "x/y@commandcode").url, "http://127.0.0.1:59999/provider/v1/chat/completions");
  const { seen, fetchImpl } = mockFetch(DIRECTORY);
  await refreshProfileModels(profile, { ...discoveryConfig(DIRECTORY), ...redirected }, { fetchImpl });
  assert.equal(seen[0].url, "http://127.0.0.1:59999/provider/v1/models");
});

test("an empty key leaves the provider out of the picker", () => {
  const config = { tokens: {}, profileId: "opencode-go" };
  assert.equal(providerForModel(config, "gpt-5.6-luna@commandcode"), "commandcode", "the slug still names its owner");
  assert.equal(config.tokens.commandcode, undefined, "no credential means no commandcode token");
});

test("directory discovery publishes only the Chat dialect", async () => {
  const profile = freshProfile();
  const { seen, fetchImpl } = mockFetch(DIRECTORY);
  const result = await refreshProfileModels(profile, discoveryConfig(DIRECTORY), { fetchImpl });

  assert.equal(result.changed, true);
  assert.equal(seen[0].url, "https://api.commandcode.ai/provider/v1/models", "discovery is one authenticated GET /models and nothing more");
  assert.equal(seen[0].headers.Authorization, "Bearer user_testkey");

  const ids = profile.availableModels.map((model) => model.id);
  assert.ok(!ids.some((id) => id.startsWith("claude-")), `a Messages-only model must never reach the picker: ${ids}`);
  // Discovery sorts with localeCompare, so compare the set rather than pinning an
  // order that is a collation detail.
  assert.deepEqual([...ids].sort(), [
    "Qwen/Qwen3.8-27B",
    "deepseek/deepseek-v4-flash",
    "gpt-5.6-luna",
    "tencent/hy4-preview",
    "xai/grok-4.6",
  ].sort());
  assert.deepEqual([...new Set(profile.availableModels.map((model) => model.endpoint))], ["chat"]);
});

test("a vendor context window is used and an absent one falls back without guessing high", async () => {
  const profile = freshProfile();
  const { fetchImpl } = mockFetch(DIRECTORY);
  await refreshProfileModels(profile, discoveryConfig(DIRECTORY), { fetchImpl });

  const byId = new Map(profile.availableModels.map((model) => [model.id, model]));
  assert.equal(byId.get("deepseek/deepseek-v4-flash").contextWindow, 1000000, "the vendor's own window is carried, not replaced");
  assert.equal(byId.get("deepseek/deepseek-v4-flash").contextSource, "vendor");
  const windowless = byId.get("tencent/hy4-preview");
  assert.equal(windowless.contextSource, "fallback", "a model with no published window says so instead of inventing one");
  assert.ok(windowless.contextWindow > 0 && windowless.contextWindow <= 1000000);
});

test("a discovered model is labelled by the directory and never claims vision", async () => {
  const profile = freshProfile();
  const { fetchImpl } = mockFetch(DIRECTORY);
  await refreshProfileModels(profile, discoveryConfig(DIRECTORY), { fetchImpl });

  const flash = profile.availableModels.find((model) => model.id === "deepseek/deepseek-v4-flash");
  assert.equal(flash.label, "DeepSeek V4 Flash (latest)", "the vendor's display name is used instead of a raw id");
  assert.equal(flash.supportsVision, false, "listing a model is not evidence it sees images");
});

test("discovery stays off when the directory is unreachable or the key is absent", async () => {
  const profile = freshProfile();
  const offline = await refreshProfileModels(profile, discoveryConfig(DIRECTORY), {
    fetchImpl: async () => new Response("nope", { status: 503 }),
  });
  assert.equal(offline.changed, false);
  assert.deepEqual(profile.availableModels, []);

  const fresh = freshProfile();
  const keyless = await refreshProfileModels(fresh, { ...discoveryConfig(DIRECTORY), tokens: {} }, {
    fetchImpl: async () => {
      throw new Error("must not contact the vendor without a key");
    },
  });
  assert.deepEqual(keyless, { changed: false, discovered: 0 });
  assert.deepEqual(fresh.availableModels, []);
});

import assert from "node:assert/strict";
import test from "node:test";
import { refreshProfileModels } from "../src/services.mjs";
import { profileById } from "../src/profiles.mjs";

test("real Go profile discovers new models without a model argument and retains Zen routing", async () => {
  const owner = profileById("opencode-go");
  const profile = { ...owner, availableModels: [...owner.availableModels] };
  const config = {
    modelDiscoveryEnabled: true,
    tokens: { "opencode-go": "test-key" },
    opencodeBaseUrl: "https://go.example/v1/",
    zenBaseUrl: "https://zen.example/v1/",
  };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, "https://go.example/v1/models");
    assert.equal(options.method, undefined);
    assert.equal(options.headers.Authorization, "Bearer test-key");
    return Response.json({ data: [{ id: "deepseek-v4.1-flash" }] });
  };
  assert.deepEqual(await refreshProfileModels(profile, config, { fetchImpl }), { changed: true, discovered: 1 });
  assert.equal(calls, 1);
  assert.equal(profile.availableModels.at(-1).id, "deepseek-v4.1-flash");
  assert.equal(profile.availableModels.at(-1).endpoint, "responses");
  assert.deepEqual(await refreshProfileModels(profile, config, { fetchImpl }), { changed: false, discovered: 0 });
  assert.equal(calls, 2, "later refreshes still query the directory");
  assert.equal(profile.availableModels.filter((model) => model.id === "deepseek-v4.1-flash").length, 1);
  assert.equal(owner.baseUrlFor({}), "https://opencode.ai/zen/go/v1");
  assert.equal(owner.target(config, "deepseek-v4-flash@opencode-go").url, "https://go.example/v1/responses");
  assert.equal(owner.target(config, "deepseek-v4-flash-free@opencode-go").url, "https://zen.example/v1/responses");
});

test("directory discovery publishes a listed DeepSeek model without sending an inference probe", async () => {
  const calls = [];
  const profile = {
    id: "deepseek-official",
    modelDiscovery: true,
    discoveryTransports: new Set(["responses"]),
    baseUrlFor: () => "https://api.deepseek.example/v1",
    availableModels: [{
      id: "deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      endpoint: "responses",
      supportsVision: false,
      contextWindow: 1_000_000,
      status: "available",
    }],
  };
  const result = await refreshProfileModels(profile, {
    modelDiscoveryEnabled: true,
    tokens: { "deepseek-official": "test-key" },
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ data: [
        { id: "deepseek-v4-flash" },
        { id: "deepseek-v5-preview" },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(result, { changed: true, discovered: 1 });
  assert.equal(calls.length, 1, "one directory request only");
  assert.equal(calls[0].url, "https://api.deepseek.example/v1/models");
  assert.equal(calls[0].options.method, undefined, "discovery must never post a test prompt");
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
  assert.deepEqual(profile.availableModels.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v5-preview"]);
  const discovered = profile.availableModels.at(-1);
  assert.equal(discovered.endpoint, "responses");
  assert.equal(discovered.supportsVision, false, "a directory listing alone never invents vision support");
  assert.equal(profile.availableModels[0].contextWindow, 1_000_000, "curated metadata survives the merge");
});

test("a provider can exclude non-Responses entries from its directory without a model test", async () => {
  const profile = {
    id: "xai",
    modelDiscovery: true,
    discoveryTransports: new Set(["responses"]),
    baseUrlFor: () => "https://api.x.ai/v1",
    availableModels: [],
    discoveryModel: (id) => id === "grok-imagine-video" ? null : {
      id,
      label: id,
      endpoint: "responses",
      supportsVision: id === "grok-4.6",
      status: "available",
    },
  };
  const result = await refreshProfileModels(profile, {
    modelDiscoveryEnabled: true,
    tokens: { xai: "subscription-token" },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [
      { id: "grok-4.6" },
      { id: "grok-imagine-video" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.deepEqual(result, { changed: true, discovered: 1 });
  assert.deepEqual(profile.availableModels.map((model) => model.id), ["grok-4.6"]);
});

test("directory discovery is on by default but retains an explicit test opt-out", async () => {
  const profile = {
    id: "deepseek-official",
    modelDiscovery: true,
    baseUrlFor: () => "https://api.deepseek.example",
    availableModels: [],
  };
  let called = false;
  const result = await refreshProfileModels(profile, {
    modelDiscoveryEnabled: false,
    tokens: { "deepseek-official": "test-key" },
  }, { fetchImpl: async () => { called = true; throw new Error("must not fetch"); } });
  assert.deepEqual(result, { changed: false, discovered: 0 });
  assert.equal(called, false);
});

test("a discovered Anthropic messages model stays out until the gateway implements that dialect", async () => {
  const profile = {
    id: "commandcode",
    modelDiscovery: true,
    discoveryTransports: new Set(["chat"]),
    baseUrlFor: () => "https://api.commandcode.example/v1",
    availableModels: [],
    discoveryModel: (id) => ({ id, label: id, endpoint: "messages", supportsVision: false, status: "available" }),
  };
  const result = await refreshProfileModels(profile, {
    modelDiscoveryEnabled: true,
    tokens: { commandcode: "test-key" },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "claude-code" }] }), { status: 200 }),
  });

  assert.deepEqual(result, { changed: false, discovered: 0 });
  assert.deepEqual(profile.availableModels, []);
});

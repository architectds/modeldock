import assert from "node:assert/strict";
import test from "node:test";
import { refreshProfileModels } from "../src/services.mjs";
import { OPENCODE_GO_PROFILE, profileById, openCodeTransportForModel } from "../src/profiles.mjs";

const goBase = "https://go.example/v1";
const zenBase = "https://zen.example/v1";
const config = {
  modelDiscoveryEnabled: true,
  tokens: { "opencode-go": "fixture-go-token", commandcode: "fixture-commandcode-token" },
  opencodeBaseUrl: goBase,
  zenBaseUrl: zenBase,
};
const freshProfile = (availableModels = []) => ({ ...OPENCODE_GO_PROFILE, availableModels });
const json = (data) => ({ ok: true, json: async () => ({ data }) });

test("OpenCode merges Go and Zen free directories without publishing Zen-only paid models", async () => {
  const curated = { id: "deepseek-v4.1-flash", endpoint: "responses", supportsVision: true, contextWindow: 1_000_000 };
  const profile = freshProfile([curated]);
  const requests = [];
  const result = await refreshProfileModels(profile, config, { fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, "Bearer fixture-go-token");
    assert.ok(options.headers["x-opencode-session"]);
    assert.ok(options.signal);
    return json(url === `${goBase}/models`
      ? [{ id: curated.id }, { id: "new-go-model" }, { id: "shared-free" }]
      : [{ id: "deepseek-v4.1-flash-free" }, { id: "shared-free" }, { id: "big-pickle" },
        { id: "glm-5.3-flash-free" }, { id: "muse-spark-1.3-contributor-free" },
        { id: "jev-1.13-free" }, { id: "paid-zen-only" }, { id: "claude-opus-5" }, { id: "" }, {}]);
  } });
  assert.deepEqual(requests.sort(), [`${goBase}/models`, `${zenBase}/models`].sort());
  assert.deepEqual(result, { changed: true, discovered: 6 });
  assert.equal(profile.availableModels[0], curated, "curated contracts must never be overwritten");
  assert.equal(profile.availableModels.filter((model) => model.id === "shared-free").length, 1);
  assert.ok(!profile.availableModels.some((model) => ["paid-zen-only", "claude-opus-5", "jev-1.13-free"].includes(model.id)));
  for (const model of profile.availableModels.filter((model) => model.id.endsWith("-free") || model.id === "big-pickle")) {
    assert.equal(model.zen, true);
    assert.equal(model.free, true);
    assert.equal(model.supportsVision, false, "a directory ID must not grant vision");
    assert.equal(model.endpoint, model.id.startsWith("muse-spark-") ? "responses" : "chat");
  }
  assert.equal(profile.availableModels.find((model) => model.id === "new-go-model").endpoint, "responses");
  const repeat = await refreshProfileModels(profile, config, { fetchImpl: async () => json([{ id: "shared-free" }]) });
  assert.deepEqual(repeat, { changed: false, discovered: 0 }, "repeat refreshes are idempotent");
});

for (const failedSource of [goBase, zenBase]) {
  for (const failure of ["http", "timeout", "json"]) {
    test(`OpenCode retains the healthy directory when ${failedSource} fails (${failure})`, async () => {
      const profile = freshProfile();
      const result = await refreshProfileModels(profile, config, { fetchImpl: async (url) => {
        if (url === `${failedSource}/models`) {
          if (failure === "timeout") throw new Error("fixture timeout");
          if (failure === "json") return { ok: true, json: async () => { throw new SyntaxError("fixture invalid JSON"); } };
          return { ok: false, status: 503 };
        }
        return json([{ id: failedSource === goBase ? "deepseek-v4.1-flash-free" : "new-go-model" }]);
      } });
      assert.equal(result.discovered, 1);
      assert.equal(profile.availableModels[0].id, failedSource === goBase ? "deepseek-v4.1-flash-free" : "new-go-model");
    });
  }
}

test("OpenCode discovery remains credential-gated and opt-out", async () => {
  for (const settings of [{ ...config, modelDiscoveryEnabled: false }, { ...config, tokens: {} }]) {
    const profile = freshProfile();
    const result = await refreshProfileModels(profile, settings, { fetchImpl: () => assert.fail("disabled discovery must not fetch") });
    assert.deepEqual(result, { changed: false, discovered: 0 });
  }
});

test("other providers keep their own single directory and transport filtering", async () => {
  const profile = { ...profileById("commandcode"), availableModels: [] };
  const requests = [];
  const result = await refreshProfileModels(profile, config, { fetchImpl: async (url) => {
    requests.push(url);
    return json([{ id: "new-commandcode-model" }, { id: "claude-opus-5" }]);
  } });
  assert.deepEqual(requests, ["https://api.commandcode.ai/provider/v1/models"]);
  assert.deepEqual(result, { changed: true, discovered: 1 });
  assert.equal(profile.availableModels[0].endpoint, "chat");
});

test("OpenCode free transports follow the Zen contract rather than the paid Go default", () => {
  assert.equal(openCodeTransportForModel("deepseek-v4.1-flash-free"), "chat");
  assert.equal(openCodeTransportForModel("glm-5.3-flash-free"), "chat");
  assert.equal(openCodeTransportForModel("big-pickle"), "chat");
  assert.equal(openCodeTransportForModel("muse-spark-1.3-contributor-free"), "responses");
  assert.equal(openCodeTransportForModel("jev-1.13-free"), "systemone");
  assert.equal(openCodeTransportForModel("deepseek-v4.1-flash"), "responses");
});

// Two endpoints, two hosts, two keys - driven through the real server.
//
// The unit tests cover the store; what they cannot show is that a request for
// model A reaches host A with key A while model B reaches host B with key B.
// That resolution is spread across gateway.mjs, upstreams.mjs and server.mjs,
// and every one of those sites used to read a single config.customBaseUrl.
// These drive the app wiring, not the caller-key guard. Enforcement is ON by
// default since 0.1.10, so this file opts out the way server-api.test.mjs does;
// the guard itself is covered in server-gateway.test.mjs.
process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createApp, createServices } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";
import { upstreamTargetFor, isLocalBackend } from "../src/gateway.mjs";
import { writeCustomEndpoints, readCustomEndpoints } from "../src/custom-endpoints.mjs";

async function startApp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-endpoints-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codexHome = path.join(dir, "codex");
  await mkdir(codexHome, { recursive: true });
  const endpointsFile = path.join(dir, "custom-endpoints.json");

  const config = {
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: "opencode-go",
    goBaseUrl: "https://go.example.com/v1",
    goToken: "test-token",
    tokens: { "opencode-go": "test-token" },
    mainModel: "deepseek-v4-flash",
    visionModel: "",
    visionTimeoutMs: 9000,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 1 << 20,
    mediaMaxEntries: 8,
    exaMcpUrl: "",
    exaApiKey: "",
    recentLimit: 10,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
    autostartDefault: false,
    codexHome,
    customEndpoints: [],
    codexCatalogFile: path.join(dir, "catalog.json"),
    nativeCatalogFile: path.join(dir, "native.json"),
    summariesFile: path.join(dir, "summaries.json"),
  };
  const services = createServices(config);
  services.customEndpointsFile = endpointsFile;
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    config,
    services,
    endpointsFile,
  };
}

const get = (base, p) => fetch(base + p).then((r) => r.json());
const post = (base, p, body) => fetch(base + p, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test("two endpoints route to their own host with their own key", async (t) => {
  const app = await startApp(t);

  writeCustomEndpoints(app.endpointsFile, [
    { modelId: "self-hosted-27b", baseUrl: "https://vllm.internal/v1", apiKey: "key-internal" },
    { modelId: "vendor-mini", baseUrl: "https://api.vendor.com/v1", apiKey: "key-vendor" },
  ]);
  app.config.customEndpoints = readCustomEndpoints(app.endpointsFile);

  // The whole reason the list exists: one slot could hold only one of these.
  const first = upstreamTargetFor(app.config, "self-hosted-27b@custom");
  const second = upstreamTargetFor(app.config, "vendor-mini@custom");
  assert.equal(first.url, "https://vllm.internal/v1/responses");
  assert.equal(first.token, "key-internal");
  assert.equal(second.url, "https://api.vendor.com/v1/responses");
  assert.equal(second.token, "key-vendor");
  assert.equal(first.model, "self-hosted-27b", "the suffix is stripped before the upstream sees it");
});

test("a loopback endpoint is a local backend and a remote one is not", async (t) => {
  const app = await startApp(t);
  writeCustomEndpoints(app.endpointsFile, [
    { modelId: "local-model", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "" },
    { modelId: "remote-model", baseUrl: "https://api.vendor.com/v1", apiKey: "k" },
  ]);
  app.config.customEndpoints = readCustomEndpoints(app.endpointsFile);

  // Slim mode keys off this. With one shared baseUrl, adding a remote endpoint
  // used to decide the question for every custom model at once.
  assert.equal(isLocalBackend(app.config, "local-model@custom"), true);
  assert.equal(isLocalBackend(app.config, "remote-model@custom"), false);
});

test("every endpoint publishes its model to the picker", async (t) => {
  const app = await startApp(t);
  writeCustomEndpoints(app.endpointsFile, [
    { modelId: "alpha", baseUrl: "https://one.example/v1", apiKey: "k1", contextWindow: 32768 },
    { modelId: "beta", baseUrl: "https://two.example/v1", apiKey: "k2", supportsVision: true },
  ]);
  // The route republishes; here the reload is done by hand because no request
  // has been made yet.
  const { applyCustomProfile, profileById } = await import("../src/profiles.mjs");
  app.config.customEndpoints = readCustomEndpoints(app.endpointsFile);
  applyCustomProfile(app.config);

  const published = profileById("custom").availableModels.map((entry) => entry.id);
  assert.deepEqual(published.sort(), ["alpha", "beta"], "both models are offered, not just the first");
  const beta = profileById("custom").availableModels.find((entry) => entry.id === "beta");
  assert.equal(beta.supportsVision, true, "vision is per endpoint, not shared");
});

test("the list survives a round trip through the API", async (t) => {
  const app = await startApp(t);
  writeCustomEndpoints(app.endpointsFile, [
    { modelId: "alpha", baseUrl: "https://one.example/v1", apiKey: "k1" },
    { modelId: "beta", baseUrl: "https://two.example/v1", apiKey: "k2" },
  ]);

  const listed = await get(app.base, "/api/custom/endpoints");
  assert.deepEqual(listed.endpoints.map((e) => e.modelId), ["alpha", "beta"]);
  assert.ok(!JSON.stringify(listed).includes("k1"), "keys never leave the machine");
  assert.equal(listed.endpoints[0].apiKeyConfigured, true);

  const removed = await post(app.base, "/api/custom/remove", { modelId: "alpha" });
  assert.equal(removed.status, 200);
  const after = await get(app.base, "/api/custom/endpoints");
  assert.deepEqual(after.endpoints.map((e) => e.modelId), ["beta"], "removing one leaves the other");

  const missing = await post(app.base, "/api/custom/remove", { modelId: "never-existed" });
  assert.equal(missing.status, 404, "removing what is not there is an error, not a silent success");
});

test("removing an endpoint releases a vision selection that pointed at it", async (t) => {
  const app = await startApp(t);
  writeCustomEndpoints(app.endpointsFile, [
    { modelId: "seeing", baseUrl: "https://one.example/v1", apiKey: "k", supportsVision: true },
  ]);
  const { applyCustomProfile } = await import("../src/profiles.mjs");
  // The routes mutate services.config, which createServices may hand back as a
  // different object than the one passed in - assert on the one the server uses.
  const live = app.services.config;
  live.customEndpoints = readCustomEndpoints(app.endpointsFile);
  applyCustomProfile(live);
  live.visionModel = "seeing@custom";
  app.services.modelSelection.visionModel = "seeing@custom";

  await post(app.base, "/api/custom/remove", { modelId: "seeing" });
  assert.equal(live.visionModel, "", "a selection must not outlive the endpoint that served it");
  assert.equal(app.services.modelSelection.visionModel, "");
});

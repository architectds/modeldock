import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createApp, createServices } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";
import { probeLocalEngine, readLocalEnginesSnapshot, writeLocalEngineSnapshot } from "../src/local-engines.mjs";
import { parseLlamaArgs } from "../src/engine-processes.mjs";
import { readLocalHostRegistry, upsertLocalHost, writeLocalHostRegistry } from "../src/local-host-registry.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

// Connecting used to fall back to the profile's default port when the caller
// sent no address, so an engine started with `--port 11435` was found by the
// scan and then could not be connected: the scan and the button disagreed
// about where the engine was. Scanning and connecting are one action, so the
// address is discovered on the server and both buttons get the same answer.

// A server that answers just enough of the OpenAI dialect for connect to
// accept it: the model list, then the Responses probe.
function fakeEngine({ models = [{ id: "qwen3.8:27b" }] } = {}) {
  return createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: models }));
      return;
    }
    if (req.url === "/v1/responses") {
      res.end(JSON.stringify({
        id: "resp_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "CUSTOM_OK" }] }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
}

test("llama.cpp discovery reads live vision capability from props", async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith("/props")) return { ok: true, json: async () => ({ modalities: { vision: false } }) };
    if (url.endsWith("/v1/models")) return { ok: true, json: async () => ({ data: [{ id: "qwen" }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const found = await probeLocalEngine(11435, { fetchImpl, timeoutMs: 50 });
  assert.equal(found.engine, "llamacpp");
  assert.equal(found.supportsVision, false, "a server without --mmproj cannot remain a visual Catalog model");
});

async function startApp(t, { discoverEngines }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-connect-discovery-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    goBaseUrl: "https://go.example.com/v1",
    goToken: "test-token",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    mediaTtlMs: 60_000,
    mediaMaxBytes: 1024 * 1024,
    mediaMaxEntries: 8,
    recentLimit: 10,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
    autostartDefault: false,
    summariesFile: path.join(dir, "summaries.json"),
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
    nativeCatalogFile: path.join(dir, "native-catalog.json"),
    codexHome: path.join(dir, "codex"),
    localHostRegistryFile: path.join(dir, "local-hosts.json"),
  };
  const services = createServices(config);
  services.discoverEngines = discoverEngines;
  services.localEnginesFile = path.join(dir, "local-engines.json");
  services.engineLogDir = path.join(dir, "engine-logs");
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, services, dir };
}

test("connect attaches the port discovery found, not the profile default", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  assert.notEqual(port, 8080, "the point of this test is that the port is not the default");

  const { base, services } = await startApp(t, {
    discoverEngines: async () => [{
      engine: "llamacpp",
      baseUrl: `http://127.0.0.1:${port}`,
      port,
      models: ["qwen3.8:27b"],
      connectable: true,
    }],
  });

  // No baseUrl in the body - exactly what both buttons send.
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `connect failed: ${JSON.stringify(payload)}`);
  // normalizeBaseUrl appends the /v1 the Responses dialect lives under; the
  // host and port are what discovery supplied.
  assert.equal(payload.baseUrl, `http://127.0.0.1:${port}/v1`);

  const snapshot = readLocalEnginesSnapshot(services.localEnginesFile);
  assert.equal(snapshot.llamacpp.baseUrl, `http://127.0.0.1:${port}/v1`, "the persisted address is the discovered one");
});

test("connect publishes the GGUF name and keeps the endpoint id for the wire", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const discovered = {
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["qwen3.8:27b"],
    supportsVision: false,
    connectable: true,
    binary: "D:/llama-cpp-cuda/bin/llama-server.exe",
    cmdline: `"D:/llama-cpp-cuda/bin/llama-server.exe" -m D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 262144 --parallel 1 --host 127.0.0.1 --port ${port}`,
    launch: { model: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: { weightBytes: 12 * 1024 ** 3, attentionLayers: 16, headCountKv: 4, keyLength: 256, valueLength: 256, trainedContext: 262144 },
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  // The launch.spec points at a real GGUF on disk; read its header for the name.
  services.modelFactsFor = (_p) => ({ modelName: "Qwen3.8-27B", modelSlug: "Qwen3.8-27B" });
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `connect failed: ${JSON.stringify(payload)}`);
  const model = payload.models[0];
  assert.equal(model.id, "Qwen3.8-27B", "the published id is the model name, not the path");
  assert.equal(model.label, "Qwen3.8-27B", "the picker label is the model name");
  assert.equal(model.upstreamId, "qwen3.8:27b", "the wire id is the endpoint id the server advertises");
  const snapshot = readLocalEnginesSnapshot(services.localEnginesFile);
  assert.equal(snapshot.llamacpp.models[0].id, "Qwen3.8-27B");
  assert.equal(snapshot.llamacpp.models[0].upstreamId, "qwen3.8:27b", "the persisted snapshot keeps the endpoint id for relaunch");
  assert.equal(snapshot.llamacpp.models[0].supportsVision, false, "a stale manual vision checkbox cannot override llama.cpp's live modalities");
  assert.equal(snapshot.llamacpp.observation.modelPath, "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf", "the connected launch remains available to prefill managed setup");
});

test("connect never assigns one GGUF name to every model from a multi-model endpoint", async (t) => {
  const engine = fakeEngine({ models: [{ id: "first" }, { id: "second" }] });
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const discovered = {
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["first", "second"],
    connectable: true,
    launch: { model: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf", ctxSize: 262144, parallel: 1 },
  };
  const { base, services } = await startApp(t, { discoverEngines: async () => [discovered] });
  services.modelFactsFor = () => ({ modelName: "Qwen3.8-27B", modelSlug: "Qwen3.8-27B" });
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `connect failed: ${JSON.stringify(payload)}`);
  assert.deepEqual(payload.models.map((model) => ({ id: model.id, upstreamId: model.upstreamId })), [
    { id: "first", upstreamId: "first" },
    { id: "second", upstreamId: "second" },
  ]);
});

test("discovery refreshes a legacy single-model snapshot from its GGUF header", async (t) => {
  const port = 11435;
  const discovered = {
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf"],
    supportsVision: false,
    connectable: true,
    launch: { model: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: { modelName: "Qwen3.8-27B", modelSlug: "Qwen3.8-27B" },
  };
  const { base, services } = await startApp(t, { discoverEngines: async () => [discovered] });
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    models: [{
      id: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf",
      label: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf",
      upstreamId: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf",
      supportsVision: true,
      contextWindow: 262144,
    }],
  });

  const response = await fetch(`${base}/api/local/discover`);
  assert.equal(response.status, 200);
  const snapshot = readLocalEnginesSnapshot(services.localEnginesFile);
  assert.deepEqual(snapshot.llamacpp.models, [{
    id: "Qwen3.8-27B",
    label: "Qwen3.8-27B",
    upstreamId: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf",
    supportsVision: false,
    contextWindow: 262144,
  }]);
});

test("gateway connection and explicit host takeover stay separate", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const discovered = {
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["qwen3.8:27b"],
    connectable: true,
    binary: "D:/llama-cpp-cuda/bin/llama-server.exe",
    cmdline: `"D:/llama-cpp-cuda/bin/llama-server.exe" -m D:/models/qwen.gguf -c 262144 --parallel 1 --host 127.0.0.1 --port ${port}`,
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: {
      weightBytes: 12 * 1024 ** 3,
      attentionLayers: 16,
      headCountKv: 4,
      keyLength: 256,
      valueLength: 256,
      trainedContext: 262144,
    },
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  services.probeGpus = async () => {
    const usedBytes = discovered.launch.ctxSize === 8_192
      ? Math.round(15.125 * 1024 ** 3)
      : 1 * 1024 ** 3;
    return [{ index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 24 * 1024 ** 3, usedBytes }];
  };
  services.createLocalHostLifecycleOperations = ({ registryFile }) => ({
    async persist(record) {
      const registry = await readLocalHostRegistry(registryFile);
      await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record));
    },
    async drain() {},
    async stop() {},
    async start(spec) {
      discovered.binary = spec.binary;
      discovered.cmdline = `"${spec.binary}" ${spec.args.join(" ")}`;
      discovered.launch = parseLlamaArgs(discovered.cmdline);
    },
    async verify() { return true; },
  });

  const connected = await fetch(`${base}/api/local/connect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }),
  });
  assert.equal(connected.status, 200);

  const before = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(before.engines[0].connected, true, "the gateway route is connected");
  assert.equal(before.engines[0].management, null, "connection did not grant process-management authority");

  const managed = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", cacheDirectory: path.join(dir, "kv"), cacheBudgetGiB: 64 }),
  });
  const managedBody = await managed.json();
  assert.equal(managed.status, 200, JSON.stringify(managedBody));
  assert.equal(managedBody.management.state, "ready");
  assert.equal(managedBody.management.ssdState, "configured", "takeover completed the verified managed restart");
  assert.equal(managedBody.management.cacheBudgetBytes, 64 * 1024 ** 3);

  const after = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(after.engines[0].connected, true, "gateway connection survives takeover");
  assert.equal(after.engines[0].management.state, "ready");
  assert.equal(after.engines[0].management.ssdState, "configured");

  const refusedDisconnect = await fetch(`${base}/api/local/disconnect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }),
  });
  assert.equal(refusedDisconnect.status, 409, "managed process authority cannot be orphaned behind a disconnected route");

  const released = await fetch(`${base}/api/local/unmanage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId: managedBody.management.id }),
  });
  assert.equal(released.status, 200);
  const finalState = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(finalState.engines[0].connected, true, "releasing authority does not disconnect the gateway route");
  assert.equal(finalState.engines[0].management, null);
  assert.equal(services.localHostRegistryFile.endsWith("local-hosts.json"), true);
});

test("managed setup applies selected model, projector, and SSD paths as one verified launch", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const originalFacts = {
    weightBytes: 17_559_178_144,
    attentionLayers: 16,
    headCountKv: 4,
    keyLength: 256,
    valueLength: 256,
    trainedContext: 262144,
    modelName: "Qwen3.8-27B",
    modelSlug: "Qwen3.8-27B",
  };
  const selectedFacts = {
    ...originalFacts,
    weightBytes: 13_575_223_296,
    modelName: "Qwen3-VL-27B",
    modelSlug: "Qwen3-VL-27B",
  };
  const discovered = {
    engine: "llamacpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["D:/models/Qwen3.8-27B-Q4.gguf"],
    connectable: true,
    binary: "D:/llama/llama-server.exe",
    cmdline: `"D:/llama/llama-server.exe" -m D:/models/Qwen3.8-27B-Q4.gguf -c 262144 --parallel 1 --port ${port}`,
    launch: { model: "D:/models/Qwen3.8-27B-Q4.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: originalFacts,
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  const projector = path.join(dir, "mmproj-Qwen3-VL.gguf");
  await writeFile(projector, "projector", "utf8");
  const selectedModel = path.join(dir, "Qwen3-VL-27B.gguf");
  services.readModelFacts = (file) => {
    assert.equal(file, selectedModel);
    return selectedFacts;
  };
  services.probeGpus = async () => {
    const usedBytes = discovered.launch.ctxSize === 8_192
      ? Math.round(16.8 * 1024 ** 3)
      : 1 * 1024 ** 3;
    return [{ index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 24 * 1024 ** 3, usedBytes }];
  };
  services.createLocalHostLifecycleOperations = ({ registryFile }) => ({
    async persist(record) {
      const registry = await readLocalHostRegistry(registryFile);
      await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record));
    },
    async drain() {},
    async stop() {},
    async start(spec) {
      discovered.cmdline = `"${spec.binary}" ${spec.args.join(" ")}`;
      discovered.launch = parseLlamaArgs(discovered.cmdline);
      discovered.models = ["D:/models/Qwen3-VL-27B.gguf"];
      discovered.modelFacts = selectedFacts;
    },
    async verify() { return true; },
  });

  assert.equal((await fetch(`${base}/api/local/connect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }),
  })).status, 200);
  const managed = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      engine: "llamacpp",
      modelPath: selectedModel,
      visionProjectorPath: projector,
      cacheDirectory: path.join(dir, "kv"),
      cacheBudgetGiB: 8,
    }),
  });
  const body = await managed.json();
  assert.equal(managed.status, 200, JSON.stringify(body));
  assert.equal(body.management.modelPath, selectedModel);
  assert.equal(body.management.visionProjectorPath, projector);
  assert.equal(discovered.launch.model, selectedModel);
  assert.equal(discovered.launch.visionProjectorPath, projector);

  const snapshot = readLocalEnginesSnapshot(services.localEnginesFile);
  assert.deepEqual(snapshot.llamacpp.models, [{
    id: "Qwen3-VL-27B",
    upstreamId: "D:/models/Qwen3-VL-27B.gguf",
    label: "Qwen3-VL-27B",
    supportsVision: true,
    contextWindow: body.management.capacity.maxSingleRequestTokens,
  }], "only the verified managed visual model reaches the Codex catalog");
});

test("the local picker API permits only the fixed native dialog kinds", async (t) => {
  const { base, services } = await startApp(t, { discoverEngines: async () => [] });
  let received = "";
  services.pickLocalHostPath = async (kind) => {
    received = kind;
    return "D:/models/Qwen3-VL.gguf";
  };
  const response = await fetch(`${base}/api/local/pick`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "model" }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).path, "D:/models/Qwen3-VL.gguf");
  assert.equal(received, "model");
});

test("a failed first takeover restores observation without leaving managed authority", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const originalCmdline = `"D:/llama/llama-server.exe" -m D:/models/qwen.gguf -c 262144 --parallel 1 --port ${port}`;
  const discovered = {
    engine: "llamacpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["qwen"],
    connectable: true,
    binary: "D:/llama/llama-server.exe",
    cmdline: originalCmdline,
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: {
      weightBytes: 12 * 1024 ** 3,
      attentionLayers: 16,
      headCountKv: 4,
      keyLength: 256,
      valueLength: 256,
      trainedContext: 262144,
    },
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  services.probeGpus = async () => [
    { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 24 * 1024 ** 3, usedBytes: 18 * 1024 ** 3 },
  ];
  services.createLocalHostLifecycleOperations = ({ registryFile }) => ({
    async persist(record) {
      const registry = await readLocalHostRegistry(registryFile);
      await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record));
    },
    async drain() {},
    async stop() {},
    async start(spec) {
      discovered.binary = spec.binary;
      discovered.cmdline = `"${spec.binary}" ${spec.args.join(" ")}`;
      discovered.launch = parseLlamaArgs(discovered.cmdline);
    },
    async verify(_spec, record) {
      return record.desiredProfile === null;
    },
  });

  assert.equal((await fetch(`${base}/api/local/connect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }),
  })).status, 200);
  const response = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", cacheDirectory: path.join(dir, "kv"), cacheBudgetGiB: 16 }),
  });
  const body = await response.json();
  assert.equal(response.status, 502, JSON.stringify(body));
  assert.equal(body.outcome, "recovered");
  assert.equal(body.management, null);
  assert.equal(discovered.cmdline, originalCmdline, "recovery used the exact command seen before takeover");
  const registry = await readLocalHostRegistry(services.localHostRegistryFile);
  assert.deepEqual(registry.hosts, {}, "failed activation leaves no process-management authority behind");
  const after = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(after.engines[0].connected, true);
  assert.equal(after.engines[0].management, null);
});

test("a double verification failure retains degraded recovery authority", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const discovered = {
    engine: "llamacpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["qwen"],
    connectable: true,
    binary: "D:/llama/llama-server.exe",
    cmdline: `"D:/llama/llama-server.exe" -m D:/models/qwen.gguf -c 262144 --parallel 1 --port ${port}`,
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: {
      weightBytes: 12 * 1024 ** 3,
      attentionLayers: 16,
      headCountKv: 4,
      keyLength: 256,
      valueLength: 256,
      trainedContext: 262144,
    },
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  services.probeGpus = async () => [
    { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 24 * 1024 ** 3, usedBytes: 18 * 1024 ** 3 },
  ];
  let verificationCount = 0;
  services.createLocalHostLifecycleOperations = ({ registryFile }) => ({
    async persist(record) {
      const registry = await readLocalHostRegistry(registryFile);
      await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record));
    },
    async drain() {},
    async stop() {},
    async start() {},
    async verify() {
      verificationCount += 1;
      if (verificationCount === 1) return true;
      throw new Error("verification failed");
    },
  });
  assert.equal((await fetch(`${base}/api/local/connect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }),
  })).status, 200);
  const response = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", cacheDirectory: path.join(dir, "kv"), cacheBudgetGiB: 16 }),
  });
  const body = await response.json();
  assert.equal(response.status, 502, JSON.stringify(body));
  assert.equal(body.outcome, "degraded");
  assert.equal(body.management.state, "degraded");
  const registry = await readLocalHostRegistry(services.localHostRegistryFile);
  assert.equal(Object.values(registry.hosts)[0].state, "degraded");
});

test("a KV budget the volume cannot hold is refused with the usable figure", async (t) => {
  // The default directory sits under the user profile - usually the system
  // drive - so the budget must fit inside the measured free space minus the
  // OS reserve (20 GiB). 30 GiB free leaves 10 GiB usable: 16 is refused,
  // and the message names the number the user should type instead.
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [] });
  services.probeKvFreeBytes = () => 30 * 1024 ** 3;
  const refused = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", cacheDirectory: path.join(dir, "kv"), cacheBudgetGiB: 16 }),
  });
  const body = await refused.json();
  assert.equal(refused.status, 400, JSON.stringify(body));
  assert.equal(body.error?.type, "kv_budget_disk");
  assert.match(body.error?.message, /at most 10 GiB/);
  // And the discover payload derives its suggested default from the same
  // measurement: min(8, usable) with the reserve already subtracted.
  const discover = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(discover.kvBudgetDefaultGiB, 8);
  services.probeKvFreeBytes = () => 23 * 1024 ** 3;
  const tight = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(tight.kvBudgetDefaultGiB, 3, "a tight volume suggests only what it can spare");
});

test("clearing SSD KV state without a managed host is a readable refusal", async (t) => {
  const { base } = await startApp(t, { discoverEngines: async () => [] });
  const refused = await fetch(`${base}/api/local/kv/clear`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  const body = await refused.json();
  assert.equal(refused.status, 409, JSON.stringify(body));
  assert.equal(body.error?.type, "not_managed");
});

test("unmanage releases a host whose first takeover verification failed", async (t) => {
  // activeSpec === null means ModelDock never replaced the original process,
  // so there is nothing to restore: unmanage must re-verify the pre-takeover
  // command and revoke management directly. Routing this shape through
  // applyLocalHostPlan drained a process this gateway never touched - and a
  // failing drain then stranded the record in "draining" (reproduced live).
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const discovered = {
    engine: "llamacpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["qwen"],
    connectable: true,
    binary: "D:/llama/llama-server.exe",
    cmdline: `"D:/llama/llama-server.exe" -m D:/models/qwen.gguf -c 262144 --parallel 1 --port ${port}`,
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: {
      weightBytes: 12 * 1024 ** 3,
      attentionLayers: 16,
      headCountKv: 4,
      keyLength: 256,
      valueLength: 256,
      trainedContext: 262144,
    },
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  services.probeGpus = async () => [
    { index: 0, uuid: "gpu-0", vendor: "nvidia", totalBytes: 24 * 1024 ** 3, usedBytes: 18 * 1024 ** 3 },
  ];
  const lifecycleCalls = [];
  let originalServing = false;
  let releaseVisionProjector = null;
  services.createLocalHostLifecycleOperations = ({ registryFile }) => ({
    async persist(record) {
      const registry = await readLocalHostRegistry(registryFile);
      await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record));
    },
    async drain() { lifecycleCalls.push("drain"); throw new Error("must never drain a process ModelDock never replaced"); },
    async stop() { lifecycleCalls.push("stop"); },
    async start() { lifecycleCalls.push("start"); },
    async verify(_spec, record) {
      releaseVisionProjector = record.capabilities?.visionProjectorPath || "";
      return originalServing;
    },
  });
  assert.equal((await fetch(`${base}/api/local/connect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }),
  })).status, 200);
  const managed = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", cacheDirectory: path.join(dir, "kv"), cacheBudgetGiB: 16 }),
  });
  const managedBody = await managed.json();
  assert.equal(managed.status, 409, JSON.stringify(managedBody));
  assert.equal(managedBody.error?.type, "takeover_failed", "the standard envelope carries the verification failure");
  assert.ok(managedBody.error?.message, "the dashboard reads body.error.message; without it the user saw 'Manage 409'");
  const registry = await readLocalHostRegistry(services.localHostRegistryFile);
  const record = Object.values(registry.hosts)[0];
  assert.equal(record.state, "degraded");
  assert.equal(record.activeSpec, null, "the original process was never replaced");
  const targetCap = { ...record, capabilities: { ...record.capabilities, visionProjectorPath: "D:/models/mmproj.gguf" } };
  await writeLocalHostRegistry(services.localHostRegistryFile, upsertLocalHost(registry, targetCap));

  originalServing = true;
  const released = await fetch(`${base}/api/local/unmanage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId: record.id }),
  });
  const releasedBody = await released.json();
  assert.equal(released.status, 200, JSON.stringify(releasedBody));
  assert.equal(releaseVisionProjector, "", "releasing a never-started target must verify only the original process capability");
  assert.deepEqual(lifecycleCalls, [], "release re-verifies and revokes; it never drains, stops, or starts");
  const cleared = await readLocalHostRegistry(services.localHostRegistryFile);
  assert.deepEqual(cleared.hosts, {}, "management authority is fully revoked");
});

test("unmanage clears a failed target projector before restoring the original command", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const original = `"D:/llama/llama-server.exe" -m D:/models/qwen.gguf -c 262144 --parallel 1 --port ${port}`;
  const discovered = {
    engine: "llamacpp", baseUrl: `http://127.0.0.1:${port}`, port, models: ["qwen"], connectable: true,
    binary: "D:/llama/llama-server.exe", cmdline: original,
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: { weightBytes: 12 * 1024 ** 3, attentionLayers: 16, headCountKv: 4, keyLength: 256, valueLength: 256, trainedContext: 262144 },
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  services.probeGpus = async () => [{
    index: 0,
    uuid: "gpu-0",
    vendor: "nvidia",
    totalBytes: 24 * 1024 ** 3,
    usedBytes: discovered.launch.ctxSize === 8_192 ? 16 * 1024 ** 3 : 1 * 1024 ** 3,
  }];
  let projectorSeen = "";
  services.createLocalHostLifecycleOperations = ({ registryFile }) => ({
    async persist(record) { const registry = await readLocalHostRegistry(registryFile); await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record)); },
    async drain() {}, async stop() {}, async start(spec) { discovered.cmdline = `"${spec.binary}" ${spec.args.join(" ")}`; discovered.launch = parseLlamaArgs(discovered.cmdline); },
    async verify(_spec, record) { projectorSeen = record.capabilities?.visionProjectorPath || ""; return !projectorSeen; },
  });
  assert.equal((await fetch(`${base}/api/local/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }) })).status, 200);
  const managed = await fetch(`${base}/api/local/manage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp", cacheDirectory: path.join(dir, "kv"), cacheBudgetGiB: 8 }) });
  const managedBody = await managed.json();
  assert.equal(managed.status, 200, JSON.stringify(managedBody));
  const record = Object.values((await readLocalHostRegistry(services.localHostRegistryFile)).hosts)[0];
  const failedTarget = { ...record, state: "degraded", capabilities: { ...record.capabilities, visionProjectorPath: "D:/models/mmproj.gguf" } };
  await writeLocalHostRegistry(services.localHostRegistryFile, upsertLocalHost(await readLocalHostRegistry(services.localHostRegistryFile), failedTarget));
  const released = await fetch(`${base}/api/local/unmanage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId: record.id }) });
  const releasedBody = await released.json();
  assert.equal(released.status, 200, JSON.stringify(releasedBody));
  assert.equal(projectorSeen, "");
});

test("managed setup rejects a served profile that leaves less than one GiB on a participating card", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const original = `"D:/llama/llama-server.exe" -m D:/models/qwen.gguf -c 262144 --parallel 1 --port ${port}`;
  const discovered = {
    engine: "llamacpp", baseUrl: `http://127.0.0.1:${port}`, port, models: ["qwen"], connectable: true,
    binary: "D:/llama/llama-server.exe", cmdline: original,
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
    modelFacts: { weightBytes: 12 * 1024 ** 3, attentionLayers: 16, headCountKv: 4, keyLength: 256, valueLength: 256, trainedContext: 262144 },
  };
  const { base, services, dir } = await startApp(t, { discoverEngines: async () => [discovered] });
  const projector = path.join(dir, "mmproj.gguf");
  await writeFile(projector, "projector", "utf8");
  services.probeGpus = async () => [{
    index: 0,
    uuid: "gpu-0",
    vendor: "nvidia",
    totalBytes: 24 * 1024 ** 3,
    usedBytes: discovered.launch.ctxSize === 8_192
      ? 16 * 1024 ** 3
      : (discovered.launch.visionProjectorPath ? Math.round(23.5 * 1024 ** 3) : 1 * 1024 ** 3),
    freeBytes: discovered.launch.visionProjectorPath ? Math.round(0.5 * 1024 ** 3) : 20 * 1024 ** 3,
  }];
  services.createLocalHostLifecycleOperations = ({ registryFile }) => ({
    async persist(record) { const registry = await readLocalHostRegistry(registryFile); await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record)); },
    async drain() {}, async stop() {},
    async start(spec) { discovered.cmdline = `"${spec.binary}" ${spec.args.join(" ")}`; discovered.launch = parseLlamaArgs(discovered.cmdline); },
    async verify() { return true; },
  });
  assert.equal((await fetch(`${base}/api/local/connect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }) })).status, 200);
  const response = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", visionProjectorPath: projector, cacheDirectory: path.join(dir, "kv"), cacheBudgetGiB: 8 }),
  });
  const body = await response.json();
  assert.equal(response.status, 502, JSON.stringify(body));
  assert.equal(body.outcome, "recovered");
  assert.match(body.message, /(1 GiB GPU headroom|No calculated P1 NVIDIA profile)/);
  assert.equal(discovered.launch.visionProjectorPath, undefined, "recovery returned to the original text-only command");
});

test("connect says nothing is running instead of failing against a default port", async (t) => {
  const { base } = await startApp(t, { discoverEngines: async () => [] });
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.error.type, "not_found");
  // The old behaviour was a connection error naming 8080, which sent the user
  // looking for a port problem that was never theirs.
  assert.doesNotMatch(payload.error.message, /8080/);
  assert.match(payload.error.message, /Start it/);
});

test("an explicit address still wins over discovery", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));

  let discoverCalls = 0;
  const { base } = await startApp(t, {
    discoverEngines: async () => { discoverCalls += 1; return []; },
  });
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", baseUrl: `http://127.0.0.1:${port}` }),
  });
  assert.equal(response.status, 200);
  assert.equal(discoverCalls, 0, "a caller who knows the address is not made to wait for a scan");
});

test("only the engine actually attached is shown as connected", async (t) => {
  // Discovery reads the process table now, so two llama-servers can appear at
  // once. Keying attachment on the engine name marked both connected while only
  // one was, which made the page claim a server was published that never was.
  const { base, services } = await startApp(t, {
    discoverEngines: async () => [
      { engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435, models: ["a"], connectable: true },
      { engine: "llamacpp", baseUrl: "http://127.0.0.1:8080", port: 8080, models: ["b"], connectable: true },
    ],
  });
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    // Stored with the /v1 suffix the connect route appends; discovery reports
    // the bare origin, so this pair must still compare equal.
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a" }],
  });

  const response = await fetch(`${base}/api/local/discover`);
  const { engines } = await response.json();
  const byPort = Object.fromEntries(engines.map((engine) => [engine.port, engine]));
  assert.equal(byPort[11435].connected, true, "the attached one");
  assert.equal(byPort[8080].connected, false, "a second llama.cpp is not attached just by being llama.cpp");
  assert.equal(byPort[8080].connectedModels, 0);
  assert.equal(engines.filter((engine) => engine.connected).length, 1);
});

test("restart refuses to start a second copy of an engine that is answering", async (t) => {
  // The button hides itself while the engine answers, but that is a rendered
  // snapshot. A direct call - or a click after the engine came back - used to
  // spawn a second copy that could only fail to bind the port.
  const { base, services } = await startApp(t, {
    discoverEngines: async () => [
      { engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435, models: ["a"], connectable: true },
    ],
  });
  // We do know how to start it - the race is that it came back on its own.
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a" }],
    launch: { binary: process.execPath, args: ["-e", "0"] },
  });
  const response = await fetch(`${base}/api/local/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.error.type, "already_running");
});

test("restart reports where the engine's output went", async (t) => {
  // AGENTS.md: a background launch must log, never discard. This button is
  // pressed exactly when the engine already died once, so the reason has to
  // land somewhere the user can be pointed at.
  const { base, services } = await startApp(t, { discoverEngines: async () => [] });
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a" }],
    // Something harmless that exists on every platform and exits immediately.
    launch: { binary: process.execPath, args: ["-e", "process.stderr.write('engine boot\\n')"] },
  });
  const response = await fetch(`${base}/api/local/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.ok(payload.logFile, "the caller is told where the output went");
  assert.match(payload.logFile, /engine-llamacpp\.log$/);
  // Give the detached child a moment to write and exit.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const written = await readFile(payload.logFile, "utf8");
  // Not just "the string is in there": this test's own -e script carried an
  // escape that JS resolved before the spawn, so node received a real newline
  // inside a quoted string, refused to parse it, and echoed the offending
  // source line - which contains "engine boot" - into the log. The assertion
  // passed on a crash traceback. The child has to have actually run.
  assert.doesNotMatch(written, /SyntaxError|Invalid or unexpected token/, "the child never ran");
  assert.match(written, /^engine boot\s*$/, "stderr reached the log instead of /dev/null");
});

// What Codex is told about a local model has to follow what the engine serves.
//
// The published window comes from meta.n_ctx, read once when the engine was
// connected. Restart it smaller - through the drawer or by hand - and the
// figure stayed where it was, so Codex kept packing against the old number and
// auto-compacted near 80% of it. An engine moved from 80K to 32K was being
// asked to hold 64,000 tokens in a window of 32,000, and it failed mid-turn.
test("a window the engine no longer serves is republished, and asks for a restart", async (t) => {
  const cmdline = "llama-server -m D:/models/q3.gguf -c 32000 --port 11435";
  const { base, services } = await startApp(t, {
    discoverEngines: async () => [{
      engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435,
      models: ["a"], connectable: true, pid: 4242,
      binary: "C:/llama/llama-server.exe", cmdline, launch: parseLlamaArgs(cmdline),
    }],
  });
  // Connected when it was serving 80K, and published as such.
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a", label: "a", contextWindow: 80000 }],
  });
  await services.configSwitcher.acknowledgeRestart();

  const response = await fetch(`${base}/api/local/discover`);
  assert.equal(response.status, 200);

  const snapshot = readLocalEnginesSnapshot(services.localEnginesFile);
  assert.equal(snapshot.llamacpp.models[0].contextWindow, 32000, "the published window follows the running one");
  const state = await services.configSwitcher.status();
  assert.equal(state.restartRequired, true, "Codex reads the catalog at startup, so the change lands on its restart");

  // And a scan that changes nothing does not keep asking for restarts.
  await services.configSwitcher.acknowledgeRestart();
  await fetch(`${base}/api/local/discover`);
  const settled = await services.configSwitcher.status();
  assert.equal(settled.restartRequired, false, "a steady engine is not a reason to restart Codex");
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createApp, createServices } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";
import { readLocalEnginesSnapshot, writeLocalEngineSnapshot } from "../src/local-engines.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

// Connecting used to fall back to the profile's default port when the caller
// sent no address, so an engine started with `--port 11435` was found by the
// scan and then could not be connected: the scan and the button disagreed
// about where the engine was. Scanning and connecting are one action, so the
// address is discovered on the server and both buttons get the same answer.

// A server that answers just enough of the OpenAI dialect for connect to
// accept it: the model list, then the Responses probe.
function fakeEngine() {
  return createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "qwen3.8:27b" }] }));
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
  };
  const services = createServices(config);
  services.discoverEngines = discoverEngines;
  services.localEnginesFile = path.join(dir, "local-engines.json");
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, services };
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
    launch: { binary: process.execPath, args: ["-e", "process.stderr.write('engine boot\n')"] },
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
  assert.match(written, /engine boot/, "stderr reached the log instead of /dev/null");
});

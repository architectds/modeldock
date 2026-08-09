import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createApp, createServices, startServer, initAutostartDefault, codexModelCatalog } from "./server.mjs";
import { OPENCODE_GO_PROFILE, DEEPSEEK_OFFICIAL_PROFILE } from "./profiles.mjs";

// Bare-path tests exercise the app wiring, not the caller-key guard. Enforcement
// is ON by default since 0.1.10, so this file opts out explicitly; the default
// enforcement behavior is covered in server-gateway.test.mjs.
process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

const TEST_PROFILE = { ...OPENCODE_GO_PROFILE };

function baseConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    profile: TEST_PROFILE,
    profileId: TEST_PROFILE.id,
    goBaseUrl: "https://go.example.com/v1",
    goToken: "test-token",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    visionFallbackModel: "kimi-k2.5",
    visionTimeoutMs: 90_000,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxEntries: 64,
    exaMcpUrl: "https://mcp.exa.ai/mcp",
    exaApiKey: "",
    recentLimit: 50,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

async function startApp(configOverrides = {}) {
  const config = { ...baseConfig(), ...configOverrides };
  if (configOverrides.goToken === null) delete config.goToken;
  // Isolate the persisted-summaries file: tests must never read or write the real
  // ~/.modeldock/summaries.json (a run of npm test was polluting the live gate's
  // file with 260 fake ses_ entries).
  if (!config.summariesFile) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-summaries-"));
    config.summariesFile = path.join(dir, "summaries.json");
  }
  // Isolate the catalog file and native capture: tests must never read or write
  // the real ~/.modeldock state (a test run was polluting the live gate's files).
  if (!config.codexCatalogFile || !config.nativeCatalogFile) {
    const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-catalog-test-"));
    config.codexCatalogFile = config.codexCatalogFile || path.join(dir, "codex-model-catalog.json");
    config.nativeCatalogFile = config.nativeCatalogFile || path.join(dir, "native-catalog.json");
  }
  const services = createServices(config);
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, services, stop: async () => { await services.mediaStore.cleanup(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); } };
}

function jsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    (async () => {
      for await (const chunk of req) chunks.push(chunk);
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    })();
  });
}

function sendSse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

const okResponse = { id: "resp_1", object: "response", status: "completed", output: [], usage: { input_tokens: 111, output_tokens: 22 } };

test("without token: healthz and responses return 503, local models catalog still works", async (t) => {
  const instance = await startApp({ goToken: null });
  t.after(instance.stop);
  assert.equal((await fetch(`${instance.base}/healthz`)).status, 503);
  const models = await fetch(`${instance.base}/v1/models`);
  assert.equal(models.status, 200, "models catalog is local and does not need the token");
  assert.equal((await models.json()).models[0].slug, "deepseek-v4-flash");
  const responses = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hi" }),
  });
  assert.equal(responses.status, 503);
  assert.equal((await responses.json()).error.type, "configuration_error");
});

test("with token: healthz returns 200", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("debug mode is exposed and can toggle at runtime", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);

  const initial = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(initial.config.debug.enabled, false);

  const changed = await fetch(`${instance.base}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  });
  assert.deepEqual(await changed.json(), { enabled: true });

  const enabled = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(enabled.config.debug.enabled, true);

  const disabled = await fetch(`${instance.base}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.deepEqual(await disabled.json(), { enabled: false });
  const final = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(final.config.debug.enabled, false);
});

test("model API exposes selectable main and vision-capable options", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const initial = await (await fetch(`${instance.base}/api/models`)).json();
  assert.equal(initial.selected.mainModel, "deepseek-v4-flash");
  assert.deepEqual(initial.options.filter((model) => model.supportsVision).map((model) => model.id), ["gpt-5.6-luna@opencode-go", "grok-4.5", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "mimo-v2.5", "mimo-v2.5-free"]);
  const changed = await fetch(`${instance.base}/api/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainModel: "gpt-5.6-luna@opencode-go", visionModel: "kimi-k2.5" }) });
  assert.equal(changed.status, 200);
  assert.deepEqual((await changed.json()).selected, { mainModel: "gpt-5.6-luna@opencode-go", visionModel: "kimi-k2.5" });
  const invalid = await fetch(`${instance.base}/api/models`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visionModel: "deepseek-v4-flash" }) });
  assert.equal(invalid.status, 400);
});

test("models endpoint serves the local Codex catalog", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.models[0].slug, "deepseek-v4-flash");
  assert.equal(body.models[0].supports_parallel_tool_calls, false);
  assert.deepEqual(body.models[0].supported_reasoning_levels.map((level) => level.effort), ["low", "high", "xhigh"]);
  assert.match(body.models[0].base_instructions, /coding agent/);
});

test("codexModelCatalog matches Codex schema requirements", () => {
  const catalog = codexModelCatalog({
    mainModel: "deepseek-v4-flash",
    // Keep the schema check hermetic: without a configured native catalog file
    // the merge would read the real ~/.modeldock capture on a dev machine and
    // the provider-grouped order would put a native GPT model first.
    nativeCatalogFile: path.join(os.tmpdir(), "modeldock-test-native-missing.json"),
  });
  const model = catalog.models[0];
  assert.equal(model.slug, "deepseek-v4-flash");
  assert.equal(model.supports_reasoning_summaries, true);
  assert.equal(model.model_messages.instructions_variables.personality_pragmatic, "");
  assert.equal(model.apply_patch_tool_type, "freeform");
  assert.equal(model.web_search_tool_type, "text");
  assert.equal(model.multi_agent_version, "v2");
});

test("api/status returns expected shape", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/api/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ready, true);
  assert.equal(body.config.mainModel, "deepseek-v4-flash");
  assert.equal(body.config.tokenConfigured, true);
  assert.ok(body.responses);
  assert.ok(body.web);
  assert.ok(body.vision);
  assert.ok(Array.isArray(body.recent));
  assert.ok(body.media);
});

test("config API defaults off and performs reversible user-triggered switching", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-server-switch-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  const original = 'model = "gpt-5.6-sol"\n\n[features]\nmulti_agent = true\n';
  await writeFile(configPath, original, "utf8");
  const instance = await startApp({ codexHome });
  t.after(instance.stop);

  assert.equal((await (await fetch(`${instance.base}/api/config`)).json()).enabled, false);
  const blocked = await fetch(`${instance.base}/api/config/enable`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://not-local.example" },
    body: "{}",
  });
  assert.equal(blocked.status, 403);

  const enabled = await fetch(`${instance.base}/api/config/enable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).restartRequired, true);
  assert.match(await readFile(configPath, "utf8"), /openai_base_url = "http:\/\/127\.0\.0\.1:\d+\/c\/[^"]+\/v1"/);

  const disabled = await fetch(`${instance.base}/api/config/disable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(disabled.status, 200);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("config mode endpoint switches OFF / TRIAL / ON and locks the free pair in trial", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-server-mode-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  const original = 'model = "gpt-5.6-sol"\n';
  await writeFile(configPath, original, "utf8");
  const envFile = path.join(codexHome, "modeldock.env");
  const instance = await startApp({ codexHome, envFile });
  t.after(instance.stop);
  const post = (body) => fetch(`${instance.base}/api/config/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const invalid = await post({ mode: "bogus" });
  assert.equal(invalid.status, 400);

  const trial = await (await post({ mode: "trial" })).json();
  assert.equal(trial.enabled, true);
  assert.equal(trial.trial, true);
  assert.equal(trial.restartRequired, true);
  assert.equal(instance.services.modelSelection.mainModel, "deepseek-v4-flash-free");
  assert.equal(instance.services.modelSelection.visionModel, "mimo-v2.5-free");
  assert.match(await readFile(envFile, "utf8"), /MODELDOCK_TRIAL=1/);

  const trialStatus = await (await fetch(`${instance.base}/api/status`)).json();
  assert.equal(trialStatus.config.trial, true);
  assert.deepEqual(trialStatus.models.options.map((model) => model.id).sort(), ["deepseek-v4-flash-free", "mimo-v2.5-free"]);

  // /api/models cannot escape the trial pair while trial is active.
  const locked = await (await fetch(`${instance.base}/api/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mainModel: "gpt-5.6-luna@opencode-go", visionModel: "kimi-k2.5" }),
  })).json();
  assert.deepEqual(locked.selected, { mainModel: "deepseek-v4-flash-free", visionModel: "mimo-v2.5-free" });

  const on = await (await post({ mode: "on" })).json();
  assert.equal(on.enabled, true);
  assert.equal(on.trial, false);
  assert.match(await readFile(envFile, "utf8"), /MODELDOCK_TRIAL=0/);

  const off = await (await post({ mode: "off" })).json();
  assert.equal(off.enabled, false);
  assert.equal(off.trial, false);
  assert.equal(await readFile(configPath, "utf8"), original, "off restores the original Codex config");
});

test("config mode ON writes the wizard nativeMerge switch and drops native GPT models when false", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-server-merge-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, 'model = "gpt-5.6-sol"\n', "utf8");
  const envFile = path.join(codexHome, "modeldock.env");
  const nativeDir = await mkdtemp(path.join(os.tmpdir(), "modeldock-server-native-"));
  t.after(() => rm(nativeDir, { recursive: true, force: true }));
  const nativeCatalogFile = path.join(nativeDir, "native-catalog.json");
  await writeFile(nativeCatalogFile, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 }],
  }), "utf8");
  const catalogFile = path.join(nativeDir, "codex-model-catalog.json");
  const instance = await startApp({ codexHome, envFile, nativeCatalogFile, codexCatalogFile: catalogFile });
  t.after(instance.stop);
  const post = (body) => fetch(`${instance.base}/api/config/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Subscriber (nativeMerge=true): native GPT models stay in the published catalog.
  const merged = await (await post({ mode: "on", nativeMerge: true })).json();
  assert.equal(merged.enabled, true);
  assert.match(await readFile(envFile, "utf8"), /MODELDOCK_NATIVE_MERGE=1/);
  assert.ok(JSON.parse(await readFile(catalogFile, "utf8")).models.some((model) => model.slug === "gpt-5.6-luna"),
    "nativeMerge=true keeps the native GPT model in the catalog file");

  // Non-subscriber (nativeMerge=false): native GPT models are dropped from the
  // catalog; login-free aliasing republishes external models under the native
  // slots instead, so the slot slug appears but never as an OpenAI entry.
  const nomerge = await (await post({ mode: "on", nativeMerge: false })).json();
  assert.equal(nomerge.enabled, true);
  assert.match(await readFile(envFile, "utf8"), /MODELDOCK_NATIVE_MERGE=0/);
  const nomergeCatalog = JSON.parse(await readFile(catalogFile, "utf8"));
  const lunaEntry = nomergeCatalog.models.find((model) => model.slug === "gpt-5.6-luna");
  assert.ok(lunaEntry, "nativeMerge=false aliases an external model onto the native slot");
  assert.ok(!String(lunaEntry.display_name).startsWith("OpenAI -"),
    "the aliased slot carries the external model's name, not OpenAI's");

  // Trial also persists the switch: a non-subscriber moving trial -> on must not get
  // the native GPT catalog back.
  const trial = await (await post({ mode: "trial", nativeMerge: false })).json();
  assert.equal(trial.trial, true);
  assert.match(await readFile(envFile, "utf8"), /MODELDOCK_NATIVE_MERGE=0/);
  assert.equal(instance.services.config.nativeMerge, false, "trial keeps the in-memory switch too");
});

test("onboarding endpoint prefills, completes, and persists the flag across mode switches", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-server-onboard-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, 'model = "gpt-5.6-sol"\n', "utf8");
  const envFile = path.join(codexHome, "modeldock.env");
  const instance = await startApp({ codexHome, envFile });
  t.after(instance.stop);

  const prefill = await (await fetch(`${instance.base}/api/onboarding`)).json();
  assert.equal(prefill.onboarded, false);
  assert.equal(prefill.nativeMerge, true, "defaults to the subscriber-native merge");
  assert.equal(prefill.mode, "off");
  assert.deepEqual(prefill.tokenConfigured, { "opencode-go": true, "deepseek-official": false },
    "prefill reports the configured test token");
  assert.equal(typeof prefill.autostart.enabled, "boolean");

  const done = await (await fetch(`${instance.base}/api/onboarding/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  })).json();
  assert.equal(done.onboarded, true);

  const after = await (await fetch(`${instance.base}/api/onboarding`)).json();
  assert.equal(after.onboarded, true, "the completed marker is served back");
  assert.ok(after.onboardedAt, "the completed marker carries a timestamp");

  await fetch(`${instance.base}/api/config/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "trial" }),
  });
  await fetch(`${instance.base}/api/config/mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "off" }),
  });
  const survived = await (await fetch(`${instance.base}/api/onboarding`)).json();
  assert.equal(survived.onboarded, true, "trial/off mode switches do not reset the onboarding flag");
});

test("api/events streams an initial snapshot", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${instance.base}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const { value } = await response.body.getReader().read();
  assert.match(new TextDecoder().decode(value), /^data: \{/);
});

test("unknown routes return 404 json", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/nope`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.message, "Not found");
});

test("GET / serves the dashboard", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /ModelDock/);
});

test("image generation posts pass through to the native backend", async (t) => {
  const instance = await startApp();
  t.after(instance.stop);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, options);
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: [{ b64_json: "abc" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const response = await fetch(`${instance.base}/v1/images/generations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer chatgpt-token" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "dashboard mockup" }),
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /chatgpt\.com\/backend-api\/codex\/images\/generations/);
  assert.equal(calls[0].headers.authorization, "Bearer chatgpt-token");
  assert.equal(calls[0].body.prompt, "dashboard mockup");
  assert.match(await response.text(), /b64_json/);
});

test("api/status exposes debug flags without dump path leaks", async (t) => {
  const instance = await startApp({ debug: { enabled: true, noReasoning: true, dumpDir: "" } });
  t.after(instance.stop);
  const response = await fetch(`${instance.base}/api/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.config.debug.enabled, true);
  assert.equal(status.config.debug.noReasoning, true);
  assert.equal(status.config.debug.dumpDir, "");
});

test("zstd decoder caps the compressed stream and the decompressed body", async (t) => {
  if (typeof zlib.zstdCompressSync !== "function") {
    t.skip("zstd requires Node 23.8+");
    return;
  }
  const instance = await startApp({});
  t.after(instance.stop);

  // Highly compressible payload: tiny on the wire, decompresses past 64MB.
  const bomb = zlib.zstdCompressSync(Buffer.alloc(100 * 1024 * 1024));
  const tooBig = await fetch(`${instance.base}/healthz`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: bomb,
  });
  assert.equal(tooBig.status, 413);

  // Incompressible stream that already exceeds the 16MB input cap.
  const huge = zlib.zstdCompressSync(randomBytes(17 * 1024 * 1024));
  const tooLong = await fetch(`${instance.base}/healthz`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: huge,
  });
  assert.equal(tooLong.status, 413);
});

test("host guard rejects non-loopback Host headers (DNS rebinding)", async (t) => {
  const instance = await startApp({});
  t.after(instance.stop);

  // fetch() strips Host overrides, so speak raw HTTP to actually spoof the header.
  const { request } = await import("node:http");
  const port = new URL(instance.base).port;
  const spoofed = await new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/api/status", headers: { host: "evil.example.com" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end();
  });
  // createMcpExpressApp({ host }) enforces this app-wide; keep it pinned by test so a
  // framework upgrade cannot silently drop the DNS-rebinding protection.
  assert.equal(spoofed.status, 403);
  assert.match(spoofed.body, /Invalid Host/i);

  const legit = await fetch(`${instance.base}/api/status`);
  assert.equal(legit.status, 200);
});

test("WebSocket upgrades are declined with 426 so Codex falls back to HTTP", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-upgrade-test-"));
  const config = {
    ...baseConfig(),
    port: 0,
    autostartDefault: false,
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
    nativeCatalogFile: path.join(dir, "native-catalog.json"),
  };
  const instance = await startServer(config);
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.after(instance.stop);
  const port = instance.server.address().port;

  const upgrade = (pathname) => new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    const chunks = [];
    socket.setTimeout(3_000, () => {
      socket.destroy();
      reject(new Error("upgrade response timeout"));
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString().includes("\r\n\r\n")) {
        socket.destroy();
        resolve(Buffer.concat(chunks).toString());
      }
    });
    socket.on("error", reject);
  });

  const bare = await upgrade("/v1/responses");
  assert.match(bare, /^HTTP\/1\.1 426 Upgrade Required/, "bare responses path is declined with 426");
  assert.match(bare, /Connection: close/i);

  const keyed = await upgrade("/c/some-key/v1/responses");
  assert.match(keyed, /^HTTP\/1\.1 426 Upgrade Required/, "keyed responses path is declined with 426");

  // Ordinary HTTP traffic is untouched: the gate still serves healthz.
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
});

test("initAutostartDefault enables login autostart on first run and records the decision", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-autostart-default-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const autostart = {
    supported: () => true,
    enabled: () => false,
    async refresh() {},
    async setEnabled(value) {
      calls.push(value);
      return { enabled: value, supported: true };
    },
  };

  assert.equal(await initAutostartDefault(autostart, { stateDir: dir }), true);
  assert.deepEqual(calls, [true], "first run enables autostart");
  assert.equal(await readFile(path.join(dir, "autostart-initialized"), "utf8").then(Boolean), true);
});

test("initAutostartDefault never re-enables after the decision is recorded", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-autostart-marked-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "autostart-initialized"), "once\n", "utf8");
  let setCalls = 0;
  const autostart = {
    supported: () => true,
    enabled: () => false,
    async refresh() {},
    async setEnabled() {
      setCalls += 1;
      return { enabled: true, supported: true };
    },
  };

  assert.equal(await initAutostartDefault(autostart, { stateDir: dir }), false);
  assert.equal(setCalls, 0, "an existing mark means the user's preference is respected");
});

test("initAutostartDefault records the mark even when autostart is already enabled", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-autostart-already-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let setCalls = 0;
  const autostart = {
    supported: () => true,
    enabled: () => true,
    async refresh() {},
    async setEnabled() {
      setCalls += 1;
      return { enabled: true, supported: true };
    },
  };

  assert.equal(await initAutostartDefault(autostart, { stateDir: dir }), true);
  assert.equal(setCalls, 0, "already enabled needs no registry write");
});

test("initAutostartDefault leaves no mark when the platform is unsupported or enabling fails", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-autostart-fail-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const unsupported = {
    supported: () => false,
    enabled: () => false,
    async refresh() {},
    async setEnabled() {
      throw new Error("unreachable");
    },
  };
  assert.equal(await initAutostartDefault(unsupported, { stateDir: dir }), false);
  await assert.rejects(readFile(path.join(dir, "autostart-initialized"), "utf8"));

  const failing = {
    supported: () => true,
    enabled: () => false,
    async refresh() {},
    async setEnabled() {
      throw new Error("registry denied");
    },
  };
  assert.equal(await initAutostartDefault(failing, { stateDir: dir }), false);
  await assert.rejects(readFile(path.join(dir, "autostart-initialized"), "utf8"));
});

test("custom endpoint flow: list models, probe, persist, publish to catalog", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-custom-endpoint-"));
  const envFile = path.join(dir, ".env");
  const instance = await startApp({
    envFile,
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
  });
  t.after(async () => {
    await instance.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      const value = String(url);
      // Only stub the external vendor endpoint; the gateway's own local routes
      // (/api/custom/*, /v1/models) must pass through to the test server.
      if (value.startsWith("https://vendor.example/") && value.endsWith("/v1/models")) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "vendor/model-x" }] }) };
      }
      if (value.startsWith("https://vendor.example/") && value.endsWith("/v1/responses")) {
        return { ok: true, status: 200, json: async () => ({ id: "resp_1", usage: { input_tokens: 5, output_tokens: 1 } }) };
      }
      return originalFetch(url, options);
    };

    const list = await (await fetch(`${instance.base}/api/custom/list-models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://vendor.example/v1", apiKey: "sk-test" }),
    })).json();
    assert.deepEqual(list.models.map((model) => model.id), ["vendor/model-x"]);

    const add = await (await fetch(`${instance.base}/api/custom/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://vendor.example/v1",
        apiKey: "sk-test",
        modelId: "vendor/model-x",
        asMain: true,
        asVision: false,
      }),
    })).json();
    assert.equal(add.ok, true);
    assert.equal(add.model, "vendor/model-x");
    assert.equal(add.responsesUrl, "https://vendor.example/v1/responses");
    assert.equal(add.settings.custom.apiKeyConfigured, true);
    assert.equal(add.settings.custom.model, "vendor/model-x");
    assert.equal(add.settings.custom.asMain, true);

    // Persisted to the isolated env file.
    const env = await readFile(envFile, "utf8");
    assert.match(env, /MODELDOCK_CUSTOM_BASE_URL=https:\/\/vendor\.example\/v1/);
    assert.match(env, /MODELDOCK_CUSTOM_API_KEY=sk-test/);
    assert.match(env, /MODELDOCK_CUSTOM_MODEL=vendor\/model-x/);
    assert.match(env, /MODELDOCK_CUSTOM_MAIN=1/);
    assert.match(env, /MODELDOCK_MAIN_MODEL=vendor\/model-x@custom/);

    // Published to the catalog under the Custom provider.
    const catalog = await (await fetch(`${instance.base}/v1/models`)).json();
    const customEntry = catalog.models.find((entry) => entry.slug === "vendor/model-x@custom");
    assert.ok(customEntry, "custom model appears in the published catalog");
    assert.equal(customEntry.display_name, "Custom - vendor/model-x");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("custom endpoint add rejects a failing probe with a classified error", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-custom-endpoint-fail-"));
  const instance = await startApp({ envFile: path.join(dir, ".env") });
  t.after(async () => {
    await instance.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith("https://vendor.example/") && String(url).endsWith("/v1/responses")) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      // Everything else (including the gateway request itself) must pass through.
      return originalFetch(url, options);
    };
    const response = await fetch(`${instance.base}/api/custom/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "https://vendor.example/v1",
        apiKey: "sk-bad",
        modelId: "vendor/model-x",
        asMain: false,
        asVision: false,
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.type, "key");
    assert.ok(body.error.message.includes("401"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings save probes the upstream and persists only a working token", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-settings-save-"));
  const envFile = path.join(dir, ".env");
  const eventsFile = path.join(dir, "settings-events.jsonl");
  const instance = await startApp({
    envFile,
    settingsEventsFile: eventsFile,
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
  });
  t.after(async () => {
    await instance.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      const value = String(url);
      if (value === "https://go.example.com/v1/responses" || value === "https://api.deepseek.com/v1/responses") {
        return { ok: true, status: 200, json: async () => ({ id: "resp_probe", usage: { input_tokens: 5, output_tokens: 1 } }) };
      }
      return originalFetch(url, options);
    };

    const response = await fetch(`${instance.base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        opencodeGoToken: "sk-opencode-valid-token-123456",
        deepseekApiKey: "sk-deepseek-valid-key-123456",
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.providers[0].tokenConfigured, true);
    assert.equal(body.providers[1].tokenConfigured, true);

    const env = await readFile(envFile, "utf8");
    assert.match(env, /^OPENCODE_GO_TOKEN=/m);
    assert.match(env, /^DEEPSEEK_API_KEY=/m);
    const events = (await readFile(eventsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[events.length - 1].ok, true);
    assert.deepEqual([...events[events.length - 1].providers].sort(), ["deepseek-official", "opencode-go"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings save rejects a token the upstream rejects without writing", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-settings-reject-"));
  const envFile = path.join(dir, ".env");
  const eventsFile = path.join(dir, "settings-events.jsonl");
  const instance = await startApp({
    envFile,
    settingsEventsFile: eventsFile,
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
  });
  t.after(async () => {
    await instance.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url) === "https://go.example.com/v1/responses") {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return originalFetch(url, options);
    };

    const response = await fetch(`${instance.base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opencodeGoToken: "sk-wrong-but-well-formed-123456" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.type, "token_rejected_opencode-go");
    assert.ok(body.error.message.includes("401"));

    const env = await readFile(envFile, "utf8").catch(() => "");
    assert.doesNotMatch(env, /OPENCODE_GO_TOKEN=/);
    const events = (await readFile(eventsFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[events.length - 1].ok, false);
    assert.equal(events[events.length - 1].error, "token_rejected_opencode-go");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings save rejects a failed provider probe without persisting exa", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-settings-exa-atomic-"));
  const envFile = path.join(dir, ".env");
  const eventsFile = path.join(dir, "settings-events.jsonl");
  const instance = await startApp({
    envFile,
    settingsEventsFile: eventsFile,
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
  });
  t.after(async () => {
    await instance.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url) === "https://api.deepseek.com/v1/responses") {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      return originalFetch(url, options);
    };

    const response = await fetch(`${instance.base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        exaApiKey: "exa_valid_shape_123",
        deepseekApiKey: "sk-well-formed-but-rejected-123456",
      }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.type, "token_rejected_deepseek-official");

    // A rejected provider probe must leave the .env byte-clean: the exa key
    // that passed validation is deferred into the same atomic write and must
    // not have been persisted on its own.
    const env = await readFile(envFile, "utf8").catch(() => "");
    assert.doesNotMatch(env, /EXA_API_KEY=/);
    assert.doesNotMatch(env, /DEEPSEEK_API_KEY=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings save rejects placeholder tokens before any upstream probe", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-settings-placeholder-"));
  const instance = await startApp({
    envFile: path.join(dir, ".env"),
    settingsEventsFile: path.join(dir, "settings-events.jsonl"),
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
  });
  t.after(async () => {
    await instance.stop();
    await rm(dir, { recursive: true, force: true });
  });

  let probed = false;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      if (String(url).endsWith("/responses") && options?.method === "POST") probed = true;
      return originalFetch(url, options);
    };
    const response = await fetch(`${instance.base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opencodeGoToken: "x" }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.type, "invalid_opencode_go_token");
    assert.equal(probed, false, "placeholder rejection must not hit the upstream");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("settings rejects malformed provider tokens without touching the env file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-settings-token-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, "modeldock.env");
  const instance = await startApp({ envFile });
  t.after(instance.stop);

  const bad = await fetch(`${instance.base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deepseekApiKey: "not-a-deepseek-key" }),
  });
  assert.equal(bad.status, 400, "a non-sk- DeepSeek key is rejected");
  const badBody = await bad.json();
  assert.equal(badBody.error.type, "invalid_deepseek_api_key");
  assert.match(badBody.error.message, /sk-/);
  await assert.rejects(readFile(envFile, "utf8"), (error) => error.code === "ENOENT", "the env file stays untouched");

  const quoted = await fetch(`${instance.base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ opencodeGoToken: 'tok"en' }),
  });
  assert.equal(quoted.status, 400, "a quoted token is rejected");
  await assert.rejects(readFile(envFile, "utf8"), (error) => error.code === "ENOENT");
});

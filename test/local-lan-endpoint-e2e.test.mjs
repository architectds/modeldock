import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));
const lanUrl = "http://192.168.50.20:11435";
const customBaseUrl = `${lanUrl}/v1`;
const modelId = "strata-flash-next";
const localModelId = "strata/flash-next";
const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64url");
const localSlug = `mdr.${b64("local")}.${b64(localModelId)}`;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForStatus(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const connected = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("built bundle did not open its loopback listener");
}

test("built bundle supports explicit private-LAN Local and Custom endpoints", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.request.tools.length, 164);
  const tempRoot = process.env.MODELDOCK_SANDBOX_DIR || os.tmpdir();
  await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, "modeldock-local-lan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const endpointFile = path.join(stateDir, "custom-endpoints.json");
  await mkdir(stateDir, { recursive: true });

  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const record = {
      method: req.method,
      path: req.url,
      originalHost: req.headers["x-test-original-host"],
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : null,
    };
    received.push(record);
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: modelId, meta: { n_ctx: 65536 } }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/props") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ modalities: { vision: true }, chat_template_caps: { supports_object_arguments: true }, media_marker: "<__local_media__>" }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses" && record.body?.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_probe", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions" && record.body?.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chat_probe", model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: "CUSTOM_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses" && record.body?.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'data: {"type":"response.created","response":{"id":"resp_lan_ok","status":"in_progress","output":[]}}',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_lan_ok","type":"message","role":"assistant","content":[]}}',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_lan_ok","type":"message","role":"assistant","content":[{"type":"output_text","text":"LAN_OK"}]}}',
        'data: {"type":"response.completed","response":{"id":"resp_lan_ok","status":"completed","output":[{"id":"msg_lan_ok","type":"message","role":"assistant","content":[{"type":"output_text","text":"LAN_OK"}]}],"usage":{"input_tokens":20,"output_tokens":2}}}',
        "data: [DONE]", "",
      ].join("\n\n"));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions" && record.body?.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        `data: ${JSON.stringify({ id: "chat_lan_ok", created: 21, model: modelId, choices: [{ index: 0, delta: { role: "assistant", content: "LOCAL_OK" } }] })}`,
        `data: ${JSON.stringify({ id: "chat_lan_ok", created: 21, model: modelId, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}`,
        "data: [DONE]", "",
      ].join("\n\n"));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected upstream request", method: req.method, path: req.url }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const preload = path.join(root, "redirect-lan-fetch.mjs");
  await writeFile(preload, `
const originalFetch = globalThis.fetch;
const upstream = process.env.MODELDOCK_TEST_LAN_UPSTREAM;
const hosts = new Set([
  "10.1.2.3", "172.16.0.1", "192.168.50.20", "fc00::1",
  "8.8.8.8", "169.254.169.254", "engine.local", "modeldock.test", "0.0.0.0", "::",
]);
globalThis.fetch = (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  if (!hosts.has(url.hostname.replace(/^\\[|\\]$/g, ""))) return originalFetch(input, init);
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  headers.set("x-test-original-host", url.host);
  return originalFetch(upstream + url.pathname + url.search, { ...init, headers });
};
`, "utf8");

  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\local-lan-${process.pid}`;
  const gatewayEnv = {
    ...process.env,
    MODELDOCK_PORT: String(gatewayPort),
    MODELDOCK_PROFILE: "opencode-go",
    MODELDOCK_HOST: "127.0.0.1",
    OPENCODE_GO_TOKEN: "fixture-go-key",
    MODELDOCK_STATE_DIR: stateDir,
    MODELDOCK_ENV_FILE: path.join(root, "modeldock.env"),
    MODELDOCK_CUSTOM_ENDPOINTS_FILE: endpointFile,
    MODELDOCK_CODEX_HOME: path.join(root, "codex-home"),
    MODELDOCK_SETTINGS_EVENTS_FILE: path.join(root, "settings-events.jsonl"),
    MODELDOCK_USAGE_EVENTS_FILE: path.join(root, "usage-events.jsonl"),
    MODELDOCK_REQUIRE_CALLER_KEY: "0",
    MODELDOCK_MEMORY: "0",
    MODELDOCK_MODEL_DISCOVERY: "0",
    MODELDOCK_NATIVE_MERGE: "0",
    MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
    MODELDOCK_AUTOSTART_KEY: autostartKey,
    MODELDOCK_AUTOSTART_NAME: `ModelDockLocalLan${process.pid}`,
    MODELDOCK_AUTOSTART_PLIST_DIR: path.join(root, "LaunchAgents"),
    MODELDOCK_TEST_LAN_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  };
  let stderr = "";
  let stdout = "";
  const launch = () => {
    const childProcess = spawn(process.execPath, ["--import", pathToFileURL(preload).href, bundle], {
      cwd: repoRoot, env: gatewayEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
    childProcess.stderr.on("data", (chunk) => { stderr += chunk; });
    return childProcess;
  };
  let child = launch();
  t.after(() => stop(child));
  if (process.platform === "win32") {
    t.after(() => {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* test key may not exist */ }
    });
  }
  await waitForStatus(gatewayPort).catch((error) => {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });
  const api = `http://127.0.0.1:${gatewayPort}`;
  const status = await (await fetch(`${api}/api/status`)).json();
  assert.equal(status.config.bind, `127.0.0.1:${gatewayPort}`, "the gateway listener remains loopback-only");
  const sameOrigin = { origin: api };
  const post = (route, body, headers = {}) => fetch(`${api}${route}`, {
    method: "POST", headers: { "content-type": "application/json", ...sameOrigin, ...headers }, body: JSON.stringify(body),
  });

  const unauthenticated = await fetch(`${api}/c/not-a-valid-caller-key/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fixture.request),
  });
  assert.equal(unauthenticated.status, 401, "the gateway relay still rejects requests without its caller key");
  const foreignOrigin = await post("/api/local/probe", { baseUrl: lanUrl }, { origin: "https://attacker.invalid" });
  assert.equal(foreignOrigin.status, 403, "a foreign Origin cannot drive local endpoint probes");

  const rejectedUrls = [
    "http://8.8.8.8:11435/v1", "http://169.254.169.254/latest/meta-data/v1",
    "http://engine.local:11435/v1", "http://modeldock.test:11435/v1",
    "http://0.0.0.0:11435/v1", "http://[::]:11435/v1",
  ];
  for (const customUrl of rejectedUrls) {
    const before = received.length;
    const customResult = await post("/api/custom/list-models", { baseUrl: customUrl, apiKey: "" });
    assert.ok(customResult.status >= 400, `Custom must reject ${customUrl}`);
    assert.equal(received.length, before, `Custom must reject ${customUrl} before outbound traffic`);
    const localResult = await post("/api/local/probe", { baseUrl: customUrl.replace(/\/v1$/, "") });
    assert.ok(localResult.status >= 400, `Local must reject ${customUrl}`);
    assert.equal(received.length, before, `Local must reject ${customUrl} before outbound traffic`);
  }

  const localProbe = await post("/api/local/probe", { baseUrl: lanUrl });
  const localProbeText = await localProbe.text();
  assert.equal(localProbe.status, 200, `the exact private-LAN Local URL must probe successfully: ${localProbeText}\n${stderr}`);
  assert.ok(received.some((entry) => entry.originalHost === "192.168.50.20:11435" && entry.path === "/v1/models"),
    "the model-list request must target the entered LAN host and port");

  const attached = await post("/api/local/attach", {
    baseUrl: lanUrl, upstreamId: modelId, providerName: "strata", modelName: "flash-next",
  });
  const attachText = await attached.text();
  assert.equal(attached.status, 200, `the private-LAN Local endpoint must attach: ${attachText}\n${stderr}`);
  assert.ok(received.some((entry) => entry.originalHost === "192.168.50.20:11435" && entry.path === "/props"),
    "/props capability detection must query the LAN URL, not 127.0.0.1:11435");
  const localSaved = JSON.parse(readFileSync(endpointFile, "utf8")).find((entry) => entry.local);
  assert.equal(localSaved.baseUrl, `${lanUrl}/v1`);
  assert.equal(localSaved.supportsVision, true);
  const discovery = await (await fetch(`${api}/api/local/discover`)).json();
  assert.equal(discovery.registrations.find((entry) => entry.modelId === "strata/flash-next")?.offline, false,
    "saved LAN registration remains online in discovery");
  const lanEngine = discovery.engines.find((entry) => entry.baseUrl === lanUrl);
  assert.ok(lanEngine, "the saved LAN service appears in discovery");
  for (const field of ["pid", "launch", "binary"]) {
    assert.equal(lanEngine[field], undefined, `LAN discovery cannot invent local ${field} attribution`);
  }

  const localCatalog = await (await fetch(`${api}/v1/models`)).json();
  const localRow = localCatalog.models.find((entry) => entry.slug === localSlug);
  assert.ok(localRow,
    `the canonical Local identity ${localSlug} must be published; related rows: ${JSON.stringify(localCatalog.models.filter((entry) => /local|strata|flash-next/i.test(`${entry.slug} ${entry.display_name}`)))}`);
  assert.equal(localRow.display_name, "Local - strata / flash-next",
    "the Codex picker label follows the established Local provider/model label contract");
  const localRelay = await fetch(`${api}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture.request, model: localRow.slug }),
  });
  const localRelayText = await localRelay.text();
  assert.equal(localRelay.status, 200, `full Codex fixture must relay through Local: ${localRelayText}\n${stderr}`);
  assert.match(localRelayText, /"type":"response.completed"/);
  assert.match(localRelayText, /LOCAL_OK/, "the client receives the upstream assistant text");
  const localTurn = received.find((entry) => entry.path === "/v1/chat/completions" && entry.body?.stream === true);
  assert.ok(localTurn, "the attached Local route sends the full streamed turn over Chat");
  assert.equal(localTurn.originalHost, "192.168.50.20:11435");
  assert.equal(localTurn.body.model, modelId);
  assert.ok(localTurn.body.tools.length > 150);

  const customList = await post("/api/custom/list-models", { baseUrl: customBaseUrl, apiKey: "" });
  assert.equal(customList.status, 200, `keyless private-LAN model listing must work: ${await customList.text()}`);
  const customAdd = await post("/api/custom/add", { baseUrl: customBaseUrl, apiKey: "", modelId });
  const customText = await customAdd.text();
  assert.equal(customAdd.status, 200, `keyless private-LAN Custom endpoint must save: ${customText}\n${stderr}`);
  assert.ok(received.filter((entry) => entry.originalHost === "192.168.50.20:11435").every((entry) => !entry.authorization),
    "keyless Local and Custom requests reach the private endpoint without an Authorization header");

  const allowedLanHosts = [
    ["http://10.1.2.3:11435/v1", "10.1.2.3:11435"],
    ["http://172.16.0.1:11435/v1", "172.16.0.1:11435"],
    [`${customBaseUrl}`, "192.168.50.20:11435"],
    ["http://[fc00::1]:11435/v1", "[fc00::1]:11435"],
  ];
  for (const [baseUrl, host] of allowedLanHosts) {
    const before = received.length;
    const result = await post("/api/custom/list-models", { baseUrl, apiKey: "" });
    assert.equal(result.status, 200, `${baseUrl} is a private LAN address`);
    assert.ok(received.slice(before).some((entry) => entry.originalHost === host), `${baseUrl} reaches its own host`);
  }

  const catalog = await (await fetch(`${api}/v1/models`)).json();
  const customRow = catalog.models.find((entry) => entry.display_name === `Custom - ${modelId}`);
  assert.ok(customRow, "the keyless Custom model is published");
  const relay = await fetch(`${api}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture.request, model: customRow.slug }),
  });
  const relayText = await relay.text();
  assert.equal(relay.status, 200, `full Codex fixture must relay through keyless Custom: ${relayText}\n${stderr}`);
  assert.match(relayText, /"type":"response.completed"/);
  assert.match(relayText, /LAN_OK/, "the client receives the Custom assistant text");
  const fullTurn = received.find((entry) => entry.path === "/v1/responses" && entry.body?.stream === true);
  assert.ok(fullTurn, "the strict mock receives the full streamed turn");
  assert.equal(fullTurn.originalHost, "192.168.50.20:11435");
  assert.equal(fullTurn.body.model, modelId);
  const expectedOmittedTools = fixture.request.tools.filter((tool) => tool.name === "view_image" || tool.type === "web_search");
  assert.deepEqual(expectedOmittedTools.map(({ type, name }) => ({ type, name: name ?? null })), [
    { type: "function", name: "view_image" },
    { type: "web_search", name: null },
  ], "Custom intentionally filters only text-incompatible view_image and unsupported hosted web_search");
  const expectedNameMappings = new Map([
    ["mcp__codex_apps__codex_document_control___execute_document_command", "codex_apps__codex_document_control___execute_document_command"],
    ["mcp__codex_apps__codex_document_control___get_document_tool_schemas", "codex_apps__codex_document_control___get_document_tool_schemas"],
    ["mcp__codex_apps__github___search_installed_repositories_streaming", "codex_apps__github___search_installed_repositories_streaming"],
    ["mcp__codex_apps__safety_settings___prepare_parental_control_update", "codex_apps__safety_settings___prepare_parental_control_update"],
    ["mcp__codex_apps__sites___create_source_repository_write_credential", "codex_apps__sites___create_source_repository_write_credential"],
  ]);
  const expectedLongNames = fixture.request.tools
    .filter((tool) => typeof tool.name === "string" && tool.name.length > 64)
    .map((tool) => tool.name);
  assert.deepEqual(expectedLongNames, [...expectedNameMappings.keys()],
    "the fixture's only overlength names are the five known mcp__-prefix mappings");
  const expectedWireTools = fixture.request.tools
    .filter((tool) => tool.name !== "view_image" && tool.type !== "web_search")
    .map((tool) => expectedNameMappings.has(tool.name)
      ? { ...tool, name: expectedNameMappings.get(tool.name) }
      : tool);
  assert.equal(fullTurn.body.tools.length, 162);
  assert.deepEqual(fullTurn.body.tools, expectedWireTools,
    "all remaining Codex descriptors and schemas reach Custom unchanged");

  await stop(child);
  child = launch();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForStatus(gatewayPort);
  const restarted = JSON.parse(readFileSync(endpointFile, "utf8"));
  assert.ok(restarted.some((entry) => entry.local && entry.baseUrl === `${lanUrl}/v1`), "Local LAN route survives restart");
  assert.ok(restarted.some((entry) => !entry.local && entry.baseUrl === `${lanUrl}/v1` && entry.modelId === modelId),
    "Custom LAN route survives restart independently");
  const afterRestart = await fetch(`${api}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture.request, model: localRow.slug }),
  });
  const afterRestartText = await afterRestart.text();
  assert.equal(afterRestart.status, 200, `the persisted Local route relays after restart: ${afterRestartText}\n${stderr}`);
  assert.match(afterRestartText, /"type":"response.completed"/);
  assert.match(afterRestartText, /LOCAL_OK/, "the Local assistant text remains intact after restart");
  const customAfterRestart = await fetch(`${api}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture.request, model: customRow.slug }),
  });
  const customAfterRestartText = await customAfterRestart.text();
  assert.equal(customAfterRestart.status, 200,
    `the persisted Custom route relays after restart: ${customAfterRestartText}\n${stderr}`);
  assert.match(customAfterRestartText, /"type":"response.completed"/);
  assert.match(customAfterRestartText, /LAN_OK/, "the Custom assistant text remains intact after restart");
});

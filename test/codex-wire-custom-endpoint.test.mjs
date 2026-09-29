// A saved endpoint with the removed provider-name field must still publish and
// relay through the single custom provider after an installed-bundle upgrade.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));
const modelId = "qwen3.8-flash-next-exl3";

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
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return;
    } catch { /* bundle is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("built bundle did not start");
}

test("built bundle publishes a saved endpoint as custom and relays the full Codex request", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.request.tools.length, 164);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-wire-custom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const endpointFile = path.join(stateDir, "custom-endpoints.json");
  await mkdir(stateDir, { recursive: true });
  const received = [];
  let incomplete = false;
  const upstream = http.createServer(async (req, res) => {
    if (req.url !== "/v1/responses") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (incomplete) {
      res.end('data: {"type":"response.created","response":{"id":"resp_custom_short","status":"in_progress","output":[]}}\n\n');
      return;
    }
    res.end([
      'data: {"type":"response.created","response":{"id":"resp_custom_ok","status":"in_progress","output":[]}}',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_custom_ok","type":"message","role":"assistant","content":[]}}',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_custom_ok","type":"message","role":"assistant","content":[{"type":"output_text","text":"CUSTOM_OK"}]}}',
      'data: {"type":"response.completed","response":{"id":"resp_custom_ok","status":"completed","output":[{"id":"msg_custom_ok","type":"message","role":"assistant","content":[{"type":"output_text","text":"CUSTOM_OK"}]}],"usage":{"input_tokens":100,"output_tokens":2}}}',
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  await writeFile(endpointFile, JSON.stringify([{
    providerId: "collab", // Obsolete stored field must not hide the endpoint.
    modelId,
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: "fixture-custom-key",
    transport: "responses",
    supportsVision: false,
  }]));
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\wire-custom-${process.pid}`;
  const gatewayEnv = {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      OPENCODE_GO_TOKEN: "fixture-go-key",
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CUSTOM_ENDPOINTS_FILE: endpointFile,
      MODELDOCK_CODEX_HOME: path.join(root, "codex-home"),
      MODELDOCK_REQUIRE_CALLER_KEY: "0",
      MODELDOCK_MEMORY: "0",
      MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey,
      MODELDOCK_AUTOSTART_NAME: `ModelDockWireCustom${process.pid}`,
  };
  const launchGateway = () => spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: gatewayEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let child = launchGateway();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stop(child));
  if (process.platform === "win32") {
    t.after(() => {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* test key may not exist */ }
    });
  }
  await waitForStatus(gatewayPort);

  const visionUpdate = await fetch(`http://127.0.0.1:${gatewayPort}/api/models/vision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: `${modelId}@custom`, supportsVision: true }),
  });
  assert.equal(visionUpdate.status, 200, `saved custom vision cannot be edited: ${await visionUpdate.text()}`);
  const savedEndpoints = JSON.parse(readFileSync(endpointFile, "utf8"));
  assert.equal(savedEndpoints[0].supportsVision, true, "the endpoint record owns its vision capability");
  const roster = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/models/roster`)).json();
  const customRow = roster.models.find((entry) => entry.id === `${modelId}@custom`);
  assert.equal(customRow?.visionEditable, true);
  assert.equal(customRow?.supportsVision, true);

  const picker = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/models`)).json();
  assert.ok(picker.options.some((option) => option.id === `${modelId}@custom` && option.provider === "custom"),
    "the old named record must be visible under custom in the dashboard picker");
  const catalog = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)).json();
  const codexModel = catalog.models.find((item) => item.display_name === `Custom - ${modelId}`);
  assert.ok(codexModel, "the same model must be published in the Codex picker");
  assert.ok(codexModel.input_modalities?.includes("image"), "Codex receives the corrected vision declaration");
  const request = { ...fixture.request, model: codexModel.slug };
  const relay = () => fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const complete = await relay();
  const completeText = await complete.text();
  assert.equal(complete.status, 200, `full Codex request did not relay: ${completeText}\n${stderr}`);
  assert.match(completeText, /"type":"response.completed"/);
  assert.equal(received.length, 1);
  assert.equal(received[0].authorization, "Bearer fixture-custom-key");
  assert.equal(received[0].body.model, modelId);
  assert.ok(received[0].body.tools.length > 150, "the full Codex tool catalog must reach the configured endpoint");

  incomplete = true;
  const short = await relay();
  const shortText = await short.text();
  assert.equal(short.status, 200);
  assert.match(shortText, /"type":"response.failed"/);
  assert.match(shortText, /Response stream ended before a terminal event/);
  assert.doesNotMatch(shortText, /OpenCode Go/);

  for (const next of [false, true]) {
    const changed = await fetch(`http://127.0.0.1:${gatewayPort}/api/models/vision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `${modelId}@custom`, supportsVision: next }),
    });
    assert.equal(changed.status, 200, `custom vision could not switch to ${next}: ${await changed.text()}`);
    const current = JSON.parse(readFileSync(endpointFile, "utf8"));
    assert.equal(current[0].supportsVision, next);
    const published = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)).json();
    assert.equal(published.models.find((entry) => entry.slug === codexModel.slug)?.input_modalities.includes("image"), next);
  }

  await stop(child);
  child = launchGateway();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForStatus(gatewayPort);
  const restored = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/models/roster`)).json();
  const restoredRow = restored.models.find((entry) => entry.id === `${modelId}@custom`);
  assert.equal(restoredRow?.supportsVision, true, "custom vision survives gateway restart");
  assert.equal(restoredRow?.visionEditable, true);
});

// The official OpenCode Go host is session-scoped: it answers only to requests
// that carry x-opencode-session. A custom endpoint whose configured URL IS that
// host is Go all the same, so the identity must be attached there too - on the
// save probe and on every relayed turn - while an ordinary custom endpoint keeps
// exactly the headers it had before.
const OFFICIAL_GO_BASE = "https://opencode.ai/zen/go/v1";
const CALLER_SESSION = "go-header-e2e-session";

test("built bundle sends x-opencode-session to a custom endpoint on the official Go URL", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-wire-go-custom-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const endpointFile = path.join(stateDir, "custom-endpoints.json");
  await mkdir(stateDir, { recursive: true });
  await writeFile(endpointFile, "[]", "utf8");

  const goModel = "qwen3.8-flash";
  const plainModel = "plain-echo-1";
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const record = {
      method: req.method,
      path: req.url,
      session: req.headers["x-opencode-session"],
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : null,
    };
    seen.push(record);
    if (req.method === "GET" && req.url.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: goModel }, { id: plainModel }] }));
      return;
    }
    if (req.url.endsWith("/responses")) {
      // Neither endpoint here speaks Responses: the save probe must fall through
      // to Chat, which is the transport this contract is about.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no Responses protocol here" }));
      return;
    }
    if (record.body?.stream !== true) {
      // The save probe's bounded turn: plain JSON, the shape probeCustomChat reads.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_custom_probe",
        model: record.body?.model || goModel,
        choices: [{ index: 0, message: { role: "assistant", content: "CUSTOM_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 2 },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({ id: "chatcmpl_custom_relay", created: 21, model: record.body?.model || goModel, choices: [{ index: 0, delta: { role: "assistant", content: "GO_HEADER_OK" } }] })}`,
      `data: ${JSON.stringify({ id: "chatcmpl_custom_relay", created: 21, model: record.body?.model || goModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8308, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } } })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  // Stand in for the official host. The endpoint stays configured as the real
  // https://opencode.ai URL; only this process's outbound socket is moved.
  const preload = path.join(root, "redirect-opencode-fetch.mjs");
  await writeFile(preload, `
const originalFetch = globalThis.fetch;
const upstream = process.env.MODELDOCK_TEST_GO_UPSTREAM;
globalThis.fetch = (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (raw.startsWith("https://opencode.ai/")) {
    const url = new URL(raw);
    return originalFetch(upstream + url.pathname + url.search, init);
  }
  return originalFetch(input, init);
};
`, "utf8");

  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\wire-go-custom-${process.pid}`;
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      OPENCODE_GO_TOKEN: "fixture-go-key",
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CUSTOM_ENDPOINTS_FILE: endpointFile,
      MODELDOCK_CODEX_HOME: path.join(root, "codex-home"),
      MODELDOCK_REQUIRE_CALLER_KEY: "0",
      MODELDOCK_MEMORY: "0",
      MODELDOCK_MODEL_DISCOVERY: "1",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey,
      MODELDOCK_AUTOSTART_NAME: `ModelDockWireGoCustom${process.pid}`,
      MODELDOCK_TEST_GO_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await stop(child);
    if (process.platform === "win32") {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* test key may not exist */ }
    }
  });
  await waitForStatus(gatewayPort);

  const addEndpoint = async (baseUrl, apiKey, modelId) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/api/custom/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey, modelId }),
    });
    const payload = await response.json().catch(() => ({}));
    assert.equal(response.status, 200, `adding ${modelId} failed: ${JSON.stringify(payload)}\n${stderr}`);
    return payload;
  };
  const posts = (pathName) => seen.filter((entry) => entry.method === "POST" && entry.path === pathName);
  let startupGoList = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    startupGoList = seen.find((entry) => entry.method === "GET" && entry.path === "/zen/go/v1/models");
    if (startupGoList) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(startupGoList, "the built-in Go provider must refresh its model directory on startup");
  assert.ok(startupGoList.session, "the built-in Go model-directory request must carry x-opencode-session");
  const publishedSlug = async (modelId) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const catalog = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)).json();
      const hit = catalog.models.find((item) => item.display_name === `Custom - ${modelId}`);
      if (hit) return hit.slug;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`custom model ${modelId} was never published to the Codex catalog`);
  };

  // The save probe against the configured official URL.
  const goAdd = await addEndpoint(OFFICIAL_GO_BASE, "fixture-go-key", goModel);
  assert.equal(goAdd.transport, "chat", "the Responses attempt must fall through to Chat");
  const goModelLists = seen.filter((entry) => entry.method === "GET" && entry.path === "/zen/go/v1/models");
  assert.equal(goModelLists.length, 2, "startup and Custom save must each read the Go model directory once");
  assert.ok(goModelLists.every((entry) => entry.session), "every Go model-directory request must carry x-opencode-session");
  const goProbeResponses = posts("/zen/go/v1/responses");
  const goProbeChat = posts("/zen/go/v1/chat/completions");
  assert.equal(goProbeResponses.length, 1, "the Go URL must be probed at /responses first");
  assert.equal(goProbeChat.length, 1, "the Chat fallback probe must reach the Go URL");
  assert.ok(
    goProbeResponses[0].session && goProbeResponses[0].session.trim(),
    "the save probe for the official Go URL must carry x-opencode-session",
  );
  assert.ok(
    goProbeChat[0].session && goProbeChat[0].session.trim(),
    "the Chat fallback probe for the official Go URL must carry x-opencode-session",
  );
  assert.equal(
    goProbeChat[0].session,
    goProbeResponses[0].session,
    "the save probe must use one stable session for the whole probe sequence",
  );

  // Negative control: an ordinary custom endpoint on the same mock, same probe.
  const plainAdd = await addEndpoint(`http://127.0.0.1:${upstreamPort}/v1`, "fixture-plain-key", plainModel);
  assert.equal(plainAdd.transport, "chat");
  const plainProbeResponses = posts("/v1/responses");
  const plainProbeChat = posts("/v1/chat/completions");
  const plainModelLists = seen.filter((entry) => entry.method === "GET" && entry.path === "/v1/models");
  assert.equal(plainModelLists.length, 1);
  assert.equal(plainModelLists[0].session, undefined,
    "an ordinary Custom model-directory request must not receive a Go session header");
  assert.equal(plainProbeResponses.length, 1);
  assert.equal(plainProbeChat.length, 1);
  assert.equal(plainProbeResponses[0].session, undefined, "an ordinary custom endpoint must not receive x-opencode-session");
  assert.equal(plainProbeChat[0].session, undefined, "an ordinary custom endpoint must not receive x-opencode-session");

  // The relayed turn: same caller headers, two endpoints, two different outcomes.
  const goSlug = await publishedSlug(goModel);
  const plainSlug = await publishedSlug(plainModel);
  const relay = (model) => fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", session_id: CALLER_SESSION },
    body: JSON.stringify({ ...fixture.request, model }),
  });

  const goRelay = await relay(goSlug);
  const goText = await goRelay.text();
  assert.equal(goRelay.status, 200, `the Go-URL custom model did not relay: ${goText}\n${stderr}`);
  assert.match(goText, /"type":"response.completed"/);
  const goRelayed = posts("/zen/go/v1/chat/completions").filter((entry) => entry.body?.stream === true);
  assert.equal(goRelayed.length, 1, "the Codex turn must reach the configured Go URL exactly once");
  assert.equal(goRelayed[0].authorization, "Bearer fixture-go-key");
  assert.equal(goRelayed[0].body.model, goModel);
  assert.equal(
    goRelayed[0].session,
    CALLER_SESSION,
    "the caller's session must be relayed to the official Go URL unchanged",
  );

  const plainRelay = await relay(plainSlug);
  const plainText = await plainRelay.text();
  assert.equal(plainRelay.status, 200, `the ordinary custom model did not relay: ${plainText}\n${stderr}`);
  assert.match(plainText, /"type":"response.completed"/);
  const plainRelayed = posts("/v1/chat/completions").filter((entry) => entry.body?.stream === true);
  assert.equal(plainRelayed.length, 1);
  assert.equal(
    plainRelayed[0].session,
    undefined,
    "an ordinary custom endpoint must stay free of x-opencode-session on the relay",
  );
});

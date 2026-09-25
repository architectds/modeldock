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
import { fileURLToPath } from "node:url";
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
    supportsVision: true,
  }]));
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\wire-custom-${process.pid}`;
  const child = spawn(process.execPath, [bundle], {
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
      MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey,
      MODELDOCK_AUTOSTART_NAME: `ModelDockWireCustom${process.pid}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stop(child));
  if (process.platform === "win32") {
    t.after(() => {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* test key may not exist */ }
    });
  }
  await waitForStatus(gatewayPort);

  const picker = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/models`)).json();
  assert.ok(picker.options.some((option) => option.id === `${modelId}@custom` && option.provider === "custom"),
    "the old named record must be visible under custom in the dashboard picker");
  const catalog = await (await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`)).json();
  const codexModel = catalog.models.find((item) => item.display_name === `Custom - ${modelId}`);
  assert.ok(codexModel, "the same model must be published in the Codex picker");
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
});

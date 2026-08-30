// Full Codex-to-ModelDock compatibility fixture.
//
// This is a sanitized original incoming Codex request, not a hand-authored
// representative subset. The test runs the built bundle as a child process and
// uses a strict xAI-shaped upstream so a schema drift fails at the same boundary
// a user hits. See the fixture's capture metadata for the exact redactions.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));
const XAI_TOOL_TYPES = new Set([
  "function", "web_search", "x_search", "image_generation", "collections_search",
  "file_search", "code_execution", "code_interpreter", "mcp", "shell",
]);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitForStatus(port) {
  let lastError = null;
  // This is a cold bundled gateway started beside the full test suite's other
  // process-heavy integration fixtures. Six seconds is sufficient in isolation
  // but flakes under parallel CI load before the child gets scheduled; waiting
  // longer changes no assertion and keeps a finite diagnostic deadline.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`built bundle did not start${lastError ? `: ${lastError.message}` : ""}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function closeServer(server) {
  // The bundle uses keep-alive for its strict upstream request. close() waits
  // for that idle socket, while this test's child shutdown runs separately and
  // can therefore leave the whole suite waiting forever during cleanup.
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => {
    if (error?.code === "ERR_SERVER_NOT_RUNNING") return resolve();
    if (error) return reject(error);
    resolve();
  }));
}

test("built bundle accepts the full original Codex xAI package after dialect normalization", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.capture.originalToolCount, 164);
  assert.equal(fixture.request.tools.length, 164, "the fixture must retain the complete Codex tool array");
  assert.deepEqual(Object.keys(fixture.request).sort(), fixture.capture.originalTopLevelFields);
  assert.equal(fixture.request.tools[163].type, "web_search");
  assert.equal(fixture.request.tools[163].external_web_access, true, "the real nested field that xAI rejected must stay in the fixture");

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-wire-xai-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  const autostartKey = `HKCU\\Software\\ModelDockTests\\full-wire-${process.pid}`;
  const autostartName = `ModelDockFullWire${process.pid}`;
  await mkdir(stateDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  if (process.platform === "win32") {
    t.after(() => {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* key may not exist */ }
    });
  }
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push(body);
    if (body.external_web_access !== undefined || (body.tools || []).some((tool) => tool?.external_web_access !== undefined)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Argument not supported: external_web_access" }));
      return;
    }
    const unsupported = (body.tools || []).find((tool) => !XAI_TOOL_TYPES.has(tool?.type));
    if (unsupported) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unknown tool type: ${unsupported.type}` }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      'data: {"type":"response.created","response":{"id":"resp_full_fixture","status":"in_progress","output":[]}}',
      'data: {"type":"response.completed","response":{"id":"resp_full_fixture","status":"completed","output":[]}}',
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  // The probe server only reserves a free port; do not leave it listening when
  // the bundle starts its own loopback server.
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const preload = path.join(root, "redirect-xai-fetch.mjs");
  writeFileSync(preload, `
const originalFetch = globalThis.fetch;
const target = process.env.MODELDOCK_TEST_XAI_UPSTREAM;
globalThis.fetch = (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (raw.startsWith("https://api.x.ai/v1/")) {
    const url = new URL(raw);
    return originalFetch(\`${"${target}"}\${url.pathname}\${url.search}\`, init);
  }
  return originalFetch(input, init);
};
`, "utf8");
  // Plaintext is intentional in this throwaway test state: readXaiAuth accepts
  // it for migration compatibility, while the real state writer encrypts it.
  writeFileSync(path.join(stateDir, "xai-auth.json"), JSON.stringify({
    accessToken: "fixture-token",
    refreshToken: "",
    expiresAt: Date.now() + 60 * 60 * 1000,
    models: ["grok-4.5", "grok-4.6"],
    connectedAt: new Date().toISOString(),
  }), "utf8");

  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "xai",
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CODEX_HOME: codexHome,
      MODELDOCK_REQUIRE_CALLER_KEY: "0",
      MODELDOCK_MEMORY: "0",
      MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey,
      MODELDOCK_AUTOSTART_NAME: autostartName,
      MODELDOCK_TEST_XAI_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stop(child));
  await waitForStatus(gatewayPort);

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixture.request),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `built bundle rejected the full package: ${text}\n${stderr}`);
  assert.equal(seen.length, 1, "the full package must reach the strict upstream exactly once");
  const outbound = seen[0];
  assert.equal(outbound.model, "grok-4.5", "the provider sees the unqualified upstream id");
  assert.equal(outbound.include, undefined, "xAI must not receive Codex's encrypted-content include option");
  assert.equal(outbound.tools.length, fixture.request.tools.length - 1, "a visual xAI model removes only the delegated vision tool");
  const outboundToolNames = new Set(outbound.tools.map((tool) => tool.name).filter(Boolean));
  assert.ok(outboundToolNames.has("view_image"), "the visual xAI model keeps direct image inspection");
  assert.equal(
    [...outboundToolNames].some((name) => name === "vision_inspect" || name.endsWith("__vision_inspect")),
    false,
    "the visual xAI model never receives the delegated vision tool",
  );

});

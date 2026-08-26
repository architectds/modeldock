// Exercise the release verifier's actual PowerShell lifecycle against current
// installer assets. The first installed process is deliberately tokenless:
// /healthz returns 503, but the owner + /api/status verifier must accept it.
// A later restart receives the deterministic local upstream and must then pass
// the provider-ready /healthz check and the stream probe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function run(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, output }));
  });
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("release verifier accepts a tokenless cold install before checking provider readiness", {
  skip: process.platform !== "win32" ? "Windows PowerShell lifecycle test" : false,
  timeout: 180_000,
}, async (t) => {
  const installer = readFileSync(path.join(repoRoot, "scripts", "install.ps1"));
  const bundle = readFileSync(path.join(repoRoot, "dist", "modeldock.mjs"));
  const bridge = readFileSync(path.join(repoRoot, "dist", "mcp-standalone.mjs"));
  const sums = Buffer.from([
    `${sha256(bundle)}  modeldock.mjs`,
    `${sha256(bridge)}  mcp-standalone.mjs`,
    "",
  ].join("\n"), "utf8");
  const assets = new Map([
    ["/install.ps1", { body: installer, type: "text/plain; charset=utf-8" }],
    ["/modeldock.mjs", { body: bundle, type: "application/octet-stream" }],
    ["/mcp-standalone.mjs", { body: bridge, type: "application/octet-stream" }],
    // GitHub serves this extension-less asset as octet-stream. Keep that
    // response shape here so this real installer path catches byte[] parsing.
    ["/SHA256SUMS", { body: sums, type: "application/octet-stream" }],
  ]);
  const requested = [];
  const assetServer = http.createServer((req, res) => {
    const asset = assets.get(new URL(req.url, "http://localhost").pathname);
    if (!asset) {
      res.writeHead(404).end();
      return;
    }
    requested.push(req.url);
    res.writeHead(200, { "content-type": asset.type, "content-length": asset.body.length });
    res.end(asset.body);
  });
  const assetPort = await listen(assetServer);
  const tempRoot = await mkdtemp(path.join(process.env.MODELDOCK_SANDBOX_DIR || os.tmpdir(), "modeldock-verify-release-"));
  t.after(async () => {
    assetServer.closeAllConnections?.();
    await new Promise((resolve) => assetServer.close(resolve));
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  const base = `http://127.0.0.1:${assetPort}`;
  const powershell = existsSync("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")
    ? "powershell.exe"
    : "pwsh.exe";
  const result = await run(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "scripts", "verify-release-install.ps1")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEMP: tempRoot,
      TMP: tempRoot,
      MODELDOCK_VERIFY_INSTALLER_URL: `${base}/install.ps1`,
      MODELDOCK_RELEASE_URL: `${base}/modeldock.mjs`,
      MODELDOCK_BRIDGE_URL: `${base}/mcp-standalone.mjs`,
      MODELDOCK_SUMS_URL: `${base}/SHA256SUMS`,
      MODELDOCK_NODE_PATH: process.execPath,
      MODELDOCK_PROFILE: "opencode-go",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.signal, null, result.output);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /tokenless gateway is running after install/, result.output);
  assert.match(result.output, /tokenless gateway is running after restart/, result.output);
  assert.match(result.output, /gateway provider-ready after stream-probe restart/, result.output);
  assert.match(result.output, /RELEASE_INSTALL_VERIFY_OK/, result.output);
  for (const pathname of assets.keys()) {
    assert.ok(requested.some((request) => request.startsWith(pathname)), `verifier did not request ${pathname}`);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inspectGateway, waitForGateway } from "../scripts/gateway-verifier.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

test("gateway verifier requires a fresh owner and the local ModelDock status shape", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-verify-root-"));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-verify-state-"));
  const server = http.createServer((req, res) => {
    if (req.url !== "/api/status") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ config: {}, runtime: {} }));
  });
  const port = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  const startedAfterMs = Date.now();
  writeFileSync(path.join(stateDir, `owner-${port}.json`), JSON.stringify({
    pid: process.pid,
    root,
    port,
    startedAt: new Date(startedAfterMs).toISOString(),
  }));

  const result = await waitForGateway({ root, stateDir, port, startedAfterMs, timeoutMs: 100, intervalMs: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.owner.pid, process.pid);
});

test("gateway verifier rejects a stale owner before trusting a listener", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-verify-root-"));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-verify-state-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  const port = 4097;
  writeFileSync(path.join(stateDir, `owner-${port}.json`), JSON.stringify({
    pid: process.pid,
    root,
    port,
    startedAt: new Date(1).toISOString(),
  }));
  const result = await inspectGateway({ root, stateDir, port, startedAfterMs: Date.now(), fetchImpl: async () => assert.fail("stale owner must not fetch") });
  assert.deepEqual(result, { ok: false, reason: "owner_stale" });
});

test("the standalone helper and built bundle both carry the migration verifier", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-verify-bundle-root-"));
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-verify-bundle-state-"));
  const server = http.createServer((req, res) => {
    if (req.url !== "/api/status") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ config: {}, runtime: {} }));
  });
  const port = await listen(server);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });
  writeFileSync(path.join(stateDir, `owner-${port}.json`), JSON.stringify({
    pid: process.pid,
    root,
    port,
    startedAt: new Date().toISOString(),
  }));

  for (const entry of [
    path.join(repoRoot, "scripts", "gateway-verifier.mjs"),
    path.join(repoRoot, "dist", "modeldock.mjs"),
  ]) {
    const child = spawn(process.execPath, [
      entry, "--verify-gateway",
      "--root", root, "--port", String(port), "--state-dir", stateDir, "--timeout-ms", "500",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, `${entry}: ${output}`);
    assert.match(output, /Gateway verified/);
  }
});

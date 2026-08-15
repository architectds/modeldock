import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  for (let index = 0; index < 40; index += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return true;
    } catch {
      // Still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("restart.ps1 refuses a live foreign listener when the owner record is missing", async (t) => {
  if (process.platform !== "win32") {
    t.skip("restart.ps1 is Windows-only");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-restart-ps1-"));
  const stateDir = path.join(root, ".state");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const port = await reservePort();
  writeFileSync(path.join(root, ".env"), `MODELDOCK_PORT=${port}\n`, "utf8");
  writeFileSync(path.join(root, "scripts", "restart.ps1"), readFileSync(path.join(repoRoot, "scripts", "restart.ps1")), "utf8");
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "process.exit(0);\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const foreign = spawn(process.execPath, ["--input-type=module", "-e", `
import http from "node:http";
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, foreign: true }));
}).listen(Number(process.env.MODELDOCK_PORT), "127.0.0.1");
`], { env: { ...process.env, MODELDOCK_PORT: String(port) }, stdio: "ignore" });
  t.after(() => foreign.kill("SIGKILL"));
  assert.equal(await waitForHealth(port), true, "foreign listener should start");

  const restart = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "restart.ps1")], {
    env: {
      ...process.env,
      MODELDOCK_PORT: String(port),
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_NODE_PATH: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  restart.stdout.on("data", (chunk) => (output += chunk));
  restart.stderr.on("data", (chunk) => (output += chunk));
  const exitCode = await new Promise((resolve) => restart.on("close", resolve));
  assert.equal(exitCode, 2, output);
  assert.match(output, /ownership could not be verified|owner record is missing/i);
  assert.equal(await waitForHealth(port), true, "foreign listener must survive the refused restart");
});

test("restart.ps1 rebuilds a stale bundle (src newer than dist) before starting", async (t) => {
  if (process.platform !== "win32") {
    t.skip("restart.ps1 is Windows-only");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-restart-build-"));
  const stateDir = path.join(root, ".state");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const port = await reservePort();
  t.after(async () => {
    try {
      const started = path.join(root, "started.txt");
      if (existsSync(started)) {
        const pid = Number(readFileSync(started, "utf8"));
        if (pid > 0) process.kill(pid, "SIGKILL");
      }
    } catch {
      // Best-effort cleanup; the temp install dir is still removed below.
    }
    // The cmd.exe wrapper that restarts the gateway can hold modeldock.log for
    // a moment after the node process exits; wait once, then retry the removal
    // so a lingering handle never leaks a temp dir.
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  writeFileSync(path.join(root, ".env"), `MODELDOCK_PORT=${port}\n`, "utf8");
  writeFileSync(
    path.join(root, "scripts", "restart.ps1"),
    readFileSync(path.join(repoRoot, "scripts", "restart.ps1")),
    "utf8",
  );
  // src is the newest input, so the launcher must run build-if-stale before the
  // bundle is served. The fake helper records that it ran.
  writeFileSync(path.join(root, "src", "server.mjs"), "export const x = 1;\n", "utf8");
  writeFileSync(
    path.join(root, "scripts", "build-if-stale.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(path.join(root, "rebuilt.txt"))}, "1");\n`,
    "utf8",
  );
  // The fake bundle answers /healthz and records its pid for cleanup.
  writeFileSync(
    path.join(root, "dist", "modeldock.mjs"),
    `import http from "node:http";
import { writeFileSync } from "node:fs";
const port = Number(process.env.MODELDOCK_PORT);
writeFileSync(${JSON.stringify(path.join(root, "started.txt"))}, String(process.pid));
http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`,
    "utf8",
  );

  const restart = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "restart.ps1")], {
    env: {
      ...process.env,
      MODELDOCK_PORT: String(port),
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_NODE_PATH: process.execPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  restart.stdout.on("data", (chunk) => (output += chunk));
  restart.stderr.on("data", (chunk) => (output += chunk));
  const exitCode = await new Promise((resolve) => restart.on("close", resolve));
  assert.equal(exitCode, 0, output);
  assert.match(output, /gateway healthy/);
  assert.equal(
    existsSync(path.join(root, "rebuilt.txt")),
    true,
    "restart.ps1 must rebuild a stale bundle (src newer than dist) before launching",
  );
  assert.equal(await waitForHealth(port), true, "the gateway should answer healthz after the rebuild");
});

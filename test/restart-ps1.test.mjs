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
  writeFileSync(path.join(root, "scripts", "gateway-verifier.mjs"), readFileSync(path.join(repoRoot, "scripts", "gateway-verifier.mjs")), "utf8");
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
  writeFileSync(
    path.join(root, "scripts", "gateway-verifier.mjs"),
    readFileSync(path.join(repoRoot, "scripts", "gateway-verifier.mjs")),
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
  // This deliberately models a prior released bundle: it has no verifier CLI
  // at all. The current lifecycle helper must validate its fresh owner and
  // /api/status without requiring the bundle to understand a new argument.
  writeFileSync(
    path.join(root, "dist", "modeldock.mjs"),
    `import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
const port = Number(process.env.MODELDOCK_PORT);
const stateDir = process.env.MODELDOCK_STATE_DIR;
const ownerFile = path.join(stateDir, \`owner-\${port}.json\`);
writeFileSync(${JSON.stringify(path.join(root, "started.txt"))}, String(process.pid));
writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, root: ${JSON.stringify(root)}, port, startedAt: new Date().toISOString() }));
http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ config: {}, runtime: {} }));
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
  assert.match(output, /verified gateway/);
  assert.equal(
    existsSync(path.join(root, "rebuilt.txt")),
    true,
    "restart.ps1 must rebuild a stale bundle (src newer than dist) before launching",
  );
  // The verifier has already confirmed readiness, but wait for the marker too
  // so cleanup can kill the exact fake child it launched.
  const started = path.join(root, "started.txt");
  for (let i = 0; i < 40 && !existsSync(started); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(existsSync(started), "the fake gateway should record its pid after the rebuild");
});

test("restart.ps1 checkpoints managed local state before replacing its gateway", async (t) => {
  if (process.platform !== "win32") {
    t.skip("restart.ps1 is Windows-only");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-restart-checkpoint-"));
  const stateDir = path.join(root, ".state");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const port = await reservePort();
  const entry = path.join(root, "dist", "modeldock.mjs");
  const ownerFile = path.join(stateDir, `owner-${port}.json`);
  const checkpointFile = path.join(stateDir, "checkpointed.txt");
  const callerKey = "test-restart-checkpoint-key-0123456789";
  t.after(async () => {
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
      if (Number(owner.pid) > 0) process.kill(Number(owner.pid), "SIGKILL");
    } catch {
      // The fake replacement may already have exited.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  writeFileSync(path.join(root, ".env"), `MODELDOCK_PORT=${port}\n`, "utf8");
  writeFileSync(path.join(stateDir, "caller-key"), `${callerKey}\n`, "utf8");
  writeFileSync(path.join(root, "scripts", "restart.ps1"), readFileSync(path.join(repoRoot, "scripts", "restart.ps1")), "utf8");
  writeFileSync(path.join(root, "scripts", "gateway-verifier.mjs"), readFileSync(path.join(repoRoot, "scripts", "gateway-verifier.mjs")), "utf8");
  writeFileSync(entry, `
import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const port = Number(process.env.MODELDOCK_PORT);
const stateDir = process.env.MODELDOCK_STATE_DIR;
mkdirSync(stateDir, { recursive: true });
writeFileSync(path.join(stateDir, \`owner-\${port}.json\`), JSON.stringify({ pid: process.pid, root: ${JSON.stringify(root)}, port, startedAt: new Date().toISOString() }));
http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; }
  if (req.url === "/api/status") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ config: {}, runtime: {} })); return; }
  if (req.url === "/api/local/restart-checkpoint" && req.method === "POST") {
    writeFileSync(path.join(stateDir, "checkpointed.txt"), String(req.headers["x-modeldock-key"] || ""));
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ managed: true, saved: 1 })); return;
  }
  if (req.url === "/api/local/restart-checkpoint/release" && req.method === "POST") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ released: true })); return; }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`, "utf8");
  const old = spawn(process.execPath, [entry], {
    env: { ...process.env, MODELDOCK_PORT: String(port), MODELDOCK_STATE_DIR: stateDir }, stdio: "ignore",
  });
  t.after(() => old.kill("SIGKILL"));
  assert.equal(await waitForHealth(port), true, "the original fake gateway should serve before restart");
  const restart = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "restart.ps1"), "-Force"], {
    env: { ...process.env, MODELDOCK_PORT: String(port), MODELDOCK_STATE_DIR: stateDir, MODELDOCK_NODE_PATH: process.execPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  restart.stdout.on("data", (chunk) => { output += chunk; });
  restart.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => restart.on("close", resolve));
  assert.equal(code, 0, output);
  assert.equal(readFileSync(checkpointFile, "utf8"), callerKey, "the old gateway received the protected checkpoint request before it was stopped");
  assert.equal(await waitForHealth(port), true, "the verified replacement should remain serving");
});

// Regression: the stop phase used to run under the script-wide
// $ErrorActionPreference = "Stop", so a Stop-Process failure aborted the script
// before it ever reached Start-Process. The updater spawns this script with
// stdio discarded, so that surfaced only as a dashboard spinner that ran its
// full 120s timeout. A refusal must now name the reason and leave the old
// gateway serving rather than dying silently between stop and start.
test("restart.ps1 reports an unstoppable gateway instead of exiting silently", async (t) => {
  if (process.platform !== "win32") {
    t.skip("restart.ps1 is Windows-only");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-restart-denied-"));
  const stateDir = path.join(root, ".state");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const port = await reservePort();
  const server = createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => setTimeout(resolve, 500));
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });
  writeFileSync(path.join(root, ".env"), `MODELDOCK_PORT=${port}\n`, "utf8");
  writeFileSync(
    path.join(root, "scripts", "restart.ps1"),
    readFileSync(path.join(repoRoot, "scripts", "restart.ps1")),
    "utf8",
  );
  writeFileSync(
    path.join(root, "scripts", "gateway-verifier.mjs"),
    readFileSync(path.join(repoRoot, "scripts", "gateway-verifier.mjs")),
    "utf8",
  );
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "// never started\n", "utf8");
  // The listener is this test process, which is neither a gateway from this
  // install nor the recorded owner, so the guard refuses without -Force.
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
  restart.stdout.on("data", (chunk) => { output += chunk; });
  restart.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => restart.on("exit", resolve));

  assert.notEqual(code, 0, "a refused restart must exit non-zero");
  assert.match(output, /refusing to stop/i, "the refusal states why it stopped");
  // The decisive part: the old listener is still answering. A silent abort
  // between stop and start is what left users with no gateway at all.
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.ok, true, "the existing listener must survive a refused restart");
});

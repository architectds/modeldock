import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitForHealth(port, expectedMarker) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      const payload = await res.json();
      if (payload.ok && (!expectedMarker || payload.marker === expectedMarker)) return payload;
    } catch {
      // Still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

test("restart.sh stops the owned listener and starts a healthy POSIX gateway", async (t) => {
  if (process.platform === "win32") {
    t.skip("restart.sh is POSIX-only");
    return;
  }

  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-restart-sh-"));
  const stateDir = path.join(root, ".state");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(path.join(root, ".env"), `MODELDOCK_PORT=${port}\n`, "utf8");
  writeFileSync(path.join(root, "scripts", "restart.sh"), readFileSync(path.join(repoRoot, "scripts", "restart.sh")), { mode: 0o755 });
  const bundlePath = path.join(root, "dist", "modeldock.mjs");
  writeFileSync(
    bundlePath,
    `import http from "node:http";
const port = Number(process.env.MODELDOCK_PORT);
http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker: "old", pid: process.pid }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`,
    "utf8",
  );

  const old = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, MODELDOCK_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => old.kill("SIGKILL"));
  const oldHealth = await waitForHealth(port, "old");
  assert.ok(oldHealth, "old gateway should start for the restart test");

  // Replace the on-disk entry only after the old process loaded it. The command
  // line still identifies the exact owned bundle while restart launches this
  // new content from the same path.
  writeFileSync(
    bundlePath,
    `import http from "node:http";
import { writeFileSync } from "node:fs";
const port = Number(process.env.MODELDOCK_PORT || ${port});
writeFileSync(${JSON.stringify(path.join(root, "started.txt"))}, String(process.pid));
http.createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker: "new", pid: process.pid }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, "127.0.0.1");
`,
    "utf8",
  );

  writeFileSync(
    path.join(stateDir, `owner-${port}.json`),
    `${JSON.stringify({ pid: old.pid, root, port }, null, 2)}\n`,
    "utf8",
  );

  const child = spawn("sh", [path.join(root, "scripts", "restart.sh")], {
    env: { ...process.env, MODELDOCK_PORT: String(port), MODELDOCK_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `restart.sh failed\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(out + err, /restart\.sh: started gateway/);
  try {
    const newPid = Number(readFileSync(path.join(root, "started.txt"), "utf8"));
    if (newPid > 0) process.kill(newPid, "SIGKILL");
  } catch {
    // Best-effort cleanup; the temp install dir is still removed by t.after.
  }
});

test("restart.sh refuses a live foreign listener when the owner record is missing", async (t) => {
  if (process.platform === "win32") {
    t.skip("restart.sh is POSIX-only");
    return;
  }
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-restart-foreign-"));
  const stateDir = path.join(root, ".state");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(root, ".env"), `MODELDOCK_PORT=${port}\n`, "utf8");
  writeFileSync(path.join(root, "scripts", "restart.sh"), readFileSync(path.join(repoRoot, "scripts", "restart.sh")), { mode: 0o755 });
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "process.exit(0);\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const foreign = spawn(process.execPath, ["--input-type=module", "-e", `
import http from "node:http";
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, marker: "foreign" }));
}).listen(Number(process.env.MODELDOCK_PORT), "127.0.0.1");
`], { env: { ...process.env, MODELDOCK_PORT: String(port) }, stdio: "ignore" });
  t.after(() => foreign.kill("SIGKILL"));
  assert.ok(await waitForHealth(port, "foreign"));
  const child = spawn("sh", [path.join(root, "scripts", "restart.sh")], {
    env: { ...process.env, MODELDOCK_PORT: String(port), MODELDOCK_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 2, output);
  assert.match(output, /ownership could not be verified|owner record is missing/i);
  assert.ok(await waitForHealth(port, "foreign"), "foreign listener must survive the refused restart");
});

test("restart.sh proceeds when the owner record is stale but the listener runs this install", async (t) => {
  if (process.platform === "win32") {
    t.skip("restart.sh is POSIX-only");
    return;
  }
  // A restart must never be blocked by a stale owner file: a crash, a manual
  // start, or a sibling that died with EADDRINUSE can leave owner-<port>.json
  // pointing at a dead pid while this install's own gateway keeps serving.
  // The command line is the ground truth, so the restart proceeds and the new
  // gateway takes over.
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-restart-stale-"));
  const stateDir = path.join(root, ".state");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, ".env"), `MODELDOCK_PORT=${port}\n`, "utf8");
  writeFileSync(path.join(root, "scripts", "restart.sh"), readFileSync(path.join(repoRoot, "scripts", "restart.sh")), { mode: 0o755 });
  const bundlePath = path.join(root, "dist", "modeldock.mjs");
  writeFileSync(
    bundlePath,
    `import http from "node:http";
const port = Number(process.env.MODELDOCK_PORT);
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, marker: "old", pid: process.pid }));
}).listen(port, "127.0.0.1");
`,
    "utf8",
  );
  const old = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, MODELDOCK_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => old.kill("SIGKILL"));
  assert.ok(await waitForHealth(port, "old"), "old gateway should start for the stale-owner test");

  // The recorded owner is a genuinely dead pid: spawn a throwaway child, let it
  // write its pid, then kill it - the exact state found on a live install after
  // a crashed second start clobbered the owner file. The real listener is this
  // install's own bundle.
  const deadOwner = spawn("sleep", ["300"], { stdio: "ignore" });
  const deadPid = deadOwner.pid;
  deadOwner.kill("SIGKILL");
  await new Promise((resolve) => deadOwner.on("close", resolve));
  writeFileSync(
    path.join(stateDir, `owner-${port}.json`),
    `${JSON.stringify({ pid: deadPid, root, port }, null, 2)}\n`,
    "utf8",
  );

  const child = spawn("sh", [path.join(root, "scripts", "restart.sh")], {
    env: { ...process.env, MODELDOCK_PORT: String(port), MODELDOCK_STATE_DIR: stateDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `stale-owner restart should succeed\nstdout:\n${out}\nstderr:\n${err}`);
  assert.match(out + err, /restart\.sh: started gateway/);
});

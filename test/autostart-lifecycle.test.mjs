import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plistXml } from "../src/autostart.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The macOS plist is the contract that launchd uses to keep the gateway alive:
// ProgramArguments must be exactly [node, server], RunAtLoad must be true, and
// KeepAlive must be present. A real mac is the only place launchd itself runs,
// but its core semantics - parse the plist, launch the command, wait for health,
// relaunch after the process dies - can be exercised on any platform against the
// real gateway. This test stands in for that loop so CI catches a broken plist,
// a missing entry, or a gateway that no longer boots.
function parseProgramArguments(xml) {
  const block = xml.split("<key>ProgramArguments</key>")[1].split("</array>")[0];
  const strings = [...block.matchAll(/<string>(.*?)<\/string>/g)].map((match) =>
    match[1]
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&apos;", "'"),
  );
  assert.equal(strings.length, 2, "ProgramArguments should be exactly [node, server]");
  return strings;
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/healthz", timeout: 2000 }, (res) => {
      res.resume();
      res.on("end", () => {
        // Any HTTP response proves the gateway is up and listening. A 503 is
        // normal on a token-less CI runner (upstreams unconfigured); this test
        // is about plist launch/relaunch liveness, not provider auth.
        resolve(true);
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitHealthy(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await fetchHealth(port)) return resolve(true);
      if (Date.now() > deadline) return reject(new Error(`gateway did not become healthy on port ${port}`));
      setTimeout(poll, 300);
    };
    poll();
  });
}

test("macOS plist lifecycle: launch, healthy, kill, relaunch", async (t) => {
  const bundle = path.join(repoRoot, "dist", "modeldock.mjs");
  const serverEntry = existsSync(bundle) ? bundle : path.join(repoRoot, "src", "server.mjs");
  const xml = plistXml(process.execPath, serverEntry, repoRoot);

  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/, "plist should load at login");
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/, "plist should keep the gateway alive");
  assert.match(xml, /<key>ThrottleInterval<\/key><integer>10<\/integer>/, "plist should throttle crash loops");

  const [nodeBin, entry] = parseProgramArguments(xml);
  assert.equal(nodeBin, process.execPath, "plist should run the same node that generated it");
  assert.equal(entry, serverEntry, "plist should point at the gateway entry");

  const port = await freePort();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-autostart-lifecycle-"));
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    MODELDOCK_PORT: String(port),
    MODELDOCK_STATE_DIR: stateDir,
    MODELDOCK_MODEL_DISCOVERY: "0",
  };

  function launch() {
    return spawn(nodeBin, [entry], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  }

  const first = launch();
  const firstStderr = [];
  first.stderr.on("data", (chunk) => firstStderr.push(chunk.toString()));
  let firstError = "";
  first.on("error", (error) => (firstError = error.message));
  t.after(() => first.kill());
  try {
    await waitHealthy(port);
  } catch (error) {
    error.message += `\nfirst spawn error: ${firstError || "none"}\nfirst stderr:\n${firstStderr.join("")}`;
    throw error;
  }
  assert.ok(first.pid, "first launch should have a pid");

  // Simulate a crash: launchd sees the process exit and, with KeepAlive, runs
  // the same command again. The gateway must come back healthy with a new pid.
  first.kill();
  await new Promise((resolve) => first.once("exit", resolve));
  const second = launch();
  const secondStderr = [];
  second.stderr.on("data", (chunk) => secondStderr.push(chunk.toString()));
  t.after(() => second.kill());
  try {
    await waitHealthy(port);
  } catch (error) {
    error.message += `\nfirst stderr:\n${firstStderr.join("")}\nsecond stderr:\n${secondStderr.join("")}`;
    throw error;
  }
  assert.ok(second.pid, "relaunch should have a pid");
  assert.notEqual(second.pid, first.pid, "KeepAlive relaunch should be a fresh process");
  second.kill();
});

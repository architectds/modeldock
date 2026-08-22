import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function wslAvailable() {
  try {
    const out = execFileSync("wsl", ["-l", "-q"], { encoding: "utf8", timeout: 15_000 });
    return out.replace(/\u0000/g, "").trim().length > 0;
  } catch {
    return false;
  }
}

// wsl.exe mangles backslashes when forwarding arguments, so convert the well-known
// C:\... temp layout to /mnt/c/... directly instead of shelling out to wslpath.
function toWslPath(winPath) {
  const drive = winPath[0].toLowerCase();
  return `/mnt/${drive}/${winPath.slice(3).replace(/\\/g, "/")}`;
}

// The macOS branch of install.sh only runs when `uname -s` says Darwin and it
// shells out to launchctl. A fake PATH of uname/launchctl/node lets any POSIX
// host (WSL included) exercise that exact branch deterministically: the plist is
// written to a throwaway dir, launchctl calls are recorded, and the fake node
// makes the launcher exit instantly so no real gateway starts in the sandbox.
function writeFakeMacTools(binDir) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "uname"),
    "#!/bin/sh\ncase \"$1\" in -m) echo arm64 ;; *) echo Darwin ;; esac\n",
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(binDir, "launchctl"),
    "#!/bin/sh\necho \"$*\" >> \"$MODELDOCK_FAKE_LAUNCHCTL_LOG\"\nexit 0\n",
    { mode: 0o755 },
  );
  writeFileSync(path.join(binDir, "node"), "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then echo v24.5.0; fi\nexit 0\n", { mode: 0o755 });
}

// Env shared by the install.sh sandbox. `fakeBin` must already exist and be
// executable on the POSIX side before install.sh runs.
function sandboxEnv({ root, fakeBin, launchctlLog, releaseUrl, bridgeUrl, helperUrl, sumsUrl, port }) {
  return {
    MODELDOCK_ROOT: root,
    MODELDOCK_STATE_DIR: `${root}/.modeldock`,
    MODELDOCK_AUTOSTART_PLIST_DIR: `${root}/LaunchAgents`,
    MODELDOCK_RELEASE_URL: releaseUrl,
    MODELDOCK_BRIDGE_URL: bridgeUrl,
    MODELDOCK_STT_HELPER_URL: helperUrl,
    MODELDOCK_SUMS_URL: sumsUrl,
    MODELDOCK_CODEX_HOME: `${root}/codex-home`,
    MODELDOCK_SKIP_OPEN: "1",
    MODELDOCK_PORT: String(port),
    MODELDOCK_NODE_PATH: `${fakeBin}/node`,
    MODELDOCK_FAKE_LAUNCHCTL_LOG: launchctlLog,
    PATH: `${fakeBin}:/usr/bin:/bin`,
  };
}

test("install.sh macOS branch: plist, launchctl, marker (WSL or direct)", async (t) => {
  if (isWindows && !wslAvailable()) {
    t.skip("WSL is required on Windows to model macOS install behavior");
    return;
  }

  const bundle = readFileSync(path.join(repoRoot, "dist", "modeldock.mjs"));
  const bridge = readFileSync(path.join(repoRoot, "dist", "mcp-standalone.mjs"));
  const helper = Buffer.from("mac stt helper fixture");
  const assetServer = createServer((req, res) => {
    let data = null;
    if (req.url === "/modeldock.mjs") data = bundle;
    else if (req.url === "/mcp-standalone.mjs") data = bridge;
    else if (req.url === "/modeldock-stt-helper") data = helper;
    else if (req.url === "/SHA256SUMS") {
      data = Buffer.from(
          `${createHash("sha256").update(bundle).digest("hex")}  modeldock.mjs\n` +
          `${createHash("sha256").update(bridge).digest("hex")}  mcp-standalone.mjs\n` +
          `${createHash("sha256").update(helper).digest("hex")}  modeldock-stt-helper\n`,
      );
    }
    if (!data) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": data.length });
    res.end(data);
  });
  const assetPort = await listen(assetServer);
  t.after(() => assetServer.close());

  const installDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-macos-sim-"));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));
  const fakeBin = path.join(installDir, "fakebin");
  writeFakeMacTools(fakeBin);
  const launchctlLog = path.join(installDir, "launchctl.log");
  const installer = path.join(repoRoot, "scripts", "install.sh");
  const releaseUrl = `http://127.0.0.1:${assetPort}/modeldock.mjs`;
  const bridgeUrl = `http://127.0.0.1:${assetPort}/mcp-standalone.mjs`;
  const helperUrl = `http://127.0.0.1:${assetPort}/modeldock-stt-helper`;
  const sumsUrl = `http://127.0.0.1:${assetPort}/SHA256SUMS`;
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  let exitCode;
  let out = "";
  let err = "";
  const env = isWindows
    ? undefined
    : { ...process.env, ...sandboxEnv({ root: installDir, fakeBin, launchctlLog, releaseUrl, bridgeUrl, helperUrl, sumsUrl, port: appPort }) };
  if (isWindows) {
    // Drive install.sh from inside WSL: the sandbox dir is on the Windows side,
    // and the fake node/uname/launchctl shims live there too. The runner script
    // fixes POSIX permissions (NTFS cannot store +x) then runs the real installer.
    const wslRoot = toWslPath(installDir);
    const wslFakeBin = toWslPath(fakeBin);
    const wslLaunchctlLog = toWslPath(launchctlLog);
    const wslInstaller = toWslPath(installer);
    const runner = path.join(installDir, "run-macos-sim.sh");
    const env = sandboxEnv({
      root: wslRoot,
      fakeBin: wslFakeBin,
      launchctlLog: wslLaunchctlLog,
      releaseUrl,
      bridgeUrl,
      helperUrl,
      sumsUrl,
      port: appPort,
    });
    const lines = [
      "#!/bin/sh",
      "set -eu",
      `chmod +x '${wslFakeBin}/uname' '${wslFakeBin}/launchctl' '${wslFakeBin}/node'`,
      ...Object.entries(env).map(([key, value]) => `export ${key}='${value}'`),
      `exec sh '${wslInstaller}'`,
    ];
    writeFileSync(runner, `${lines.join("\n")}\n`, "utf8");
    const child = spawn("wsl", ["bash", toWslPath(runner)], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    exitCode = await new Promise((resolve) => child.on("close", resolve));
  } else {
    const child = spawn("sh", [installer], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    exitCode = await new Promise((resolve) => child.on("close", resolve));
  }
  assert.equal(exitCode, 0, `install.sh failed:\n${out}\n${err}`);
  assert.match(out, /start at login enabled/, `installer should report the default autostart\n${out}`);

  const plist = path.join(installDir, "LaunchAgents", "com.modeldock.gateway.plist");
  assert.ok(existsSync(plist), "plist should be written to the redirectable LaunchAgents dir");
  const plistText = readFileSync(plist, "utf8");
  assert.match(plistText, /<key>RunAtLoad<\/key><true\/>/, "plist should load at login");
  assert.match(plistText, /dist\/modeldock\.mjs/, "plist should launch the installed bundle directly");
  assert.match(plistText, /<key>KeepAlive<\/key><true\/>/, "plist should keep the gateway alive");
  assert.match(plistText, /<key>ThrottleInterval<\/key><integer>10<\/integer>/, "plist should throttle crash-loop restarts");
  assert.ok(plistText.includes("<key>MODELDOCK_NODE_PATH</key>"), "plist should pin the node binary");
  assert.match(plistText, /\/opt\/homebrew\/bin/, "plist should keep the launchd-safe PATH");

  assert.ok(existsSync(launchctlLog), "launchctl log should be written");
  const launchctlCalls = readFileSync(launchctlLog, "utf8");
  assert.match(launchctlCalls, /load -w/, `launchctl should load the plist: ${launchctlCalls}`);
  assert.ok(launchctlCalls.includes("com.modeldock.gateway.plist"), "launchctl should target our plist");

  // Runtime-only migration must preserve the installed bundle while refreshing
  // launchd so the existing bridge restarts on the selected Node 24 binary.
  const bundleBeforeRuntimeMigration = readFileSync(path.join(installDir, "dist", "modeldock.mjs"));
  const runtimeLoadCountBefore = (readFileSync(launchctlLog, "utf8").match(/load -w/g) || []).length;
  let runtimeExit;
  let runtimeOut = "";
  let runtimeErr = "";
  if (isWindows) {
    const wslRoot = toWslPath(installDir);
    const wslFakeBin = toWslPath(fakeBin);
    const runtimeEnv = {
      ...sandboxEnv({
        root: wslRoot,
        fakeBin: wslFakeBin,
        launchctlLog: toWslPath(launchctlLog),
        releaseUrl,
        bridgeUrl,
        helperUrl,
        sumsUrl,
        port: appPort,
      }),
      MODELDOCK_RUNTIME_ONLY: "1",
    };
    const runner = path.join(installDir, "run-macos-runtime-only.sh");
    const lines = [
      "#!/bin/sh",
      "set -eu",
      `chmod +x '${wslFakeBin}/uname' '${wslFakeBin}/launchctl' '${wslFakeBin}/node'`,
      ...Object.entries(runtimeEnv).map(([key, value]) => `export ${key}='${value}'`),
      `exec sh '${toWslPath(installer)}'`,
    ];
    writeFileSync(runner, `${lines.join("\n")}\n`, "utf8");
    const child = spawn("wsl", ["bash", toWslPath(runner)], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (runtimeOut += d));
    child.stderr.on("data", (d) => (runtimeErr += d));
    runtimeExit = await new Promise((resolve) => child.on("close", resolve));
  } else {
    const child = spawn("sh", [installer], {
      env: { ...env, MODELDOCK_RUNTIME_ONLY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => (runtimeOut += d));
    child.stderr.on("data", (d) => (runtimeErr += d));
    runtimeExit = await new Promise((resolve) => child.on("close", resolve));
  }
  assert.equal(runtimeExit, 0, `runtime-only install.sh failed:\n${runtimeOut}\n${runtimeErr}`);
  assert.deepEqual(
    readFileSync(path.join(installDir, "dist", "modeldock.mjs")),
    bundleBeforeRuntimeMigration,
    "runtime-only migration must not replace the installed bundle",
  );
  const runtimeLaunchctlCalls = readFileSync(launchctlLog, "utf8");
  const runtimeLoadCountAfter = (runtimeLaunchctlCalls.match(/load -w/g) || []).length;
  assert.equal(runtimeLoadCountAfter, runtimeLoadCountBefore + 1, "runtime-only migration should reload launchd once");
  const expectedPlistNode = isWindows ? `${toWslPath(fakeBin)}/node` : `${fakeBin}/node`;
  assert.ok(readFileSync(plist, "utf8").includes(expectedPlistNode),
    "runtime-only migration should keep the selected Node binary in the plist");

  assert.ok(existsSync(path.join(installDir, ".modeldock", "autostart-initialized")), "installer should record the decision marker");
  const installedHelper = path.join(installDir, "dist", "modeldock-stt-helper");
  assert.ok(existsSync(installedHelper), "macOS install should include the verified STT helper");
  if (!isWindows) {
    assert.ok((statSync(installedHelper).mode & 0o111) !== 0, "macOS STT helper must stay executable");
  }

  // Reinstall with the decision marker already present: start at login must be
  // (re-)enabled on every install, not only on a first install.
  if (!isWindows) {
    const loadCountBefore = (readFileSync(launchctlLog, "utf8").match(/load -w/g) || []).length;
    let out2 = "";
    let err2 = "";
    const child2 = spawn("sh", [installer], { env, stdio: ["ignore", "pipe", "pipe"] });
    child2.stdout.on("data", (d) => (out2 += d));
    child2.stderr.on("data", (d) => (err2 += d));
    const exit2 = await new Promise((resolve) => child2.on("close", resolve));
    assert.equal(exit2, 0, `second install.sh failed:\n${out2}\n${err2}`);
    assert.match(out2, /start at login enabled/, `reinstall should re-enable start at login\n${out2}`);
    const launchctlCalls2 = readFileSync(launchctlLog, "utf8");
    const loadCountAfter = (launchctlCalls2.match(/load -w/g) || []).length;
    assert.equal(loadCountAfter, loadCountBefore + 1, "reinstall should load the plist again");
    assert.ok(existsSync(plist), "reinstall should keep the plist in place");
  }
  for (const file of [
    path.join(installDir, "dist", "modeldock.mjs"),
    path.join(installDir, "dist", "mcp-standalone.mjs"),
    path.join(installDir, "dist", "modeldock-stt-helper"),
    path.join(installDir, "scripts", "start-hidden.sh"),
    path.join(installDir, "scripts", "restart.ps1"),
    path.join(installDir, "scripts", "restart.sh"),
    path.join(installDir, "scripts", "recover.sh"),
  ]) {
    assert.ok(existsSync(file), `${path.basename(file)} should be laid out by the installer`);
  }
  // The content-to-video skill is not mirrored by the installer anymore; only a
  // manual copy from the repo supplies it, so the install must not create it.
  assert.equal(
    existsSync(path.join(installDir, "codex-home", "skills", "content-to-video")),
    false,
    "the installer no longer downloads content-to-video",
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyFileSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ownerFilePath } from "../src/instance-owner.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Windows executes scripts/install.ps1 (via powershell); macOS/Linux execute
// scripts/install.sh (via sh). Each platform gets a real end-to-end mock install.
const isWindows = process.platform === "win32";
const installerScript = isWindows ? "install.ps1" : "install.sh";
const uninstallScript = isWindows ? "uninstall.ps1" : "uninstall.sh";
const launcherName = isWindows ? "start-hidden.ps1" : "start-hidden.sh";
const runInstaller = (installer, env) =>
  isWindows
    ? spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installer], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("sh", [installer], { env, stdio: ["ignore", "pipe", "pipe"] });
const runUninstall = (installer, env) => runInstaller(installer, env);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function fetchText(url) {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, text };
}

// The gateway persists its caller key inside MODELDOCK_STATE_DIR (default
// ~/.modeldock/caller-key); the mock install redirects the state dir into its
// throwaway root. The managed Codex config routes through /c/<key>/v1, so the
// routing probe uses the keyed URL built from that same key file.
function readCallerKey(stateDir) {
  const keyFile = path.join(stateDir, "caller-key");
  try {
    const key = readFileSync(keyFile, "utf8").trim();
    return /^[A-Za-z0-9_-]{32,}$/.test(key) ? key : "";
  } catch {
    return "";
  }
}

async function relayProbe(port, callerKey) {
  const prefix = callerKey ? `/c/${callerKey}` : "";
  return fetch(`http://127.0.0.1:${port}${prefix}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
    }),
  });
}

async function waitForHealth(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      return { up: true, status: res.status };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { up: false, status: 0 };
}

// Streamable-HTTP MCP client used against the installed gateway (same call shape
// Codex uses when mcpTransport=url, and what the stdio bridge forwards to).
async function rpcMcp(url, method, params) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      try {
        return { status: res.status, parsed: JSON.parse(data) };
      } catch {
        // Try the next data line.
      }
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { status: res.status, parsed };
}

// The installed stdio bridge (dist/mcp-standalone.mjs) is what Codex spawns for
// [mcp_servers.modeldock]; talk to it over JSON-RPC exactly like Codex does.
function startBridge(bridgePath, gatewayUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, MODELDOCK_GATEWAY_URL: gatewayUrl, MODELDOCK_MEMORY: "0", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, stderr: () => stderr };
}

function bridgeRpc(bridge, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} response\n${bridge.stderr()}`)), 8_000);
    const onData = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === id) {
          clearTimeout(timer);
          bridge.child.stdout.off("data", onData);
          resolve(parsed);
          return;
        }
      }
    };
    bridge.child.stdout.on("data", onData);
    bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function bridgeNotify(bridge, method, params) {
  bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function stopBridge(bridge) {
  if (bridge.child.exitCode !== null) return;
  bridge.child.stdin.end();
  await Promise.race([once(bridge.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (bridge.child.exitCode === null) bridge.child.kill();
}

// A stand-in for the OpenCode Go responses endpoint. The gateway relays /v1/responses
// here, so routing is proven end to end with a distinctive output token per attempt.
function startFakeUpstream(tag) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ url: req.url, body });
      const payload = JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_fake",
          object: "response",
          created_at: 0,
          status: "completed",
          model: "deepseek-v4-flash",
          output: [
            {
              type: "message",
              id: "msg_1",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: tag }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 5 },
        },
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: response.completed\ndata: ${payload}\n\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function assertRoutingWorks(port, upstreamTag, callerKey) {
  const res = await relayProbe(port, callerKey);
  const text = await res.text();
  assert.equal(res.status, 200, `relay should return 200 (got ${res.status})`);
  assert.match(text, new RegExp(upstreamTag), `relay should carry the upstream output through`);
}

async function assertGatewayMcpTools(port, callerKey) {
  const gatewayMcpBase = `http://127.0.0.1:${port}/c/${callerKey}`;
  const init = await rpcMcp(gatewayMcpBase, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "install-test", version: "1.0.0" },
  });
  assert.equal(init.status, 200, "MCP initialize should succeed against the installed gateway");
  const listed = await rpcMcp(gatewayMcpBase, "tools/list", {});
  const names = (listed.parsed?.result?.tools || []).map((tool) => tool.name);
  for (const name of ["web_search_exa", "vision_inspect", "speak", "hear", "recall_memory", "store_memory"]) {
    assert.ok(names.includes(name), `${name} missing from installed gateway MCP tools: ${names.join(",")}`);
  }
}

async function assertBridgeTools(bridgePath, gatewayUrl, memoryDir) {
  const bridge = startBridge(bridgePath, gatewayUrl, { MODELDOCK_MEMORY: "1", MODELDOCK_MEMORY_DIR: memoryDir });
  try {
    const init = await bridgeRpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "install-test", version: "1.0.0" },
    });
    assert.equal(init.result?.serverInfo?.name, "modeldock-opencode-go", `bridge init failed:\n${bridge.stderr()}`);
    bridgeNotify(bridge, "notifications/initialized", {});
    const listed = await bridgeRpc(bridge, 2, "tools/list", {});
    const names = (listed.result?.tools || []).map((tool) => tool.name);
    for (const name of ["web_search_exa", "vision_inspect", "speak", "hear", "recall_memory", "store_memory"]) {
      assert.ok(names.includes(name), `${name} missing from installed bridge tools: ${names.join(",")}`);
    }
    const call = await bridgeRpc(bridge, 3, "tools/call", {
      name: "recall_memory",
      arguments: { query: "baseline" },
    });
    const text = call.result?.content?.[0]?.text || "";
    assert.match(text, /MEMORY_RECALL/, `recall_memory should forward through the bridge:\n${bridge.stderr()}`);
  } finally {
    await stopBridge(bridge);
  }
}

// The catalog is what Codex reads for the picker and for the tool/instruction
// surface it hands to the LLM, so assert the loaded model entry carries the
// capability declarations the session depends on.
function assertCatalogTools(catalogPath) {
  const payload = JSON.parse(readFileSync(catalogPath, "utf8"));
  const entry = (payload.models || []).find((model) => String(model.slug || "").includes("deepseek-v4-flash"));
  assert.ok(entry, "catalog should publish the main model entry");
  assert.deepEqual(
    entry.experimental_supported_tools,
    ["artifact", "tool_call_mcp_elicitation", "workspace_dependencies", "computer_use", "browser_use"],
    "catalog should declare the Codex experimental tool surface",
  );
  const instructions = entry.base_instructions || "";
  assert.match(instructions, /vision_inspect/, "base instructions should expose the vision tool");
  assert.match(instructions, /web search/, "base instructions should expose the search tool");
  assert.match(instructions, /recall_memory/, "base instructions should expose recall_memory");
  assert.match(instructions, /store_memory/, "base instructions should expose store_memory");
  assert.ok(entry.context_window > 0, "catalog should declare a context window");
  assert.ok(Array.isArray(entry.input_modalities), "catalog should declare input modalities");
}

function writeFakeLaunchctl(binDir, logPath) {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "launchctl"),
    `#!/bin/sh
echo "$*" >> "$MODELDOCK_FAKE_LAUNCHCTL_LOG"
if [ "$1" = "list" ]; then
  echo "-	0	com.modeldock.gateway"
fi
exit 0
`,
    { mode: 0o755 },
  );
}

// Windows: the install writes a login Run entry under a redirectable registry key.
// The value must point back at the installed launcher, and launching that exact
// command must bring the gateway up (the "reboot" path).
function assertWinRunEntryPointsAt(keyPath, name, installDir) {
  const buf = execFileSync("reg.exe", ["query", keyPath, "/v", name], { encoding: "buffer" });
  assert.ok(
    buf.includes(Buffer.from(installDir, "utf8")),
    `Run value under ${keyPath} should reference the installed launcher in ${installDir}`,
  );
}

function deleteWinRegistryKey(keyPath) {
  try {
    execFileSync("reg.exe", ["delete", keyPath, "/f"], { stdio: "ignore" });
  } catch {
    // Already gone.
  }
}

function readWinRunValue(keyPath, name) {
  try {
    // The failing query is expected (key absent); keep reg.exe's stderr off the
    // console or the PowerShell host renders it as an error record every run.
    const buf = execFileSync("reg.exe", ["query", keyPath, "/v", name], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    for (const encoding of ["utf16le", "utf8"]) {
      const text = buf.toString(encoding).replace(/\u0000/g, "");
      const match = text.match(/REG_SZ\s+(.+?)(?:\r?\n|$)/);
      if (match && match[1].includes("powershell.exe")) return match[1].trim();
    }
  } catch {
    // Key or value absent.
  }
  return null;
}

// Guard rails against the mock install rewriting the user's real login entry: the
// throwaway redirect must be airtight, otherwise every test run quietly changes
// what starts at login. Snapshot before and assert identical after.
function assertRealLoginUntouched(t, installDir) {
  if (isWindows) {
    const realKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const before = readWinRunValue(realKey, "ModelDock");
    t.after(() => {
      const after = readWinRunValue(realKey, "ModelDock");
      assert.equal(after, before, "the real login Run key must not change during a mock install");
    });
    return;
  }
  const realPlist = path.join(os.homedir(), "Library", "LaunchAgents", "com.modeldock.gateway.plist");
  const before = existsSync(realPlist);
  t.after(() => {
    assert.equal(existsSync(realPlist), before, "the real LaunchAgents plist must not change during a mock install");
  });
}

// Login-autostart sandbox shared by every mock install: a throwaway registry key
// on Windows, a throwaway plist dir plus a fake launchctl on POSIX.
function installAutostartEnv(installDir) {
  if (isWindows) {
    return {
      MODELDOCK_AUTOSTART_KEY: `HKCU\\Software\\ModelDockTests\\${randomUUID()}`,
      MODELDOCK_AUTOSTART_NAME: "ModelDock",
    };
  }
  writeFakeLaunchctl(path.join(installDir, "fakebin"), path.join(installDir, "launchctl.log"));
  return {
    MODELDOCK_AUTOSTART_PLIST_DIR: path.join(installDir, "LaunchAgents"),
    MODELDOCK_FAKE_LAUNCHCTL_LOG: path.join(installDir, "launchctl.log"),
    PATH: `${path.join(installDir, "fakebin")}${path.delimiter}${process.env.PATH}`,
  };
}

// The installer starts the gateway in the background (a hidden node process). Track
// it down by the port it listens on so cleanup can stop it before removing the
// install dir - an open handle would otherwise make rmSync fail with EPERM.
function pidListeningOn(port) {
  if (isWindows) {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
      if (m && Number(m[1]) === port) return Number(m[2]);
    }
    return null;
  }
  // POSIX: lsof is present on both Linux and macOS runners; fall back to ss (Linux
  // only - macOS has no iproute2, hence the stderr redirect so a missing tool is quiet).
  for (const probe of [`lsof -ti tcp:${port} 2>/dev/null`, `ss -tlnp 2>/dev/null`]) {
    try {
      const out = execFileSync("sh", ["-c", probe], { encoding: "utf8" });
      if (probe.startsWith("lsof")) {
        const pid = out.trim();
        if (/^\d+$/.test(pid)) return Number(pid);
      } else {
        const line = out
          .split(/\r?\n/)
          .find((l) => l.includes(`:${port}`) && l.includes("pid="));
        if (line) {
          const m = line.match(/pid=(\d+)/);
          if (m) return Number(m[1]);
        }
      }
    } catch {
      // Tool missing or nothing matched; try the next probe.
    }
  }
  return null;
}

function killByPort(port) {
  const pid = pidListeningOn(port);
  if (pid === null) return;
  try {
    if (isWindows) {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      execFileSync("kill", [String(pid)], { stdio: "ignore" });
    }
  } catch {
    // The process may already be gone; treat it as cleaned up.
  }
}

async function waitForPortFree(port, tries = 20) {
  for (let i = 0; i < tries; i++) {
    if (pidListeningOn(port) === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// Minimal ZIP writer (stored entries) so the Windows Node-download test can serve a
// small fake node archive without depending on external tooling. Read by
// PowerShell's Expand-Archive.
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data);
    const crc = crc32(data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(0, 8); // method: stored
    lfh.writeUInt16LE(0, 10); // mtime
    lfh.writeUInt16LE(0, 12); // mdate
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28); // extra
    parts.push(lfh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(0, 10); // method
    ch.writeUInt16LE(0, 12); // mtime
    ch.writeUInt16LE(0, 14); // mdate
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra len
    ch.writeUInt16LE(0, 32); // comment len
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lfh.length + name.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, eocd]);
}

// Minimal USTAR tar writer (for the POSIX Node-download test). Extracted by tar(1).
function buildTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    if (name.length > 100) throw new Error("tar name too long");
    const data = e.type === "dir" ? Buffer.alloc(0) : Buffer.from(e.data);
    const h = Buffer.alloc(512);
    name.copy(h, 0);
    h.write("0000755\0", 100); // mode
    h.write("0000000\0", 108); // uid
    h.write("0000000\0", 116); // gid
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124); // size
    h.write("00000000000\0", 136); // mtime
    h.write("        ", 148); // checksum placeholder
    h.write(e.type === "dir" ? "5" : "0", 156); // typeflag
    h.write("ustar\0", 257, 6, "ascii");
    h.write("00", 263, 2, "ascii");
    h.write("root", 265, 32, "ascii");
    h.write("root", 297, 32, "ascii");
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h);
    if (data.length) {
      blocks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks end the archive
  return Buffer.concat(blocks);
}

test("mock install lifecycle: first start, second start routes, login relaunch", async (t) => {
  const bundle = path.join(repoRoot, "dist", "modeldock.mjs");
  const bridge = path.join(repoRoot, "dist", "mcp-standalone.mjs");
  assert.ok(existsSync(bundle), "dist/modeldock.mjs must be built before this test");
  assert.ok(existsSync(bridge), "dist/mcp-standalone.mjs must be built before this test");

  // 1. Local HTTP server pretending to be a GitHub Release asset endpoint, plus a
  //    fake OpenCode upstream that proves routing relays end to end.
  const asset = readFileSync(bundle);
  const bridgeAsset = readFileSync(bridge);
  const assetServer = createServer((req, res) => {
    if (req.url === "/modeldock.mjs") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": asset.length,
      });
      res.end(asset);
    } else if (req.url === "/mcp-standalone.mjs") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": bridgeAsset.length,
      });
      res.end(bridgeAsset);
    } else if (req.url === "/SHA256SUMS") {
      const text =
        `${createHash("sha256").update(asset).digest("hex")}  modeldock.mjs\n` +
        `${createHash("sha256").update(bridgeAsset).digest("hex")}  mcp-standalone.mjs\n`;
      // GitHub serves extension-less release assets as application/octet-stream,
      // and Windows PowerShell 5.1 then returns .Content as byte[] - the
      // installer must decode it as text or the checksum lookup fails.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(text);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const assetPort = await listen(assetServer);
  t.after(() => assetServer.close());
  const releaseUrl = `http://127.0.0.1:${assetPort}/modeldock.mjs`;
  const fakeUpstream = await startFakeUpstream("modeldock-relay-ok");
  t.after(() => fakeUpstream.close());

  // 2. Temp install dir (never touches the real ~/.modeldock) + a free app port.
  const installDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mock-install-"));
  // Use the port the kernel just confirmed free, not that port + 1: +1 was never
  // verified and collides with whatever else holds it (macOS hands out ephemeral
  // ports randomly, so a neighbour being taken is common there).
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  // Cleanup order matters: stop the background gateway first (it holds the install
  // dir open), then remove the dir.
  t.after(() => killByPort(appPort));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));
  // MODELDOCK_STATE_DIR (below) keeps the owner record inside installDir, but the
  // gateway is stopped with a hard kill, so nothing here can rely on its shutdown
  // hook running. Sweep the real home path too: if the redirect ever regresses,
  // this test cleans up after itself instead of leaking a file per run.
  t.after(() => rmSync(ownerFilePath(appPort, os.homedir()), { force: true }));
  // Login autostart is redirected to a throwaway registry key (Windows) or plist
  // dir (POSIX), so the install never touches the real login entry.
  const winRunKey = `HKCU\\Software\\ModelDockTests\\install-${randomUUID()}`;
  if (isWindows) t.after(() => deleteWinRegistryKey(winRunKey));
  assertRealLoginUntouched(t, installDir);
  const fakeBinDir = path.join(installDir, "fakebin");
  const launchctlLog = path.join(installDir, "launchctl.log");
  writeFakeLaunchctl(fakeBinDir, launchctlLog);
  const memoryDir = path.join(installDir, ".modeldock", "memory");
  const codexHome = path.join(installDir, "codex-home");

  // 3. Run the real installer with every default redirected through env vars.
  const installer = path.join(repoRoot, "scripts", installerScript);
  const env = {
    ...process.env,
    MODELDOCK_ROOT: installDir,
    MODELDOCK_RELEASE_URL: releaseUrl,
    MODELDOCK_BRIDGE_URL: `http://127.0.0.1:${assetPort}/mcp-standalone.mjs`,
    MODELDOCK_SUMS_URL: `http://127.0.0.1:${assetPort}/SHA256SUMS`,
    MODELDOCK_CODEX_HOME: codexHome,
    MODELDOCK_PORT: String(appPort),
    MODELDOCK_SKIP_OPEN: "1",
    // The installer starts a real gateway, which records port ownership on
    // startup. Point that record at the throwaway root so removing installDir
    // removes it too - the promise above ("never touches the real ~/.modeldock")
    // was untrue while the owner file resolved against the home directory.
    MODELDOCK_STATE_DIR: path.join(installDir, ".modeldock"),
    ...(isWindows
      ? { MODELDOCK_AUTOSTART_KEY: winRunKey, MODELDOCK_AUTOSTART_NAME: "ModelDock" }
      : { MODELDOCK_AUTOSTART_PLIST_DIR: path.join(installDir, "LaunchAgents") }),
    // A valid token + local upstream make /healthz return 200 and let the routing
    // leg relay a real request; memory is enabled so the MCP tool surface includes
    // recall_memory / store_memory.
    // Realistic token shape: isPlaceholderToken requires >= 12 chars, and the
    // unified tokens map drops shorter values (a 10-char "test-token" made the
    // installed gateway report 503 even though the env carried a token).
    OPENCODE_GO_TOKEN: "sk-mock-opencode-token-123456",
    MODELDOCK_UPSTREAM_BASE_URL: fakeUpstream.url,
    MODELDOCK_MEMORY: "1",
    MODELDOCK_MEMORY_DIR: memoryDir,
    // POSIX install.sh shells out to launchctl only on macOS; a fake one keeps
    // every runner deterministic and never registers anything with the host.
    ...(isWindows ? {} : { PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH}`, MODELDOCK_FAKE_LAUNCHCTL_LOG: launchctlLog }),
  };
  const child = runInstaller(installer, env);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `installer failed:\n${out}\n${err}`);

  // 4. Assert the layout the installer creates.
  const installedBundle = path.join(installDir, "dist", "modeldock.mjs");
  assert.ok(existsSync(path.join(installDir, "dist", "mcp-standalone.mjs")), "dist/mcp-standalone.mjs should be downloaded");
  const launcher = path.join(installDir, "scripts", launcherName);
  assert.ok(existsSync(installedBundle), "dist/modeldock.mjs should be downloaded");
  assert.ok(existsSync(launcher), `${launcherName} launcher should be written`);
  assert.ok(existsSync(path.join(installDir, "scripts", "restart.ps1")), "scripts/restart.ps1 should be written");
  if (!isWindows) {
    assert.ok(existsSync(path.join(installDir, "scripts", "restart.sh")), "scripts/restart.sh should be written");
    assert.ok(existsSync(path.join(installDir, "scripts", "mcp-call.sh")), "scripts/mcp-call.sh should be written");
    assert.ok(existsSync(path.join(installDir, "scripts", "mcp-call.mjs")), "scripts/mcp-call.mjs should be written");
  }
  assert.ok(
    existsSync(path.join(installDir, "scripts", isWindows ? "recover.ps1" : "recover.sh")),
    "manual recovery script should be written",
  );
  if (isWindows) {
    assert.match(
      readFileSync(path.join(installDir, "scripts", "recover.ps1"), "utf8"),
      /Repair-Autostart/,
      "embedded recovery script should carry the autostart repair",
    );
  }
  assert.equal(readFileSync(installedBundle).length, asset.length, "bundle byte-identical");
  // The content-to-video skill is not downloaded by the installer; the install
  // must not create the skills dir it used to mirror into.
  assert.equal(
    existsSync(path.join(codexHome, "skills", "content-to-video")),
    false,
    "the installer no longer downloads content-to-video",
  );

  // 5. The installer already started the gateway in the background on $port. Hit
  //    /healthz + dashboard + api/status to prove the installed bundle runs.
  const healthz = await waitForHealth(appPort);
  // The launcher runs node in the background, so a startup crash only shows up in the
  // log it writes; surface it here or the failure is just "did not come up".
  if (!healthz.up) {
    // Windows writes stdout and stderr separately (Start-Process cannot send both to
    // one file); POSIX appends both to modeldock.log.
    const logs = ["modeldock.log", "modeldock.err.log"]
      .map((name) => {
        const file = path.join(installDir, name);
        return `--- ${name} ---\n${existsSync(file) ? readFileSync(file, "utf8") || "(empty)" : "(not written)"}`;
      })
      .join("\n");
    assert.fail(`gateway should come up after install\n--- installer stdout ---\n${out}\n--- installer stderr ---\n${err}\n${logs}`);
  }
  assert.equal(healthz.status, 200, "with a token configured the gateway should report healthy");

  const installedCatalog = path.join(installDir, ".modeldock", "codex-model-catalog.json");

  const dashboard = await fetchText(`http://127.0.0.1:${appPort}/`);
  assert.equal(dashboard.status, 200, "dashboard should be served");
  assert.match(dashboard.text, /modeldock/i, "dashboard HTML should mention ModelDock");

  const status = await fetchText(`http://127.0.0.1:${appPort}/api/status`);
  assert.equal(status.status, 200);
  const payload = JSON.parse(status.text);
  assert.ok(payload.config?.bind, "api/status should expose config.bind");
  assert.ok("autostart" in payload, "api/status should expose autostart");
  // Windows and macOS default autostart ON from the installer; Linux has no login
  // integration and must report unsupported instead of pretending.
  if (isWindows || process.platform === "darwin") {
    assert.equal(payload.autostart?.enabled, true, "first install should leave autostart enabled");
  } else {
    assert.equal(payload.autostart?.supported, false, "Linux should report autostart unsupported");
  }
  if (isWindows) {
    assertWinRunEntryPointsAt(winRunKey, "ModelDock", installDir);
    assert.ok(existsSync(path.join(installDir, ".modeldock", "autostart-initialized")), "installer should record the autostart decision");
  }

  // 5b. The surfaces a real session depends on must be live after install: the
  //     MCP tool list (HTTP /mcp + the stdio bridge Codex spawns), and the catalog
  //     declarations the LLM reads for its tool surface.
  const callerKey = readCallerKey(path.join(installDir, ".modeldock"));
  await assertGatewayMcpTools(appPort, callerKey);
  await assertBridgeTools(path.join(installDir, "dist", "mcp-standalone.mjs"), `http://127.0.0.1:${appPort}/c/${callerKey}`, memoryDir);
  assertCatalogTools(installedCatalog);
  // Caller-key enforcement is on by default, so routing must go through the
  // keyed /c/<key>/v1 URL (what the managed Codex config points at) while the
  // bare path is rejected.
  await assertRoutingWorks(appPort, "modeldock-relay-ok", callerKey);
  const bare = await relayProbe(appPort, "");
  assert.equal(bare.status, 401, "bare /v1 relay should be rejected when caller-key enforcement is on by default");
  await bare.text();

  // 6. The gateway is up, so it has written its owner record. Assert it landed in
  //    the throwaway root and not in the user's home: this test is stopped with a
  //    hard kill, which skips the shutdown hook that would normally remove it, so
  //    a record written to the real ~/.modeldock would survive every single run.
  assert.ok(existsSync(ownerFilePath(appPort, installDir)), "owner record should follow MODELDOCK_STATE_DIR");
  assert.ok(
    !existsSync(ownerFilePath(appPort, os.homedir())),
    "the real ~/.modeldock must stay untouched",
  );

  // The model catalog follows the same redirect: a gateway started from a
  // throwaway install bakes paths from that install root, so writing it to the
  // real ~/.modeldock would leave the user's catalog pointing at a deleted temp
  // dir. Assert the catalog stayed inside the throwaway root and references the
  // install's own restart script.
  assert.ok(existsSync(installedCatalog), "catalog should follow MODELDOCK_STATE_DIR");
  const installedCatalogPayload = JSON.parse(readFileSync(installedCatalog, "utf8"));
  // The baked restart path is compared through realpath: Windows may render the
  // temp parent as an 8.3 short name (CHENBA~1) while mkdtempSync returned the
  // long form, so a raw string compare would be flaky.
  const restartScriptName = isWindows ? "restart.ps1" : "restart.sh";
  const marker = `${path.sep}scripts${path.sep}${restartScriptName}`;
  const baked = (installedCatalogPayload.models || [])
    .map((model) => model?.base_instructions || "")
    .find((instructions) => instructions.includes(marker)) || "";
  const bakedIndex = baked.indexOf(marker);
  assert.ok(bakedIndex > 0, `catalog base_instructions should reference scripts/${restartScriptName}`);
  // The path is quoted inside the instruction ("...\scripts\restart.ps1" or
  // ".../scripts/restart.sh"); walk
  // back from the marker to that opening quote so dirname sees a real path.
  const bakedRestartPath = baked.slice(baked.lastIndexOf('"', bakedIndex) + 1, bakedIndex + marker.length);
  const bakedRoot = path.dirname(path.dirname(bakedRestartPath));
  // Ancestor directories may render as 8.3 short names (CHENBA~1 for
  // "chenbao"), but the mkdtemp install dir's own name is stable, so compare
  // basenames.
  assert.equal(path.basename(bakedRoot), path.basename(installDir), "restart path should point inside the install root");

  // 7. Second start: stop the install-time gateway and bring it up again through
  //    the installed launcher (what restart.ps1 / the updater do). Routing and the
  //    MCP surface must still work after the bounce.
  killByPort(appPort);
  assert.ok(await waitForPortFree(appPort), "background gateway should stop");
  const second = isWindows
    ? spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher], { env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("/bin/sh", [launcher], { env, stdio: ["ignore", "pipe", "pipe"] });
  let secondOut = "";
  let secondErr = "";
  second.stdout.on("data", (d) => (secondOut += d));
  second.stderr.on("data", (d) => (secondErr += d));
  await once(second, "exit");
  const secondHealth = await waitForHealth(appPort);
  assert.ok(secondHealth.up, `gateway should come up on second start\n${secondOut}\n${secondErr}`);
  assert.equal(secondHealth.status, 200);
  await assertRoutingWorks(appPort, "modeldock-relay-ok", callerKey);
  await assertGatewayMcpTools(appPort, callerKey);
  assertCatalogTools(installedCatalog);

  // 8. Login relaunch: start through the exact entry the OS uses at login. Windows
  //    runs the Run key command; macOS launchd runs /bin/sh <launcher> from the
  //    plist; Linux has no login entry, so this is the manual launcher (already
  //    proven) and the supported=false state above is the contract.
  killByPort(appPort);
  assert.ok(await waitForPortFree(appPort), "gateway should stop before the login relaunch");
  let relaunch;
  if (isWindows) {
    const runCommand = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"`;
    // WScript.Shell.Run uses the same ShellExecute command-line parsing Explorer
    // applies to the Run key at login, so the exact stored command is exercised.
    const shell = `(New-Object -ComObject WScript.Shell).Run('${runCommand}', 0)`;
    relaunch = spawn("powershell", ["-NoProfile", "-Command", shell], { env, stdio: ["ignore", "pipe", "pipe"] });
  } else if (process.platform === "darwin") {
    const plist = path.join(installDir, "LaunchAgents", "com.modeldock.gateway.plist");
    const plistText = readFileSync(plist, "utf8");
    assert.match(plistText, /RunAtLoad/, "plist should load at login");
    assert.match(plistText, /<key>KeepAlive<\/key><true\/>/, "plist should keep the gateway alive");
    const argBlock = plistText.split("<key>ProgramArguments</key>")[1].split("</array>")[0];
    const args = [...argBlock.matchAll(/<string>(.*?)<\/string>/g)].map((match) => match[1]);
    assert.equal(args.length, 2, "plist ProgramArguments should be exactly [node, server]");
    assert.ok(plistText.includes("dist/modeldock.mjs"), "plist should launch the installed bundle directly");
    relaunch = spawn(args[0], [args[1]], { env, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    relaunch = spawn("/bin/sh", [launcher], { env, stdio: ["ignore", "pipe", "pipe"] });
  }
  let relaunchOut = "";
  let relaunchErr = "";
  relaunch.stdout.on("data", (d) => (relaunchOut += d));
  relaunch.stderr.on("data", (d) => (relaunchErr += d));
  await once(relaunch, "exit");
  const relaunchHealth = await waitForHealth(appPort);
  assert.ok(relaunchHealth.up, `gateway should come up through the login entry\n${relaunchOut}\n${relaunchErr}`);
  assert.equal(relaunchHealth.status, 200);
  await assertRoutingWorks(appPort, "modeldock-relay-ok", callerKey);
  await assertGatewayMcpTools(appPort, callerKey);

  // 9. Stop the final gateway so cleanup can remove the temp install dir.
  killByPort(appPort);
  assert.ok(await waitForPortFree(appPort), "final gateway should stop");
});

test("mock install: upgrades an existing bundled Node 22 to Node 24", async (t) => {
  const bundle = readFileSync(path.join(repoRoot, "dist", "modeldock.mjs"));
  const fakeBridge = Buffer.from("// fake mcp bridge\n");
  const nodeVer = "24.5.0";
  const distName = "v" + nodeVer;

  // Fake nodejs.org/dist server. The version index is ordered newest-first with a
  // non-LTS v25 ahead of the v24 LTS entries, so resolution must pick v24.5.0.
  const zipEntry = { name: `node-${distName}-win-x64/node.exe`, data: "fake node.exe for download test\n" };
  const zip = buildZip([zipEntry]);
  const nodeBin = "#!/bin/sh\nexec node \"$@\"\n";
  const oldNodeBin = "#!/bin/sh\nif [ \"\${1:-}\" = \"--version\" ]; then echo v22.18.0; exit 0; fi\nexec node \"$@\"\n";
  const tgz = gzipSync(
    buildTar([
      { name: `node-${distName}-linux-x64/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/node`, type: "file", data: nodeBin },
    ]),
  );
  const tgzDarwin = gzipSync(
    buildTar([
      { name: `node-${distName}-darwin-arm64/`, type: "dir" },
      { name: `node-${distName}-darwin-arm64/bin/`, type: "dir" },
      { name: `node-${distName}-darwin-arm64/bin/node`, type: "file", data: nodeBin },
    ]),
  );
  const tgzDarwinX64 = gzipSync(
    buildTar([
      { name: `node-${distName}-darwin-x64/`, type: "dir" },
      { name: `node-${distName}-darwin-x64/bin/`, type: "dir" },
      { name: `node-${distName}-darwin-x64/bin/node`, type: "file", data: nodeBin },
    ]),
  );
  const shasums =
    [
      `${sha256(zip)}  node-${distName}-win-x64.zip`,
      `${sha256(tgz)}  node-${distName}-linux-x64.tar.gz`,
      `${sha256(tgzDarwin)}  node-${distName}-darwin-arm64.tar.gz`,
      `${sha256(tgzDarwinX64)}  node-${distName}-darwin-x64.tar.gz`,
    ].join("\n") + "\n";
  const indexJson = JSON.stringify([
    { version: "v25.1.0", lts: false, npm: "11.0.0" },
    { version: "v24.5.0", lts: "Krypton", npm: "10.8.0" },
    { version: "v24.4.0", lts: "Krypton", npm: "10.8.0" },
  ]);
  const server = createServer((req, res) => {
    const url = req.url;
    if (url === "/modeldock.mjs") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bundle.length });
      res.end(bundle);
    } else if (url === "/mcp-standalone.mjs") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fakeBridge.length });
      res.end(fakeBridge);
    } else if (url === "/SHA256SUMS") {
      const text =
        `${createHash("sha256").update(bundle).digest("hex")}  modeldock.mjs\n` +
        `${createHash("sha256").update(fakeBridge).digest("hex")}  mcp-standalone.mjs\n`;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(text);
    } else if (url === "/index.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(indexJson);
    } else if (url === `/v${nodeVer}/SHASUMS256.txt`) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(shasums);
    } else if (url === `/v${nodeVer}/node-${distName}-win-x64.zip`) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(zip);
    } else if (url === `/v${nodeVer}/node-${distName}-linux-x64.tar.gz`) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgz);
    } else if (url === `/v${nodeVer}/node-${distName}-darwin-arm64.tar.gz`) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgzDarwin);
    } else if (url === `/v${nodeVer}/node-${distName}-darwin-x64.tar.gz`) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgzDarwinX64);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const serverPort = await listen(server);
  t.after(() => server.close());

  const installDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mock-node-"));
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  t.after(() => killByPort(appPort));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));
  const autostartEnv = installAutostartEnv(installDir);
  if (isWindows) t.after(() => deleteWinRegistryKey(autostartEnv.MODELDOCK_AUTOSTART_KEY));
  const oldBundledNode = isWindows
    ? path.join(installDir, "node", "v22.18.0", "node.exe")
    : path.join(installDir, "node", "v22.18.0", "bin", "node");
  mkdirSync(path.dirname(oldBundledNode), { recursive: true });
  if (isWindows) copyFileSync(process.execPath, oldBundledNode);
  else writeFileSync(oldBundledNode, oldNodeBin, { mode: 0o755 });
  const sentinelBundle = Buffer.from("runtime-only must preserve this bundle\n");
  mkdirSync(path.join(installDir, "dist"), { recursive: true });
  writeFileSync(path.join(installDir, "dist", "modeldock.mjs"), sentinelBundle);

  const env = {
    ...process.env,
    MODELDOCK_ROOT: installDir,
    MODELDOCK_RELEASE_URL: `http://127.0.0.1:${serverPort}/modeldock.mjs`,
    MODELDOCK_BRIDGE_URL: `http://127.0.0.1:${serverPort}/mcp-standalone.mjs`,
    MODELDOCK_SUMS_URL: `http://127.0.0.1:${serverPort}/SHA256SUMS`,
    MODELDOCK_NODE_BASE_URL: `http://127.0.0.1:${serverPort}`,
    MODELDOCK_NODE_PATH: oldBundledNode,
    // The Windows fixture node.exe is a text file; executing it would make Windows
    // pop an "Unsupported 16-Bit Application" dialog and hang the test's launcher.
    // Skip the start on Windows so only download/verify/extract/layout is asserted.
    MODELDOCK_SKIP_START: isWindows ? "1" : "0",
    MODELDOCK_PORT: String(appPort),
    MODELDOCK_SKIP_OPEN: "1",
    MODELDOCK_STATE_DIR: path.join(installDir, ".modeldock"),
    ...autostartEnv,
  };
  const runtimeOnly = runInstaller(path.join(repoRoot, "scripts", installerScript), {
    ...env,
    MODELDOCK_RUNTIME_ONLY: "1",
    MODELDOCK_SKIP_START: "1",
  });
  let runtimeOnlyOut = "";
  let runtimeOnlyErr = "";
  runtimeOnly.stdout.on("data", (d) => (runtimeOnlyOut += d));
  runtimeOnly.stderr.on("data", (d) => (runtimeOnlyErr += d));
  const runtimeOnlyExit = await new Promise((resolve) => runtimeOnly.on("close", resolve));
  assert.equal(runtimeOnlyExit, 0, `runtime-only migration failed:\n${runtimeOnlyOut}\n${runtimeOnlyErr}`);
  assert.deepEqual(
    readFileSync(path.join(installDir, "dist", "modeldock.mjs")),
    sentinelBundle,
    "runtime-only migration must not replace the installed bundle",
  );

  const child = runInstaller(path.join(repoRoot, "scripts", installerScript), env);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `installer failed:\n${out}\n${err}`);

  // The bundled node landed under <root>/node/v24.5.0 with the archive's content.
  const bundledNode = isWindows
    ? path.join(installDir, "node", `v${nodeVer}`, "node.exe")
    : path.join(installDir, "node", `v${nodeVer}`, "bin", "node");
  assert.ok(existsSync(bundledNode), `bundled node should be extracted at ${bundledNode}`);
  assert.equal(
    readFileSync(bundledNode, "utf8"),
    isWindows ? zipEntry.data : nodeBin,
    "extracted node content should match the archive",
  );
  assert.ok(existsSync(path.join(installDir, "dist", "modeldock.mjs")), "release bundle should still be downloaded");

  // The launcher and restart script carry the bundled-first node resolution.
  const launcher = readFileSync(path.join(installDir, "scripts", launcherName), "utf8");
  const restart = readFileSync(path.join(installDir, "scripts", "restart.ps1"), "utf8");
  const restartSh = !isWindows ? readFileSync(path.join(installDir, "scripts", "restart.sh"), "utf8") : "";
  assert.ok(
    launcher.includes(isWindows ? 'Join-Path $root "node"' : '"$ROOT"/node/v*'),
    "launcher should prefer the bundled node",
  );
  assert.ok(restart.includes('Join-Path $root "node"'), "restart.ps1 should prefer the bundled node");
  if (!isWindows) {
    assert.ok(restartSh.includes('"$ROOT"/node/v*'), "restart.sh should prefer the bundled node");
  }

  // POSIX: the fixture node is a real executable wrapper, so the launcher can start
  // the gateway with the bundled node end to end. Windows cannot run a text file as
  // node.exe, so only the download/extract/layout path is asserted there.
  if (!isWindows) {
    let healthz;
    for (let i = 0; i < 40 && !healthz; i++) {
      try {
        healthz = await fetchText(`http://127.0.0.1:${appPort}/healthz`);
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(
      healthz && [200, 503].includes(healthz.status),
      `gateway should come up via the bundled node\n${out}\n${err}`,
    );
  }

  killByPort(appPort);
  assert.ok(await waitForPortFree(appPort), "background gateway should stop");
});

test("mock install: rejects a Node download whose SHA256 does not match", async (t) => {
  const nodeVer = "24.5.0";
  const distName = "v" + nodeVer;
  const fakeBridge = Buffer.from("// fake mcp bridge\n");
  const zip = buildZip([{ name: `node-${distName}-win-x64/node.exe`, data: "fake\n" }]);
  const tgz = gzipSync(
    buildTar([
      { name: `node-${distName}-linux-x64/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/`, type: "dir" },
      { name: `node-${distName}-linux-x64/bin/node`, type: "file", data: "#!/bin/sh\n" },
    ]),
  );
  const wrong = sha256(Buffer.from("not the archive"));
  const shasums = [
    `${wrong}  node-${distName}-win-x64.zip`,
    `${wrong}  node-${distName}-linux-x64.tar.gz`,
    `${wrong}  node-${distName}-darwin-arm64.tar.gz`,
    `${wrong}  node-${distName}-darwin-x64.tar.gz`,
  ].join("\n") + "\n";
  const indexJson = JSON.stringify([{ version: "v24.5.0", lts: "Krypton", npm: "10.8.0" }]);
  const server = createServer((req, res) => {
    const url = req.url;
    if (url === "/modeldock.mjs") {
      const bundle = readFileSync(path.join(repoRoot, "dist", "modeldock.mjs"));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bundle.length });
      res.end(bundle);
    } else if (url === "/mcp-standalone.mjs") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": fakeBridge.length });
      res.end(fakeBridge);
    } else if (url === "/SHA256SUMS") {
      const bundle = readFileSync(path.join(repoRoot, "dist", "modeldock.mjs"));
      const text =
        `${createHash("sha256").update(bundle).digest("hex")}  modeldock.mjs\n` +
        `${createHash("sha256").update(fakeBridge).digest("hex")}  mcp-standalone.mjs\n`;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(text);
    } else if (url === "/index.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(indexJson);
    } else if (url.endsWith("/SHASUMS256.txt")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(shasums);
    } else if (url.endsWith(".zip")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(zip);
    } else if (url.endsWith(".tar.gz")) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(tgz);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  const serverPort = await listen(server);
  t.after(() => server.close());

  const installDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mock-badsha-"));
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  t.after(() => killByPort(appPort));
  t.after(() => rmSync(installDir, { recursive: true, force: true }));
  const autostartEnv = installAutostartEnv(installDir);
  if (isWindows) t.after(() => deleteWinRegistryKey(autostartEnv.MODELDOCK_AUTOSTART_KEY));

  const env = {
    ...process.env,
    MODELDOCK_ROOT: installDir,
    MODELDOCK_RELEASE_URL: `http://127.0.0.1:${serverPort}/modeldock.mjs`,
    MODELDOCK_BRIDGE_URL: `http://127.0.0.1:${serverPort}/mcp-standalone.mjs`,
    MODELDOCK_SUMS_URL: `http://127.0.0.1:${serverPort}/SHA256SUMS`,
    MODELDOCK_NODE_BASE_URL: `http://127.0.0.1:${serverPort}`,
    MODELDOCK_FORCE_NODE_DOWNLOAD: "1",
    MODELDOCK_PORT: String(appPort),
    MODELDOCK_SKIP_OPEN: "1",
    MODELDOCK_STATE_DIR: path.join(installDir, ".modeldock"),
    ...autostartEnv,
  };
  const child = runInstaller(path.join(repoRoot, "scripts", installerScript), env);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(exitCode, 0, `a bad SHA256 should fail the install, got exit 0\n${out}\n${err}`);
  assert.match(out + err, /SHA256 mismatch/, `installer should report the hash mismatch\n${out}\n${err}`);
  assert.ok(
    !existsSync(path.join(installDir, "node", `v${nodeVer}`)),
    "no bundled node should be installed after a bad hash",
  );
});

test("uninstall preserves the memory vault and never kills a foreign listener", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-uninstall-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, ".modeldock");
  const memoryDir = path.join(stateDir, "memory");
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, "global.db"), "sqlite-bytes");
  writeFileSync(path.join(stateDir, "caller-key"), "not-a-real-key\n");
  writeFileSync(path.join(stateDir, "autostart-initialized"), "2026-01-01\n");

  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  // Forge a stale owner record around a real foreign listener. PID and port
  // equality alone must not authorize a kill after PID reuse; the process must
  // also run this install's exact gateway entry path.
  const foreign = spawn(process.execPath, ["--input-type=module", "-e", `
import http from "node:http";
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, foreign: true }));
}).listen(Number(process.env.MODELDOCK_PORT), "127.0.0.1");
`], { env: { ...process.env, MODELDOCK_PORT: String(port) }, stdio: "ignore" });
  t.after(() => foreign.kill("SIGKILL"));
  assert.ok((await waitForHealth(port)).up, "foreign listener should start");
  writeFileSync(ownerFilePath(port, root), JSON.stringify({ pid: foreign.pid, root: repoRoot, port }));

  const env = {
    ...process.env,
    MODELDOCK_ROOT: stateDir,
    MODELDOCK_STATE_DIR: stateDir,
    MODELDOCK_PORT: String(port),
    ...(isWindows
      ? {
          MODELDOCK_AUTOSTART_KEY: `HKCU\\Software\\ModelDockTests\\uninstall-${randomUUID()}`,
          MODELDOCK_AUTOSTART_NAME: "ModelDock",
        }
      : {}),
  };
  const child = runUninstall(path.join(repoRoot, "scripts", uninstallScript), env);
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const exitCode = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(exitCode, 0, `uninstall failed:\n${out}\n${err}`);
  assert.ok(existsSync(path.join(memoryDir, "global.db")), "uninstall must preserve the memory vault");
  assert.ok(!existsSync(path.join(stateDir, "caller-key")), "runtime state files should be cleared");
  assert.ok(!existsSync(path.join(stateDir, "autostart-initialized")), "the autostart mark should be cleared");
  assert.match(out + err, /preserved/i, "uninstall should say the memory vault is preserved");
  assert.ok((await waitForHealth(port)).up, "uninstall must leave the foreign listener running");
});

test("recover menu repairs a lost autostart Run key", async (t) => {
  if (!isWindows) {
    t.skip("autostart repair is Windows-only");
    return;
  }
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-recover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyPath = `HKCU\\Software\\ModelDockTests\\recover-${randomUUID()}`;
  t.after(() => deleteWinRegistryKey(keyPath));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "recover.ps1"), readFileSync(path.join(repoRoot, "scripts", "recover.ps1"), "utf8"));
  writeFileSync(path.join(root, "scripts", "restart.ps1"), "exit 0\n");
  writeFileSync(path.join(root, "scripts", "start-hidden.ps1"), "# launcher stub\n");
  const mark = path.join(root, "autostart-initialized");
  const env = {
    ...process.env,
    MODELDOCK_AUTOSTART_KEY: keyPath,
    MODELDOCK_AUTOSTART_NAME: "ModelDock",
    MODELDOCK_STATE_DIR: root,
  };
  const runRecover = () =>
    execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "recover.ps1")],
      { env, input: "1\n", encoding: "utf8" },
    );

  writeFileSync(mark, "2026-01-01\n");
  const repaired = runRecover();
  assert.match(repaired, /re-enabled|OK/, "recover should report the autostart state");
  const value = readWinRunValue(keyPath, "ModelDock");
  // Ancestors may render as 8.3 short names (CHENBA~1) while the Run value
  // records the long path PowerShell resolved; the mkdtemp dir's own name is
  // stable, so match on basename + suffix like the catalog assertions above.
  assert.ok(
    value && value.includes(path.basename(root)) && value.includes("scripts\\start-hidden.ps1"),
    "a lost Run key should be re-created pointing at the installed launcher",
  );

  deleteWinRegistryKey(keyPath);
  rmSync(mark, { force: true });
  const untouched = runRecover();
  assert.ok(!untouched.includes("re-enabled"), "no decision mark means no decision; recover must not enable autostart");
  assert.equal(readWinRunValue(keyPath, "ModelDock"), null, "no Run key should be written without a decision mark");
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repoRoot, "dist", "modeldock.mjs");
const mcpBundle = path.join(repoRoot, "dist", "mcp-standalone.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => {
    if (error?.code === "ERR_SERVER_NOT_RUNNING") return resolve();
    if (error) return reject(error);
    resolve();
  }));
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function removeFixtureRoot(root) {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    // Codex can leave its disposable plugin-clone directory briefly locked on
    // Windows after the parent exits. The sandbox janitor removes that stale
    // fixture later; a transient external-process lock is not a product fail.
    if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has(error?.code)) throw error;
  }
}

async function waitForGateway(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch {
      // The built bundle may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("built gateway did not start");
}

function stream(event) {
  return `data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`;
}

function toolStream(name, imagePath) {
  return stream({
    id: "chatcmpl_preview_tool",
    created: 31,
    model: "qwen3.8-flash",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "call_preview_images",
          type: "function",
          function: { name, arguments: JSON.stringify({ paths: [imagePath] }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 100, completion_tokens: 12 },
  });
}

function textStream() {
  return stream({
    id: "chatcmpl_preview_done",
    created: 32,
    model: "qwen3.8-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: "PREVIEW_E2E_OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 140, completion_tokens: 4 },
  });
}

function imageUrls(body) {
  const urls = [];
  for (const message of body.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type !== "image_url") continue;
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url === "string") urls.push(url);
    }
  }
  return urls;
}

function screenshotPng() {
  const width = 1200;
  const height = 800;
  const pixels = new Uint8Array(width * height * 3);
  let random = 0x13572468;
  for (let index = 0; index < pixels.length; index += 1) {
    random = (random * 1664525 + 1013904223) >>> 0;
    pixels[index] = random >>> 24;
  }
  return Buffer.from(encodePng({ width, height, channels: 3, depth: 8, data: pixels }));
}

test("installed Codex replays a bounded preview_images result with its original ref", { timeout: 180_000 }, async (t) => {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (probe.error?.code === "ENOENT") {
    t.skip("Codex is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-preview-"));
  const stateDir = path.join(root, "state");
  const gatewayCodexHome = path.join(root, "gateway-codex-home");
  const clientCodexHome = path.join(root, "client-codex-home");
  const workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(gatewayCodexHome, { recursive: true }),
    mkdir(clientCodexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  t.after(() => removeFixtureRoot(root));
  const imagePath = path.join(workspace, "large-screenshot.png");
  const original = screenshotPng();
  await writeFile(imagePath, original);

  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (requests.length === 1) {
      const previewTool = (body.tools || []).find((tool) => tool?.function?.name?.endsWith("preview_images"));
      assert.ok(previewTool, "the complete Codex tool package must include preview_images");
      res.end(toolStream(previewTool.function.name, imagePath.replace(/\\/g, "/")));
      return;
    }
    res.end(textStream());
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const portProbe = http.createServer();
  const gatewayPort = await listen(portProbe);
  await closeServer(portProbe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\codex-preview-${process.pid}`;
  const autostartName = `ModelDockCodexPreview${process.pid}`;
  const gateway = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENCODE_GO_TOKEN: "fixture-token",
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CODEX_HOME: gatewayCodexHome,
      MODELDOCK_REQUIRE_CALLER_KEY: "0",
      MODELDOCK_MEMORY: "0",
      MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey,
      MODELDOCK_AUTOSTART_NAME: autostartName,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let gatewayStderr = "";
  gateway.stderr.on("data", (chunk) => { gatewayStderr += chunk; });
  t.after(async () => {
    await stop(gateway);
    if (process.platform === "win32") spawnSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore", windowsHide: true });
  });
  await waitForGateway(gatewayPort);
  const catalogFile = path.join(stateDir, "codex-model-catalog.json");
  await access(catalogFile);
  const callerKey = (await readFile(path.join(stateDir, "caller-key"), "utf8")).trim();
  await writeFile(path.join(clientCodexHome, "config.toml"), [
    "[mcp_servers.modeldock]",
    `command = ${JSON.stringify(process.execPath.replace(/\\/g, "/"))}`,
    `args = [${JSON.stringify(mcpBundle.replace(/\\/g, "/"))}]`,
    `env = { "MODELDOCK_GATEWAY_URL" = ${JSON.stringify(`http://127.0.0.1:${gatewayPort}/c/${callerKey}`)}, "MODELDOCK_STATE_DIR" = ${JSON.stringify(stateDir.replace(/\\/g, "/"))}, "MODELDOCK_MEMORY" = "0" }`,
  ].join("\n"), "utf8");

  const args = [
    "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "--json",
    "-C", workspace,
    "-c", 'model="qwen3.8-flash@opencode-go"',
    "-c", `openai_base_url=${JSON.stringify(`http://127.0.0.1:${gatewayPort}/v1`)}`,
    "-c", `model_catalog_json=${JSON.stringify(catalogFile.replace(/\\/g, "/"))}`,
    "-c", 'approval_policy="never"',
    "-c", 'sandbox_mode="workspace-write"',
    "Call the requested preview tool, then reply with the final marker.",
  ];
  const codex = spawn("codex", args, {
    env: { ...process.env, CODEX_HOME: clientCodexHome, OPENAI_API_KEY: "fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  codex.stdout.on("data", (chunk) => { stdout += chunk; });
  codex.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(codex, "exit");

  assert.equal(exitCode, 0, `${stderr}\n${stdout}\n${gatewayStderr}`);
  assert.match(stdout, /PREVIEW_E2E_OK/);
  assert.ok(requests.length >= 2, "Codex must continue after the MCP image result");
  assert.ok(
    requests[0].tools.some((tool) => tool?.function?.name?.endsWith("preview_images")),
    "the real client request must carry the preview_images descriptor it executed",
  );
  const replay = requests.at(-1);
  const images = imageUrls(replay);
  assert.equal(images.length, 1, "the next complete Codex request must contain the MCP preview image");
  const previewBytes = Buffer.from(images[0].split(",")[1], "base64").byteLength;
  assert.ok(previewBytes <= 1024 * 1024);
  assert.ok(previewBytes < original.byteLength, "Codex must replay the preview, not the original screenshot");
  assert.match(JSON.stringify(replay), /original_ref/);
  assert.match(JSON.stringify(replay), /img_[0-9a-f]{20}/);
});

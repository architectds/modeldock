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
const IMAGE_LIMIT = 320 * 1024;

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

function stream(events) {
  return [...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n");
}

function textStream(text) {
  return stream([{
    id: "chatcmpl_vision_client",
    created: 21,
    model: "qwen3.8-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 4 },
  }]);
}

function toolStream(imagePath) {
  const code = [
    'var fsVisionProbe = await import("node:fs");',
    `var bytesVisionProbe = fsVisionProbe.readFileSync(${JSON.stringify(imagePath.replace(/\\/g, "/"))});`,
    "await nodeRepl.emitImage(bytesVisionProbe);",
  ].join("\n");
  return stream([{
    id: "chatcmpl_vision_tool",
    created: 22,
    model: "qwen3.8-flash",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: "call_current_codex_emit_image",
          type: "function",
          function: {
            name: "mcp__node_repl__js",
            arguments: JSON.stringify({ code, title: "Return the test image through the current Codex media tool" }),
          },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 90, completion_tokens: 12 },
  }]);
}

function imageUrls(body) {
  const urls = [];
  for (const message of body.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof url === "string") urls.push(url);
      }
    }
  }
  return urls;
}

function visionFixturePng() {
  const width = 900;
  const height = 600;
  const pixels = new Uint8Array(width * height * 3);
  let random = 0x76543210;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      random = (random * 1664525 + 1013904223) >>> 0;
      const noise = random >>> 27;
      const index = (y * width + x) * 3;
      const left = x < width / 2;
      pixels[index] = left ? 210 + noise : noise;
      pixels[index + 1] = noise;
      pixels[index + 2] = left ? noise : 210 + noise;
    }
  }
  return Buffer.from(encodePng({ width, height, channels: 3, depth: 8, data: pixels }));
}

async function runCodex({ clientCodexHome, workspace, gatewayPort, catalogFile, model = "qwen3.8-flash@opencode-go", imagePath = "", prompt }) {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "--json",
    "-C",
    workspace,
    "-c",
    `model=${JSON.stringify(model)}`,
    "-c",
    `openai_base_url=${JSON.stringify(`http://127.0.0.1:${gatewayPort}/v1`)}`,
    "-c",
    `model_catalog_json=${JSON.stringify(catalogFile.replace(/\\/g, "/"))}`,
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="workspace-write"',
  ];
  // --image accepts multiple values, so the separate-argument form consumes
  // the trailing prompt as a second filename. The equals form terminates the
  // option unambiguously and leaves the real prompt positional.
  if (imagePath) args.push(`--image=${imagePath}`);
  args.push(prompt);
  const child = spawn("codex", args, {
    env: { ...process.env, CODEX_HOME: clientCodexHome, OPENAI_API_KEY: "fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(child, "exit");
  return { exitCode, stdout, stderr };
}

test("current installed Codex sends bounded Qwen images directly and after nodeRepl.emitImage", { timeout: 180_000 }, async (t) => {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (probe.error?.code === "ENOENT") {
    t.skip("Codex is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-vision-"));
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const imagePath = path.join(workspace, "large-current-codex-image.png");
  const originalPng = visionFixturePng();
  await writeFile(imagePath, originalPng);
  assert.ok(originalPng.byteLength * 4 / 3 > IMAGE_LIMIT, "fixture must exceed the provider image budget");

  const live = process.env.MODELDOCK_LIVE_VISION === "1";
  let liveTarget = null;
  if (live) {
    const { loadConfig } = await import("../src/config.mjs");
    const liveConfig = loadConfig();
    const token = liveConfig.tokens?.["opencode-go"];
    assert.ok(token, "MODELDOCK_LIVE_VISION requires a configured OpenCode Go token");
    liveTarget = { url: `${liveConfig.opencodeBaseUrl}/chat/completions`, token };
  }
  let scenario = "direct";
  const requests = { direct: [], tool: [] };
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests[scenario].push(body);
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "expected Chat Completions" }));
      return;
    }
    const forwardLive = async () => {
      const upstreamResponse = await fetch(liveTarget.url, {
        method: "POST",
        headers: { authorization: `Bearer ${liveTarget.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const bytes = Buffer.from(await upstreamResponse.arrayBuffer());
      res.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") || "application/json" });
      res.end(bytes);
    };
    if (scenario === "direct" && live) {
      await forwardLive();
      return;
    }
    if (scenario === "direct") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textStream("DIRECT_IMAGE_OK"));
      return;
    }
    if (requests.tool.length === 1) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(toolStream(imagePath));
      return;
    }
    if (live) {
      await forwardLive();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(textStream("TOOL_IMAGE_OK"));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gatewayProbe = http.createServer();
  const gatewayPort = await listen(gatewayProbe);
  await closeServer(gatewayProbe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\codex-vision-${process.pid}`;
  const autostartName = `ModelDockCodexVision${process.pid}`;
  const gateway = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENCODE_GO_TOKEN: "fixture-token",
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CODEX_HOME: codexHome,
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
  const clientCodexHome = path.join(os.homedir(), ".codex");

  const directPrompt = live
    ? "Inspect the attached image. Reply with exactly LEFT_RED_RIGHT_BLUE."
    : "Inspect the attached image, then finish.";
  const direct = await runCodex({ clientCodexHome, workspace, gatewayPort, catalogFile, imagePath, prompt: directPrompt });
  assert.equal(direct.exitCode, 0, `${direct.stderr}\n${direct.stdout}\n${gatewayStderr}`);
  assert.match(direct.stdout, live ? /LEFT_RED_RIGHT_BLUE/ : /DIRECT_IMAGE_OK/);
  assert.equal(requests.direct.length, 1);
  assert.ok(requests.direct[0].tools.length > 100, `the live client sent only ${requests.direct[0].tools.length} tools`);
  const directImages = imageUrls(requests.direct[0]);
  assert.equal(directImages.length, 1);
  assert.match(directImages[0], /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.byteLength(directImages[0]) <= IMAGE_LIMIT);

  scenario = "tool";
  const toolPrompt = live
    ? "After the requested image tool returns, inspect it and reply with exactly LEFT_RED_RIGHT_BLUE."
    : "Use the requested image tool, inspect its result, then finish.";
  const tool = await runCodex({ clientCodexHome, workspace, gatewayPort, catalogFile, prompt: toolPrompt });
  assert.equal(tool.exitCode, 0, `${tool.stderr}\n${tool.stdout}\n${gatewayStderr}`);
  assert.match(tool.stdout, live ? /LEFT_RED_RIGHT_BLUE/ : /TOOL_IMAGE_OK/);
  assert.equal(requests.tool.length, 2, "Codex must send the image-tool continuation");
  assert.ok(
    requests.tool[1].messages.some((message) => message.tool_calls?.some((call) => call.id === "call_current_codex_emit_image")),
    "the complete continuation must replay the requested visual tool call",
  );
  const toolImages = imageUrls(requests.tool[1]);
  assert.equal(toolImages.length, 1);
  assert.match(toolImages[0], /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.byteLength(toolImages[0]) <= IMAGE_LIMIT);
  assert.deepEqual(await readFile(imagePath), originalPng, "transport compression never rewrites the user's source image");
});

test("live current Codex image envelope works on new GLM and Grok vision candidates", { timeout: 180_000 }, async (t) => {
  if (process.env.MODELDOCK_LIVE_VISION_MATRIX !== "1") {
    t.skip("set MODELDOCK_LIVE_VISION_MATRIX=1 for subscribed provider coupling checks");
    return;
  }
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const { loadConfig } = await import("../src/config.mjs");
  const liveConfig = loadConfig();
  const token = liveConfig.tokens?.["opencode-go"];
  assert.ok(token, "live vision matrix requires a configured OpenCode Go token");

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-vision-matrix-"));
  const stateDir = path.join(root, "state");
  const gatewayCodexHome = path.join(root, "gateway-codex-home");
  const workspace = path.join(root, "workspace");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(gatewayCodexHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(workspace, "vision-matrix.png");
  await writeFile(imagePath, visionFixturePng());

  const gatewayProbe = http.createServer();
  const gatewayPort = await listen(gatewayProbe);
  await closeServer(gatewayProbe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\codex-vision-matrix-${process.pid}`;
  const autostartName = `ModelDockCodexVisionMatrix${process.pid}`;
  const gateway = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_UPSTREAM_BASE_URL: liveConfig.opencodeBaseUrl,
      OPENCODE_GO_TOKEN: token,
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
  const clientCodexHome = path.join(os.homedir(), ".codex");

  for (const model of ["glm-5.3-flash@opencode-go", "grok-4.6@opencode-go"]) {
    const result = await runCodex({
      clientCodexHome,
      workspace,
      gatewayPort,
      catalogFile,
      model,
      imagePath,
      prompt: "Inspect the attached image. Reply with exactly LEFT_RED_RIGHT_BLUE.",
    });
    assert.equal(result.exitCode, 0, `${model}\n${result.stderr}\n${result.stdout}\n${gatewayStderr}`);
    assert.match(result.stdout, /LEFT_RED_RIGHT_BLUE/, model);
    const status = await fetch(`http://127.0.0.1:${gatewayPort}/api/status`).then((response) => response.json());
    const trace = status.recent.find((entry) => entry.kind === "responses" && entry.model === model);
    assert.equal(trace?.status, "ok", `${model}: ${trace?.error || "missing trace"}`);
    assert.equal(trace.imageTransfer?.received?.images, 1);
    assert.equal(trace.imageTransfer?.forwarded?.images, 1);
  }
});

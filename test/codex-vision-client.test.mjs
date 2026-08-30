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

function toolStream(imagePaths, sequence) {
  const code = [
    'var fsVisionProbe = await import("node:fs");',
    ...imagePaths.flatMap((imagePath, index) => [
      `var bytesVisionProbe${index} = fsVisionProbe.readFileSync(${JSON.stringify(imagePath.replace(/\\/g, "/"))});`,
      `await nodeRepl.emitImage(bytesVisionProbe${index});`,
    ]),
  ].join("\n");
  const callId = `call_current_codex_emit_image_${sequence}`;
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
          id: callId,
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

function responseImageUrls(body) {
  const urls = [];
  for (const item of body.input || []) {
    if (!Array.isArray(item?.content)) continue;
    for (const part of item.content) {
      if (part?.type === "input_image" && typeof part.image_url === "string") urls.push(part.image_url);
    }
  }
  return urls;
}

function visionFixturePng(seed = 0x76543210) {
  const width = 900;
  const height = 600;
  const pixels = new Uint8Array(width * height * 3);
  let random = seed;
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

async function runCodex({ clientCodexHome, workspace, gatewayPort, catalogFile, model = "qwen3.8-flash@opencode-go", imagePath = "", imagePaths = [], prompt }) {
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
  for (const path of imagePaths.length ? imagePaths : imagePath ? [imagePath] : []) {
    args.push(`--image=${path}`);
  }
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
  const toolImagePaths = [];
  for (let index = 0; index < 7; index += 1) {
    const toolPath = path.join(workspace, `tool-image-${index}.png`);
    await writeFile(toolPath, visionFixturePng(0x12340000 + index));
    toolImagePaths.push(toolPath);
  }
  const toolImageBatches = [
    toolImagePaths.slice(0, 1),
    toolImagePaths.slice(1, 3),
    toolImagePaths.slice(3, 7),
  ];

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
  const requests = { direct: [], crowded: [], tool: [] };
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
    if (scenario === "crowded") {
      if (live) {
        await forwardLive();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textStream("CROWDED_IMAGE_OK"));
      return;
    }
    if (scenario === "tool" && requests.tool.length <= toolImageBatches.length) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(toolStream(toolImageBatches[requests.tool.length - 1], requests.tool.length));
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
  assert.ok(requests.direct.length >= 1, "the direct Codex image turn must reach the upstream");
  assert.ok(requests.direct[0].tools.length > 100, `the live client sent only ${requests.direct[0].tools.length} tools`);
  const directToolNames = new Set(requests.direct[0].tools.map((tool) => tool?.function?.name).filter(Boolean));
  const hasDirectTool = (name) => [...directToolNames].some((toolName) => toolName === name || toolName.endsWith(`__${name}`));
  assert.ok(hasDirectTool("view_image"), "a vision model receives Codex's direct image viewer");
  assert.ok(hasDirectTool("preview_images"), "a vision model receives bounded local image previews");
  assert.equal(hasDirectTool("vision_inspect"), false, "a vision model does not receive the delegated vision tool");
  const directImages = imageUrls(requests.direct[0]);
  assert.equal(directImages.length, 1);
  assert.match(directImages[0], /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.byteLength(directImages[0]) <= IMAGE_LIMIT);
  assert.ok(
    requests.direct.every((request) => imageUrls(request).reduce((sum, url) => sum + Buffer.byteLength(url), 0) <= IMAGE_LIMIT),
    "every direct-image continuation stays inside the total image budget",
  );

  const crowdedImagePaths = [];
  for (let index = 0; index < 12; index += 1) {
    const crowdedPath = path.join(workspace, `crowded-current-image-${index}.png`);
    await writeFile(crowdedPath, visionFixturePng(0x76543210 + index));
    crowdedImagePaths.push(crowdedPath);
  }
  scenario = "crowded";
  const crowded = await runCodex({
    clientCodexHome,
    workspace,
    gatewayPort,
    catalogFile,
    imagePaths: crowdedImagePaths,
    prompt: live
      ? "Inspect the attached images and reply with exactly CROWDED_IMAGE_OK."
      : "Inspect the attached images, then finish.",
  });
  assert.equal(crowded.exitCode, 0, `${crowded.stderr}\n${crowded.stdout}\n${gatewayStderr}`);
  assert.match(crowded.stdout, /CROWDED_IMAGE_OK/);
  assert.ok(requests.crowded.length >= 1, "the crowded Codex turn must reach the upstream");
  assert.equal(imageUrls(requests.crowded[0]).length, 10, "the useful transport floor keeps ten large current images inline");
  assert.equal(
    (JSON.stringify(requests.crowded[0]).match(/Image attachment img_/g) || []).length,
    2,
    "the two overflow images remain available through canonical refs",
  );
  assert.ok(
    requests.crowded.every((request) => imageUrls(request).reduce((sum, url) => sum + Buffer.byteLength(url), 0) <= IMAGE_LIMIT),
    "every model-driven continuation stays inside the same total image budget",
  );

  scenario = "tool";
  const toolPrompt = live
    ? "After the requested image tool returns, inspect it and reply with exactly LEFT_RED_RIGHT_BLUE."
    : "Use the requested image tool, inspect its result, then finish.";
  const tool = await runCodex({ clientCodexHome, workspace, gatewayPort, catalogFile, prompt: toolPrompt });
  assert.equal(tool.exitCode, 0, `${tool.stderr}\n${tool.stdout}\n${gatewayStderr}`);
  assert.match(tool.stdout, live ? /LEFT_RED_RIGHT_BLUE/ : /TOOL_IMAGE_OK/);
  assert.ok(requests.tool.length >= 4, "Codex must continue through all three image-tool batches");
  assert.ok(
    requests.tool.some((request) => request.messages.some((message) => message.tool_calls?.some((call) => call.id === "call_current_codex_emit_image_3"))),
    "the complete continuation must replay the latest requested visual tool call",
  );
  assert.deepEqual(
    requests.tool.slice(0, 4).map((request) => imageUrls(request).length),
    [0, 1, 3, 7],
    "images accumulate within one Codex user turn until the transport budget spills them to refs",
  );
  const finalToolImages = imageUrls(requests.tool[3]);
  assert.ok(finalToolImages.every((url) => /^data:image\/jpeg;base64,/.test(url)));
  assert.ok(finalToolImages.every((url) => Buffer.byteLength(url) <= IMAGE_LIMIT / finalToolImages.length));
  assert.equal(
    (JSON.stringify(requests.tool[3]).match(/Image attachment img_/g) || []).length,
    0,
    "seven large images still fit the 320 KiB floor and need no refs",
  );
  assert.ok(
    requests.tool.every((request) => imageUrls(request).reduce((sum, url) => sum + Buffer.byteLength(url), 0) <= IMAGE_LIMIT),
    "every tool continuation stays inside the same total image budget",
  );
  assert.deepEqual(await readFile(imagePath), originalPng, "transport compression never rewrites the user's source image");
});

test("live current Codex image envelope works on the Grok 4.6 vision route", { timeout: 180_000 }, async (t) => {
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

  const upstreamDiagnostics = [];
  const upstreamProxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(bytes.toString("utf8"));
    const upstreamResponse = await fetch(`${liveConfig.opencodeBaseUrl.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    });
    const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
    const images = responseImageUrls(body);
    upstreamDiagnostics.push({
      status: upstreamResponse.status,
      topLevelKeys: Object.keys(body).sort(),
      toolTypes: [...new Set((body.tools || []).map((tool) => tool?.type || "missing"))].sort(),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      inputTypes: Array.isArray(body.input) ? body.input.map((item) => item?.type || "missing") : [],
      callNames: Array.isArray(body.input)
        ? body.input.filter((item) => item?.type === "function_call").map((item) => item.name)
        : [],
      imageWireBytes: images.map((image) => Buffer.byteLength(image)),
    });
    res.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") || "application/json" });
    res.end(responseBytes);
  });
  const upstreamProxyPort = await listen(upstreamProxy);
  t.after(() => closeServer(upstreamProxy));

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
      MODELDOCK_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamProxyPort}/v1`,
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

  const model = "grok-4.6@opencode-go";
  const direct = await runCodex({
    clientCodexHome,
    workspace,
    gatewayPort,
    catalogFile,
    model,
    imagePath,
    prompt: "Inspect the attached image. Reply with exactly LEFT_RED_RIGHT_BLUE.",
  });
  let status = await fetch(`http://127.0.0.1:${gatewayPort}/api/status`).then((response) => response.json());
  let trace = status.recent.find((entry) => entry.kind === "responses" && entry.model === model);
  let failure = `${model}\n${direct.stderr}\n${direct.stdout}\n${gatewayStderr}\n${JSON.stringify({ trace, upstreamDiagnostics }, null, 2)}`;
  assert.equal(direct.exitCode, 0, failure);
  assert.match(direct.stdout, /LEFT_RED_RIGHT_BLUE/, model);
  assert.equal(trace?.status, "ok", `${model}: ${trace?.error || "missing trace"}`);
  assert.equal(trace.imageTransfer?.received?.images, 1);
  assert.equal(trace.imageTransfer?.forwarded?.images, 1);
  assert.ok(upstreamDiagnostics[0].toolCount > 100, "the complete Codex tool set must reach the model policy");
  assert.deepEqual(upstreamDiagnostics[0].toolTypes, ["function"]);
  assert.equal(upstreamDiagnostics[0].imageWireBytes.length, 1);
  assert.ok(upstreamDiagnostics[0].imageWireBytes[0] <= IMAGE_LIMIT);

  const continuationStart = upstreamDiagnostics.length;
  const continuation = await runCodex({
    clientCodexHome,
    workspace,
    gatewayPort,
    catalogFile,
    model,
    imagePath,
    prompt: "First call the node_repl JavaScript tool to evaluate and return the string GROK_TOOL_OK. After its result, inspect the attached image and reply with exactly GROK_TOOL_OK_LEFT_RED_RIGHT_BLUE.",
  });
  status = await fetch(`http://127.0.0.1:${gatewayPort}/api/status`).then((response) => response.json());
  trace = status.recent.find((entry) => entry.kind === "responses" && entry.model === model);
  const continuationWires = upstreamDiagnostics.slice(continuationStart);
  failure = `${model} continuation\n${continuation.stderr}\n${continuation.stdout}\n${gatewayStderr}\n${JSON.stringify({ trace, continuationWires }, null, 2)}`;
  assert.equal(continuation.exitCode, 0, failure);
  assert.match(continuation.stdout, /GROK_TOOL_OK_LEFT_RED_RIGHT_BLUE/, model);
  assert.ok(continuationWires.length >= 2, "Grok must continue after the namespace tool result");
  assert.ok(continuationWires.some((wire) => wire.callNames.includes("mcp__node_repl__js")));
  assert.ok(continuationWires.every((wire) => wire.toolTypes.length === 1 && wire.toolTypes[0] === "function"));
});

test("live current Codex tool continuation works on the HY4 Preview Chat route", { timeout: 180_000 }, async (t) => {
  if (process.env.MODELDOCK_LIVE_HY4 !== "1") {
    t.skip("set MODELDOCK_LIVE_HY4=1 for the subscribed HY4 coupling check");
    return;
  }
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const { loadConfig } = await import("../src/config.mjs");
  const liveConfig = loadConfig();
  const token = liveConfig.tokens?.["opencode-go"];
  assert.ok(token, "live HY4 check requires a configured OpenCode Go token");

  const upstreamDiagnostics = [];
  const upstreamProxy = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(bytes.toString("utf8"));
    const upstreamResponse = await fetch(`${liveConfig.opencodeBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: bytes,
      signal: AbortSignal.timeout(120_000),
    });
    const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
    upstreamDiagnostics.push({
      status: upstreamResponse.status,
      responseText: upstreamResponse.ok ? "" : responseBytes.toString("utf8").slice(0, 2_000),
      topLevelKeys: Object.keys(body).sort(),
      toolTypes: [...new Set((body.tools || []).map((tool) => tool?.type || "missing"))].sort(),
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
      messageRoles: Array.isArray(body.messages) ? body.messages.map((message) => message?.role || "missing") : [],
      callNames: Array.isArray(body.messages)
        ? body.messages.flatMap((message) => (message?.tool_calls || []).map((call) => call?.function?.name).filter(Boolean))
        : [],
      imageWireBytes: imageUrls(body).map((image) => Buffer.byteLength(image)),
    });
    res.writeHead(upstreamResponse.status, { "content-type": upstreamResponse.headers.get("content-type") || "application/json" });
    res.end(responseBytes);
  });
  const upstreamProxyPort = await listen(upstreamProxy);
  t.after(() => closeServer(upstreamProxy));

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-hy4-"));
  const stateDir = path.join(root, "state");
  const gatewayCodexHome = path.join(root, "gateway-codex-home");
  const workspace = path.join(root, "workspace");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(gatewayCodexHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const imagePath = path.join(workspace, "hy4-vision.png");
  const width = 320;
  const height = 200;
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 3;
      pixels[index] = x < width / 2 ? 255 : 0;
      pixels[index + 1] = 0;
      pixels[index + 2] = x < width / 2 ? 0 : 255;
    }
  }
  await writeFile(imagePath, Buffer.from(encodePng({ width, height, channels: 3, depth: 8, data: pixels })));

  const gatewayProbe = http.createServer();
  const gatewayPort = await listen(gatewayProbe);
  await closeServer(gatewayProbe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\codex-hy4-${process.pid}`;
  const autostartName = `ModelDockCodexHy4${process.pid}`;
  const gateway = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamProxyPort}/v1`,
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

  const model = "hy4-preview@opencode-go";
  const result = await runCodex({
    clientCodexHome: path.join(os.homedir(), ".codex"),
    workspace,
    gatewayPort,
    catalogFile,
    model,
    imagePath,
    prompt: "First call the node_repl JavaScript tool to evaluate and return the string HY4_TOOL_OK. After its result, inspect the attached image and reply with exactly HY4_TOOL_OK_LEFT_RED_RIGHT_BLUE.",
  });
  const status = await fetch(`http://127.0.0.1:${gatewayPort}/api/status`).then((response) => response.json());
  const trace = status.recent.find((entry) => entry.kind === "responses" && entry.model === model);
  const failure = `${model}\n${result.stderr}\n${result.stdout}\n${gatewayStderr}\n${JSON.stringify({ trace, upstreamDiagnostics }, null, 2)}`;
  assert.equal(result.exitCode, 0, failure);
  assert.match(result.stdout, /HY4_TOOL_OK_LEFT_RED_RIGHT_BLUE/, model);
  assert.equal(trace?.status, "ok", `${failure}\n${trace?.error || "missing trace"}`);
  assert.ok(upstreamDiagnostics.length >= 2, "HY4 must continue after the real Codex namespace tool result");
  assert.ok(upstreamDiagnostics[0].toolCount > 100, "the complete current Codex tool set must reach the model policy");
  assert.ok(upstreamDiagnostics.some((wire) => wire.callNames.includes("mcp__node_repl__js")));
  assert.ok(upstreamDiagnostics.some((wire) => wire.imageWireBytes.length === 1), "the complete Codex image envelope must reach HY4");
});

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repoRoot, "dist", "modeldock.mjs");

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
      // The bundle may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("built gateway did not start");
}

function stream(events) {
  return [...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n");
}

test("installed Codex replays bridged Chat reasoning and a custom tool on the next turn", { timeout: 60_000 }, async (t) => {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (probe.error?.code === "ENOENT") {
    t.skip("Codex is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-chat-reasoning-"));
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(codexHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const requests = [];
  const patchInput = "*** Begin Patch\n*** Add File: reasoning-round-trip.txt\n+CUSTOM_TOOL_OK\n*** End Patch";
  let replayedReasoning = "";
  let replayedCustomInput = "";
  let replayedToolOutput = "";
  let protocolError = "";
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (req.url !== "/v1/chat/completions") {
      protocolError = `unexpected upstream route ${req.url}`;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: protocolError }));
      return;
    }
    const toolIds = new Set((body.messages || []).filter((message) => message.role === "tool").map((message) => message.tool_call_id));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (toolIds.has("call_reasoning_client")) {
      const assistant = body.messages.find((message) => message.tool_calls?.some((call) => call.id === "call_reasoning_client"));
      replayedReasoning = assistant?.reasoning_content || "";
      const call = assistant?.tool_calls?.find((item) => item.id === "call_reasoning_client");
      const callArguments = typeof call?.function?.arguments === "string"
        ? JSON.parse(call.function.arguments)
        : call?.function?.arguments;
      replayedCustomInput = callArguments?.input || "";
      replayedToolOutput = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "call_reasoning_client")?.content || "";
      res.end(stream([{
        id: "chatcmpl_reasoning_client_done",
        created: 22,
        model: "qwen3.8-flash",
        choices: [{ index: 0, delta: { role: "assistant", content: "REASONING_ROUND_TRIP_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 4 },
      }]));
      return;
    }
    res.end(stream([
      {
        id: "chatcmpl_reasoning_client",
        created: 21,
        model: "qwen3.8-flash",
        choices: [{ index: 0, delta: {
          role: "assistant",
          reasoning: "Apply the requested patch, then continue from its result.",
          tool_calls: [{ index: 0, id: "call_reasoning_client", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: patchInput }) } }],
        }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 90, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 12 } },
      },
    ]));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  const gatewayProbe = http.createServer();
  const gatewayPort = await listen(gatewayProbe);
  await closeServer(gatewayProbe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\codex-chat-reasoning-${process.pid}`;
  const autostartName = `ModelDockCodexChatReasoning${process.pid}`;
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
  await writeFile(path.join(codexHome, "config.toml"), [
    'model = "qwen3.8-flash@opencode-go"',
    `openai_base_url = ${JSON.stringify(`http://127.0.0.1:${gatewayPort}/v1`)}`,
    `model_catalog_json = ${JSON.stringify(catalogFile.replace(/\\/g, "/"))}`,
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    "",
  ].join("\n"), "utf8");

  const codex = spawn("codex", [
    "exec",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "--json",
    "-C",
    workspace,
    "Apply the requested patch and finish the task.",
  ], {
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  codex.stdout.on("data", (chunk) => { stdout += chunk; });
  codex.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stop(codex));
  const [exitCode] = await once(codex, "exit");
  assert.equal(exitCode, 0, `${stderr}\n${stdout}\n${gatewayStderr}`);
  assert.equal(protocolError, "");
  assert.ok(requests.length >= 2, "Codex must send a tool continuation request");
  assert.equal(replayedReasoning, "Apply the requested patch, then continue from its result.");
  assert.equal(replayedCustomInput, patchInput);
  assert.match(replayedToolOutput, /Done|Success|reasoning-round-trip/i, `${replayedToolOutput}\n${stdout}`);
  const written = await readFile(path.join(workspace, "reasoning-round-trip.txt"), "utf8").catch((error) => {
    throw new Error(`${error.message}\nCodex output:\n${stdout}\nGateway stderr:\n${gatewayStderr}`);
  });
  assert.equal(written, "CUSTOM_TOOL_OK\n");
  assert.match(stdout, /REASONING_ROUND_TRIP_OK/);
});

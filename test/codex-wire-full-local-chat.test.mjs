// Full Codex-to-ModelDock local Chat compatibility fixture.
//
// The request is the same sanitized original Codex package used for strict
// provider-wire testing. This test changes only the selected model, then proves
// the built bundle sends a real Chat Completions request to a strict local
// upstream and returns a complete Codex Responses tool lifecycle.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitForStatus(port) {
  let lastError = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`built bundle did not start${lastError ? `: ${lastError.message}` : ""}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
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

function completedResponse(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.completed") return event.response;
  }
  throw new Error("Responses stream had no completed response");
}

test("built bundle bridges the complete original Codex package to strict local Chat", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.request.tools.length, 164);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-wire-local-chat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  const autostartKey = `HKCU\\Software\\ModelDockTests\\full-local-chat-${process.pid}`;
  const autostartName = `ModelDockFullLocalChat${process.pid}`;
  await mkdir(stateDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "expected Chat Completions endpoint" }));
      return;
    }
    if (body.input !== undefined || body.instructions !== undefined || body.include !== undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Responses-only field reached Chat upstream" }));
      return;
    }
    if (!Array.isArray(body.messages) || !body.messages.length || !Array.isArray(body.tools) || !body.tools.length || body.tools.some((tool) => tool?.type !== "function" || !tool.function?.name)) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid Chat tool package" }));
      return;
    }
    if (!body.cache_prompt || body.stream_options?.include_usage !== true) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "cache or stream usage request missing" }));
      return;
    }
    const toolIds = new Set(body.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (toolIds.has("call_local_fixture")) {
      res.end([
        'data: {"id":"chatcmpl_full_fixture_done","created":22,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","reasoning_text":"The command completed successfully.","content":"LOCAL_FIXTURE_DONE"},"finish_reason":"stop"}],"usage":{"prompt_tokens":8340,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":8304},"completion_tokens_details":{"reasoning_tokens":8}}}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    res.end([
      'data: {"id":"chatcmpl_full_fixture","created":21,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Run the requested command and inspect its result.","tool_calls":[{"index":0,"id":"call_local_fixture","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\""}}]}}]}',
      'data: {"id":"chatcmpl_full_fixture","model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"echo LOCAL_FIXTURE\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8308,"completion_tokens":19,"prompt_tokens_details":{"cached_tokens":8304},"completion_tokens_details":{"reasoning_tokens":10}}}',
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  await writeFile(path.join(stateDir, "local-engines.json"), JSON.stringify({
    llamacpp: {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      models: [{ id: "Qwen3.8-27B", upstreamId: "Qwen3.8-27B", label: "Qwen3.8-27B", supportsVision: false, contextWindow: 32_768 }],
    },
  }), "utf8");
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const child = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "llamacpp",
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
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await stop(child);
    if (process.platform === "win32") {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* key may not exist */ }
    }
  });
  await waitForStatus(gatewayPort);
  const selectedModel = "Qwen3.8-27B@llamacpp";
  const send = async (input) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": "full-local-fixture" },
      body: JSON.stringify({ ...fixture.request, model: selectedModel, input }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `built bundle rejected the full package: ${text}\n${stderr}`);
    return text;
  };
  const first = await send(fixture.request.input);
  const firstToolNames = new Set(requests[0].tools.map((tool) => tool.function.name));
  for (const name of ["exec_command", "mcp__modeldock__learn", "mcp__node_repl__js", "mcp__codex_apps__github___search_repositories"]) {
    assert.ok(firstToolNames.has(name), `the complete local tool surface keeps ${name}`);
  }
  assert.equal(firstToolNames.has("view_image"), false, "the text-only model still hides the incompatible pixel viewer");
  assert.match(first, /response\.function_call_arguments\.done/);
  assert.match(first, /response\.reasoning_text\.done/);
  assert.match(first, /exec_command/);
  assert.match(first, /cached_tokens":8304/);
  const firstOutput = completedResponse(first).output;
  assert.deepEqual(firstOutput.map((item) => item.type), ["reasoning", "function_call"]);
  const second = await send([
    ...fixture.request.input,
    ...firstOutput,
    { type: "function_call_output", call_id: "call_local_fixture", output: "LOCAL_FIXTURE" },
  ]);
  assert.match(second, /LOCAL_FIXTURE_DONE/);
  const replayedAssistant = requests[1].messages.find((message) => message.tool_calls?.some((call) => call.id === "call_local_fixture"));
  assert.equal(replayedAssistant?.reasoning_content, "Run the requested command and inspect its result.");

  // The transition that broke in 0.3.77 and never worked for a scheduled wake:
  // Codex delivers an automation heartbeat (and a cross-thread message) as a
  // function_call_output that has an id, a name and a turn_id but NO call_id, so
  // the pairing pass used to delete the instruction along with the tool row. The
  // model then saw a history ending in its own previous report and kept writing it.
  // Replay it through the built bundle and prove the strict Chat upstream receives
  // the text as a user turn while the pairing contract still holds.
  const wake = {
    type: "function_call_output",
    id: "fco_local_wake",
    name: "automation_update",
    namespace: "codex_app",
    output: "<heartbeat>\n<automation_id>trader-cycle</automation_id>\nSTEP 0 - read the market clock first.\n</heartbeat>",
    internal_chat_message_metadata_passthrough: { turn_id: "local-wake-turn" },
  };
  const third = await send([...fixture.request.input, wake]);
  assert.match(third, /response\.completed/);
  const wakeMessages = requests[2].messages;
  assert.equal(wakeMessages.at(-1).role, "user", "the delivered wake is the turn the model is asked to answer");
  assert.match(String(wakeMessages.at(-1).content), /STEP 0 - read the market clock first\./);
  assert.equal(
    wakeMessages.filter((message) => message.role === "tool" && message.tool_call_id === "fco_local_wake").length,
    0,
    "a delivery never becomes an unpaired tool row",
  );
  assert.equal(
    JSON.stringify(wakeMessages).includes("automation_update"),
    false,
    "the delivering tool name is not invented as an upstream call",
  );
});


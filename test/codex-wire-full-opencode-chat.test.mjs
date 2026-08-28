// Full original Codex package through the generic remote Chat route.
//
// This fixture retains all 164 tool declarations from an actual sanitized
// desktop request. The strict upstream rejects any Responses-only fields and
// every non-function Chat tool, so this proves the built bundle's complete
// wire conversion rather than a hand-authored subset.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));

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
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
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

function sse(events) {
  return [...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n");
}

function completedResponse(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.completed") return event.response;
  }
  throw new Error("Responses stream had no completed response");
}

function toolStream(calls, { reasoningField = "reasoning", reasoningText = "" } = {}) {
  const firstDelta = {
    role: "assistant",
    ...(reasoningText ? { [reasoningField]: reasoningText } : {}),
    tool_calls: calls.map((call, index) => ({
      index,
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments.slice(0, Math.ceil(call.arguments.length / 2)) },
    })),
  };
  return sse([
    {
      id: "chatcmpl_go_fixture",
      created: 21,
      model: "qwen3.8-flash",
      choices: [{ index: 0, delta: firstDelta }],
    },
    {
      id: "chatcmpl_go_fixture",
      model: "qwen3.8-flash",
      choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({
        index,
        function: { arguments: call.arguments.slice(Math.ceil(call.arguments.length / 2)) },
      })) }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 8308, completion_tokens: 19, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 10 } },
    },
  ]);
}

function textStream(text) {
  return sse([{
    id: "chatcmpl_go_fixture",
    created: 21,
    model: "qwen3.8-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 8308, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } },
  }]);
}

test("built bundle bridges the complete original Codex package to strict OpenCode Chat", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.capture.originalToolCount, 164);
  assert.equal(fixture.request.tools.length, 164);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-wire-go-chat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
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
    if (body.input !== undefined || body.instructions !== undefined || body.include !== undefined || body.cache_prompt !== undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Responses-only or local-only field reached Chat upstream" }));
      return;
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing Chat messages" }));
      return;
    }
    if (body.model !== "qwen3.8-flash") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "wrong Go Chat model" }));
      return;
    }
    if (body.stream === false) {
      if (body.tools?.length || body.tool_choice !== "none" || !body.messages.at(-1)?.content.includes("CONTEXT CHECKPOINT COMPACTION")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid compaction Chat request" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl_go_compact",
        model: "qwen3.8-flash",
        choices: [{ index: 0, message: { role: "assistant", content: "GO_COMPACTION_FIXTURE" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8308, completion_tokens: 9 },
      }));
      return;
    }
    if (body.stream !== true || body.stream_options?.include_usage !== true || !Array.isArray(body.tools) || body.tools.length !== 162 || body.tools.some((tool) => tool?.type !== "function" || !tool.function?.name)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing Go Chat stream contract" }));
      return;
    }
    const toolIds = new Set(body.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
    const resumed = body.messages.some((message) => typeof message.content === "string" && message.content.includes("Resume after compaction"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (resumed) {
      res.end(textStream("GO_COMPACTION_RESUMED"));
    } else if (toolIds.has("call_go_c")) {
      res.end(textStream("GO_TOOL_LOOP_COMPLETE"));
    } else if (toolIds.has("call_go_a") && toolIds.has("call_go_b")) {
      res.end(toolStream(
        [{ id: "call_go_c", name: "write_stdin", arguments: "{\"session_id\":0,\"chars\":\"continue\"}" }],
        { reasoningField: "reasoning_text", reasoningText: "The first tools completed; continue the same task." },
      ));
    } else {
      res.end(toolStream(
        [
          { id: "call_go_a", name: "exec_command", arguments: "{\"cmd\":\"echo GO_A\"}" },
          { id: "call_go_b", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
        ],
        { reasoningField: "reasoning", reasoningText: "Inspect both sources before continuing." },
      ));
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\full-go-chat-${process.pid}`;
  const autostartName = `ModelDockFullGoChat${process.pid}`;
  const child = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      OPENCODE_GO_TOKEN: "fixture-token",
      MODELDOCK_STATE_DIR: path.join(root, "state"),
      MODELDOCK_CODEX_HOME: path.join(root, "codex-home"),
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
  const send = async (input, sessionId, stream = true) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": sessionId },
      body: JSON.stringify({ ...fixture.request, model: "qwen3.8-flash@opencode-go", stream, input }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `built bundle rejected the full package: ${text}\n${stderr}`);
    return text;
  };
  const first = await send(fixture.request.input, "full-go-chat-fixture");
  assert.match(first, /response\.function_call_arguments\.done/);
  assert.match(first, /call_go_a/);
  assert.match(first, /call_go_b/);
  assert.match(first, /response\.reasoning_text\.done/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools.length, 162, "only the two universally unsupported hosted tools are removed before the generic Chat bridge");
  const firstOutput = completedResponse(first).output;
  assert.deepEqual(firstOutput.map((item) => item.type), ["reasoning", "function_call", "function_call"]);
  const firstTurn = [
    ...firstOutput,
    { type: "function_call_output", call_id: "call_go_a", output: "GO_A" },
    { type: "function_call_output", call_id: "call_go_b", output: "# ModelDock" },
  ];
  const second = await send([...fixture.request.input, ...firstTurn], "full-go-chat-fixture");
  assert.match(second, /call_go_c/);
  assert.equal(requests[1].messages.find((message) => message.tool_calls?.some((call) => call.id === "call_go_a"))?.reasoning_content, "Inspect both sources before continuing.");
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "call_go_a"));
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "call_go_b"));
  const secondOutput = completedResponse(second).output;
  const third = await send([...fixture.request.input, ...firstTurn, ...secondOutput,
    { type: "function_call_output", call_id: "call_go_c", output: "done" },
  ], "full-go-chat-fixture");
  assert.match(third, /GO_TOOL_LOOP_COMPLETE/);
  assert.equal(requests[2].messages.find((message) => message.tool_calls?.some((call) => call.id === "call_go_c"))?.reasoning_content, "The first tools completed; continue the same task.");
  const compact = await send([...fixture.request.input,
    { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize the completed work." }] },
    { type: "compaction_trigger" },
  ], "full-go-chat-fixture", false);
  const compacted = JSON.parse(compact);
  assert.equal(compacted.output[0].type, "compaction");
  assert.match(compacted.output[0].encrypted_content, /^kcr1:/);
  const resumed = await send([
    ...fixture.request.input,
    compacted.output[0],
    { type: "message", role: "user", content: [{ type: "input_text", text: "Resume after compaction." }] },
  ], "full-go-chat-fixture");
  assert.match(resumed, /GO_COMPACTION_RESUMED/);
});

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
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));
const longFixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/voxel-commandcode-native-compact-2026-09-02.json.gz", import.meta.url))).toString("utf8"));

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

// A real upstream answers for the whole request when one tool name is longer than
// 64 characters, and the captured Codex desktop package carries five such plugin
// tools - the reason a Muse Spark turn ended with a 400 instead of an answer.
function overLongToolNames(body) {
  const names = [
    ...(body.tools || []).map((tool) => tool?.function?.name ?? tool?.name),
    ...(body.input || []).map((item) => item?.name),
    ...(body.input || []).flatMap((item) => (item?.type === "additional_tools" && Array.isArray(item.tools)
      ? item.tools.map((tool) => tool?.name)
      : [])),
    ...(body.messages || []).flatMap((message) => (message?.tool_calls || []).map((call) => call?.function?.name)),
  ];
  return names.filter((name) => typeof name === "string" && name.length > 64);
}

function assertChatPairs(messages) {
  const used = new Set();
  const pending = new Set();
  for (const message of messages) {
    if (message.role === "tool") {
      assert.ok(pending.delete(message.tool_call_id), "result must belong to the immediately preceding call group");
    } else {
      assert.equal(pending.size, 0, "all parallel results must arrive before another message");
      for (const call of message.tool_calls || []) {
        assert.ok(!used.has(call.id), "each invocation must have a distinct id");
        used.add(call.id);
        pending.add(call.id);
      }
    }
  }
  assert.equal(pending.size, 0, "history must not end in an orphan call");
}

// A routed parallel call group must receive all its results before a message
// starts another turn. Matching aggregate call/result counts is not enough.
function assertResponsesToolPairs(input) {
  const pending = new Set();
  const callId = (item) => item.call_id;
  for (const item of input) {
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      pending.add(callId(item));
      continue;
    }
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      assert.ok(pending.has(callId(item)), `result ${callId(item)} must belong to the open call group`);
      pending.delete(callId(item));
      continue;
    }
    assert.equal(
      pending.size,
      0,
      `nothing may sit between a parallel call group and its results (saw ${item?.type}${item?.role ? ` ${item.role}` : ""} before ${[...pending].join(",")})`,
    );
  }
  assert.equal(pending.size, 0, "history must not end in an orphan call");
}

test("built bundle bridges the complete original Codex package to strict OpenCode Chat", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.capture.originalToolCount, 164);
  assert.equal(fixture.request.tools.length, 164);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-wire-go-chat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const sessionHeaders = [];
  let directoryCalls = 0;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      directoryCalls += 1;
      assert.equal(req.headers.authorization, "Bearer fixture-token");
      res.writeHead(200, { "content-type": "application/json" });
      // The directory deliberately lists a slug NO provider declares: that is what
      // proves discovery still publishes new models. deepseek-v4.1-flash is absent
      // here on purpose - it must be routable because it is declared, with no help
      // from this response, which is the restart-window bug it used to hit.
      res.end(JSON.stringify({ data: [{ id: "deepseek-v4.2-flash" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    sessionHeaders.push(req.headers["x-opencode-session"]);
    if (!["full-go-chat-fixture", "legacy-go-chat-fixture", "other-go-task"].includes(req.headers["x-opencode-session"])) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing stable x-opencode-session" }));
      return;
    }
    if (req.url === "/v1/responses") {
      try {
        assert.ok(["deepseek-v4-flash", "deepseek-v4.1-flash", "deepseek-v4.2-flash"].includes(body.model));
        const calls = body.input.filter((item) => ["function_call", "custom_tool_call"].includes(item.type));
        const results = body.input.filter((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type));
        assert.equal(new Set(calls.map((item) => item.call_id)).size, calls.length);
        assert.deepEqual(results.map((item) => item.call_id), calls.map((item) => item.call_id));
        assert.ok(body.input.every((item) => !item.tool_calls && item.role !== "tool"));
        assertResponsesToolPairs(body.input);
        assert.deepEqual(overLongToolNames(body), [], "every name in the sent package fits the upstream limit");
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse([{ type: "response.completed", response: { id: "resp_history", status: "completed", output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "RESPONSES_HISTORY_OK" }] },
        ] } }]));
      } catch (error) {
        res.writeHead(422, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
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
    try {
      assertChatPairs(body.messages);
    } catch (error) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
    const longNames = overLongToolNames(body);
    if (longNames.length) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `\`name\` must be at most 64 characters, got ${longNames[0].length}` } }));
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
      res.end(JSON.stringify({ error: "missing Go Chat stream contract", toolCount: body.tools?.length }));
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
      MODELDOCK_MODEL_DISCOVERY: "1",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REVIEW_MODEL: "deepseek-v4-pro@opencode-go",
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
  let discovered = false;
  let published = false;
  let declaredWithoutDiscovery = false;
  let wireModels = {};
  let reviewOverrides = [];
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const models = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/models`)).json();
    discovered = models.options.some((model) => model.id === "deepseek-v4.2-flash@opencode-go");
    const catalog = JSON.parse(readFileSync(path.join(root, "state", "codex-model-catalog.json"), "utf8"));
    const byName = (name) => catalog.models.find((model) =>
      String(model.display_name || "").toLowerCase() === `opencode go - ${name}`.toLowerCase())?.slug || "";
    wireModels = {
      qwen: byName("Qwen 3.8 Flash"),
      v4: byName("DeepSeek V4 Flash"),
      v41: byName("DeepSeek V4.1 Flash"),
      v42: byName("DeepSeek V4.2 Flash"),
    };
    reviewOverrides = catalog.models
      .map((model) => model.auto_review_model_override)
      .filter(Boolean);
    published = Boolean(wireModels.v42);
    // The directory above never mentions v4.1: it is only here because it is declared.
    const v41 = models.options.find((model) => model.id === "deepseek-v4.1-flash@opencode-go");
    declaredWithoutDiscovery = Boolean(v41?.contextWindow && v41?.inputNormalizer);
    if (discovered && published && declaredWithoutDiscovery) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(discovered, "boot discovery must publish the new Go model in the picker");
  assert.ok(
    declaredWithoutDiscovery,
    "a declared model must be published with its window and normalizer even when discovery never lists it",
  );
  assert.equal(directoryCalls, 1, "boot must query the real Go profile directory once");
  assert.ok(published, "Codex must receive the same discovered slug");
  assert.ok(Object.values(wireModels).every(Boolean), `Codex catalog missed a routed wire slug: ${JSON.stringify(wireModels)}`);
  assert.ok(Object.values(wireModels).every((slug) => /^[A-Za-z0-9._/-]+$/.test(slug) && !slug.includes("@")),
    `every Codex-facing model slug must be telemetry-safe: ${JSON.stringify(wireModels)}`);
  assert.ok(reviewOverrides.length > 0, "the built catalog publishes its configured review route");
  assert.ok(reviewOverrides.every((slug) => /^[A-Za-z0-9._/-]+$/.test(slug) && !slug.includes("@")),
    `review overrides must use the same telemetry-safe boundary: ${JSON.stringify(reviewOverrides)}`);
  for (const enabled of [false, true]) {
    const changed = await fetch(`http://127.0.0.1:${gatewayPort}/api/models/enabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: wireModels.qwen, enabled }),
    });
    const result = await changed.json();
    assert.equal(changed.status, 200, JSON.stringify(result));
    assert.equal(result.id, "qwen3.8-flash@opencode-go",
      "Codex-facing model edits fold onto the internal preference key");
  }
  const send = async (input, sessionId, stream = true, model = wireModels.qwen) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": sessionId },
      body: JSON.stringify({ ...fixture.request, model, stream, input }),
    });
    const text = await response.text();
    const rejectedTools = requests.at(-1)?.tools || [];
    const rejectedNames = rejectedTools.map((tool) => tool?.function?.name).filter(Boolean);
    assert.equal(response.status, 200, `built bundle rejected the full package with ${rejectedTools.length} tools (view_image=${rejectedNames.includes("view_image")}, vision_inspect=${rejectedNames.some((name) => name.endsWith("vision_inspect"))}): ${text}\n${stderr}`);
    return text;
  };
  const first = await send(fixture.request.input, "full-go-chat-fixture");
  assert.match(first, /response\.function_call_arguments\.done/);
  assert.match(first, /call_go_a/);
  assert.match(first, /call_go_b/);
  assert.match(first, /response\.reasoning_text\.done/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tools.length, 162, "the unsupported hosted tool and delegated vision tool are removed for a visual Chat model");
  const firstToolNames = new Set(requests[0].tools.map((tool) => tool.function.name));
  assert.ok(firstToolNames.has("view_image"), "the visual Chat model keeps direct image inspection");
  assert.equal(
    [...firstToolNames].some((name) => name === "vision_inspect" || name.endsWith("__vision_inspect")),
    false,
    "the visual Chat model never receives the delegated vision tool",
  );
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
  // Reuse the captured long-session history and complete tool table, not a
  // shortened hand-authored envelope. The added rounds exercise #36's mixed
  // dialect and reused-id transitions before and after compaction.
  const history = [...longFixture.input.filter((item) => item.type !== "compaction_trigger"),
    ...firstTurn, ...secondOutput, { type: "function_call_output", call_id: "call_go_c", output: "done" }];
  const markers = [];
  for (let round = 1; round <= 8; round += 1) {
    const id = round === 3 ? "reuse__2" : "reuse";
    const call = { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: `echo round_${round}` }) };
    const chat = { type: "message", role: "assistant", content: null, tool_calls: [
      { id, type: "function", function: { name: call.name, arguments: call.arguments } },
    ] };
    const marker = `ROUND_${round}_RESULT`;
    markers.push(marker);
    history.push({ type: "message", role: "user", content: `Run round ${round}.` }, round % 2 ? chat : call);
    if (round % 2) history.push(call); // Same pending invocation in both dialects.
    history.push(round % 2
      ? { type: "function_call_output", call_id: id, output: marker }
      : { type: "message", role: "tool", tool_call_id: id, content: marker });
    history.push(
      { type: "custom_tool_call", call_id: "patch_reused", name: "apply_patch", input: `*** Begin Patch\n*** Add File: round${round}.txt\n+fixture\n*** End Patch` },
      { type: "custom_tool_call_output", call_id: "patch_reused", output: `PATCH_${round}_RESULT` },
    );
    await send(history, "full-go-chat-fixture");
    const chatResults = requests.at(-1).messages.filter((item) => item.role === "tool").map((item) => item.content);
    assert.deepEqual(chatResults.filter((text) => /^ROUND_\d+_RESULT$/.test(text)), markers);
    assert.equal(chatResults.filter((text) => /^PATCH_\d+_RESULT$/.test(text)).length, round);
  }
  const switched = await send(history, "full-go-chat-fixture", true, wireModels.v4);
  assert.match(switched, /RESPONSES_HISTORY_OK/);
  const responseResults = requests.at(-1).input.filter((item) => item.type === "function_call_output").map((item) => item.output);
  assert.deepEqual(responseResults.filter((text) => /^ROUND_\d+_RESULT$/.test(text)), markers);
  const newlyDiscovered = await send(history, "full-go-chat-fixture", true, wireModels.v42);
  assert.match(newlyDiscovered, /RESPONSES_HISTORY_OK/);
  assert.equal(requests.at(-1).model, "deepseek-v4.2-flash", "new model must not fall back to the old main model");
  // The declared row must also route now, which is the transition this gateway had to
  // make safe: discovery-only rows used to be missing right after a restart, and the
  // addressed-provider guard answered 503 "endpoint was removed" for them.
  const declared = await send(history, "full-go-chat-fixture", true, wireModels.v41);
  assert.match(declared, /RESPONSES_HISTORY_OK/);
  assert.equal(requests.at(-1).model, "deepseek-v4.1-flash", "the declared DeepSeek row must route without discovery");
  const legacyDeclared = await send(history, "legacy-go-chat-fixture", true, "deepseek-v4.1-flash@opencode-go");
  assert.match(legacyDeclared, /RESPONSES_HISTORY_OK/);
  assert.equal(requests.at(-1).model, "deepseek-v4.1-flash", "a stored legacy model@provider session must still reach the same upstream model");

  const compact = await send([...history,
    { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize the completed work." }] },
    { type: "compaction_trigger" },
  ], "full-go-chat-fixture", false);
  const compacted = JSON.parse(compact);
  assert.equal(compacted.model, wireModels.qwen, "compaction returns the same safe model identity Codex selected");
  assert.equal(compacted.output[0].type, "compaction");
  assert.match(compacted.output[0].encrypted_content, /^kcr1:/);
  const resumed = await send([
    ...fixture.request.input,
    compacted.output[0],
    { type: "message", role: "user", content: [{ type: "input_text", text: "Resume after compaction." }] },
  ], "full-go-chat-fixture");
  assert.match(resumed, /GO_COMPACTION_RESUMED/);
  // The first post-compaction tool invocation may reuse a pre-compaction id.
  await send([
    ...fixture.request.input, compacted.output[0],
    { type: "function_call", call_id: "reuse", name: "exec_command", arguments: '{"cmd":"echo after_compact"}' },
    { type: "function_call_output", call_id: "reuse", output: "AFTER_COMPACT_RESULT" },
  ], "full-go-chat-fixture");
  const afterResults = requests.at(-1).messages.filter((item) => item.role === "tool").map((item) => item.content);
  assert.deepEqual(afterResults, ["AFTER_COMPACT_RESULT"], "pre-compaction pairing state must not leak into the next history");
  assert.equal(sessionHeaders.filter((id) => id === "legacy-go-chat-fixture").length, 1);
  assert.ok(sessionHeaders.filter((id) => id !== "legacy-go-chat-fixture").every((id) => id === "full-go-chat-fixture"),
    "Chat, Responses and compaction retain one conversation identity");
  await send(fixture.request.input, "other-go-task");
  assert.equal(sessionHeaders.at(-1), "other-go-task");
  await send(fixture.request.input, "full-go-chat-fixture");
  assert.equal(sessionHeaders.at(-1), "full-go-chat-fixture", "another task must not overwrite the first task's header");
  await Promise.all([
    send(fixture.request.input, "full-go-chat-fixture"),
    send(fixture.request.input, "other-go-task"),
  ]);
  assert.deepEqual(new Set(sessionHeaders.slice(-2)), new Set(["full-go-chat-fixture", "other-go-task"]));
  const compactV1 = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses/compact`, {
    method: "POST",
    headers: { "content-type": "application/json", "session_id": "other-go-task" },
    body: JSON.stringify({ ...fixture.request, model: wireModels.qwen, stream: false }),
  });
  assert.equal(compactV1.status, 200, await compactV1.text());
  assert.equal(sessionHeaders.at(-1), "other-go-task", "the dedicated compact endpoint preserves its task identity too");

  // Append a reconstruction of the September parallel-image failure to the
  // older sanitized August fixture, retaining all 164 tool declarations.
  // The unsupported-call result exists in Codex history; inserting an image
  // message before it caused Go to report "No tool output found" instead.
  const parallelImageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const parallelGroup = [
    {
      type: "function_call",
      call_id: "call_par_images",
      name: "mcp__modeldock__preview_images",
      arguments: JSON.stringify({ files: ["scaling-law-a.png", "scaling-law-b.png"], question: "Compare the two charts." }),
    },
    { type: "function_call", call_id: "call_par_agents", name: "collaboration__list_agents", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "call_par_images",
      output: [
        { type: "input_text", text: "Wall time: 9.4832 seconds\nOutput:" },
        {
          type: "input_text",
          text: JSON.stringify({ kind: "screenshot_previews", images: [{ index: 1, file: "scaling-law-a.png", original_ref: "img_parallel_fixture" }] }),
        },
        { type: "input_image", image_url: parallelImageUrl },
      ],
    },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "Inspect the chart before continuing." }] },
    { type: "function_call_output", call_id: "call_par_agents", output: "unsupported call: collaboration__list_agents" },
  ];
  const parallelInput = [...fixture.request.input, ...parallelGroup];
  const runParallelGroup = async (model) => {
    await send(parallelInput, "full-go-chat-fixture", true, model);
    const body = requests.at(-1);
    const start = body.input.findIndex((item) => item.type === "function_call" && item.call_id === "call_par_images");
    assert.notEqual(start, -1, `${model} must receive the parallel preview group`);
    assert.deepEqual(
      body.input.slice(start, start + 4).map((item) => [item.type, item.call_id || item.role]),
      [
        ["function_call", "call_par_images"],
        ["function_call", "call_par_agents"],
        ["function_call_output", "call_par_images"],
        ["function_call_output", "call_par_agents"],
      ],
      `${model} must keep the parallel group contiguous: no user message may split the two results`,
    );
    const imageResult = body.input[start + 2];
    const agentResult = body.input[start + 3];
    assert.equal(
      imageResult.output.some((part) => part.type === "input_image"),
      false,
      `${model} promotes pixels out of the tool result`,
    );
    assert.ok(
      imageResult.output.some((part) => part.type === "input_text" && part.text.includes("Wall time: 9.4832 seconds")),
      `${model} keeps the preview tool text result`,
    );
    assert.equal(agentResult.output, "unsupported call: collaboration__list_agents", `${model} keeps the later parallel error result`);
    const promoted = body.input
      .slice(start + 4)
      .find((item) => item.type === "message" && item.role === "user"
        && Array.isArray(item.content)
        && item.content.some((part) => part.type === "input_text" && part.text.includes("call_par_images")));
    assert.ok(promoted, `${model} must keep the promoted preview message after the group`);
    return promoted;
  };
  const referenced = await runParallelGroup("deepseek-v4-flash@opencode-go");
  assert.equal(referenced.content.some((part) => part.type === "input_image"), false, "a text-only route must not embed pixels");
  assert.ok(referenced.content.every((part) => part.type === "input_text"), "a text-only route keeps the preview as text");
  assert.match(
    referenced.content.map((part) => part.text).join("\n"),
    /\[Image attachment img_[A-Za-z0-9_-]+: if visual evidence is needed/,
    "a text-only route must keep the preview by reference",
  );
  const visual = await runParallelGroup("deepseek-v4.1-flash@opencode-go");
  const visualImages = visual.content.filter((part) => part.type === "input_image");
  assert.equal(visualImages.length, 1, "a vision route keeps the promoted preview pixels");
  assert.equal(visualImages[0].image_url, parallelImageUrl, "a vision route keeps the exact pixels the tool returned");
});

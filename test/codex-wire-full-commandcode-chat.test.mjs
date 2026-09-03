// Full original Codex package through the Command Code Chat route.
//
// Reuses the committed sanitized capture (all 164 tool declarations from a real
// desktop request) rather than a hand-authored message, because Command Code is a
// plain OpenAI Chat endpoint: anything Responses-only, or any non-function tool
// wrapper, is a hard 400 upstream. A subset fixture would prove nothing about that,
// which is exactly how the external_web_access bug survived a "real" test once.
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
const longSwitchFixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/voxel-commandcode-native-compact-2026-09-02.json.gz", import.meta.url))).toString("utf8"));
const UPSTREAM_MODEL = "deepseek/deepseek-v4-flash";
const ROUTED_SLUG = `${UPSTREAM_MODEL}@commandcode`;
const VISION_UPSTREAM_MODEL = "Qwen/Qwen3.8-Flash";
const VISION_ROUTED_SLUG = `${VISION_UPSTREAM_MODEL}@commandcode`;
const BLUE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZCMsAAAAASUVORK5CYII=";

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

// Discovery runs on boot, so wait for it to land rather than racing it: a model
// the gateway has not published is correctly refused, and that would look like a
// bridge failure instead of a timing artifact.
async function waitForModel(port, slug) {
  const seen = [];
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/models`, { cache: "no-store" });
      if (response.ok) {
        const options = (await response.json()).options || [];
        const ids = options.map((entry) => entry.id);
        if (ids.includes(slug)) return ids;
        seen.push(...ids);
      }
    } catch {
      // Gateway still booting; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`model ${slug} was never published; saw ${new Set(seen).size} model(s)`);
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

// Mirrors what was measured live: reasoning arrives in a `reasoning` field beside a
// null content, and tool arguments stream in fragments.
function toolStream(calls, reasoningText) {
  return sse([
    {
      id: "chatcmpl_cmd_fixture",
      created: 31,
      model: UPSTREAM_MODEL,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          ...(reasoningText ? { reasoning: reasoningText } : {}),
          tool_calls: calls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments.slice(0, Math.ceil(call.arguments.length / 2)) },
          })),
        },
      }],
    },
    {
      id: "chatcmpl_cmd_fixture",
      model: UPSTREAM_MODEL,
      choices: [{
        index: 0,
        delta: { tool_calls: calls.map((call, index) => ({
          index,
          function: { arguments: call.arguments.slice(Math.ceil(call.arguments.length / 2)) },
        })) },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 9000,
        completion_tokens: 21,
        prompt_tokens_details: { cached_tokens: 512 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    },
  ]);
}

function textStream(text, model = UPSTREAM_MODEL) {
  return sse([{
    id: "chatcmpl_cmd_fixture",
    created: 31,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 9000, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } },
  }]);
}

test("built bundle bridges the complete Codex package to Command Code Chat", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.request.tools.length, 164);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-wire-commandcode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const nativeRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const rejectWith = (status, error) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error }));
    };
    if (req.method === "GET" && req.url === "/provider/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      // The Claude entry is here on purpose: end to end, the directory must be
      // filtered, not merely described as filtered.
      return res.end(JSON.stringify({ data: [
        { id: UPSTREAM_MODEL, name: "DeepSeek V4 Flash (latest)", context_length: 1_000_000 },
        { id: VISION_UPSTREAM_MODEL, name: "Qwen 3.8 Flash", context_length: 1_000_000 },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5", context_length: 1_000_000 },
      ] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (req.url === "/native/responses") {
      nativeRequests.push(body);
      const prefixes = new Map([
        ["message", "msg_"],
        ["reasoning", "rs_"],
        ["function_call", "fc_"],
        ["function_call_output", "fco_"],
        ["custom_tool_call", "ctc_"],
        ["custom_tool_call_output", "ctco_"],
      ]);
      for (const [index, item] of (body.input || []).entries()) {
        const prefix = prefixes.get(item?.type);
        if (prefix && typeof item.id === "string" && !item.id.startsWith(prefix)) {
          return rejectWith(400, `Invalid 'input[${index}].id': '${item.id}'. Expected an ID that begins with '${prefix.slice(0, -1)}'.`);
        }
        if (item?.type === "reasoning" && Array.isArray(item.content) && item.content.length > 0) {
          return rejectWith(400, `Invalid 'input[${index}].content': array too long.`);
        }
        if (item?.type === "reasoning"
          && !(typeof item.encrypted_content === "string" && /^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(item.encrypted_content))) {
          return rejectWith(404, `Item with id '${item.id}' not found. Items are not persisted when store is set to false.`);
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        id: "resp_native_long_compact",
        object: "response",
        status: "completed",
        model: body.model,
        output: [{ type: "compaction", id: "cmp_native_long", encrypted_content: "gAAAAcaptured_native_long_token" }],
      }));
    }
    requests.push(body);
    // The vendor's real root carries /provider/v1, so the bridge must land on its
    // chat surface and nowhere else.
    if (req.url !== "/provider/v1/chat/completions") {
      return rejectWith(404, `expected the Command Code provider chat path, saw ${req.url}`);
    }
    if (body.input !== undefined || body.instructions !== undefined || body.include !== undefined || body.cache_prompt !== undefined) {
      return rejectWith(400, "Responses-only field reached a Chat upstream");
    }
    if (![UPSTREAM_MODEL, VISION_UPSTREAM_MODEL].includes(body.model)) {
      return rejectWith(400, `wrong model reached the upstream: ${JSON.stringify(body.model)}`);
    }
    if (!Array.isArray(body.messages) || !body.messages.length) {
      return rejectWith(422, "missing Chat messages");
    }
    if (!Array.isArray(body.tools) || body.tools.some((tool) => tool?.type !== "function" || !tool.function?.name)) {
      return rejectWith(400, `non-function tool declaration reached a Chat upstream: ${JSON.stringify((body.tools || []).filter((tool) => tool?.type !== "function").map((tool) => tool?.type))}`);
    }
    const names = new Set(body.tools.map((tool) => tool.function.name));
    if ([...names].some((name) => name.includes("."))) {
      return rejectWith(400, `namespaced tool name survived for a Chat upstream: ${[...names].find((name) => name.includes("."))}`);
    }
    const toolIds = new Set(body.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id));
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (body.model === VISION_UPSTREAM_MODEL) return res.end(textStream("COMMAND_CODE_VISION_OK", body.model));
    // Longest history first: the third turn carries a, b and c, so checking the
    // a+b pair ahead of c would answer the same hop twice.
    if (toolIds.has("call_cmd_c")) return res.end(textStream("CMD_TOOL_LOOP_COMPLETE"));
    if (toolIds.has("call_cmd_a") && toolIds.has("call_cmd_b")) {
      return res.end(toolStream(
        [{ id: "call_cmd_c", name: "write_stdin", arguments: "{\"session_id\":0,\"chars\":\"continue\"}" }],
        "Both results are in; keep going.",
      ));
    }
    return res.end(toolStream(
      [
        { id: "call_cmd_a", name: "exec_command", arguments: "{\"cmd\":\"echo CMD_A\"}" },
        { id: "call_cmd_b", name: "read_file", arguments: "{\"path\":\"README.md\"}" },
      ],
      "Inspect both sources before continuing.",
    ));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\commandcode-${process.pid}`;
  const autostartName = `ModelDockCommandCode${process.pid}`;
  const child = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      OPENCODE_GO_TOKEN: "fixture-token",
      // Discovery stays on: this test drives the whole real path, directory to
      // bridge, so the published set is produced by the gateway rather than by the
      // test. The mock serves /provider/v1/models for it.
      COMMANDCODE_API_KEY: "user_fixturekey",
      MODELDOCK_COMMANDCODE_BASE_URL: `http://127.0.0.1:${upstreamPort}/provider/v1`,
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${upstreamPort}/native`,
      MODELDOCK_STATE_DIR: path.join(root, "state"),
      MODELDOCK_CODEX_HOME: path.join(root, "codex-home"),
      MODELDOCK_REQUIRE_CALLER_KEY: "0",
      MODELDOCK_MEMORY: "0",
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
  const providerIcon = await fetch(`http://127.0.0.1:${gatewayPort}/assets/commandcode-favicon.svg`);
  assert.equal(providerIcon.status, 200, "the built bundle serves the Command Code provider mark");
  assert.equal(providerIcon.headers.get("content-type"), "image/svg+xml; charset=utf-8",
    "the bundled favicon reaches the browser as an SVG rather than an opaque download");
  assert.match(await providerIcon.text(), /<svg\b/, "the served provider mark contains SVG image data");
  const published = await waitForModel(gatewayPort, ROUTED_SLUG);
  assert.ok(!published.some((id) => id.startsWith("claude-")),
    `the vendor directory listed a Claude model and it reached the picker anyway: ${published}`);

  const send = async (input, stream = true, model = ROUTED_SLUG, sessionId = "full-commandcode-chat-fixture") => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-session-id": sessionId },
      body: JSON.stringify({ ...fixture.request, model, stream, input }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `built bundle rejected the full package: ${text}\n${stderr}`);
    return text;
  };

  const first = await send(fixture.request.input);
  assert.equal(requests.filter((body) => body.messages).length, 1, "discovery must not cost an inference request");
  assert.match(first, /response\.function_call_arguments\.done/);
  assert.match(first, /call_cmd_a/);
  assert.match(first, /call_cmd_b/);
  assert.equal(requests.length, 1);
  // A text-only model gets the delegated vision tool and never the native one, and
  // every hosted/non-function declaration has to be flattened away.
  const firstNames = new Set(requests[0].tools.map((tool) => tool.function.name));
  assert.equal(firstNames.has("view_image"), false, "a non-visual model must not be handed native image inspection");
  assert.ok([...firstNames].some((name) => name === "vision_inspect" || name.endsWith("__vision_inspect")),
    "the delegated vision tool is how a text-only model still sees a picture");
  const firstOutput = completedResponse(first).output;
  assert.deepEqual(firstOutput.map((item) => item.type), ["reasoning", "function_call", "function_call"]);
  assert.match(firstOutput[0].id, /^rs_/, "Chat reasoning is stored in a native-compatible Responses namespace");
  assert.ok(firstOutput.slice(1).every((item) => /^fc_/.test(item.id)),
    "Chat tool item ids are native-compatible before Codex persists them");
  assert.deepEqual(firstOutput.slice(1).map((item) => item.call_id), ["call_cmd_a", "call_cmd_b"],
    "tool-output join ids remain the upstream call ids");

  const firstTurn = [
    ...firstOutput,
    { type: "function_call_output", call_id: "call_cmd_a", output: "CMD_A" },
    { type: "function_call_output", call_id: "call_cmd_b", output: "# ModelDock" },
  ];
  const second = await send([...fixture.request.input, ...firstTurn]);
  assert.match(second, /call_cmd_c/);
  assert.equal(requests[1].messages.find((message) => message.tool_calls?.some((call) => call.id === "call_cmd_a"))?.reasoning_content,
    "Inspect both sources before continuing.", "the reasoning half of a bridged turn has to come back on the next hop");
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "call_cmd_a"));
  assert.ok(requests[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "call_cmd_b"));

  const secondOutput = completedResponse(second).output;
  const third = await send([...fixture.request.input, ...firstTurn, ...secondOutput,
    { type: "function_call_output", call_id: "call_cmd_c", output: "done" },
  ]);
  assert.match(third, /CMD_TOOL_LOOP_COMPLETE/);
  assert.equal(requests[2].messages.find((message) => message.tool_calls?.some((call) => call.id === "call_cmd_c"))?.reasoning_content,
    "Both results are in; keep going.");

  // Switch the live generated Chat turn to native before compaction too. The
  // reasoning item came from this bridge with encrypted_content:"", so its
  // rs_* id is not an OpenAI item that a store:false request can retrieve.
  await send([
    ...fixture.request.input,
    ...firstTurn,
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue on the native model." }] },
  ], false, "gpt-5.6-terra", "full-commandcode-native-ordinary-switch");
  assert.equal(nativeRequests.length, 1);
  assert.equal(nativeRequests[0].input.some((item) => item?.type === "reasoning"), false,
    "a routed Chat reasoning id never reaches an ordinary native turn");
  assert.ok(nativeRequests[0].input.some((item) => item?.type === "function_call" && item.call_id === "call_cmd_a"),
    "the tool history beside the dropped reasoning remains available to native");

  // Keep the same complete 164-tool Codex capture and add the ordinary image
  // item that a pasted screenshot contributes. This exercises the real catalog,
  // router, vision-specific tool filter and Responses-to-Chat image conversion
  // together; a hand-authored reduced tool package would miss that coupling.
  const visualInput = [
    ...fixture.request.input,
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Name the dominant image color." },
        { type: "input_image", image_url: BLUE_PNG },
      ],
    },
  ];
  const visual = await send(visualInput, true, VISION_ROUTED_SLUG, "full-commandcode-chat-vision");
  assert.match(visual, /COMMAND_CODE_VISION_OK/);
  const visualRequest = requests.at(-1);
  const visualNames = new Set(visualRequest.tools.map((tool) => tool.function.name));
  assert.ok(visualNames.has("view_image"), "a visual Command Code model keeps direct image inspection");
  assert.equal(
    [...visualNames].some((name) => name === "vision_inspect" || name.endsWith("__vision_inspect")),
    false,
    "a visual Command Code model must not delegate images to the fallback model",
  );
  assert.ok(
    visualRequest.messages.some((message) => Array.isArray(message.content)
      && message.content.some((part) => part?.type === "image_url" && part.image_url?.url === BLUE_PNG)),
    "the complete Codex image item reaches Command Code Chat",
  );

  // Recombine the complete current top-level Codex package with the complete
  // captured 1,659-item Voxel history that failed after Command Code -> native
  // switching. This strict built-bundle hop is the actual regression boundary:
  // every historical Chat item must speak native Responses before Terra sees it.
  assert.equal(longSwitchFixture.capture.inputItems, 1659);
  assert.match(longSwitchFixture.input[41].id, /^call_/);
  const nativeCompact = await send(
    longSwitchFixture.input,
    false,
    "gpt-5.6-terra",
    "full-commandcode-native-long-switch",
  );
  assert.equal(nativeRequests.length, 2);
  const nativeCompactRequest = nativeRequests.at(-1);
  const foreignReasoning = longSwitchFixture.input.filter((item) => item?.type === "reasoning"
    && !(typeof item.encrypted_content === "string" && /^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(item.encrypted_content)));
  assert.equal(foreignReasoning.length, 432, "the captured long session carries the routed reasoning state that native cannot retrieve");
  assert.equal(nativeCompactRequest.input.length, longSwitchFixture.input.length - foreignReasoning.length,
    "only unpersisted routed reasoning is removed at the native boundary");
  const repairedCall = nativeCompactRequest.input.find((item) => item?.type === "function_call"
    && item.call_id === longSwitchFixture.input[41].call_id);
  assert.match(repairedCall.id, /^fc_/,
    "the exact historical call_* failure is repaired in the shipped bundle");
  assert.equal(repairedCall.call_id, longSwitchFixture.input[41].call_id);
  assert.equal(JSON.parse(nativeCompact).output[0].type, "compaction");

  // And the Messages-only half is unreachable even when a stale Codex picker sends
  // it: never published means refused at the gate, not forwarded to a Chat endpoint
  // that would answer 400 on every turn.
  const chatRequests = requests.length;
  const claudeTurn = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": "full-commandcode-chat-claude" },
    body: JSON.stringify({ ...fixture.request, model: "claude-sonnet-5@commandcode", stream: false, input: fixture.request.input }),
  });
  await claudeTurn.text();
  assert.notEqual(claudeTurn.status, 200, "a Messages-dialect model must never be served through the Chat bridge");
  assert.equal(requests.length, chatRequests, "the refused Claude request must not reach the upstream");
});

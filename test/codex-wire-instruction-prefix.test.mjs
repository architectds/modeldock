// Replay the complete redacted Codex envelope (164 descriptors), plus the
// captured long compaction history. Later control messages reproduce the
// reported new-turn time/permission updates; their text is synthetic, not a
// claim that this fixture captures the user's unredacted current requests.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repo, "dist/modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))));
const longFixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/voxel-commandcode-native-compact-2026-09-02.json.gz", import.meta.url))));
const slug = (provider, model) => `mdr.${Buffer.from(provider).toString("base64url")}.${Buffer.from(model).toString("base64url")}`;
const message = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const TIME = "The current time is 2026-10-03T22:18:00-05:00. This is a platform time update, not a new task.";
const PERMISSION = "Permission update: the workspace is read-only; do not write outside the authorized directory. Current time: 2026-10-03T22:27:00-05:00.";
const TASK = "Continue implementing the prefix fix; next inspect src/gateway.mjs. Do not restart the live gateway.";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function completed(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.completed") return event.response;
  }
  throw new Error("No terminal Responses event");
}

function content(item) {
  return typeof item.content === "string" ? item.content : (item.content || []).map((part) => part.text || "").join("\n");
}

function transcript(body) {
  return body.messages || body.input;
}

function initialSystem(body) {
  return body.messages ? body.messages[0].content : body.instructions;
}

function assertPrefix(before, after) {
  assert.deepEqual(initialSystem(after), initialSystem(before), "a later instruction must not change initial instructions");
  const old = transcript(before);
  assert.deepEqual(transcript(after).slice(0, old.length), old, "the upstream history must grow only at its tail");
  assert.deepEqual(after.tools, before.tools, "ordinary turn updates do not change the rendered tool prefix");
}

function assertPairs(body) {
  const pending = new Set();
  for (const item of transcript(body)) {
    if (item.tool_calls) {
      assert.equal(pending.size, 0, "previous Chat call group was resolved");
      for (const call of item.tool_calls) pending.add(call.id);
    } else if (item.role === "tool") {
      assert.ok(pending.delete(item.tool_call_id), "Chat output has its own preceding call");
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      pending.add(item.call_id);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      assert.ok(pending.delete(item.call_id), "Responses output has its own preceding call");
    } else {
      assert.equal(pending.size, 0, "no control message is moved inside a pending call group");
    }
  }
  assert.equal(pending.size, 0);
}

test("built bundle keeps later platform instructions in place across providers, compaction and restart", { timeout: 90_000 }, async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.request.tools.length, 164);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-instruction-prefix-"));
  const state = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  await mkdir(state, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-native" } }));
  const catalogFile = path.join(state, "native-catalog.json");
  await writeFile(catalogFile, JSON.stringify({ captured_with: "0.158.0", models: [{
    slug: "gpt-6-astra", visibility: "list", input_modalities: ["text", "image"],
    base_instructions: "Native fixture.", model_messages: { instructions_template: "Native fixture." },
  }] }));
  await writeFile(path.join(state, "xai-auth.json"), JSON.stringify({
    accessToken: "fixture-xai", expiresAt: Date.now() + 3_600_000, models: ["grok-4.6"],
  }));

  const received = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "Qwen/Qwen3.8-Flash", name: "Qwen 3.8 Flash", context_length: 1_000_000 }] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    received.push({ path: req.url, body });
    try {
      assertPairs(body);
      if (/^\/(local|loop|cloud)-/.test(req.url)) {
        const messages = body.messages || [message("system", body.instructions || ""), ...body.input];
        assert.ok(messages.slice(1).every((item) => !["system", "developer"].includes(item.role)), "strict local template accepts system only first");
      }
    } catch (error) {
      res.writeHead(422, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: error.message } }));
    }
    const n = received.length;
    const call = { type: "function_call", id: `fc_prefix_${n}`, call_id: `call_prefix_${n}`, name: "exec_command", arguments: "{\"cmd\":\"echo PREFIX_OK\"}" };
    const response = {
      id: `resp_prefix_${n}`, object: "response", status: "completed", model: body.model,
      output: body.stream === false ? [message("assistant", "Summary: preserve the active task and the later permission update.")] : [call],
      usage: { input_tokens: 100, output_tokens: 5 },
    };
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(body.messages ? {
        id: `chatcmpl_summary_${n}`, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Summary: preserve the active task and the later permission update." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
      } : response));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const event = body.messages ? {
      id: `chatcmpl_prefix_${n}`, model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Inspect the next file.", tool_calls: [{
        index: 0, id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments },
      }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    } : { type: "response.completed", response };
    res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  const origin = `http://127.0.0.1:${await listen(upstream)}`;
  const endpointsFile = path.join(state, "custom-endpoints.json");
  await writeFile(endpointsFile, JSON.stringify([
    { modelId: "lab/chat", local: true, baseUrl: `${origin}/local-chat/v1`, transport: "chat" },
    { modelId: "lab/responses", local: true, baseUrl: `${origin}/local-responses/v1`, transport: "responses" },
    { modelId: "loop-chat", baseUrl: `${origin}/loop-chat/v1`, transport: "chat" },
    { modelId: "loop-responses", baseUrl: `${origin}/loop-responses/v1`, transport: "responses" },
    { modelId: "cloud-chat", baseUrl: "https://hosted.fixture/cloud-chat/v1", transport: "chat" },
    { modelId: "cloud-responses", baseUrl: "https://hosted.fixture/cloud-responses/v1", transport: "responses" },
  ].map((entry) => ({ apiKey: "fixture-key", supportsVision: true, contextWindow: 1_000_000, ...entry }))));
  const redirect = path.join(root, "redirect.mjs");
  await writeFile(redirect, `const original = globalThis.fetch;
globalThis.fetch = (url, options) => original(String(url).replace("https://hosted.fixture/", "${origin}/").replace("https://api.x.ai/", "${origin}/xai/"), options);
`);
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await close(probe);
  const env = {
    ...process.env, MODELDOCK_PORT: String(gatewayPort), MODELDOCK_PROFILE: "opencode-go",
    MODELDOCK_STATE_DIR: state, MODELDOCK_ENV_FILE: path.join(state, ".env"), MODELDOCK_CODEX_HOME: codexHome,
    MODELDOCK_NATIVE_CATALOG_FILE: catalogFile, MODELDOCK_CUSTOM_ENDPOINTS_FILE: endpointsFile,
    MODELDOCK_USAGE_EVENTS_FILE: path.join(state, "usage-events.jsonl"), MODELDOCK_SETTINGS_EVENTS_FILE: path.join(state, "settings-events.jsonl"),
    MODELDOCK_UPSTREAM_BASE_URL: `${origin}/go/v1`, MODELDOCK_COMMANDCODE_BASE_URL: `${origin}/command/v1`,
    MODELDOCK_DEEPSEEK_BASE_URL: `${origin}/deepseek/v1`, CODEX_NATIVE_BASE_URL: `${origin}/native`,
    OPENCODE_GO_TOKEN: "fixture-go-token", COMMANDCODE_API_KEY: "user_fixturecommand", DEEPSEEK_API_KEY: "fixture-deepseek",
    MODELDOCK_REQUIRE_CALLER_KEY: "0", MODELDOCK_MEMORY: "0", MODELDOCK_NATIVE_MERGE: "1",
    MODELDOCK_REFRESH_NATIVE_CATALOG: "0", MODELDOCK_VISION_MODEL: "none",
    MODELDOCK_AUTOSTART_KEY: `HKCU\\Software\\ModelDockTests\\instruction-prefix-${process.pid}`,
    MODELDOCK_AUTOSTART_NAME: `ModelDockInstructionPrefix${process.pid}`,
  };
  const launch = () => spawn(process.execPath, ["--import", pathToFileURL(redirect).href, bundle], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let child;
  let logs = "";
  const start = async () => {
    child = launch();
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    for (let n = 0; n < 200; n++) {
      if (child.exitCode !== null) throw new Error(`isolated bundle exited: ${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { signal: AbortSignal.timeout(500) });
        if (response.ok && JSON.stringify(await response.json()).includes("Qwen/Qwen3.8-Flash")) return;
      } catch { /* test-owned process is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`isolated bundle did not publish test models: ${logs}`);
  };
  t.after(async () => {
    if (child) await stop(child);
    await close(upstream);
    if (process.platform === "win32") {
      try { execFileSync("reg.exe", ["delete", env.MODELDOCK_AUTOSTART_KEY, "/f"], { stdio: "ignore" }); } catch { /* only the test key */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  await start();
  const send = async (model, input, { instructions = fixture.request.instructions, endpoint = "/responses", v2 = false, session = "prefix-session" } = {}) => {
    const n = received.length;
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json", session_id: session },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ ...fixture.request, model, instructions, input: v2 ? [...input, { type: "compaction_trigger" }] : input }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${model}: ${text}\n${logs}`);
    return { body: received.length > n ? received.at(-1).body : null, response: text.startsWith("{") ? JSON.parse(text) : completed(text) };
  };
  const continuation = (result) => [...result.response.output, ...result.response.output.filter((item) => item.type === "function_call").map((item) => ({
    type: "function_call_output", call_id: item.call_id, output: "PREFIX_OK",
  }))];
  const routes = [
    ["Local Chat", slug("local", "lab/chat"), true], ["Local Responses", slug("local", "lab/responses"), true],
    ["loopback Custom Chat", slug("custom", "loop-chat"), true], ["loopback Custom Responses", slug("custom", "loop-responses"), true],
    ["cloud Custom Chat", slug("custom", "cloud-chat"), true], ["cloud Custom Responses", slug("custom", "cloud-responses"), true],
    ["Go Chat", slug("opencode-go", "qwen3.8-flash"), false], ["Go Responses", slug("opencode-go", "deepseek-v4.1-flash"), false],
    ["Go Pro Responses", slug("opencode-go", "deepseek-v4-pro"), false],
    ["Command Code", slug("commandcode", "Qwen/Qwen3.8-Flash"), false], ["DeepSeek official", slug("deepseek-official", "deepseek-v4-flash"), false],
    ["xAI", slug("xai", "grok-4.6"), false], ["native", "gpt-6-astra", false],
  ];
  for (const [name, model, adapted] of routes) await t.test(name, async () => {
    const input = [...fixture.request.input];
    const first = await send(model, input);
    input.push(...continuation(first), message("developer", TIME));
    const second = await send(model, input);
    assertPrefix(first.body, second.body);
    const update = transcript(second.body).find((item) => content(item) === TIME);
    assert.equal(update?.role, adapted ? "user" : second.body.messages ? "system" : "developer");
    assert.equal(transcript(second.body).filter((item) => content(item) === TIME).length, 1);
    input.push(...continuation(second), message("system", PERMISSION), message("user", TASK));
    const third = await send(model, input);
    assertPrefix(second.body, third.body);
    assert.ok(transcript(third.body).findIndex((item) => content(item) === PERMISSION) > transcript(third.body).findIndex((item) => content(item) === TIME));
    assert.equal(content(transcript(third.body).at(-1)), TASK);
  });

  await t.test("long retained history, CPU compact_v2 and the next instruction update", async () => {
    const model = slug("local", "lab/chat");
    // compaction_trigger is a control for a separate compact request, not a
    // history row. All other captured items and schema fields are retained.
    const input = [...fixture.request.input, ...longFixture.input.filter((item) => item.type !== "compaction_trigger"), message("user", TASK)];
    assert.ok(input.length > 1_600);
    const first = await send(model, input);
    input.push(...continuation(first), message("developer", TIME), message("system", PERMISSION));
    const second = await send(model, input);
    assertPrefix(first.body, second.body);
    const compact = await send(model, input, { v2: true });
    assert.equal(compact.body, null, "CPU compaction must not run inference");
    assert.equal(compact.response.output.at(-1).type, "compaction");
    const nextInput = [...fixture.request.input, ...compact.response.output, message("user", TASK)];
    const after = await send(model, nextInput);
    const handoff = transcript(after.body).map(content).find((text) => text.includes("HEAD:"));
    assert.ok(handoff, "the client-replayed compaction is readable");
    assert.match(handoff, /HEAD: task=Continue implementing the prefix fix/, "platform updates must not replace the user's task");
    assert.match(handoff, /Permission update/, "the later permission instruction survives the handoff");
    nextInput.push(...continuation(after), message("developer", TIME.replace("22:18", "22:28")));
    const next = await send(model, nextInput);
    assertPrefix(after.body, next.body);
  });

  await t.test("sustained tool turns keep the prefix stable with later instruction-only turns", async () => {
    const model = slug("local", "lab/chat");
    const input = [...fixture.request.input, message("user", TASK)];
    let previous = await send(model, input);
    for (let turn = 0; turn < 20; turn++) {
      input.push(...continuation(previous), message(turn % 2 ? "system" : "developer", `Platform time update ${turn}: ${TIME}`));
      const next = await send(model, input);
      assertPrefix(previous.body, next.body);
      previous = next;
    }
    assert.equal(transcript(previous.body).filter((item) => content(item).startsWith("Platform time update")).length, 20);
  });

  await t.test("a large tool result keeps its upstream prefix when new-turn permissions are appended", async () => {
    const model = slug("local", "lab/chat");
    // Redaction removes the bulk of real tool output. Restore a deterministic
    // large value in the same wire shape to exercise a long rendered prefix,
    // without copying any private tool output or pretending to measure prefill.
    const output = Array.from({ length: 12_000 }, (_, row) => `Archive row ${row}: inspected file state and command results; details redacted.\n`).join("");
    const input = [...fixture.request.input,
      { type: "function_call", id: "fc_large_output", call_id: "call_large_output", name: "exec_command", arguments: "{}" },
      { type: "function_call_output", call_id: "call_large_output", output },
      message("user", TASK),
    ];
    const first = await send(model, input);
    input.push(...continuation(first), message("developer", PERMISSION));
    const next = await send(model, input);
    assertPrefix(first.body, next.body);
    assert.ok(JSON.stringify(first.body).length > 900_000);
    assert.equal(transcript(next.body).at(-1).role, "user");
  });

  await t.test("cloud Custom compact_v1 and v2 share the ordinary relay contract", async () => {
    for (const model of [slug("custom", "cloud-chat"), slug("custom", "cloud-responses")]) {
      const input = [...fixture.request.input, message("assistant", "Previous work."), message("developer", TIME), message("user", TASK)];
      const ordinary = await send(model, input);
      for (const options of [{ endpoint: "/responses/compact" }, { v2: true }]) {
        const compact = await send(model, input, options);
        assert.equal(initialSystem(compact.body), initialSystem(ordinary.body));
        assert.equal(transcript(compact.body).find((item) => content(item) === TIME)?.role, "user");
        assert.ok(compact.response.output.length);
      }
    }
  });

  await t.test("Go Pro keeps its fixed execution rule in instructions on both compact protocols", async () => {
    const model = slug("opencode-go", "deepseek-v4-pro");
    const input = [...fixture.request.input, message("assistant", "Previous work."), message("developer", TIME), message("user", TASK)];
    const first = await send(model, input);
    for (const options of [{ endpoint: "/responses/compact" }, { v2: true }]) {
      const compact = await send(model, input, options);
      assert.deepEqual(initialSystem(compact.body), initialSystem(first.body));
      const text = typeof compact.body.instructions === "string" ? compact.body.instructions : compact.body.instructions.map((part) => part.text).join("\n");
      assert.equal(text.split("ModelDock execution protocol for this Codex turn:").length, 2, "the rule is appended once, not once per normalization pass");
      assert.equal(content(transcript(compact.body).find((item) => content(item) === TASK)), TASK, "the human instruction is not rewritten");
      assert.equal(transcript(compact.body).find((item) => content(item) === TIME)?.role, "developer");
    }
  });

  await t.test("absent instructions, leading string content, and later empty instructions", async () => {
    for (const model of [slug("local", "lab/chat"), slug("local", "lab/responses")]) {
      const input = [message("developer", "LEADING_A"), { type: "message", role: "system", content: "LEADING_B" }, message("user", TASK)];
      const first = await send(model, input, { instructions: null });
      assert.match(String(initialSystem(first.body) || content(transcript(first.body)[0])), /LEADING_A\nLEADING_B/);
      input.push(...continuation(first), message("developer", ""), { type: "message", role: "system", content: TIME });
      const second = await send(model, input, { instructions: null });
      assertPrefix(first.body, second.body);
      assert.equal(transcript(second.body).find((item) => content(item) === TIME)?.role, "user");
    }
  });

  await t.test("an empty opening block and optional message type do not re-open the prefix later", async () => {
    const model = slug("local", "lab/chat");
    const input = [message("developer", ""), message("user", TASK)];
    const first = await send(model, input, { instructions: [] });
    input.push(...continuation(first), { role: "developer", content: TIME });
    const next = await send(model, input, { instructions: [] });
    assertPrefix(first.body, next.body);
    assert.equal(content(transcript(next.body).at(-1)), TIME);
    assert.equal(transcript(next.body).at(-1).role, "user");
  });

  await t.test("restarting the isolated bundle preserves projection and switching back does not mutate history", async () => {
    const model = slug("local", "lab/chat");
    const input = [...fixture.request.input, message("assistant", "Previous work."), message("developer", TIME), message("user", TASK)];
    const before = await send(model, input);
    await send("gpt-6-astra", input);
    const back = await send(model, input);
    assert.deepEqual(back.body, before.body, "native switching does not rewrite the client's saved history");
    await stop(child);
    await start();
    const after = await send(model, input);
    assert.deepEqual(after.body, before.body, "normalization does not depend on process-local cache state");
    // Optional offline renderer inspection, never an inference request. The
    // artifact contains only these already-redacted test upstream requests.
    if (process.env.MODELDOCK_PREFIX_ARTIFACT) {
      await writeFile(process.env.MODELDOCK_PREFIX_ARTIFACT, JSON.stringify(received.filter((entry) => entry.path === "/local-chat/v1/chat/completions")));
    }
  });
});

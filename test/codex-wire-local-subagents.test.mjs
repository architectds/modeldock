// Full captured Codex envelope through the built bundle. Extra declarations
// exercise the current collaboration namespace and deferred tool delivery;
// the original 164 descriptors remain intact in every request.
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
const starts = ["spawn_agent", "followup_task", "resume_agent", "send_input"];
const cleanup = ["wait_agent", "list_agents", "interrupt_agent", "close_agent"];
const fn = (name) => ({ type: "function", name, parameters: { type: "object", properties: {}, additionalProperties: false } });
const collab = (names = [...starts, ...cleanup]) => ({ type: "namespace", name: "collaboration", tools: names.map(fn) });
const slug = (provider, model) => `mdr.${Buffer.from(provider).toString("base64url")}.${Buffer.from(model).toString("base64url")}`;

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

function declaredNames(tools) {
  return (tools || []).flatMap((tool) => tool.type === "namespace"
    ? (tool.tools || []).map((child) => `${tool.name.replace(/^namespace:/, "").replace(/_+$/, "")}__${child.name}`)
    : [tool.function?.name || tool.name]).filter(Boolean);
}

function allDeclarations(body) {
  return [...declaredNames(body.tools), ...(body.input || []).flatMap((item) => item.type === "additional_tools" ? declaredNames(item.tools) : [])];
}

function instructions(body) {
  return body.messages
    ? body.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n")
    : typeof body.instructions === "string" ? body.instructions : (body.instructions || []).map((part) => part.text || "").join("\n");
}

function assertPolicy(body, local, localBackend = local) {
  const names = allDeclarations(body);
  if (local) {
    assert.ok((body.input || []).every((item) => item.type !== "additional_tools" || item.tools.length > 0), "removing a starters-only batch does not leave an empty additional_tools item");
  }
  for (const name of starts) {
    for (const candidate of [name, `collaboration__${name}`, `multi_agent_v1__${name}`]) {
      assert.equal(names.includes(candidate), !local, `${local ? "local hides" : "cloud keeps"} ${candidate}`);
    }
  }
  for (const name of cleanup) assert.ok(names.includes(`collaboration__${name}`), `keep existing-child management ${name}`);
  for (const name of ["mcp__trading_support__spawn_agent", "mcp__trading_support__get_ledger", "update_plan", "exec_command"]) {
    assert.ok(names.includes(name), `retain unrelated callable ${name}`);
  }
  assert.ok(names.includes("collaboration__send_message"), "a deferred non-starting tool stays available");
  if (local) {
    assert.match(instructions(body), /LOCAL SUBAGENT RULE:/);
    assert.match(instructions(body), /primary agent/);
    if (localBackend) assert.match(instructions(body), /LONG TASK PLAN/);
    else assert.doesNotMatch(instructions(body), /LOCAL HOST RULE:/, "a remote vision turn does not receive local server maintenance rules");
    assert.doesNotMatch(instructions(body), /For ordinary delegation, set agent_type=/, "the stale ModelDock spawn recipe is removed");
  }
}

function assertHistory(body) {
  if (body.messages) {
    const call = body.messages.flatMap((message) => message.tool_calls || []).find((item) => item.id === "call_previous_child");
    assert.equal(call?.function.name, "collaboration__spawn_agent", "old child invocation remains history");
    assert.ok(body.messages.some((message) => message.role === "tool" && message.tool_call_id === call.id && message.content === "CHILD_ALREADY_STARTED"));
  } else {
    assert.ok(body.input.some((item) => item.call_id === "call_previous_child" && item.name === (item.namespace ? "spawn_agent" : "collaboration__spawn_agent")));
    assert.ok(body.input.some((item) => item.type === "function_call_output" && item.call_id === "call_previous_child" && item.output === "CHILD_ALREADY_STARTED"));
  }
}

test("built bundle removes only child-work starters for local models across tool delivery, switches and restart", { timeout: 60_000 }, async (t) => {
  assert.equal(fixture.request.tools.length, 164);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-subagents-"));
  const state = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  await mkdir(state, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const configText = "[agents]\nenabled = true\n";
  await writeFile(path.join(codexHome, "config.toml"), configText);
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-native" } }));
  const nativeCatalog = path.join(state, "native-catalog.json");
  await writeFile(nativeCatalog, JSON.stringify({ captured_with: "0.158.0", models: [{
    slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list", input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "medium", description: "fixture" }], default_reasoning_level: "medium",
    base_instructions: "Native fixture instructions.", model_messages: { instructions_template: "Native fixture instructions." },
  }] }));

  const received = [];
  let localVisionTurn = false;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [] }));
    }
    received.push({ path: req.url, body });
    const local = /^\/(local-chat|local-responses|loop-custom)\//.test(req.url);
    try {
      assertPolicy(body, local || localVisionTurn, local);
      if (!localVisionTurn) assertHistory(body);
      else {
        assert.equal(req.url, "/cloud/v1/responses", "the text-only Local selection escalates only pixels to its vision model");
        assert.ok(body.input.some((item) => item.content?.some((part) => part.type === "input_image")), "the vision route still receives the attachment");
      }
      if (req.url.endsWith("chat/completions")) {
        assert.ok(body.messages.every((message) => ["system", "user", "assistant", "tool"].includes(message.role)));
        assert.ok(body.tools.every((tool) => tool.type === "function" && typeof tool.function?.name === "string"));
      }
    } catch (error) {
      res.writeHead(422, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: error.message } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const events = req.url.endsWith("chat/completions")
      ? [{ id: "chatcmpl_policy", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "POLICY_OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 2 } }]
      : [{ type: "response.completed", response: { id: "resp_policy", status: "completed", model: body.model, output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "POLICY_OK" }] },
      ], usage: { input_tokens: 100, output_tokens: 2 } } }];
    res.end([...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n"));
  });
  const port = await listen(upstream);
  const origin = `http://127.0.0.1:${port}`;
  const endpoints = path.join(state, "custom-endpoints.json");
  await writeFile(endpoints, JSON.stringify([
    { modelId: "lab/chat", upstreamId: "local-chat-model", label: "lab / chat", local: true, baseUrl: `${origin}/local-chat/v1`, transport: "chat" },
    { modelId: "lab/responses", upstreamId: "local-responses-model", label: "lab / responses", local: true, supportsVision: false, baseUrl: `${origin}/local-responses/v1`, transport: "responses" },
    { modelId: "loop-custom", baseUrl: `${origin}/loop-custom/v1`, apiKey: "fixture-loop-token", transport: "chat" },
    { modelId: "cloud-custom", baseUrl: "https://hosted.fixture/v1", apiKey: "fixture-custom", transport: "responses" },
  ].map((entry) => ({ supportsVision: true, contextWindow: 262144, apiKey: "", ...entry }))));
  // Only the hosted Custom URL is redirected. The bundle still resolves a
  // non-loopback identity, while every real socket remains test-owned.
  const redirect = path.join(root, "redirect.mjs");
  await writeFile(redirect, `const original = globalThis.fetch;
globalThis.fetch = (url, options) => original(String(url).replace("https://hosted.fixture/", "${origin}/cloud/"), options);
`);
  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await close(probe);
  const env = {
    ...process.env,
    MODELDOCK_PORT: String(gatewayPort), MODELDOCK_PROFILE: "opencode-go", OPENCODE_GO_TOKEN: "fixture-go-token",
    MODELDOCK_STATE_DIR: state, MODELDOCK_ENV_FILE: path.join(state, ".env"), MODELDOCK_CODEX_HOME: codexHome,
    MODELDOCK_NATIVE_CATALOG_FILE: nativeCatalog, MODELDOCK_CUSTOM_ENDPOINTS_FILE: endpoints,
    MODELDOCK_SETTINGS_EVENTS_FILE: path.join(state, "settings-events.jsonl"), MODELDOCK_USAGE_EVENTS_FILE: path.join(state, "usage-events.jsonl"),
    MODELDOCK_UPSTREAM_BASE_URL: `${origin}/go/v1`, CODEX_NATIVE_BASE_URL: `${origin}/native`,
    MODELDOCK_REQUIRE_CALLER_KEY: "0", MODELDOCK_MEMORY: "0", MODELDOCK_MODEL_DISCOVERY: "0",
    MODELDOCK_NATIVE_MERGE: "1", MODELDOCK_REFRESH_NATIVE_CATALOG: "0", MODELDOCK_REVIEW_MODEL: "gpt-6-astra@openai",
    MODELDOCK_VISION_MODEL: "cloud-custom@custom",
    MODELDOCK_AUTOSTART_KEY: `HKCU\\Software\\ModelDockTests\\local-subagents-${process.pid}`,
    MODELDOCK_AUTOSTART_NAME: `ModelDockLocalSubagents${process.pid}`,
  };
  const launch = () => spawn(process.execPath, ["--import", pathToFileURL(redirect).href, bundle], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let child = launch();
  let logs = "";
  const captureLogs = () => {
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
  };
  captureLogs();
  t.after(async () => {
    await stop(child);
    await close(upstream);
    if (process.platform === "win32") {
      try { execFileSync("reg.exe", ["delete", env.MODELDOCK_AUTOSTART_KEY, "/f"], { stdio: "ignore" }); } catch { /* test key may not exist */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${gatewayPort}`;
  const catalog = async () => {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`isolated bundle exited ${child.exitCode}: ${logs}`);
      try {
        const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return (await response.json()).models;
      } catch { /* isolated bundle is starting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`isolated bundle failed to start: ${logs}`);
  };
  const initial = await catalog();
  const cloudRecipe = initial.find((entry) => entry.slug === slug("opencode-go", "deepseek-v4-flash")).base_instructions;
  const declarations = [...fixture.request.tools, collab([...starts, ...cleanup, "send_message"]), ...starts.map(fn), ...starts.map((name) => fn(`collaboration__${name}`)),
    fn("multi_agent_v1__followup_task"), { type: "namespace", name: "mcp__trading_support", tools: [fn("spawn_agent"), fn("get_ledger")] }];
  const input = [...fixture.request.input,
    { type: "function_call", id: "fc_previous_child", call_id: "call_previous_child", namespace: "collaboration", name: "spawn_agent", arguments: "{}" },
    { type: "function_call_output", call_id: "call_previous_child", output: "CHILD_ALREADY_STARTED" },
    { type: "additional_tools", tools: [collab([...starts, "send_message"]), ...starts.map(fn), ...starts.map((name) => fn(`multi_agent_v1__${name}`))] },
    { type: "additional_tools", tools: [collab(starts)] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue in this conversation." }] },
  ];
  const send = async (model, instructionShape = cloudRecipe, session = "local-policy-session", requestInput = input) => {
    const before = received.length;
    t.diagnostic(`relay ${model}`);
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", "session_id": session },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ ...fixture.request, model, instructions: instructionShape, tools: declarations, input: requestInput }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${model} wire policy failed: ${text}\n${logs}`);
    assert.match(text, /POLICY_OK/);
    assert.equal(received.length, before + 1);
    return received.at(-1).body;
  };

  // Same session switches both ways; policy follows the selected model, not
  // the global dashboard default, nor a sticky flag from the previous turn.
  await send(slug("opencode-go", "deepseek-v4-flash"));
  await send(slug("local", "lab/chat"));
  await send(slug("local", "lab/responses"), [{ type: "input_text", text: cloudRecipe }]);
  await send(slug("custom", "loop-custom"));
  await send(slug("custom", "cloud-custom"));
  await send("gpt-6-astra");
  await send(slug("local", "lab/chat"));
  // A separate cloud session remains unaffected by concurrent Local usage.
  await send(slug("opencode-go", "deepseek-v4-flash"), cloudRecipe, "cloud-policy-session");

  // A fresh pasted-image turn has no prior tool loop. Keep the full envelope
  // and declarations while exercising the existing remote vision escalation.
  localVisionTurn = true;
  try {
    await send(slug("local", "lab/responses"), cloudRecipe, "local-vision-policy-session", [{
      type: "message", role: "user", content: [
        { type: "input_text", text: "Inspect this test pixel." },
        { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPioAAAAASUVORK5CYII=" },
      ],
    }]);
  } finally {
    localVisionTurn = false;
  }
  await send(slug("custom", "cloud-custom"));

  for (const model of [slug("local", "lab/chat"), slug("local", "lab/responses"), slug("custom", "loop-custom")]) {
    const row = initial.find((entry) => entry.slug === model);
    assert.match(row.base_instructions, /LOCAL SUBAGENT RULE:/);
    assert.doesNotMatch(row.base_instructions, /For ordinary delegation, set agent_type=/);
    assert.equal(row.model_messages.instructions_template, row.base_instructions);
    assert.equal(row.auto_review_model_override, "gpt-6-astra", "local filtering never disables the approval reviewer");
  }
  for (const model of [slug("opencode-go", "deepseek-v4-flash"), slug("custom", "cloud-custom"), "gpt-6-astra"]) {
    const row = initial.find((entry) => entry.slug === model);
    assert.match(row.base_instructions, /For ordinary delegation, set agent_type=/);
    assert.doesNotMatch(row.base_instructions, /LOCAL SUBAGENT RULE:/);
  }
  assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), configText, "no global multi-agent configuration changes");
  await stop(child);
  child = launch();
  captureLogs();
  await catalog();
  await send(slug("local", "lab/chat"));
});

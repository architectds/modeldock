// Keep the complete redacted original Codex envelope and all 164 descriptors.
// Synthetic history and one extra namespace exercise normalization without
// claiming to reproduce an unredacted Mac request or an upstream cache policy.
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
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { encode } from "fast-png";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repo, "dist/modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))));
const usage = { input_tokens: 4096, output_tokens: 17, input_tokens_details: { cached_tokens: 3072 }, output_tokens_details: { reasoning_tokens: 3 } };
const chatUsage = { prompt_tokens: 4096, completion_tokens: 17, prompt_tokens_details: { cached_tokens: 3072 }, completion_tokens_details: { reasoning_tokens: 3 } };
const summary = "COMPACTION_PREFIX_HANDOFF: continue the same task with its recorded constraints.";
const callerKey = "test-caller-key-0123456789abcdefghij";
const slug = (provider, model) => `mdr.${Buffer.from(provider).toString("base64url")}.${Buffer.from(model).toString("base64url")}`;
const message = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const transcript = (body) => body.messages || body.input;
const textOf = (item) => typeof item?.content === "string" ? item.content : (item?.content || []).map((part) => part.text || "").join("\n");
const instructions = (body) => body.messages ? body.messages[0]?.content : body.instructions;
const imageUrls = (body) => transcript(body).flatMap((item) => Array.isArray(item.content)
  ? item.content.filter((part) => ["input_image", "image_url"].includes(part.type)).map((part) => typeof part.image_url === "string" ? part.image_url : part.image_url?.url)
  : []);

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function completed(text) {
  if (text.startsWith("{")) return JSON.parse(text);
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.completed") return event.response;
  }
  throw new Error("No completed response from the built bundle");
}

function toolNames(body) {
  return (body.tools || []).map((tool) => tool.function?.name || tool.name).filter(Boolean);
}

function historyCalls(body) {
  return body.messages
    ? body.messages.flatMap((item) => (item.tool_calls || []).map((call) => ({ id: call.id, name: call.function.name })))
    : body.input.filter((item) => ["function_call", "custom_tool_call"].includes(item.type)).map((item) => ({ id: item.call_id, name: item.name }));
}

test("built bundle preserves the model-driven compaction prefix and reports cached tokens", { timeout: 90_000 }, async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.capture.originalToolCount, 164);
  assert.equal(fixture.request.tools.length, 164);
  const sandbox = path.resolve(process.env.MODELDOCK_SANDBOX_DIR || os.tmpdir());
  await mkdir(sandbox, { recursive: true });
  const root = await mkdtemp(path.join(sandbox, "modeldock-compaction-prefix-"));
  assert.equal(path.dirname(root), sandbox, "cleanup must stay inside the chosen test sandbox");
  const state = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  await mkdir(state, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(state, "caller-key"), callerKey);
  await writeFile(path.join(state, "xai-auth.json"), JSON.stringify({
    accessToken: "fixture-xai-token", expiresAt: Date.now() + 3_600_000, models: ["grok-4.6"],
  }));
  const usageFile = path.join(state, "usage-events.jsonl");
  const received = [];
  let child;
  let logs = "";
  const autostartKey = `HKCU\\Software\\ModelDockTests\\compaction-prefix-${process.pid}`;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    received.push({ path: req.url, body });
    const n = received.length;
    const text = body.stream === false ? summary : "ORDINARY_PREFIX_OK";
    const response = {
      id: `resp_prefix_${n}`, object: "response", status: "completed", model: body.model,
      output: [message("assistant", text)], usage,
    };
    if (body.stream === false) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(body.messages ? {
        id: `chatcmpl_prefix_${n}`, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: chatUsage,
      } : response));
    }
    const event = body.messages ? {
      id: `chatcmpl_prefix_${n}`, model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: chatUsage,
    } : { type: "response.completed", response };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  t.after(async () => {
    await stop(child);
    await close(upstream);
    if (process.platform === "win32") {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* only this test's key */ }
    }
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${await listen(upstream)}`;
  const endpointsFile = path.join(state, "custom-endpoints.json");
  await writeFile(endpointsFile, JSON.stringify(["responses", "chat"].map((transport) => ({
    modelId: `prefix-${transport}`, baseUrl: `https://hosted.fixture/${transport}/v1`, transport,
    apiKey: "fixture-custom", supportsVision: true, contextWindow: 1_000_000,
  }))));
  const redirect = path.join(root, "redirect.mjs");
  await writeFile(redirect, `const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(String(input));
  if (url.origin === "https://hosted.fixture") return original("${origin}" + url.pathname + url.search, options);
  if (url.origin === "https://api.x.ai") return original("${origin}/xai" + url.pathname + url.search, options);
  if (url.origin === "${origin}") return original(input, options);
  throw new Error("Compaction prefix test blocked external fetch: " + url.origin);
};
`);
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  const api = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", pathToFileURL(redirect).href, bundle], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env, MODELDOCK_PORT: String(port), MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_STATE_DIR: state, MODELDOCK_ENV_FILE: path.join(state, ".env"), MODELDOCK_CODEX_HOME: codexHome,
      MODELDOCK_CUSTOM_ENDPOINTS_FILE: endpointsFile, MODELDOCK_USAGE_EVENTS_FILE: usageFile,
      MODELDOCK_SETTINGS_EVENTS_FILE: path.join(state, "settings-events.jsonl"),
      MODELDOCK_UPSTREAM_BASE_URL: `${origin}/go/v1`, OPENCODE_GO_TOKEN: "fixture-go-token",
      MODELDOCK_REQUIRE_CALLER_KEY: "0", MODELDOCK_MEMORY: "0", MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0", MODELDOCK_MODEL_DISCOVERY: "0", MODELDOCK_VISION_MODEL: "none",
      MODELDOCK_AUTOSTART_KEY: autostartKey, MODELDOCK_AUTOSTART_NAME: `ModelDockCompactionPrefix${process.pid}`,
    },
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`isolated bundle exited: ${logs}`);
    try {
      const response = await fetch(`${api}/api/status`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* only the isolated bundle is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `isolated bundle did not start: ${logs}`);

  const longTool = fixture.request.tools.find((tool) => typeof tool.name === "string" && tool.name.length > 64);
  assert.ok(longTool, "the original fixture must exercise a real overlong tool descriptor");
  const namespace = "mcp__prefix_fixture";
  const tools = [...fixture.request.tools, {
    type: "namespace", name: namespace, description: "Synthetic prefix probe.",
    tools: [{ type: "function", name: "inspect", description: "Read a synthetic state.", strict: true,
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }],
  }];
  const input = [...fixture.request.input,
    { type: "reasoning", summary: [], content: [{ type: "reasoning_text", text: "RETAIN_REASONING_PREFIX" }] },
    { type: "function_call", id: "fc_prefix_namespace", call_id: "call_prefix_namespace", namespace, name: "inspect", arguments: '{"path":"fixture.txt"}' },
    { type: "function_call_output", call_id: "call_prefix_namespace", output: "NAMESPACE_RESULT" },
    { type: "function_call", id: "fc_prefix_long", call_id: "call_prefix_long", name: longTool.name, arguments: "{}" },
    { type: "function_call_output", call_id: "call_prefix_long", output: "LONG_NAME_RESULT" },
    { type: "additional_tools", tools: [longTool] },
    message("assistant", "The previous synthetic inspection is complete."),
    message("developer", "Later permission update: preserve the read-only boundary."),
    message("user", "Continue the same task without replacing the retained history."),
  ];
  const currentImages = Array.from({ length: 21 }, (_, index) => ({
    type: "input_image", image_url: `data:image/png;base64,${Buffer.from(encode({ width: 1, height: 1, channels: 4, data: new Uint8Array([index, 100, 200, 255]) })).toString("base64")}`,
  }));
  const send = async (model, session, protocol = null, requestInput = input, compactPath = "/v1/responses/compact") => {
    const before = received.length;
    const response = await fetch(`${api}${protocol === "v1" ? compactPath : "/v1/responses"}`, {
      method: "POST", headers: { "content-type": "application/json", session_id: session },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ ...fixture.request, model, tools,
        ...(model === slug("xai", "grok-4.6") ? { external_web_access: true } : {}),
        input: protocol === "v2" ? [...requestInput, { type: "compaction_trigger" }] : requestInput }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `${model} ${protocol || "ordinary"}: ${text}\n${logs}`);
    assert.equal(received.length, before + 1, "model-driven compaction must make exactly one mocked upstream request");
    return { body: received.at(-1).body, response: completed(text) };
  };
  const routes = [
    ["Custom Responses", slug("custom", "prefix-responses"), `/c/${callerKey}/v1/responses/compact`],
    ["Custom Chat", slug("custom", "prefix-chat"), "/responses/compact"],
    ["Go Pro Responses", slug("opencode-go", "deepseek-v4-pro")],
    ["Go Flash Responses", slug("opencode-go", "deepseek-v4.1-flash")],
    ["xAI Responses", slug("xai", "grok-4.6")],
  ];
  for (const [name, model, compactPath] of routes) await t.test(name, async (routeTest) => {
    const withImages = name.startsWith("Custom") || name === "xAI Responses";
    const requestInput = withImages
      ? [...input, { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect these 21 current attachments." }, ...currentImages] }]
      : input;
    const ordinary = await send(model, `${name}-ordinary`, null, requestInput);
    assert.match(JSON.stringify(ordinary.response), /ORDINARY_PREFIX_OK/);
    if (withImages) {
      const images = imageUrls(ordinary.body);
      for (const image of currentImages) assert.ok(images.includes(image.image_url), "ordinary relay must retain all 21 current images, not merely the last 20");
    }
    assert.ok(toolNames(ordinary.body).length >= 150, "the baseline must forward the full normalized fixture, not a small tool sample");
    for (const id of ["call_prefix_namespace", "call_prefix_long"]) {
      const call = historyCalls(ordinary.body).find((item) => item.id === id);
      assert.ok(call && call.name.length <= 64 && toolNames(ordinary.body).includes(call.name), `${id} must match its normalized declaration`);
    }
    assert.match(JSON.stringify(transcript(ordinary.body)), /RETAIN_REASONING_PREFIX/);
    for (const protocol of ["v1", "v2"]) await routeTest.test(protocol, async (compactTest) => {
      const session = `${name}-${protocol}`;
      const compact = await send(model, session, protocol, requestInput, compactPath);
      assert.ok(compact.response.output?.length, "the client receives a completed compact handoff");
      if (protocol === "v2") {
        assert.equal(compact.response.output[0].type, "compaction");
        assert.match(compact.response.output[0].encrypted_content, /^kcr1:/);
        assert.ok(Buffer.from(compact.response.output[0].encrypted_content.slice(5), "base64").toString("utf8").startsWith(summary), "the decoded compact item must retain the exact upstream summary");
      } else assert.ok(compact.response.output.some((item) => textOf(item).includes(summary)), "replacement history must deliver the exact upstream summary");
      if (name === "xAI Responses") await compactTest.test("preserves xAI current pixels and removes unsupported web options", () => {
        assert.ok(imageUrls(compact.body).includes(currentImages.at(-1).image_url), "xAI compaction must receive the exact original current image URL");
        assert.equal(Object.hasOwn(compact.body, "external_web_access"), false);
        const hosted = compact.body.tools.find((tool) => tool.type === "web_search");
        assert.ok(hosted, "xAI must retain its hosted web_search descriptor");
        assert.equal(Object.hasOwn(hosted, "external_web_access"), false);
      });
      await compactTest.test("retains normalized instructions", () => {
        assert.ok(isDeepStrictEqual(instructions(compact.body), instructions(ordinary.body)), "compaction must retain the complete normalized instruction prefix");
      });
      await compactTest.test("retains normalized tool names, order and descriptors", () => {
        assert.ok(isDeepStrictEqual(compact.body.tools, ordinary.body.tools), `compaction tools differ: ordinary=${ordinary.body.tools?.length || 0}, compact=${compact.body.tools?.length || 0}`);
      });
      await compactTest.test("retains the entire normalized history prefix", () => {
        const prior = transcript(ordinary.body);
        assert.equal(transcript(compact.body).length, prior.length + 1, "compaction only appends one summary-demand message");
        assert.ok(isDeepStrictEqual(transcript(compact.body).slice(0, prior.length), prior), "compaction rewrote the normalized shared history prefix");
        assert.match(textOf(transcript(compact.body).at(-1)), /CONTEXT CHECKPOINT COMPACTION/);
        assert.equal(transcript(compact.body).at(-1).role, "user");
        assert.equal(compact.body.tool_choice, "none");
        assert.equal(compact.body.stream, false);
        assert.ok((compact.body.input || []).every((item) => item.type !== "compaction_trigger"), "the client trigger must never reach the upstream");
        assert.deepEqual(compact.body.reasoning, ordinary.body.reasoning);
        assert.equal(compact.body.cache_prompt, ordinary.body.cache_prompt);
      });
      await compactTest.test("records the upstream cache hit in persisted usage", () => {
        const events = readFileSync(usageFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
        const event = events.findLast((item) => item.sessionId === session && item.route === `compact_${protocol}`);
        assert.ok(event, "compaction must record a usage event");
        assert.equal(event.inputTokens, usage.input_tokens);
        assert.equal(event.cachedTokens, usage.input_tokens_details.cached_tokens);
      });
      await compactTest.test("records the upstream cache hit in the compact trace", async () => {
        const snapshot = await (await fetch(`${api}/api/status`)).json();
        const trace = snapshot.recent.find((item) => item.sessionId === session && item.operation === `compact_${protocol}`);
        assert.ok(trace, "compaction must expose a trace record");
        assert.equal(trace.inputTokens, usage.input_tokens);
        assert.equal(trace.cachedTokens, usage.input_tokens_details.cached_tokens, "compact trace must not turn an upstream cache hit into an absent/zero field");
      });
    });
  });
});

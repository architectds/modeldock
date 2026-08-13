import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createApp, createServices } from "./server.mjs";
import { OPENCODE_GO_PROFILE } from "./profiles.mjs";

// Bare-path relay tests exercise the routed gateway, not the caller-key guard.
// Enforcement is ON by default since 0.1.10, so these tests opt out explicitly;
// the default-enforcement behavior itself is covered by its own test below.
process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

const TEST_PROFILE = { ...OPENCODE_GO_PROFILE };

function baseConfig() {
  return {
    host: "127.0.0.1",
    port: 0,
    profile: TEST_PROFILE,
    profileId: TEST_PROFILE.id,
    goBaseUrl: "https://go.example.com/v1",
    opencodeBaseUrl: "https://go.example.com/v1",
    deepseekBaseUrl: "https://ds.example.com",
    goToken: "go-token",
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    visionFallbackModel: "kimi-k2.5",
    visionTimeoutMs: 90_000,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxEntries: 64,
    exaMcpUrl: "https://mcp.exa.ai/mcp",
    exaApiKey: "",
    recentLimit: 50,
    debug: { noSessionCheck: true },
    callerKey: "test-caller-key-0123456789abcdefghij",
    refreshNativeCatalog: false,
  };
}

async function startApp(configOverrides = {}) {
  const config = { ...baseConfig(), ...configOverrides };
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-gateway-test-"));
  config.summariesFile = path.join(dir, "summaries.json");
  config.codexCatalogFile = path.join(dir, "codex-model-catalog.json");
  config.nativeCatalogFile = path.join(dir, "native-catalog.json");
  const services = createServices(config);
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    server,
    services,
    stop: async () => {
      await services.mediaStore.cleanup();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function jsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

function sseResponse(events) {
  const body = events.map(({ type, data }) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

test("gateway: image turns escalate to the vision model; an explicit client model reclaims the continuation", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ model: body.model, input: body.input, auth: req.headers.authorization });
    if (body.input.some((item) => item.type === "function_call_output")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "resp_final",
        output: [{ id: "msg_final", type: "message", role: "assistant", content: [{ type: "output_text", text: "DONE" }] }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-luna","output":[{"type":"function_call","call_id":"call_00_viz","name":"shell_command","arguments":"{}"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n\n');
    res.end();
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const imageTurn = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/p.png" }] }],
    }),
  });
  assert.equal(imageTurn.status, 200);
  await imageTurn.text();
  assert.equal(seen[0].model, "gpt-5.6-luna", "image turn is escalated to the vision model");
  assert.equal(seen[0].input[0].content[0].type, "input_image", "image bytes are forwarded untouched");

  const continuation = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "function_call_output", call_id: "call_00_viz", output: "{}" }],
    }),
  });
  assert.equal(continuation.status, 200);
  await continuation.text();
  assert.equal(seen[1].model, "deepseek-v4-flash", "the explicit client model reclaims the wheel - no cascade onto the vision model");

  const textTurn = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(textTurn.status, 200);
  await textTurn.text();
  assert.equal(seen[2].model, "deepseek-v4-flash", "a fresh text turn returns to the main model");
});

test("gateway: deepseek-official models route to the DeepSeek upstream with its token", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ url: `${req.headers.host}${req.url}`, model: body.model, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_ds",
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ deepseekBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash@deepseek-official",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, "deepseek-v4-flash", "owner suffix is stripped before the upstream");
  assert.equal(seen[0].auth, "Bearer ds-token");
  assert.match(seen[0].url, /127\.0\.0\.1:\d+\/responses/);
});

test("gateway: SSE bytes pass through verbatim and usage reaches the meter", async (t) => {
  const upstream = createServer((_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}\n\n');
    res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n');
    res.write('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":22,"output_tokens":7}}}\n\n');
    res.end();
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const response = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  const body = await response.text();
  assert.match(body, /response\.output_text\.delta/);
  assert.match(body, /"delta":"hel"/);
  assert.match(body, /"delta":"lo"/);
  const snap = instance.services.metrics.snapshot();
  assert.equal(snap.responses.inputTokens, 22);
  assert.equal(snap.responses.outputTokens, 7);
});

test("gateway: hosted tool schemas are stripped before reaching the upstream", async (t) => {
  let received;
  const upstream = createServer(async (req, res) => {
    received = await jsonBody(req);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_t",
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: {},
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [
        { type: "web_search", name: "web_search" },
        { type: "function", name: "shell_command", parameters: {} },
      ],
    }),
  });
  const names = (received.tools || []).map((tool) => tool.name);
  assert.deepEqual(names, ["shell_command"]);
});

test("gateway: historical images are replaced with refs, current images stay for the vision model", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ model: body.model, input: body.input });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: `resp_${seen.length}`,
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: {},
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  // Turn 1: image in the current turn -> escalated to the vision model, image bytes kept.
  const imageUrl = "data:image/png;base64,AAAA";
  await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] }],
    }),
  });
  assert.equal(seen[0].model, "gpt-5.6-luna");
  assert.equal(seen[0].input[0].content[0].type, "input_image", "current-turn image reaches the vision model");

  // Turn 2: the same image now lives in history plus a text question.
  // The main model must not receive the image bytes again.
  await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [
        { type: "message", role: "user", content: [{ type: "input_image", image_url: imageUrl }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "The image shows a chart." }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "What was the y-axis?" }] },
      ],
    }),
  });
  assert.equal(seen[1].model, "deepseek-v4-flash", "text-only follow-up returns to the main model");
  const historyPart = seen[1].input[0].content[0];
  assert.equal(historyPart.type, "input_text", "historical image is not re-sent as bytes");
  assert.match(historyPart.text, /\[Image attachment img_[a-f0-9]+/);
  assert.equal(seen[1].input[2].content[0].type, "input_text");
  const hasImageAnywhere = seen[1].input.some((item) => Array.isArray(item.content) && item.content.some((part) => part.type === "input_image"));
  assert.equal(hasImageAnywhere, false, "the main model request carries no input_image at all");
});

test("caller-key routes: correct key relays, wrong key and enforced bare path 401", async (t) => {
  const zlib = await import("node:zlib");
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n');
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);
  const body = JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
  const headers = { "content-type": "application/json" };

  const keyed = await fetch(`${instance.base}/c/test-caller-key-0123456789abcdefghij/v1/responses`, { method: "POST", headers, body });
  assert.equal(keyed.status, 200, "the keyed path relays");
  await keyed.text();

  const wrong = await fetch(`${instance.base}/c/wrong-key-00000000000000000000000/v1/responses`, { method: "POST", headers, body });
  assert.equal(wrong.status, 401, "a wrong key is rejected");
  const wrongCompressed = await fetch(`${instance.base}/c/wrong-key-00000000000000000000000/v1/responses`, {
    method: "POST",
    headers: { ...headers, "content-encoding": "zstd" },
    body: zlib.zstdCompressSync(Buffer.from(body)),
  });
  assert.equal(wrongCompressed.status, 401, "a wrong key is rejected before zstd decompression");

  const models = await fetch(`${instance.base}/c/test-caller-key-0123456789abcdefghij/v1/models`);
  assert.equal(models.status, 200, "the keyed models path serves the catalog");

  process.env.MODELDOCK_REQUIRE_CALLER_KEY = "1";
  t.after(() => { process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0"; });
  const bare = await fetch(`${instance.base}/v1/responses`, { method: "POST", headers, body });
  assert.equal(bare.status, 401, "bare path is refused once enforcement is on");
  const bareCompressed = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { ...headers, "content-encoding": "zstd" },
    body: zlib.zstdCompressSync(Buffer.from(body)),
  });
  assert.equal(bareCompressed.status, 401, "compressed bare path is refused before decompression");
});

test("caller-key enforcement defaults to on: bare paths 401 without an explicit opt-out", async (t) => {
  const upstream = createServer((req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n');
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);
  const body = JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
  const headers = { "content-type": "application/json" };

  delete process.env.MODELDOCK_REQUIRE_CALLER_KEY;
  t.after(() => { process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0"; });
  const bare = await fetch(`${instance.base}/v1/responses`, { method: "POST", headers, body });
  assert.equal(bare.status, 401, "the bare path is refused by default");
  const bareImages = await fetch(`${instance.base}/images/generations`, { method: "POST", headers, body });
  assert.equal(bareImages.status, 401, "the bare native-image path is refused by default");
  const keyed = await fetch(`${instance.base}/c/test-caller-key-0123456789abcdefghij/v1/responses`, { method: "POST", headers, body });
  assert.equal(keyed.status, 200, "the keyed path still relays by default");
  await keyed.text();
});

test("zstd-encoded request bodies are decompressed before the relay", { skip: typeof (await import("node:zlib")).zstdCompressSync !== "function" }, async (t) => {
  const zlib = await import("node:zlib");
  let seenModel = null;
  const upstream = createServer(async (req, res) => {
    seenModel = (await jsonBody(req)).model;
    res.setHeader("content-type", "text/event-stream");
    res.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\ndata: [DONE]\n\n');
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);
  const payload = JSON.stringify({ model: "deepseek-v4-flash", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
  // Codex sends zstd-compressed bodies on some requests (remote compact tasks);
  // body-parser only speaks gzip/deflate/br and 415'd the whole turn.
  const res = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "zstd" },
    body: zlib.zstdCompressSync(Buffer.from(payload)),
  });
  assert.equal(res.status, 200, "zstd body must relay, not 415");
  await res.text();
  assert.equal(seenModel, "deepseek-v4-flash");
});

test("gateway: remote compaction v1/v2 is synthesized for routed models", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ path: req.url, model: body.model, stream: body.stream, tools: body.tools, toolChoice: body.tool_choice, lastInput: body.input?.at(-1) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_summary",
      object: "response",
      model: "deepseek-v4-flash",
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "compact summary" }] }],
      usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11 },
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({ goBaseUrl: `http://127.0.0.1:${port}`, opencodeBaseUrl: `http://127.0.0.1:${port}` });
  t.after(instance.stop);

  const keyedCompactV1 = await fetch(`${instance.base}/c/test-caller-key-0123456789abcdefghij/v1/responses/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "recent" }] }] }),
  });
  assert.equal(keyedCompactV1.status, 200);
  const v1Body = await keyedCompactV1.json();
  assert.ok(Array.isArray(v1Body.output));
  assert.equal(v1Body.output.at(-1).role, "user");
  assert.match(v1Body.output.at(-1).content[0].text, /compact summary/);
  assert.equal(seen[0].stream, false, "the summarize call is non-streaming");
  assert.deepEqual(seen[0].tools, [], "no tools ride on the summarize call");
  assert.equal(seen[0].toolChoice, "none");

  const v2 = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "compaction_trigger" },
      ],
    }),
  });
  assert.equal(v2.status, 200);
  const v2Body = await v2.json();
  assert.equal(v2Body.output[0].type, "compaction");
  assert.match(v2Body.output[0].encrypted_content, /^kcr1:/);
  assert.ok(!seen[1].lastInput || seen[1].lastInput.type !== "compaction_trigger", "the trigger never reaches the upstream");

  // The same v2 request must not 404 on the wrong-keyed path, and a bare
  // compact path relays too.
  const bareV1 = await fetch(`${instance.base}/responses/compact`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", input: [] }),
  });
  assert.equal(bareV1.status, 200);
  const bareV1Body = await bareV1.json();
  assert.ok(Array.isArray(bareV1Body.output));
});

test("gateway: nativeMerge=false hides native models from /v1/models but the relay still routes", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    seen.push({ model: (await jsonBody(req)).model });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_go",
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-native-nomerge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const nativeCatalogFile = path.join(dir, "native-catalog.json");
  await writeFile(nativeCatalogFile, JSON.stringify({
    captured_with: "0.1.0",
    models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 }],
  }), "utf8");
  const instance = await startApp({
    goBaseUrl: `http://127.0.0.1:${port}`,
    opencodeBaseUrl: `http://127.0.0.1:${port}`,
    nativeCatalogFile,
    nativeMerge: false,
  });
  t.after(instance.stop);

  const models = await (await fetch(`${instance.base}/v1/models`)).json();
  const slugs = models.models.map((model) => model.slug);
  assert.ok(slugs.includes("deepseek-v4-flash@opencode-go"), "curated Go models stay published");
  assert.ok(slugs.includes("gpt-5.6-luna@opencode-go"), "our qualified Luna stays published");
  assert.ok(!slugs.includes("gpt-5.6-luna"), "the native GPT model is hidden for non-subscribers");

  const relay = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(relay.status, 200, "the relay still works with the native merge off");
  await relay.text();
  assert.equal(seen[0].model, "deepseek-v4-flash", "the upstream receives the routed model");
});

test("gateway: trial mode serves only the free pair and relays zen-free models to the zen base", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    seen.push({ url: req.url, model: (await jsonBody(req)).model });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "resp_free",
      output: [{ id: "msg", type: "message", role: "assistant", content: [{ type: "output_text", text: "free ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({
    goBaseUrl: `http://127.0.0.1:${port}`,
    opencodeBaseUrl: `http://127.0.0.1:${port}`,
    zenBaseUrl: `http://127.0.0.1:${port}/v1`,
    trialMode: true,
  });
  t.after(instance.stop);

  const models = await (await fetch(`${instance.base}/v1/models`)).json();
  assert.deepEqual(models.models.map((model) => model.slug).sort(), ["deepseek-v4-flash-free@opencode-go", "mimo-v2.5-free@opencode-go"]);

  const relay = await fetch(`${instance.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash-free",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "trial" }] }],
    }),
  });
  assert.equal(relay.status, 200, "a zen-free model relays in trial mode");
  await relay.text();
  assert.equal(seen[0].model, "deepseek-v4-flash-free", "the zen base receives the free model");
  assert.match(seen[0].url, /\/responses$/, "the free model goes over the responses wire");
});

test("gateway: captures zen free 200+empty output as a quota error on both wires", async (t) => {
  const seen = [];
  const upstream = createServer(async (req, res) => {
    const body = await jsonBody(req);
    seen.push({ url: req.url, model: body.model, stream: body.stream });
    if (body.model === "deepseek-v4-flash-free") {
      // Free endpoint answering 200 with no output items on both wires.
      if (body.stream === true) {
        res.setHeader("content-type", "text/event-stream");
        res.end(
          "event: response.completed\n" +
            'data: {"type":"response.completed","response":{"id":"resp_bare","model":"deepseek-v4-flash-free"}}\n\n' +
            'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":42,"completion_tokens":64,"total_tokens":106}}\n\n' +
            "data: [DONE]\n\n",
        );
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_empty",
          output: [],
          stop_reason: "max_output_tokens",
          usage: { input_tokens: 42, output_tokens: 64 },
        }),
      );
      return;
    }
    if (body.model === "mimo-v2.5-free") {
      // Free endpoint that answered properly.
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "resp_ok",
          output: [{ id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text: "free ok" }] }],
        }),
      );
      return;
    }
    // Paid model: an empty output must pass through untouched - the capture is free-only.
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "resp_paid_empty", output: [], stop_reason: "max_output_tokens" }));
  });
  const port = await listen(upstream);
  t.after(() => upstream.close());
  const instance = await startApp({
    goBaseUrl: `http://127.0.0.1:${port}`,
    opencodeBaseUrl: `http://127.0.0.1:${port}`,
    zenBaseUrl: `http://127.0.0.1:${port}/v1`,
  });
  t.after(instance.stop);
  const post = (model, stream) =>
    fetch(`${instance.base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

  // Non-stream free empty: 429 + the reused quota_exhausted guidance.
  const json = await post("deepseek-v4-flash-free", false);
  assert.equal(json.status, 429);
  const jsonBodyRes = await json.json();
  assert.equal(jsonBodyRes.error.type, "quota_exhausted");
  assert.match(jsonBodyRes.error.message, /\[opencode-go\]/);
  assert.match(jsonBodyRes.error.message, /zen free endpoint has no quota left/);
  assert.match(jsonBodyRes.error.message, /5h rolling window/);
  assert.match(jsonBodyRes.error.message, /switch to ON mode/);

  // Streaming free empty: the bare completed is replaced by response.failed.
  const stream = await post("deepseek-v4-flash-free", true);
  assert.equal(stream.status, 200);
  const streamText = await stream.text();
  assert.match(streamText, /event: response\.failed/);
  assert.match(streamText, /zen free endpoint has no quota left/);
  assert.doesNotMatch(streamText, /response\.completed/);

  // The captured streaming failure lands in the metrics trace as an error.
  const trace = instance.services.metrics.recent.find(
    (record) => record.ok === false && record.httpStatus === 429,
  );
  assert.ok(trace, "the empty free stream records an error trace");
  assert.match(trace.error, /zen free endpoint has no quota left/);

  // Free normal response stays untouched.
  const ok = await post("mimo-v2.5-free", false);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.output[0].content[0].text, "free ok");

  // Paid empty output is NOT intercepted.
  const paid = await post("deepseek-v4-flash", false);
  assert.equal(paid.status, 200);
  const paidBody = await paid.json();
  assert.deepEqual(paidBody.output, []);
});

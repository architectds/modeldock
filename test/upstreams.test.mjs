import { test } from "node:test";
import assert from "node:assert/strict";
import { createUpstreams, parseMcpTextResult, extractOutputText } from "../src/upstreams.mjs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

test("generateImage posts to the native backend and saves the PNG", async () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "modeldock-upstreams-auth-"));
  writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test-token", account_id: "acct-1" } }),
    "utf8",
  );
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const upstreams = createUpstreams({
    config: { codexHome },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ b64_json: pngBytes.toString("base64") }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const output = await upstreams.generateImage({ prompt: "a red square" });
    assert.match(output, /^Generated image saved to .+\.png$/);
    const file = output.replace("Generated image saved to ", "");
    assert.ok(existsSync(file), "the PNG file exists on disk");
    assert.equal(readFileSync(file)[0], 0x89, "the file starts with the PNG magic byte");
    rmSync(file, { force: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
    assert.equal(calls[0].init.headers.Authorization, "Bearer test-token");
    assert.equal(calls[0].init.headers["chatgpt-account-id"], "acct-1");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "gpt-image-1");
    assert.equal(body.prompt, "a red square");
    assert.equal(body.size, "1024x1024");
    assert.equal(body.n, 1);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("generateImage fails with a readable error when there is no session token", async () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "modeldock-upstreams-auth-"));
  writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: {} }), "utf8");
  const upstreams = createUpstreams({
    config: { codexHome },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not be called without a token");
  };
  try {
    await assert.rejects(
      () => upstreams.generateImage({ prompt: "x" }),
      /No ChatGPT session token/,
      "missing sign-in surfaces a readable error instead of a fetch attempt",
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("parseMcpTextResult parses a plain JSON tools/call result", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "the answer" }] },
  });
  assert.equal(parseMcpTextResult(body), "the answer");
});

test("parseMcpTextResult parses SSE-wrapped messages", () => {
  const body = [
    "event: message",
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"sse answer"}]}}',
    "",
  ].join("\n");
  assert.equal(parseMcpTextResult(body), "sse answer");
});

test("parseMcpTextResult picks the first payload with text content", () => {
  const body = [
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"image","data":"x"}]}}',
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"winner"}]}}',
  ].join("\n");
  assert.equal(parseMcpTextResult(body), "winner");
});

test("parseMcpTextResult returns empty string for unusable bodies", () => {
  assert.equal(parseMcpTextResult(""), "");
  assert.equal(parseMcpTextResult("{not json"), "");
  assert.equal(parseMcpTextResult(JSON.stringify({ result: { content: [] } })), "");
  assert.equal(parseMcpTextResult(JSON.stringify({ result: {} })), "");
  assert.equal(parseMcpTextResult(undefined), "");
});

test("extractOutputText joins message text parts", () => {
  const response = {
    output: [
      { type: "message", content: [{ type: "output_text", text: "first" }] },
      { type: "message", content: [{ type: "text", text: "second" }] },
      { type: "function_call", name: "x" },
    ],
  };
  assert.equal(extractOutputText(response), "first\nsecond");
});

test("extractOutputText skips non-text parts and non-message items", () => {
  const response = {
    output: [
      { type: "message", content: [{ type: "reasoning", text: "hidden" }, { type: "output_text", text: "visible" }] },
      { type: "message", content: [{ type: "output_text", text: "" }] },
      { type: "message", content: [] },
    ],
  };
  assert.equal(extractOutputText(response), "visible");
});

test("extractOutputText returns empty string for empty responses", () => {
  assert.equal(extractOutputText({ output: [] }), "");
  assert.equal(extractOutputText(undefined), "");
  assert.equal(extractOutputText({}), "");
});

test("searchWeb passes through and parses Exa response", async () => {
  const calls = [];
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "v",
      visionFallbackModel: "f",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "exa result" }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const output = await upstreams.searchWeb({ query: "test query", numResults: 3 });
    assert.equal(output, "exa result");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://mcp.exa.ai/mcp");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.method, "tools/call");
    assert.equal(body.params.name, "web_search_exa");
    assert.equal(body.params.arguments.query, "test query");
    assert.equal(body.params.arguments.numResults, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchWeb appends exaApiKey as query param when configured", async () => {
  const calls = [];
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "secret-key",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "v",
      visionFallbackModel: "f",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "x" }] } }), { status: 200 });
  };
  try {
    await upstreams.searchWeb({ query: "q" });
    assert.equal(calls[0], "https://mcp.exa.ai/mcp?exaApiKey=secret-key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("searchWeb surfaces upstream errors and redacts bearer tokens", async () => {
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "k",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "v",
      visionFallbackModel: "f",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: { get: () => undefined },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('error: Authorization: Bearer abc123tokenxyz', { status: 500 });
  try {
    await assert.rejects(() => upstreams.searchWeb({ query: "q" }), /Bearer \[redacted\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inspectVision reads a local path, registers it, and calls the vision model", async (t) => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "modeldock-vision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pngPath = join(dir, "shot.png");
  const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
  writeFileSync(pngPath, pngBytes);

  let sentBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/chat\/completions$/);
    sentBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "resp_v", choices: [{ message: { role: "assistant", content: "It shows a red chart." } }] }), { status: 200 });
  };

  const MediaStore = (await import("../src/media-store.mjs")).MediaStore;
  const store = new MediaStore({ ttlMs: 60_000, maxBytes: 10 * 1024 * 1024, maxEntries: 8 });
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "mimo-v2.5-free",
      visionFallbackModel: "minimax-m3",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: store,
    // A private cache instance: the module-level singleton would leak this
    // test's answer into the cache-hit test below (same image, same question).
    visionCache: new (await import("../src/vision-cache.mjs")).createVisionCache(),
  });
  try {
    const result = await upstreams.inspectVision({ path: pngPath, question: "What does it show?", mode: "chart" });
    assert.equal(result.answer, "It shows a red chart.");
    assert.equal(result.imageRefs.length, 1);
    assert.match(result.imageRefs[0], /^img_/);
    assert.equal(store.get(result.imageRefs[0]).mime, "image/png");
    assert.equal(sentBody.model, "mimo-v2.5-free");
    assert.match(sentBody.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inspectVision caches the transcription and skips the upstream on repeat", async (t) => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { visionEvidenceCache } = await import("../src/vision-cache.mjs");
  const dir = mkdtempSync(join(tmpdir(), "modeldock-vision-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pngPath = join(dir, "shot.png");
  writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "## Summary\nA chart." } }] }), { status: 200 });
  };

  const MediaStore = (await import("../src/media-store.mjs")).MediaStore;
  const store = new MediaStore({ ttlMs: 60_000, maxBytes: 10 * 1024 * 1024, maxEntries: 8 });
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "mimo-v2.5-free",
      visionFallbackModel: "minimax-m3",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: store,
  });
  try {
    const first = await upstreams.inspectVision({ path: pngPath, question: "What does it show?", mode: "chart" });
    assert.equal(first.answer, "## Summary\nA chart.");
    assert.equal(first.cached, false);
    assert.equal(upstreamCalls, 1);
    const second = await upstreams.inspectVision({ path: pngPath, question: "What does it show?", mode: "chart" });
    assert.equal(second.answer, "## Summary\nA chart.");
    assert.equal(second.cached, true, "the repeat call is served from the cache");
    assert.equal(upstreamCalls, 1, "the vision upstream is paid exactly once");
  } finally {
    globalThis.fetch = originalFetch;
    visionEvidenceCache.clear();
  }
});

test("inspectVision rejects a missing path and a missing ref", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "modeldock-vision-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const MediaStore = (await import("../src/media-store.mjs")).MediaStore;
  const store = new MediaStore({ ttlMs: 60_000, maxBytes: 10 * 1024 * 1024, maxEntries: 8 });
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "mimo-v2.5-free",
      visionFallbackModel: "minimax-m3",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: store,
  });
  await assert.rejects(() => upstreams.inspectVision({ path: join(dir, "nope.png"), question: "q" }), /Image path not found/);
  await assert.rejects(() => upstreams.inspectVision({ question: "q" }), /requires path, image_ref, or compare_image_ref/);
  await assert.rejects(() => upstreams.inspectVision({ image_ref: "img_missing", question: "q" }), /Unknown or expired image_ref/);
});

test("inspectVision degrades one bad image instead of failing the whole turn", async (t) => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "modeldock-vision-mixed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pngPath = join(dir, "ok.png");
  writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

  let sentBody = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "resp_v", choices: [{ message: { role: "assistant", content: "## Summary\nThe good chart." } }] }), { status: 200 });
  };

  const MediaStore = (await import("../src/media-store.mjs")).MediaStore;
  const store = new MediaStore({ ttlMs: 60_000, maxBytes: 10 * 1024 * 1024, maxEntries: 8 });
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "mimo-v2.5-free",
      visionFallbackModel: "minimax-m3",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: store,
    visionCache: new (await import("../src/vision-cache.mjs")).createVisionCache(),
  });
  try {
    const result = await upstreams.inspectVision({
      path: pngPath,
      image_ref: "img_expired",
      question: "What does it show?",
      mode: "chart",
    });
    assert.equal(result.answer, "## Summary\nThe good chart.", "the turn survives with the readable image");
    assert.equal(result.imageRefs.length, 2, "both refs are still reported (including the expired one)");
    assert.equal(sentBody.messages[0].content.filter((c) => c.type === "image_url").length, 1, "only the readable image reaches the vision model");
    assert.equal(result.skippedImages.length, 1, "the caller is told which image was skipped");
    assert.match(result.skippedImages[0], /img_expired/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inspectVision reports a combined failure message when every image is bad", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "modeldock-vision-allbad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const MediaStore = (await import("../src/media-store.mjs")).MediaStore;
  const store = new MediaStore({ ttlMs: 60_000, maxBytes: 10 * 1024 * 1024, maxEntries: 8 });
  const upstreams = createUpstreams({
    config: {
      exaMcpUrl: "https://mcp.exa.ai/mcp",
      exaApiKey: "",
      tokens: { "opencode-go": "t" },
      goBaseUrl: "https://go.example.com/v1",
      visionTimeoutMs: 90_000,
      visionModel: "mimo-v2.5-free",
      visionFallbackModel: "minimax-m3",
    },
    metrics: new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 }),
    mediaStore: store,
  });
  await assert.rejects(
    () => upstreams.inspectVision({ path: join(dir, "nope.png"), image_ref: "img_expired", question: "q" }),
    /every image failed to load/,
    "when every image is unreadable the call fails loudly with each reason",
  );
});

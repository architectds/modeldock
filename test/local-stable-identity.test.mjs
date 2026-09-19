// Contract tests for the stable local llama.cpp identity. One llama.cpp
// endpoint publishes exactly one entry (Local@llamacpp) whatever GGUF is
// loaded on it: stale per-file slugs fold onto the live endpoint for routing
// and stats, the catalog labels the provider once, the local route keeps a
// quiet cold prefill alive with SSE comment frames, and a dead engine fails
// honestly. The hosted path must stay byte-identical throughout.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";

import { applyLocalEngineProfile, publishedCatalogFingerprint, profileById, LLAMACPP_LOCAL_MODEL_LABEL, LLAMACPP_LOCAL_SLUG } from "../src/profiles.mjs";
import { canonicalLlamaLocalKey, foldLlamaLocalKeys } from "../src/model-identity.mjs";
import { normalizeLegacySlug, relayResponses } from "../src/gateway.mjs";
import { estimateApiCost } from "../src/api-pricing.mjs";
import { codexModelCatalog } from "../src/model-options.mjs";
import { attachSseKeepAlive } from "../src/sse.mjs";
import { mainRouteFromUsageEvent } from "../src/usage-events.mjs";
import { LocalHostKvCoordinator } from "../src/local-host-kv-coordinator.mjs";

const FLASH = "D:/models/Qwen3.8-Flash-Next/Qwen3.8-Flash-Next-00001-of-00033.gguf";
const OTHER = "D:/models/Qwen3.9-Next/Qwen3.9-Next.gguf";

function llamaSnapshot(overrides = {}) {
  return {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{
      id: "Src",
      label: "Src",
      upstreamId: FLASH,
      supportsVision: false,
      chatTemplateSupportsObjectArguments: true,
      mediaMarker: "<__media_test__>",
      contextWindow: 262144,
      ...overrides,
    }],
  };
}

function collectingResponse() {
  const chunks = [];
  const res = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }), {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    flushHeaders() { this.headersSent = true; },
  });
  res.chunks = chunks;
  return res;
}

test("a single-model llama.cpp publishes the stable id and keeps the wire id", () => {
  try {
    applyLocalEngineProfile("llamacpp", llamaSnapshot());
    const [entry] = profileById("llamacpp").availableModels;
    assert.equal(entry.id, "Local");
    assert.equal(entry.label, LLAMACPP_LOCAL_MODEL_LABEL);
    assert.equal(entry.upstreamId, FLASH, "the wire carries the id the server advertises");
    assert.equal(entry.mediaMarker, "<__media_test__>");
    assert.equal(entry.contextWindow, 262_144);

    // A hot-swap of the GGUF behind the same port changes the wire id and
    // nothing Codex was told: no restart is owed for it.
    const fingerprintBefore = publishedCatalogFingerprint("llamacpp");
    applyLocalEngineProfile("llamacpp", llamaSnapshot({ upstreamId: OTHER }));
    assert.equal(publishedCatalogFingerprint("llamacpp"), fingerprintBefore);
    assert.equal(profileById("llamacpp").availableModels[0].upstreamId, OTHER);

    // A real window change is a catalog change.
    applyLocalEngineProfile("llamacpp", llamaSnapshot({ upstreamId: OTHER, contextWindow: 131072 }));
    assert.notEqual(publishedCatalogFingerprint("llamacpp"), fingerprintBefore);
  } finally {
    applyLocalEngineProfile("llamacpp", null);
  }
});

test("only the single-model llama.cpp identity is pinned", () => {
  try {
    applyLocalEngineProfile("llamacpp", {
      baseUrl: "http://127.0.0.1:11435/v1",
      models: [{ id: "first", upstreamId: "first" }, { id: "second", upstreamId: "second" }],
    });
    assert.deepEqual(profileById("llamacpp").availableModels.map((model) => model.id), ["first", "second"],
      "a multi-model server keeps per-model ids; one launch spec cannot name all of them");
  } finally {
    applyLocalEngineProfile("llamacpp", null);
  }
  try {
    applyLocalEngineProfile("vllm", llamaSnapshot());
    assert.equal(profileById("vllm").availableModels[0].id, "Src", "vLLM keeps per-model ids");
  } finally {
    applyLocalEngineProfile("vllm", null);
  }
});

test("stale llama slugs resolve to the live stable entry", () => {
  const known = new Set(["Local@llamacpp", "qwen3.8-flash@opencode-go"]);
  assert.equal(normalizeLegacySlug("Qwen3.8-27B@llamacpp", known), "Local@llamacpp");
  assert.equal(normalizeLegacySlug("Src@llamacpp", known), "Local@llamacpp");
  assert.equal(normalizeLegacySlug("Local@llamacpp", known), "Local@llamacpp");
  assert.equal(normalizeLegacySlug("qwen3.8-flash@opencode-go", known), "qwen3.8-flash@opencode-go");
  assert.equal(normalizeLegacySlug("gpt-5.6-sol", known), "gpt-5.6-sol");
  // No local engine published: the old name falls through unchanged so the
  // 503 configuration error stays honest.
  assert.equal(normalizeLegacySlug("Src@llamacpp", new Set(["qwen3.8-flash@opencode-go"])), "Src@llamacpp");
  // The legacy merged-catalog slash form keeps working alongside.
  assert.equal(normalizeLegacySlug("opencode-go/deepseek-v4-flash", new Set(["deepseek-v4-flash@opencode-go"])),
    "deepseek-v4-flash@opencode-go");
});

// A context window is stored under the slug the catalog published when it was
// written, so a value measured before the stable identity is filed under the
// file's own name. Folding is what keeps it applying; the canonical key wins, so
// a fold never replaces a newer value with an older name for the same entry.
test("stored local keys fold onto the stable entry without overwriting it", () => {
  assert.deepEqual(foldLlamaLocalKeys({ "Qwen3.8-27B@llamacpp": 131_072 }), { "Local@llamacpp": 131_072 });
  assert.deepEqual(foldLlamaLocalKeys({ "Src@llamacpp": 262_144, "Local@llamacpp": 131_072 }),
    { "Local@llamacpp": 131_072 }, "the published key outranks the name it used to be published under");
  assert.deepEqual(foldLlamaLocalKeys({ "Local@llamacpp": 131_072, "Src@llamacpp": 262_144 }),
    { "Local@llamacpp": 131_072 });
  // Everything else is left exactly as stored, including another provider that
  // happens to be called llamacpp-like and a key for a hosted model.
  const untouched = { "deepseek-v4-flash@opencode-go": 1_000_000, "qwen3.8:27b@custom": 65_536 };
  assert.equal(foldLlamaLocalKeys(untouched), untouched, "an unchanged map is returned as-is");
  assert.deepEqual(foldLlamaLocalKeys({}), {});
});

test("the catalog labels the stable entry once and honors the engine window", () => {
  try {
    applyLocalEngineProfile("llamacpp", llamaSnapshot());
    const catalog = codexModelCatalog({ profileId: "llamacpp", mainModel: LLAMACPP_LOCAL_SLUG, tokens: {}, nativeMerge: false });
    const entry = catalog.models.find((row) => row.slug === LLAMACPP_LOCAL_SLUG);
    assert.ok(entry, "the stable entry is published");
    assert.equal(entry.display_name, "llama.cpp (local)");
    assert.doesNotMatch(entry.display_name, / - /, "the provider label is not doubled with a model name");
    assert.equal(entry.context_window, 262144);
    assert.equal(entry.auto_compact_token_limit, 209715);
  } finally {
    applyLocalEngineProfile("llamacpp", null);
  }
});

test("the stable local entry carries the hosted flash shadow price", () => {
  const mix = { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 };
  const local = estimateApiCost({ model: "Local", provider: "llamacpp", ...mix });
  const hosted = estimateApiCost({ model: "qwen3.8-flash", provider: "opencode-go", ...mix });
  assert.ok(local.usd > 0, "the local row is priced, not silently zero");
  assert.equal(local.usd, hosted.usd, "the local row is directly comparable to hosted flash");
});

test("stats and replayed boot selections fold historical llama keys", () => {
  assert.equal(canonicalLlamaLocalKey("Qwen3.8-27B@llamacpp"), "Local@llamacpp");
  assert.equal(canonicalLlamaLocalKey("Local@llamacpp"), "Local@llamacpp");
  assert.equal(canonicalLlamaLocalKey("qwen3.8-flash@opencode-go"), "qwen3.8-flash@opencode-go");
  const replayed = mainRouteFromUsageEvent({
    model: "Src@llamacpp", provider: "llamacpp", route: "client_selected", status: 200, at: "2026-09-18T00:00:00.000Z",
  });
  assert.equal(replayed.model, "Local@llamacpp", "a boot selection replayed from history names the stable entry");
});

test("a quiet local upstream keeps the client stream alive and stops on detach", async () => {
  const writes = [];
  const res = { writableEnded: false, destroyed: false, write: (chunk) => { writes.push(String(chunk)); return true; } };
  const detach = attachSseKeepAlive(res, 30);
  res.write("data: first\n\n");
  await new Promise((resolve) => setTimeout(resolve, 140));
  detach();
  assert.equal(writes[0], "data: first\n\n");
  assert.ok(writes.slice(1).every((chunk) => chunk === ": keepalive\r\n\r\n"), "only comment frames were emitted while quiet");
  assert.ok(writes.length > 1, "silence produced comment frames");
  const count = writes.length;
  res.write("data: after\n\n");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes.length, count + 1, "the detached wrapper emits nothing on its own");
  assert.equal(writes[writes.length - 1], "data: after\n\n");
});

test("a stale local slug streams from the live engine behind keepalives", async (t) => {
  applyLocalEngineProfile("llamacpp", llamaSnapshot());
  t.after(() => applyLocalEngineProfile("llamacpp", null));
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    const encoder = new TextEncoder();
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    // Silent for longer than the keepalive interval, then one Chat chunk.
    setTimeout(() => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "chatcmpl_keepalive", object: "chat.completion.chunk", model: FLASH,
        choices: [{ index: 0, delta: { content: "pong" }, finish_reason: "stop" }],
      })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }, 180);
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const res = collectingResponse();
  const result = await relayResponses(
    {
      model: "Qwen3.8-27B@llamacpp",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
    },
    res,
    {
      config: { mainModel: LLAMACPP_LOCAL_SLUG, profileId: "llamacpp", tokens: {} },
      mainModel: LLAMACPP_LOCAL_SLUG,
      visionModel: "",
      knownModels: new Set([LLAMACPP_LOCAL_SLUG]),
      incomingHeaders: { "x-codex-session-id": "keepalive-local-session" },
      requestUrl: "/v1/responses",
      localStreamKeepAliveMs: 30,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.route.model, LLAMACPP_LOCAL_SLUG, "the stale request slug resolved to the stable entry");
  assert.equal(seen[0].model, FLASH, "the wire carries the endpoint's own advertised id");
  const out = Buffer.concat(res.chunks).toString("utf8");
  const keepIndex = out.indexOf(": keepalive");
  const pongIndex = out.indexOf("pong");
  assert.ok(keepIndex >= 0, "the silent prefill produced comment frames");
  assert.ok(pongIndex > keepIndex, "keepalives precede the delayed first token");
  assert.ok((out.match(/: keepalive/g) || []).length <= 6, "the frames stay bounded");
});

test("a dead local engine says so instead of saying fetch failed", async () => {
  try {
    applyLocalEngineProfile("llamacpp", llamaSnapshot());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    try {
      const res = collectingResponse();
      const result = await relayResponses(
        {
          model: LLAMACPP_LOCAL_SLUG,
          stream: false,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
        },
        res,
        {
          config: { mainModel: LLAMACPP_LOCAL_SLUG, profileId: "llamacpp", tokens: {} },
          mainModel: LLAMACPP_LOCAL_SLUG,
          visionModel: "",
          knownModels: new Set([LLAMACPP_LOCAL_SLUG]),
          incomingHeaders: { "x-codex-session-id": "offline-local-session" },
          requestUrl: "/v1/responses",
        },
      );
      assert.equal(result.ok, false);
      assert.equal(result.httpStatus, 502);
      assert.match(result.error, /llama\.cpp \(local\) at .* is not answering/);
      assert.match(result.error, /ModelDock itself is up/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    applyLocalEngineProfile("llamacpp", null);
  }
});

test("slot commands stop hammering an unreachable engine", async () => {
  const kinds = [];
  let eraseCalls = 0;
  const coordinator = new LocalHostKvCoordinator({
    hostId: "h",
    laneCount: 1,
    fingerprint: "fp",
    store: {
      has: async () => false,
      save: async () => ({ saved: false }),
      restore: async () => ({ restored: false }),
      invalidateExcept: async () => ({}),
    },
    slotClient: {
      erase: async () => {
        eraseCalls += 1;
        throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      },
    },
    onDiagnostic: async ({ kind }) => { kinds.push(kind); },
  });
  const warmBase = { sessionKey: "base", messages: [], requiresTranscript: false, create: async () => ({ assistantContent: "x" }) };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await coordinator.primeWarmBase(warmBase)).primed, false);
  }
  assert.equal(eraseCalls, 3, "the fourth attempt is paused, not re-sent to a dead engine");
  assert.deepEqual(kinds, ["slot_erase_failed", "slot_erase_failed", "slot_commands_paused"]);
});

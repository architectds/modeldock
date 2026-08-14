import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  OllamaError,
  clearOllamaSnapshot,
  listOllamaModels,
  normalizeOllamaBase,
  probeOllamaResponses,
  publishedOllamaId,
  readOllamaSnapshot,
  validateOllamaBase,
  writeOllamaSnapshot,
} from "./ollama.mjs";

test("publishedOllamaId replaces colons with dashes", () => {
  assert.equal(publishedOllamaId("qwen3.8:27b"), "qwen3.8-27b");
  assert.equal(publishedOllamaId("llama3.1"), "llama3.1");
  assert.equal(publishedOllamaId(""), "");
});

test("normalizeOllamaBase lands on the root where /api/tags lives", () => {
  assert.equal(normalizeOllamaBase("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBase("http://127.0.0.1:11434/"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBase("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBase("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434");
  assert.equal(normalizeOllamaBase(""), "http://127.0.0.1:11434", "blank falls back to the default");
});

test("validateOllamaBase allows loopback http and https only", () => {
  assert.equal(validateOllamaBase("http://localhost:11434"), "http://localhost:11434");
  assert.equal(validateOllamaBase("https://ollama.example.com"), "https://ollama.example.com");
  assert.throws(() => validateOllamaBase("http://192.168.1.10:11434"), OllamaError);
  assert.throws(() => validateOllamaBase("not-a-url"), OllamaError);
});

test("listOllamaModels parses /api/tags and skips embedding-only models", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(String(url), "http://127.0.0.1:11434/api/tags");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: "qwen3.8:27b", details: { context_length: 262144 }, capabilities: ["completion", "tools", "thinking", "vision"] },
            { name: "embed-model", details: { context_length: 8192 }, capabilities: ["embedding"] },
            { name: "llama3.1", details: {}, capabilities: ["completion"] },
          ],
        }),
      };
    };
    const result = await listOllamaModels({});
    assert.equal(result.endpoint, "http://127.0.0.1:11434");
    assert.equal(result.responsesUrl, "http://127.0.0.1:11434/v1/responses");
    assert.deepEqual(result.models, [
      { id: "qwen3.8-27b", upstreamId: "qwen3.8:27b", label: "qwen3.8:27b", supportsVision: true, contextWindow: 262144, status: "available" },
      { id: "llama3.1", upstreamId: "llama3.1", label: "llama3.1", supportsVision: false, contextWindow: undefined, status: "available" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listOllamaModels classifies a dead Ollama as connect", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed: connection refused");
    };
    await assert.rejects(() => listOllamaModels({}), (error) => {
      assert.ok(error instanceof OllamaError);
      assert.equal(error.code, "connect");
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeOllamaResponses flags old Ollama versions as protocol", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), "http://127.0.0.1:11434/v1/responses");
      const body = JSON.parse(options.body);
      assert.equal(body.model, "qwen3.8:27b", "the probe sends the original upstream tag");
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await assert.rejects(
      () => probeOllamaResponses({ modelId: "qwen3.8:27b" }),
      (error) => error instanceof OllamaError && error.code === "protocol",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("probeOllamaResponses succeeds on a working Responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: "resp_1" }) });
    const result = await probeOllamaResponses({ modelId: "qwen3.8:27b" });
    assert.equal(result.ok, true);
    assert.equal(result.responsesUrl, "http://127.0.0.1:11434/v1/responses");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the connection snapshot round-trips through disk", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-ollama-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ollama-models.json");
  const snapshot = {
    baseUrl: "http://127.0.0.1:11434",
    connectedAt: "2026-08-14T00:00:00.000Z",
    models: [{ id: "qwen3.8-27b", upstreamId: "qwen3.8:27b", label: "qwen3.8:27b", supportsVision: true, contextWindow: 262144, status: "available" }],
  };
  writeOllamaSnapshot(file, snapshot);
  assert.deepEqual(readOllamaSnapshot(file), snapshot);
  assert.equal(readOllamaSnapshot(path.join(dir, "missing.json")), null);
  clearOllamaSnapshot(file);
  assert.equal(readOllamaSnapshot(file), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CustomEndpointError,
  listEndpointModels,
  normalizeBaseUrl,
  probeCustomResponses,
  validateBaseUrl,
} from "../src/custom-endpoint.mjs";

test("normalizeBaseUrl lands on the v1 tree", () => {
  assert.equal(normalizeBaseUrl("https://host/v1"), "https://host/v1");
  assert.equal(normalizeBaseUrl("https://host"), "https://host/v1");
  assert.equal(normalizeBaseUrl("https://host/"), "https://host/v1");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8080/api/v1"), "http://127.0.0.1:8080/api/v1");
  assert.equal(normalizeBaseUrl(""), "");
  assert.equal(normalizeBaseUrl("ftp://host"), "");
});

test("validateBaseUrl only accepts https and loopback http", () => {
  assert.equal(validateBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
  assert.equal(validateBaseUrl("http://127.0.0.1:9000/v1"), "http://127.0.0.1:9000/v1");
  assert.equal(validateBaseUrl("http://localhost:9000"), "http://localhost:9000/v1");
  assert.throws(() => validateBaseUrl("http://192.168.1.5/v1"), (error) => error.code === "connect");
  assert.throws(() => validateBaseUrl("http://internal.example/v1"), (error) => error.code === "connect");
  assert.throws(() => validateBaseUrl("not a url"), (error) => error.code === "connect");
  assert.throws(() => validateBaseUrl(""), (error) => error.code === "connect");
});

test("listEndpointModels returns ids and classifies failures", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const value = String(url);
      if (value === "https://host/v1/models") {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: "vendor/a" }, { id: "vendor/b" }] }) };
      }
      if (value === "https://auth/v1/models") return { ok: false, status: 401, json: async () => ({}) };
      if (value === "https://bad/v1/models") return { ok: false, status: 500, json: async () => ({}) };
      if (value === "https://nover/models") return { ok: true, status: 200, json: async () => ({ data: [{ id: "vendor/c" }] }) };
      throw new Error("ECONNREFUSED");
    };
    const { models, endpoint, responsesUrl } = await listEndpointModels({ baseUrl: "https://host/v1", apiKey: "k" });
    assert.deepEqual(models.map((model) => model.id), ["vendor/a", "vendor/b"]);
    assert.equal(endpoint, "https://host/v1");
    assert.equal(responsesUrl, "https://host/v1/responses");
    // Models are fetched from the base as entered (no /v1 completion); the
    // Responses probe URL still completes /v1 for the later Add step.
    const nover = await listEndpointModels({ baseUrl: "https://nover", apiKey: "k" });
    assert.equal(nover.modelsUrl, "https://nover/models");
    assert.equal(nover.responsesUrl, "https://nover/v1/responses");
    await assert.rejects(
      listEndpointModels({ baseUrl: "http://192.168.1.5", apiKey: "k" }),
      (error) => error.code === "connect",
    );
    await assert.rejects(
      listEndpointModels({ baseUrl: "https://auth/v1", apiKey: "k" }),
      (error) => error instanceof CustomEndpointError && error.code === "key",
    );
    await assert.rejects(
      listEndpointModels({ baseUrl: "https://bad/v1", apiKey: "k" }),
      (error) => error.code === "upstream",
    );
    await assert.rejects(
      listEndpointModels({ baseUrl: "https://down/v1", apiKey: "k" }),
      (error) => error.code === "connect",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("probeCustomResponses verifies the Responses dialect and classifies failures", async () => {
  const original = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      const value = String(url);
      if (value === "https://ok/v1/responses") {
        return { ok: true, status: 200, json: async () => ({ usage: { input_tokens: 5, output_tokens: 1 } }) };
      }
      if (value === "https://key/v1/responses") return { ok: false, status: 401, json: async () => ({}) };
      if (value === "https://model/v1/responses") return { ok: false, status: 404, json: async () => ({}) };
      if (value === "https://up/v1/responses") return { ok: false, status: 502, json: async () => ({}) };
      throw new Error("ECONNREFUSED");
    };
    const result = await probeCustomResponses({ baseUrl: "https://ok", apiKey: "k", modelId: "m1" });
    assert.equal(result.ok, true);
    assert.equal(result.model, "m1");
    assert.equal(result.usage.output_tokens, 1);
    assert.equal(result.endpoint, "https://ok/v1");
    assert.equal(result.responsesUrl, "https://ok/v1/responses");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, "m1");
    assert.equal(body.max_output_tokens, 16);
    assert.equal(calls[0].options.headers.authorization, "Bearer k");
    await assert.rejects(
      probeCustomResponses({ baseUrl: "https://key", apiKey: "k", modelId: "m" }),
      (error) => error.code === "key",
    );
    await assert.rejects(
      probeCustomResponses({ baseUrl: "https://model", apiKey: "k", modelId: "m" }),
      (error) => error.code === "model",
    );
    await assert.rejects(
      probeCustomResponses({ baseUrl: "https://up", apiKey: "k", modelId: "m" }),
      (error) => error.code === "upstream",
    );
    await assert.rejects(
      probeCustomResponses({ baseUrl: "https://down", apiKey: "k", modelId: "m" }),
      (error) => error.code === "connect",
    );
    await assert.rejects(
      probeCustomResponses({ baseUrl: "https://ok", apiKey: "k", modelId: "" }),
      (error) => error.code === "model",
    );
  } finally {
    globalThis.fetch = original;
  }
});

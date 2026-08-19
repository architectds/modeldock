// Discovery has to be right about two things: what it found, and what it
// refuses to reach. Both are pure enough to test without a live engine.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalEngineError,
  assertLocalBase,
  discoverLocalEngines,
  engineFromProbes,
  probeLocalEngine,
} from "../src/local-engines.mjs";

test("engineFromProbes names the engine from the response, not the port", () => {
  assert.equal(engineFromProbes({ tags: { models: [{ name: "qwen3:8b" }] } }), "ollama");
  assert.equal(engineFromProbes({ props: { default_generation_settings: {} } }), "llama.cpp");
  assert.equal(engineFromProbes({ models: { data: [{ id: "m" }] } }), "openai");
  assert.equal(engineFromProbes({}), "");
  assert.equal(engineFromProbes(), "");
});

test("a llama.cpp server on any port is still llama.cpp", () => {
  // /props is what separates it from every other OpenAI-compatible server, so
  // it wins even when /v1/models answers too.
  assert.equal(
    engineFromProbes({ props: { slots_idle: 4 }, models: { data: [{ id: "local" }] } }),
    "llama.cpp",
  );
});

test("assertLocalBase accepts loopback and refuses everything else", () => {
  assert.equal(assertLocalBase("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(assertLocalBase("http://localhost:8080/"), "http://localhost:8080");
  for (const remote of ["http://192.168.1.5:8080", "https://example.com", "http://10.0.0.2:8000"]) {
    assert.throws(() => assertLocalBase(remote), LocalEngineError, `${remote} must be refused`);
  }
  assert.throws(() => assertLocalBase("ftp://127.0.0.1"), LocalEngineError);
  assert.throws(() => assertLocalBase("not a url"), LocalEngineError);
});

function fakeFetch(routes) {
  return async (url) => {
    const path = new URL(url).pathname;
    const port = new URL(url).port;
    const body = routes[`${port}${path}`];
    if (body === undefined) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => body };
  };
}

test("probeLocalEngine reports the models it saw", async () => {
  const fetchImpl = fakeFetch({
    "11434/api/tags": { models: [{ name: "qwen3:8b" }, { name: "llama3:70b" }] },
  });
  const found = await probeLocalEngine(11434, { fetchImpl, timeoutMs: 50 });
  assert.equal(found.engine, "ollama");
  assert.equal(found.baseUrl, "http://127.0.0.1:11434");
  assert.deepEqual(found.models, ["qwen3:8b", "llama3:70b"]);
});

test("an empty port yields nothing rather than an error", async () => {
  const found = await probeLocalEngine(8080, { fetchImpl: fakeFetch({}), timeoutMs: 50 });
  assert.equal(found, null);
});

test("discoverLocalEngines returns only what answered", async () => {
  const fetchImpl = fakeFetch({
    "11434/api/tags": { models: [{ name: "qwen3:8b" }] },
    "8080/props": { slots_idle: 2 },
    "8080/v1/models": { data: [{ id: "qwen3-27b" }] },
  });
  const found = await discoverLocalEngines({ fetchImpl, timeoutMs: 50 });
  assert.deepEqual(found.map((f) => f.engine), ["ollama", "llama.cpp"]);
  assert.deepEqual(found.find((f) => f.engine === "llama.cpp").models, ["qwen3-27b"]);
});

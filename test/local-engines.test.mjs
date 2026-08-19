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

test("the snapshot keys engines instead of giving each one a file", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { readLocalEnginesSnapshot, writeLocalEngineSnapshot, clearLocalEngineSnapshot } =
    await import("../src/local-engines.mjs");

  const dir = await mkdtemp(path.join(os.tmpdir(), "local-snap-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "local-engines.json");

  assert.equal(readLocalEnginesSnapshot(file), null, "absent file reads as nothing");

  writeLocalEngineSnapshot(file, "llamacpp", { baseUrl: "http://127.0.0.1:8080", models: [{ id: "a" }] });
  writeLocalEngineSnapshot(file, "vllm", { baseUrl: "http://127.0.0.1:8000", models: [{ id: "b" }] });
  assert.deepEqual(Object.keys(readLocalEnginesSnapshot(file)).sort(), ["llamacpp", "vllm"]);

  // Disconnecting one engine must not disturb the other.
  clearLocalEngineSnapshot(file, "llamacpp");
  const left = readLocalEnginesSnapshot(file);
  assert.deepEqual(Object.keys(left), ["vllm"]);
  assert.equal(left.vllm.models[0].id, "b");

  clearLocalEngineSnapshot(file, "vllm");
  assert.equal(readLocalEnginesSnapshot(file), null, "the last engine takes the file with it");
});

test("applyLocalEngineProfile publishes vision and context, and nothing else", async () => {
  const { applyLocalEngineProfile, profileById } = await import("../src/profiles.mjs");

  const profile = applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:8080",
    models: [{ id: "qwen3-27b", supportsVision: true, contextWindow: 32768 }],
  });
  assert.equal(profile.id, "llamacpp");
  assert.equal(profile.baseUrl, "http://127.0.0.1:8080");
  const [model] = profile.availableModels;
  assert.equal(model.id, "qwen3-27b");
  assert.equal(model.supportsVision, true);
  assert.ok(model.contextWindow > 0, "the advertised window survives");
  assert.equal(model.ownerQualified, true, "local ids always carry their provider");

  // Disconnecting empties the profile rather than leaving stale models behind.
  applyLocalEngineProfile("llamacpp", null);
  assert.deepEqual(profileById("llamacpp").availableModels, []);
});

test("llama.cpp and vLLM are separate providers so both can be live", async () => {
  const { applyLocalEngineProfile, profileOptions } = await import("../src/profiles.mjs");
  applyLocalEngineProfile("llamacpp", { models: [{ id: "a" }] });
  applyLocalEngineProfile("vllm", { models: [{ id: "b" }] });
  const ids = profileOptions().map((p) => p.id);
  assert.ok(ids.includes("llamacpp") && ids.includes("vllm"));
  applyLocalEngineProfile("llamacpp", null);
  applyLocalEngineProfile("vllm", null);
});

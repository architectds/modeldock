// Discovery has to be right about two things: what it found, and what it
// refuses to reach. Both are pure enough to test without a live engine.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalEngineError,
  assertLocalBase,
  discoverLocalEngines,
  CONNECTABLE_ENGINES,
  engineFromProbes,
  probeLocalEngine,
} from "../src/local-engines.mjs";
import { allProfiles } from "../src/profiles.mjs";

test("engineFromProbes names the engine from the response, not the port", () => {
  assert.equal(engineFromProbes({ tags: { models: [{ name: "qwen3:8b" }] } }), "ollama");
  assert.equal(engineFromProbes({ props: { default_generation_settings: {} } }), "llamacpp");
  // vLLM is only distinguishable from any other OpenAI-compatible server by
  // /version. Without that probe it was reported as "openai", which no route
  // accepted, so vLLM could be found and never connected.
  assert.equal(
    engineFromProbes({ version: { version: "0.11.0" }, models: { data: [{ id: "Qwen/Qwen3-8B" }] } }),
    "vllm",
  );
  assert.equal(engineFromProbes({ models: { data: [{ id: "m" }] } }), "openai");
  assert.equal(engineFromProbes({}), "");
  assert.equal(engineFromProbes(), "");
});

test("a llama.cpp server on any port is still llama.cpp", () => {
  // /props is what separates it from every other OpenAI-compatible server, so
  // it wins even when /v1/models answers too.
  assert.equal(
    engineFromProbes({ props: { slots_idle: 4 }, models: { data: [{ id: "local" }] } }),
    "llamacpp",
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
  assert.deepEqual(found.map((f) => f.engine), ["ollama", "llamacpp"]);
  assert.deepEqual(found.find((f) => f.engine === "llamacpp").models, ["qwen3-27b"]);
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

// The defect this guards against shipped once and made the whole feature
// unreachable: discovery answered "llama.cpp" and "openai" while the connect
// route, the snapshot key, and the profile ids all spoke "llamacpp" and
// "vllm". Every layer was individually correct and nothing could be connected.
// Names crossing a boundary are only right relative to each other, so the
// check has to span the boundary too.
test("every engine discovery calls connectable is one the gateway can attach", async () => {
  const fetchImpl = async (url) => {
    const reply = (body) => ({ ok: true, json: async () => body });
    if (url === "http://127.0.0.1:8080/props") return reply({ slots_idle: 2 });
    if (url === "http://127.0.0.1:8080/v1/models") return reply({ data: [{ id: "qwen3-30b" }] });
    if (url === "http://127.0.0.1:8000/version") return reply({ version: "0.11.0" });
    if (url === "http://127.0.0.1:8000/v1/models") return reply({ data: [{ id: "Qwen/Qwen3-8B" }] });
    return { ok: false, json: async () => ({}) };
  };

  const found = await discoverLocalEngines({ fetchImpl, timeoutMs: 50 });
  assert.deepEqual(found.map((f) => f.engine), ["llamacpp", "vllm"], "both engines are found and named");

  for (const engine of found) {
    assert.equal(engine.connectable, true, `${engine.engine} is offered`);
    assert.ok(
      CONNECTABLE_ENGINES.includes(engine.engine),
      `${engine.engine} is a name the connect route accepts`,
    );
    assert.ok(
      allProfiles().some((profile) => profile.id === engine.engine),
      `${engine.engine} has a profile to publish its models through`,
    );
  }
});

test("a bare OpenAI-compatible server is found but not offered a Connect button", async () => {
  const fetchImpl = async (url) => {
    if (url === "http://127.0.0.1:8000/v1/models") return { ok: true, json: async () => ({ data: [{ id: "m" }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const [found] = await discoverLocalEngines({ fetchImpl, timeoutMs: 50 });
  // It has no profile to attach to, and the API page already takes an endpoint
  // with a key. Offering a button that could only fail would be worse.
  assert.equal(found.engine, "openai");
  assert.equal(found.connectable, false);
});

// A connected local engine has to be reachable, not merely listed. Every layer
// that decides where a request goes was written with a chain of provider
// comparisons that named ollama and custom; llamacpp and vllm matched neither,
// so they fell through to the OpenCode Go branch and would have been sent to
// opencode.ai carrying the OpenCode token - a keyless local model leaking to a
// remote host under someone else's credential. Routing is checked here rather
// than in each branch because the bug was the absence of a branch.
test("a connected local engine is routed to itself, keyless", async () => {
  const { upstreamTargetFor, isLocalBackend } = await import("../src/gateway.mjs");
  const { applyLocalEngineProfile, tokenFor } = await import("../src/profiles.mjs");

  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:8080/v1",
    models: [{ id: "qwen3-30b.gguf", upstreamId: "qwen3-30b.gguf" }],
  });
  applyLocalEngineProfile("vllm", {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [{ id: "Qwen/Qwen3-8B", upstreamId: "Qwen/Qwen3-8B" }],
  });

  const config = { tokens: { "opencode-go": "should-never-be-used" } };
  const cases = [
    ["qwen3-30b.gguf@llamacpp", "http://127.0.0.1:8080/v1/responses", "llamacpp"],
    ["Qwen/Qwen3-8B@vllm", "http://127.0.0.1:8000/v1/responses", "vllm"],
  ];
  for (const [model, url, provider] of cases) {
    const target = upstreamTargetFor(config, model);
    assert.equal(target.url, url, `${model} goes to its own engine`);
    assert.equal(target.provider, provider);
    assert.equal(target.token, "", "no credential is sent to a loopback engine");
    assert.equal(target.tokenRequired, false, "and the tokenless gate must not 503 it");
    assert.equal(tokenFor(config, model), "local", "a connected engine reads as ready");
    assert.equal(isLocalBackend(config, model), true, "local accommodations apply");
  }

  applyLocalEngineProfile("llamacpp", null);
  applyLocalEngineProfile("vllm", null);
});

// The catalog is the file Codex actually reads. Publishing to the profile
// without reaching this file left an engine connected in the dashboard and
// absent from Codex, which is indistinguishable from not working.
test("a connected local engine reaches the catalog Codex reads", async () => {
  const { enabledProvidersFor } = await import("../src/catalog.mjs");
  const { applyLocalEngineProfile } = await import("../src/profiles.mjs");

  const config = { profileId: "opencode-go", tokens: {} };
  assert.equal(enabledProvidersFor(config).has("vllm"), false, "nothing is published before a connection");

  applyLocalEngineProfile("vllm", {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [{ id: "Qwen/Qwen3-8B", upstreamId: "Qwen/Qwen3-8B" }],
  });
  // The rule is "keyless and connected", not a list of engine names: naming
  // them is what left these two out when they were added.
  assert.equal(enabledProvidersFor(config).has("vllm"), true);

  applyLocalEngineProfile("vllm", null);
});

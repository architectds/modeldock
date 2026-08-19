// The provider registry is the only place that knows how a provider is reached.
//
// It did not used to be. The same question - where does a request for this
// model go - was answered by five separate if-chains, and they disagreed:
// three had no case for a local engine at all, so a llama.cpp model resolved to
// opencode.ai and a local vision model posted its image there. Every chain was
// individually correct; what was missing was a case, and nothing could notice a
// missing case because there was no contract to violate.
//
// These tests are that contract. They are deliberately about shape and
// agreement rather than specific URLs: a provider added tomorrow should either
// satisfy them without being named here, or fail loudly.
import test from "node:test";
import assert from "node:assert/strict";
import {
  allProfiles,
  applyLocalEngineProfile,
  applyOllamaProfile,
  profileById,
  tokenFor,
} from "../src/profiles.mjs";
import { upstreamTargetFor, isLocalBackend } from "../src/gateway.mjs";

function connectLocalEngines() {
  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:8080/v1",
    models: [{ id: "qwen3-30b.gguf", upstreamId: "qwen3-30b.gguf" }],
  });
  applyLocalEngineProfile("vllm", {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [{ id: "Qwen/Qwen3-8B", upstreamId: "Qwen/Qwen3-8B", supportsVision: true }],
  });
}

function disconnectLocalEngines() {
  applyLocalEngineProfile("llamacpp", null);
  applyLocalEngineProfile("vllm", null);
}

test("every profile answers the routing questions itself", () => {
  for (const profile of allProfiles()) {
    assert.equal(typeof profile.baseUrlFor, "function", `${profile.id} says where it lives`);
    assert.equal(typeof profile.target, "function", `${profile.id} says how it is called`);
    for (const trait of ["keyless", "local", "normalizesPayload"]) {
      assert.equal(
        typeof profile[trait],
        "boolean",
        `${profile.id} declares ${trait} rather than leaving callers to guess`,
      );
    }
    // A keyless provider is one with no credential to present. Declaring a
    // token env name alongside it would be a contradiction, and the tokenless
    // gate reads both.
    if (profile.keyless) {
      assert.ok(!profile.tokenEnvName, `${profile.id} is keyless, so it names no token variable`);
    }
  }
});

test("a target names its own provider and carries a usable credential rule", () => {
  connectLocalEngines();
  const config = {
    tokens: { "opencode-go": "go-key", "deepseek-official": "sk-ds" },
    customEndpoints: [{ modelId: "vendor-x", baseUrl: "https://api.vendor.example/v1", apiKey: "sk-vendor" }],
  };

  for (const profile of allProfiles()) {
    // A model that unambiguously belongs to this provider.
    const model = `${profile.availableModels?.[0]?.id || "vendor-x"}@${profile.id}`;
    const target = upstreamTargetFor(config, model);

    assert.equal(target.provider, profile.id, `${profile.id} does not answer as someone else`);
    assert.ok(target.url.startsWith("http"), `${profile.id} produces an absolute URL`);
    assert.ok(
      !/undefined|\/\/responses|^\/+/.test(target.url),
      `${profile.id} produces a URL with a host: ${target.url}`,
    );
    if (profile.keyless) {
      assert.equal(target.token, "", `${profile.id} sends no credential`);
      assert.equal(target.tokenRequired, false, `${profile.id} is not 503'd by the tokenless gate`);
    }
  }
  disconnectLocalEngines();
});

// The failure this rules out is specific: a keyless loopback model resolving to
// a remote host and being sent there under an unrelated provider's token.
test("a local engine is never routed off this machine", () => {
  connectLocalEngines();
  applyOllamaProfile({}, {
    baseUrl: "http://127.0.0.1:11434",
    models: [{ id: "qwen3-8b", upstreamId: "qwen3:8b" }],
  });
  const config = {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    tokens: { "opencode-go": "sk-someone-elses-token" },
  };

  for (const model of ["qwen3-30b.gguf@llamacpp", "Qwen/Qwen3-8B@vllm", "qwen3-8b@ollama"]) {
    const target = upstreamTargetFor(config, model);
    const host = new URL(target.url).hostname;
    assert.equal(host, "127.0.0.1", `${model} stays on this machine, got ${target.url}`);
    assert.equal(target.token, "", `${model} carries no credential`);
    assert.notEqual(target.token, config.tokens["opencode-go"]);
    assert.equal(isLocalBackend(config, model), true, `${model} gets the local-backend accommodations`);
    assert.equal(tokenFor(config, model), "local", `${model} reads as ready once connected`);
  }

  applyOllamaProfile({}, null);
  disconnectLocalEngines();
});

// The dashboard shows the upstream a model resolves to. It used to compute that
// with its own if-chain and disagreed with the relay about Ollama, so the
// address on screen was not the address used.
test("the address shown is the address used", () => {
  connectLocalEngines();
  const config = {
    ollamaBaseUrl: "http://127.0.0.1:11434",
    tokens: { "opencode-go": "go-key", "deepseek-official": "sk-ds" },
    customEndpoints: [{ modelId: "vendor-x", baseUrl: "https://api.vendor.example/v1", apiKey: "sk-vendor" }],
  };
  for (const model of [
    "deepseek-v4-pro", "deepseek-v4-flash-free",
    "deepseek-chat@deepseek-official", "vendor-x@custom",
    "qwen3-30b.gguf@llamacpp", "Qwen/Qwen3-8B@vllm",
  ]) {
    const profile = profileById(model.includes("@") ? model.split("@").pop() : "opencode-go");
    const shown = profile.baseUrlFor(config, model);
    const used = upstreamTargetFor(config, model).url;
    assert.equal(used, `${shown}/responses`, `${model}: shown ${shown}, used ${used}`);
  }
  disconnectLocalEngines();
});

// big-pickle is a Zen free model that is not in the catalog, so the entry
// lookup finds nothing for it. Three call sites recognised it by name and sent
// it to the Zen host; the one that actually issued the request did not, and
// sent it to the paid Go host instead. Collapsing them had to pick a winner,
// and the majority was also the one that matches every other free model.
test("an unregistered Zen model still resolves to the Zen host", () => {
  const config = { tokens: { "opencode-go": "go-key" } };
  const go = profileById("opencode-go");
  assert.equal(go.baseUrlFor(config, "big-pickle"), "https://opencode.ai/zen/v1");
  assert.equal(
    upstreamTargetFor(config, "big-pickle").url,
    "https://opencode.ai/zen/v1/responses",
  );
  // A registered paid model is unaffected.
  assert.equal(
    upstreamTargetFor(config, "deepseek-v4-pro").url,
    "https://opencode.ai/zen/go/v1/responses",
  );
});

// The cross-provider vision helper resolved its address with yet another
// if-chain, and that one knew only custom and deepseek. A local vision model
// therefore had its image posted to opencode.ai - not a routing inconvenience
// but a local picture leaving the machine, and true of Ollama in shipped
// versions. The address now comes from the provider like every other address.
test("a local vision model's image never leaves this machine", async () => {
  const { createUpstreams } = await import("../src/upstreams.mjs");
  const { Metrics } = await import("../src/metrics.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  applyOllamaProfile({}, {
    baseUrl: "http://127.0.0.1:11434",
    models: [{ id: "llava-7b", upstreamId: "llava:7b", label: "llava:7b", supportsVision: true }],
  });
  applyLocalEngineProfile("vllm", {
    baseUrl: "http://127.0.0.1:8000/v1",
    models: [{ id: "qwen-vl", upstreamId: "qwen-vl", supportsVision: true }],
  });

  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-vision-route-"));
  const image = path.join(dir, "shot.png");
  writeFileSync(image, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ));

  for (const model of ["llava-7b@ollama", "qwen-vl@vllm"]) {
    const upstreams = createUpstreams({
      config: {
        ollamaBaseUrl: "http://127.0.0.1:11434",
        goBaseUrl: "https://opencode.ai/zen/go/v1",
        tokens: { "opencode-go": "sk-opencode" },
        visionModel: model,
        visionTimeoutMs: 30_000,
      },
      metrics: new Metrics({ recentLimit: 10 }),
      mediaStore: { get: () => undefined, put: (v) => ({ ref: "ref-1", dataUrl: v, value: v }), maxBytes: 10_000_000 },
      getVisionModel: () => model,
    });

    let requested = "";
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      requested = String(url);
      return new Response(JSON.stringify({ output: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    try {
      // The call itself fails on the empty stub reply; the address is the point.
      await upstreams.inspectVision({ path: image, question: "what is this" }).catch(() => {});
    } finally {
      globalThis.fetch = original;
    }

    assert.ok(requested, `${model} issued a request`);
    assert.equal(
      new URL(requested).hostname,
      "127.0.0.1",
      `${model} sent its image to ${requested}`,
    );
  }

  applyOllamaProfile({}, null);
  applyLocalEngineProfile("vllm", null);
});

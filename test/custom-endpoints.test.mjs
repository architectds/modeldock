// The endpoint list replaced a single .env slot where adding a second endpoint
// silently replaced the first. What has to hold: a key stays encrypted, routing
// can find the endpoint for a model, and a duplicate model id is refused rather
// than published unreachable.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  CustomEndpointsError,
  addCustomEndpoint,
  customEndpointFor,
  migrateLegacyCustomEndpoint,
  readCustomEndpoints,
  removeCustomEndpoint,
  writeCustomEndpoints,
} from "../src/custom-endpoints.mjs";
import { dpapiSupported } from "../src/secrets.mjs";
import { allProfiles } from "../src/profiles.mjs";
import { NATIVE_PROVIDER_ID } from "../src/native-provider.mjs";

function tmpFile(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-endpoints-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "custom-endpoints.json");
}

const entry = (over = {}) => ({
  modelId: "vendor/model-x",
  baseUrl: "https://vendor.example/v1",
  apiKey: "sk-test",
  ...over,
});

test("an endpoint survives the round trip", (t) => {
  const file = tmpFile(t);
  assert.deepEqual(readCustomEndpoints(file), [], "no file reads as no endpoints");
  writeCustomEndpoints(file, [entry()]);
  const [read] = readCustomEndpoints(file);
  assert.equal(read.modelId, "vendor/model-x");
  assert.equal(read.baseUrl, "https://vendor.example/v1");
  assert.equal(read.apiKey, "sk-test", "the key comes back usable");
});

test("the key is encrypted at rest, exactly as it was in .env", (t) => {
  const file = tmpFile(t);
  writeCustomEndpoints(file, [entry()]);
  const raw = readFileSync(file, "utf8");
  if (dpapiSupported()) {
    // Moving out of .env must not mean moving out of DPAPI.
    assert.ok(!raw.includes("sk-test"), "the plaintext key is not on disk");
    assert.match(raw, /"apiKey": "dpapi:/);
  } else {
    assert.ok(raw.includes("sk-test"), "without DPAPI the key is stored as given, as in .env");
  }
});

test("a trailing slash never changes which endpoint is stored", (t) => {
  const file = tmpFile(t);
  writeCustomEndpoints(file, [entry({ baseUrl: "https://vendor.example/v1///" })]);
  assert.equal(readCustomEndpoints(file)[0].baseUrl, "https://vendor.example/v1");
});

test("routing finds the endpoint that serves a model", () => {
  const endpoints = [
    entry({ modelId: "a", baseUrl: "https://one.example/v1", apiKey: "key-one" }),
    entry({ modelId: "b", baseUrl: "https://two.example/v1", apiKey: "key-two" }),
  ];
  // Requests arrive naming the published slug, so the suffix has to be tolerated.
  assert.equal(customEndpointFor(endpoints, "b").baseUrl, "https://two.example/v1");
  assert.equal(customEndpointFor(endpoints, "b@custom").apiKey, "key-two");
  assert.equal(customEndpointFor(endpoints, "a@custom").baseUrl, "https://one.example/v1");
  assert.equal(customEndpointFor(endpoints, "missing"), null);
  assert.equal(customEndpointFor(endpoints, ""), null);
  assert.equal(customEndpointFor(null, "a"), null);
});

test("two endpoints can hold different hosts and different keys", () => {
  // This is the whole point of the list: one slot could not.
  const endpoints = addCustomEndpoint(
    addCustomEndpoint([], entry({ modelId: "self-hosted", baseUrl: "https://vllm.internal/v1", apiKey: "k1" })),
    entry({ modelId: "third-party", baseUrl: "https://api.vendor.com/v1", apiKey: "k2" }),
  );
  assert.equal(endpoints.length, 2);
  assert.equal(customEndpointFor(endpoints, "self-hosted").apiKey, "k1");
  assert.equal(customEndpointFor(endpoints, "third-party").apiKey, "k2");
});

test("a duplicate model id is refused, and says which endpoint has it", () => {
  const first = addCustomEndpoint([], entry({ modelId: "gpt-4o", baseUrl: "https://one.example/v1" }));
  // Two endpoints serving the same model id cannot both be routed to: the
  // second would be unreachable, so it is refused rather than published.
  assert.throws(
    () => addCustomEndpoint(first, entry({ modelId: "gpt-4o", baseUrl: "https://two.example/v1" })),
    (error) => {
      assert.ok(error instanceof CustomEndpointsError);
      assert.equal(error.code, "duplicate");
      assert.match(error.message, /one\.example/, "the message names the endpoint that already has it");
      return true;
    },
  );
});

test("an endpoint missing a base URL or a model is refused", () => {
  assert.throws(() => addCustomEndpoint([], entry({ modelId: "" })), CustomEndpointsError);
  assert.throws(() => addCustomEndpoint([], entry({ baseUrl: "" })), CustomEndpointsError);
});

test("removing one endpoint leaves the others alone", (t) => {
  const file = tmpFile(t);
  const endpoints = [entry({ modelId: "a" }), entry({ modelId: "b" }), entry({ modelId: "c" })];
  writeCustomEndpoints(file, endpoints);
  writeCustomEndpoints(file, removeCustomEndpoint(readCustomEndpoints(file), "b"));
  assert.deepEqual(readCustomEndpoints(file).map((e) => e.modelId), ["a", "c"]);
});

test("removing the last endpoint takes the file with it", (t) => {
  const file = tmpFile(t);
  writeCustomEndpoints(file, [entry()]);
  writeCustomEndpoints(file, removeCustomEndpoint(readCustomEndpoints(file), "vendor/model-x"));
  assert.deepEqual(readCustomEndpoints(file), [], "an empty file and no file mean the same thing");
});

test("a hand-edited duplicate is dropped on read rather than trusted", (t) => {
  const file = tmpFile(t);
  writeFileSync(file, JSON.stringify([
    { modelId: "a", baseUrl: "https://one.example/v1", apiKey: "" },
    { modelId: "a", baseUrl: "https://two.example/v1", apiKey: "" },
    { modelId: "", baseUrl: "https://three.example/v1", apiKey: "" },
    { modelId: "d", baseUrl: "", apiKey: "" },
  ]), "utf8");
  const read = readCustomEndpoints(file);
  assert.deepEqual(read.map((e) => e.modelId), ["a"], "the first wins; the unroutable rest are dropped");
  assert.equal(read[0].baseUrl, "https://one.example/v1");
});

test("a corrupt file reads as no endpoints instead of throwing", (t) => {
  const file = tmpFile(t);
  writeFileSync(file, "{ not json", "utf8");
  assert.deepEqual(readCustomEndpoints(file), []);
});

// The MODELDOCK_CUSTOM_* variables configured a single custom endpoint before
// the list existed, and were left readable as a fallback. That made them a
// second source: the model they described showed up in every picker, while the
// endpoints page - which reads only the list - showed nothing, so there was no
// way to remove it. The variables are now an input on first boot and nothing
// after.
test("a legacy env slot becomes a list entry, once", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-legacy-custom-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "custom-endpoints.json");

  const env = {
    MODELDOCK_CUSTOM_MODEL: "qwen3.8:27b",
    MODELDOCK_CUSTOM_BASE_URL: "http://127.0.0.1:11435/v1/",
    MODELDOCK_CUSTOM_API_KEY: "sk-legacy",
    MODELDOCK_CUSTOM_CONTEXT_WINDOW: "81920",
    MODELDOCK_CUSTOM_VISION: "0",
  };

  const first = migrateLegacyCustomEndpoint(env, file);
  assert.deepEqual(first, { modelId: "qwen3.8:27b", added: true });

  const stored = readCustomEndpoints(file);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].modelId, "qwen3.8:27b");
  assert.equal(stored[0].baseUrl, "http://127.0.0.1:11435/v1", "the trailing slash is normalised away");
  assert.equal(stored[0].apiKey, "sk-legacy", "the key survives the move");
  assert.equal(stored[0].contextWindow, 81920);
  assert.equal(stored[0].supportsVision, false);

  // Running again must not duplicate it: the list is already the truth.
  const second = migrateLegacyCustomEndpoint(env, file);
  assert.deepEqual(second, { modelId: "qwen3.8:27b", added: false });
  assert.equal(readCustomEndpoints(file).length, 1);
});

test("nothing to migrate is not an event", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-legacy-none-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "custom-endpoints.json");

  assert.equal(migrateLegacyCustomEndpoint({}, file), null);
  // A half-configured slot describes no endpoint and must not create one.
  assert.equal(migrateLegacyCustomEndpoint({ MODELDOCK_CUSTOM_MODEL: "m" }, file), null);
  assert.equal(migrateLegacyCustomEndpoint({ MODELDOCK_CUSTOM_BASE_URL: "http://x/v1" }, file), null);
  assert.equal(existsSync(file), false, "no file is created for nothing");
});

// Once the entry is in the list it is an ordinary endpoint: the page shows it
// and Remove takes it away. That is the whole point of folding it in.
test("a migrated endpoint removes like any other", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-legacy-remove-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "custom-endpoints.json");

  migrateLegacyCustomEndpoint({
    MODELDOCK_CUSTOM_MODEL: "qwen3.8:27b",
    MODELDOCK_CUSTOM_BASE_URL: "http://127.0.0.1:11435/v1",
  }, file);

  const next = removeCustomEndpoint(readCustomEndpoints(file), "qwen3.8:27b");
  writeCustomEndpoints(file, next);
  assert.deepEqual(readCustomEndpoints(file), []);
});

// loadConfig is called by tests, tools and harnesses, and envFileFor resolves
// to the user's real ~/.modeldock/.env unless something redirects it - which
// the test preload deliberately does not do, because the install and restart
// tests need their own .env. A loader that writes is therefore a loader that
// writes the real file: putting the legacy migration inside loadConfig cleared
// a live install's MODELDOCK_CUSTOM_* during an ordinary `npm test`.
test("loadConfig does not write the .env it reads", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-loadconfig-ro-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const envFile = path.join(dir, ".env");
  const original = [
    "MODELDOCK_CUSTOM_BASE_URL=http://127.0.0.1:11435/v1",
    "MODELDOCK_CUSTOM_MODEL=qwen3.8:27b",
    "MODELDOCK_CUSTOM_CONTEXT_WINDOW=81920",
    "",
  ].join("\n");
  writeFileSync(envFile, original, "utf8");

  const saved = { ...process.env };
  process.env.MODELDOCK_ENV_FILE = envFile;
  process.env.MODELDOCK_STATE_DIR = dir;
  process.env.MODELDOCK_CUSTOM_ENDPOINTS_FILE = path.join(dir, "custom-endpoints.json");
  try {
    const { loadConfig } = await import("../src/config.mjs");
    loadConfig();
    loadConfig();
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }

  assert.equal(readFileSync(envFile, "utf8"), original, "the file it read is the file it left");
});

// Every user endpoint used to answer to one "custom" provider, so three
// endpoints published three models all suffixed @custom - one address for three
// upstreams. Naming the provider is what makes the address mean something.
test("an endpoint belongs to the provider it names", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-provider-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "custom-endpoints.json");

  let list = [];
  list = addCustomEndpoint(list, { modelId: "shared", baseUrl: "https://alpha.example/v1", apiKey: "sk-a", providerId: "Alpha" });
  list = addCustomEndpoint(list, { modelId: "shared", baseUrl: "https://beta.example/v1", apiKey: "sk-b", providerId: "beta" });
  // No provider means the group every endpoint added before this is already in,
  // so their published slugs do not move.
  list = addCustomEndpoint(list, { modelId: "legacy", baseUrl: "https://old.example/v1", apiKey: "sk-o" });
  writeCustomEndpoints(file, list);

  const stored = readCustomEndpoints(file);
  assert.deepEqual(stored.map((e) => `${e.providerId}/${e.modelId}`), ["alpha/shared", "beta/shared", "custom/legacy"]);

  // The suffix decides which endpoint answers, which is the whole point.
  assert.equal(customEndpointFor(stored, "shared@alpha").baseUrl, "https://alpha.example/v1");
  assert.equal(customEndpointFor(stored, "shared@beta").baseUrl, "https://beta.example/v1");
  assert.equal(customEndpointFor(stored, "legacy@custom").baseUrl, "https://old.example/v1");
  // A provider that serves no such model resolves to nothing rather than to
  // somebody else's endpoint.
  assert.equal(customEndpointFor(stored, "legacy@alpha"), null);
  // An unknown explicit provider is just as authoritative. It must not fall
  // through to the legacy custom endpoint (or any other same-id endpoint).
  assert.equal(customEndpointFor(stored, "legacy@missing-provider"), null);
});

test("a clash is per provider, and built-in names are refused", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-provider-clash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  let list = [];
  list = addCustomEndpoint(list, { modelId: "shared", baseUrl: "https://alpha.example/v1", apiKey: "", providerId: "alpha" });
  // The same id under another provider is exactly what naming them allows.
  assert.doesNotThrow(() => addCustomEndpoint(list, { modelId: "shared", baseUrl: "https://beta.example/v1", apiKey: "", providerId: "beta" }));
  // Under the same one it is still unroutable.
  assert.throws(
    () => addCustomEndpoint(list, { modelId: "shared", baseUrl: "https://other.example/v1", apiKey: "", providerId: "alpha" }),
    (error) => error.code === "duplicate",
  );
  // A built-in name would put two different things at one address.
  const reservedProviders = [
    ...allProfiles().filter((profile) => !profile.userDefined && profile.id !== "custom").map((profile) => profile.id),
    NATIVE_PROVIDER_ID,
  ];
  for (const reserved of reservedProviders) {
    assert.throws(
      () => addCustomEndpoint(list, { modelId: "x", baseUrl: "https://x.example/v1", apiKey: "", providerId: reserved }),
      (error) => error.code === "provider",
      `${reserved} is refused`,
    );
  }
});

// Removing one of two endpoints serving the same model id must take the one
// that was asked for.
test("removal names the provider", () => {
  let list = [];
  list = addCustomEndpoint(list, { modelId: "shared", baseUrl: "https://alpha.example/v1", apiKey: "", providerId: "alpha" });
  list = addCustomEndpoint(list, { modelId: "shared", baseUrl: "https://beta.example/v1", apiKey: "", providerId: "beta" });

  const left = removeCustomEndpoint(list, "shared", "alpha");
  assert.deepEqual(left.map((e) => e.providerId), ["beta"]);
  // Without a provider it still means "every endpoint for that model", which is
  // what a caller written before providers existed means by it.
  assert.deepEqual(removeCustomEndpoint(list, "shared"), []);
});

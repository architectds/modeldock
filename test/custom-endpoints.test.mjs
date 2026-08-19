// The endpoint list replaced a single .env slot where adding a second endpoint
// silently replaced the first. What has to hold: a key stays encrypted, routing
// can find the endpoint for a model, and a duplicate model id is refused rather
// than published unreachable.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  CustomEndpointsError,
  addCustomEndpoint,
  customEndpointFor,
  readCustomEndpoints,
  removeCustomEndpoint,
  writeCustomEndpoints,
} from "../src/custom-endpoints.mjs";
import { dpapiSupported } from "../src/secrets.mjs";

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

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import {
  emptyRollup,
  foldEvents,
  readRollup,
  usageStats,
} from "../src/usage-rollup.mjs";
import {
  localEngineDefinition,
  localEngineDefinitions,
} from "../src/local-engine-definitions.mjs";
import { credentialProfiles } from "../src/profiles.mjs";

const event = (at, model, provider, values = {}) => JSON.stringify({
  at,
  model,
  provider,
  status: 200,
  durationMs: 1000,
  inputTokens: 100,
  outputTokens: 10,
  cachedTokens: 20,
  ...values,
});

function assertTimelineMatchesSummary(timeline) {
  const byModel = Object.values(timeline.byModel || {});
  const sum = (field) => byModel.reduce((total, row) => total + (Number(row[field]) || 0), 0);
  assert.equal(sum("newInput") + sum("cached"), timeline.inputTokens,
    "a timeline cannot use a different token identity than its model breakdown");
  assert.equal(sum("output"), timeline.outputTokens,
    "model output stacks must add back to the timeline output");
  assert.equal(sum("requests"), timeline.completedRequests,
    "model request stacks must add back to completed requests");
  const spend = byModel.reduce((total, row) => total + (Number(row.cost) || 0), 0);
  assert.ok(Math.abs(spend - timeline.estimatedApiCostUsd) < 1e-8,
    "model spend stacks must add back to the timeline spend");
}

test("one canonical model projection drives every stats range and timeline", () => {
  const rollup = emptyRollup();
  const day = "2026-08-18";
  const hour = `${day}T12:00:00.000Z`;
  rollup.days[day] = {
    // These two spellings must be one model everywhere, including the colour
    // identity used by the dashboard.
    "Qwen/Qwen3.8-Flash@commandcode": {
      requests: 1, ok: 1, in: 700, out: 70, cached: 600, ms: 1000, okOut: 70, okMs: 1000,
    },
    "qwen3.8-flash@opencode-go": {
      requests: 1, ok: 1, in: 500, out: 50, cached: 400, ms: 1000, okOut: 50, okMs: 1000,
    },
  };
  for (let index = 1; index <= 6; index += 1) {
    rollup.days[day][`model-${index}@provider-${index}`] = {
      requests: 1, ok: 1, in: 100 + index, out: index, cached: 0,
      ms: 1000, okOut: index, okMs: 1000,
    };
  }
  rollup.hours[hour] = rollup.days[day];

  const stats = usageStats(rollup, `${day}T12:30:00.000Z`);
  for (const [periodName, period] of Object.entries(stats.modelPeriods)) {
    const ids = period.models.filter((model) => model.id !== "__other__").map((model) => model.id);
    assert.equal(new Set(ids).size, ids.length, `${periodName} has duplicate model identities`);
    const allowed = new Set([...ids, "__other__"]);
    for (const timeline of (stats.series[periodName] || [])) {
      assert.ok(Object.keys(timeline.byModel || {}).every((id) => allowed.has(id)),
        `${periodName} timeline contains a model missing from its donut projection`);
      assertTimelineMatchesSummary(timeline);
    }
  }
  assert.equal(stats.modelPeriods.hours24.models[0].id, "qwen3.8-flash");
  assert.equal(stats.modelPeriods.hours24.models[0].totalTokens, 1320);
  assert.deepEqual(new Set(Object.keys(stats.series.hours24.at(-1).byModel)),
    new Set(["qwen3.8-flash", "model-6", "model-5", "model-4", "model-3", "model-2", "__other__"]));
});

test("malformed persisted rollups cannot poison the cursor or aggregates", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-rollup-invariant-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage-rollup.json");
  const cases = [
    ["cursor", { version: 2, lastFoldedAt: "not-a-timestamp", days: {}, hours: {} }],
    ["day key", { version: 2, lastFoldedAt: "", days: { "not-a-day": {} }, hours: {} }],
    ["hour key", { version: 2, lastFoldedAt: "", days: {}, hours: { "not-an-hour": {} } }],
    ["numeric string", {
      version: 2, lastFoldedAt: "", days: { "2026-08-18": { model: { requests: "4" } } }, hours: {},
    }],
    ["nonfinite field", {
      version: 2, lastFoldedAt: "", days: { "2026-08-18": { model: { requests: "Infinity" } } }, hours: {},
    }],
    ["negative field", {
      version: 2, lastFoldedAt: "", days: { "2026-08-18": { model: { requests: -1 } } }, hours: {},
    }],
  ];
  for (const [label, value] of cases) {
    writeFileSync(file, JSON.stringify(value), "utf8");
    assert.deepEqual(readRollup(file), emptyRollup(),
      `${label} must reset rather than leak into stats or advance the cursor`);
  }
});

test("event fields with nonfinite or negative values are ignored without moving the cursor", () => {
  const { rollup, folded } = foldEvents(emptyRollup(), [
    event("not-a-timestamp", "bad", "provider"),
    event("2026-08-18T01:00:00.000Z", "safe", "provider", {
      inputTokens: -10,
      outputTokens: "NaN",
      cachedTokens: -20,
      durationMs: "Infinity",
    }),
  ], { now: "2026-08-18T02:00:00.000Z" });
  assert.equal(folded, 1, "only the timestamped event should be folded");
  const row = rollup.days["2026-08-18"]["safe@provider"];
  assert.deepEqual(row, { requests: 1, ok: 1, in: 0, out: 0, cached: 0, ms: 0, okOut: 0, okMs: 0 });
  assert.equal(rollup.lastFoldedAt, "2026-08-18T01:00:00.000Z");
});

test("local engine definitions have one source for labels, ports, and connectability", () => {
  const definitions = localEngineDefinitions();
  const ids = definitions.map((definition) => definition.id);
  assert.deepEqual(ids, ["ollama", "llamacpp", "vllm", "openai"]);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(definitions.map((definition) => definition.defaultPort)).size, definitions.length);
  for (const definition of definitions) {
    assert.deepEqual(localEngineDefinition(definition.id), definition,
      `${definition.id} must be read from the same canonical definition table`);
  }
});

test("credential settings and their browser fields share the provider registry", () => {
  const profiles = credentialProfiles();
  assert.ok(profiles.length > 0);
  assert.equal(new Set(profiles.map((profile) => profile.settingsField)).size, profiles.length,
    "every credential provider needs one unique public settings field");
  for (const profile of profiles) {
    assert.ok(profile.settingsField, `${profile.id} has no settings field`);
    assert.ok(profile.settingsErrorCode?.startsWith("invalid_"), `${profile.id} has no settings error contract`);
  }
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const browserProviders = [...html.matchAll(/data-provider-token="([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(browserProviders, profiles.map((profile) => profile.id).sort(),
    "the browser cannot maintain a second credential-provider inventory");
});

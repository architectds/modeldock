import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createApp, createServices, codexModelCatalog } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";
import {
  isModelPublished,
  isRuleEligible,
  readModelToggles,
  selectedModelSlugs,
  writeModelToggles,
} from "../src/model-toggles.mjs";
import { readLifecycle, writeLifecycle } from "../src/model-lifecycle-state.mjs";
import { modelsToPark } from "../src/model-tidy.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

async function tempFile(name = "model-toggles.json") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-toggles-"));
  return path.join(dir, name);
}

// --- the file ---

test("legacy boolean entries round-trip, and nothing else does", async (t) => {
  const file = await tempFile();
  t.after(() => rm(path.dirname(file), { recursive: true, force: true }));

  writeModelToggles(file, { "a@go": false, "b@go": true, "c@go": "maybe", "d@go": 1 });
  // false is hidden; true is kept only so an older file can be migrated on the
  // next tidy. Non-boolean hand edits are discarded.
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { "a@go": false, "b@go": true });
});

test("a file with nothing switched off is removed rather than left empty", async (t) => {
  const file = await tempFile();
  t.after(() => rm(path.dirname(file), { recursive: true, force: true }));

  writeModelToggles(file, { "a@go": false });
  assert.equal(existsSync(file), true);
  writeModelToggles(file, {});
  assert.equal(existsSync(file), false, "no file and an empty file mean the same thing");
});

test("an unknown model is published, and junk on disk does not change that", async (t) => {
  const file = await tempFile();
  t.after(() => rm(path.dirname(file), { recursive: true, force: true }));

  assert.equal(isModelPublished({}, "never-seen@go"), true, "absence is published");
  assert.equal(isModelPublished({ "x@go": false }, "x@go"), false);

  await writeFile(file, '{"a@go": false, "b@go": "yes", "c@go": 0, "d@go": true}', "utf8");
  assert.deepEqual(readModelToggles(file), { "a@go": false, "d@go": true }, "only booleans are opinions");

  await writeFile(file, "not json at all", "utf8");
  assert.deepEqual(readModelToggles(file), {}, "an unreadable file publishes everything");
});

test("the selected models are the ones the gateway is pointed at", () => {
  const selected = selectedModelSlugs({ mainModel: "m@go", visionModel: "v@go" }, "s@openai");
  assert.deepEqual([...selected].sort(), ["m@go", "s@openai", "v@go"]);
  assert.equal(selectedModelSlugs({}, "").size, 0, "an unset selection selects nothing");
});

// --- the catalog ---

function catalogSlugs(config) {
  return codexModelCatalog({
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    goToken: "test-token",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    refreshNativeCatalog: false,
    ...config,
  }).models.map((entry) => entry.slug);
}

test("a switched-off model leaves Codex's picker", () => {
  const before = catalogSlugs({});
  const victim = "deepseek-v4-pro@opencode-go";
  assert.ok(before.includes(victim), "fixture check: the model starts published");

  const after = catalogSlugs({ modelToggles: { [victim]: false } });
  assert.ok(!after.includes(victim), "the switched-off model is gone");
  assert.equal(after.length, before.length - 1, "and nothing else moved with it");
});

test("a model the gateway is pointed at stays published even when switched off", () => {
  // The file can name a model that a later selection picked up: switching the
  // vision model to something previously parked must not leave Codex unable to
  // name the model it is talking to.
  const slugs = catalogSlugs({
    visionModel: "gpt-5.6-luna@opencode-go",
    modelToggles: { "gpt-5.6-luna@opencode-go": false, "deepseek-v4-pro@opencode-go": false },
  });
  assert.ok(slugs.includes("gpt-5.6-luna@opencode-go"), "the selected model is published anyway");
  assert.ok(!slugs.includes("deepseek-v4-pro@opencode-go"), "an unselected one still leaves");
});

// --- the endpoint ---

async function startApp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-toggle-app-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    goBaseUrl: "https://go.example.com/v1",
    goToken: "test-token",
    tokens: { "opencode-go": "test-token" },
    mainModel: "deepseek-v4-flash@opencode-go",
    visionModel: "gpt-5.6-luna@opencode-go",
    visionTimeoutMs: 90_000,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxEntries: 64,
    exaMcpUrl: "https://mcp.exa.ai/mcp",
    exaApiKey: "",
    recentLimit: 50,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
    codexHome: dir,
    summariesFile: path.join(dir, "summaries.json"),
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
    nativeCatalogFile: path.join(dir, "native-catalog.json"),
    // Never the real ~/.modeldock files: a test run must not park a model in
    // the gateway the developer is using. Set on the config rather than on
    // services, because the boot-time tidy resolves them before services exist.
    modelTogglesFile: path.join(dir, "model-toggles.json"),
    modelLifecycleFile: path.join(dir, "model-lifecycle.json"),
    usageRollupFile: path.join(dir, "usage-rollup.json"),
  };
  const services = createServices(config);
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    dir,
    services,
    base: `http://127.0.0.1:${server.address().port}`,
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const setEnabled = (base, id, enabled) => fetch(`${base}/api/models/enabled`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, enabled }),
});

test("switching a model off rewrites the catalog Codex reads", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const victim = "deepseek-v4-pro@opencode-go";
  const catalogFile = path.join(app.dir, "codex-model-catalog.json");

  const before = JSON.parse(await readFile(catalogFile, "utf8")).models.map((m) => m.slug);
  assert.ok(before.includes(victim), "fixture check: published at startup");

  const response = await setEnabled(app.base, victim, false);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.enabled, false);
  assert.equal(body.restartRequired, true, "Codex caches the catalog; the change lands on its restart");

  const after = JSON.parse(await readFile(catalogFile, "utf8")).models.map((m) => m.slug);
  assert.ok(!after.includes(victim), "the file Codex reads no longer offers it");
  assert.deepEqual(readModelToggles(app.services.modelTogglesFile), { [victim]: false });
});

test("switching it back on restores it, and restarts its clock", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const victim = "deepseek-v4-pro@opencode-go";
  const catalogFile = path.join(app.dir, "codex-model-catalog.json");
  const before = Date.now();

  await setEnabled(app.base, victim, false);
  await setEnabled(app.base, victim, true);

  const slugs = JSON.parse(await readFile(catalogFile, "utf8")).models.map((m) => m.slug);
  assert.ok(slugs.includes(victim), "back in the picker");
  // The entry is gone rather than flipped to true: a rescue says "I want this
  // one", not "never judge this one again".
  assert.equal(existsSync(app.services.modelTogglesFile), false, "no entry left behind");
  assert.equal(isRuleEligible(readModelToggles(app.services.modelTogglesFile), victim), true);

  const stamped = Date.parse(readLifecycle(app.services.modelLifecycleFile).firstSeen[victim]);
  assert.ok(stamped >= before, "and its thirty-day clock starts over");
});

// The two halves of the rescue, stated as behaviour rather than as file shape:
// the clock restart is what makes deleting the entry safe, and deleting the
// entry is what stops the exemption outliving the intent.
test("a rescued model is not re-parked next week, but is not exempt forever", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const victim = "deepseek-v4-pro@opencode-go";
  const DAY = 24 * 60 * 60 * 1000;

  // Age the model past the window first. Without this the boot pass has just
  // stamped it with "now" and the assertions below hold whether or not the
  // rescue restamps anything - the test would pass for the wrong reason.
  const seeded = readLifecycle(app.services.modelLifecycleFile);
  writeLifecycle(app.services.modelLifecycleFile, {
    ...seeded,
    firstSeen: { ...seeded.firstSeen, [victim]: new Date(Date.now() - 40 * DAY).toISOString() },
  });

  await setEnabled(app.base, victim, false);
  await setEnabled(app.base, victim, true);

  const toggles = readModelToggles(app.services.modelTogglesFile);
  const firstSeen = readLifecycle(app.services.modelLifecycleFile).firstSeen;
  assert.ok(Date.now() - Date.parse(firstSeen[victim]) < DAY, "the rescue restamped it, not the boot pass");
  // A rollup wide enough to judge on, in which this model has no traffic at
  // all - the exact input that parked it the first time.
  const rollup = { version: 2, days: { "2000-01-01": {} } };
  const models = [{ id: victim, provider: "opencode-go" }];

  const nextWeek = Date.now() + 7 * DAY;
  assert.deepEqual(
    modelsToPark({ models, rollup, toggles, firstSeen, now: nextWeek }), [],
    "a week later the rescue still stands",
  );

  const nextMonth = Date.now() + 31 * DAY;
  assert.deepEqual(
    modelsToPark({ models, rollup, toggles, firstSeen, now: nextMonth }), [victim],
    "thirty days later, unused, it is judged again like any other model",
  );
});

test("a legacy re-enable entry receives the same fresh thirty-day clock", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const victim = "deepseek-v4-pro@opencode-go";
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();

  writeModelToggles(app.services.modelTogglesFile, { [victim]: true });
  const seeded = readLifecycle(app.services.modelLifecycleFile);
  writeLifecycle(app.services.modelLifecycleFile, {
    ...seeded,
    firstSeen: { ...seeded.firstSeen, [victim]: new Date(now - 60 * DAY).toISOString() },
  });
  seedRollup(app.services.usageRollupFile, "deepseek-v4-flash@opencode-go", now);

  const result = app.services.runModelTidy(now);
  assert.ok(!result.parked.includes(victim), "the legacy entry is not parked immediately on upgrade");
  assert.deepEqual(readModelToggles(app.services.modelTogglesFile), {}, "legacy true no longer becomes a permanent exemption");
  const stamped = Date.parse(readLifecycle(app.services.modelLifecycleFile).firstSeen[victim]);
  assert.ok(stamped >= now, "the legacy rescue gets a new thirty-day clock");
});

test("the model the gateway is pointed at cannot be switched off", async (t) => {
  const app = await startApp();
  t.after(app.stop);

  const response = await setEnabled(app.base, "gpt-5.6-luna@opencode-go", false);
  assert.equal(response.status, 409, "refused rather than stored as a preference that never applies");
  const body = await response.json();
  assert.equal(body.error.type, "model_in_use");
  assert.equal(existsSync(app.services.modelTogglesFile), false, "nothing was written");
});

test("the roster reports the state and never hides a switched-off model", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const victim = "deepseek-v4-pro@opencode-go";

  await setEnabled(app.base, victim, false);
  const roster = await (await fetch(`${app.base}/api/models/roster`)).json();

  const row = roster.models.find((entry) => entry.id === victim);
  assert.ok(row, "the roster is the only way back on, so it still lists it");
  assert.equal(row.published, false);
  assert.equal(row.locked, false);

  const selectedRow = roster.models.find((entry) => entry.id === "gpt-5.6-luna@opencode-go");
  assert.equal(selectedRow.published, true);
  assert.equal(selectedRow.locked, true, "the selected model reads as locked, not merely on");
});

test("a bad request is refused before anything is written", async (t) => {
  const app = await startApp();
  t.after(app.stop);

  assert.equal((await setEnabled(app.base, "", false)).status, 400);
  const noState = await fetch(`${app.base}/api/models/enabled`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "deepseek-v4-pro@opencode-go" }),
  });
  assert.equal(noState.status, 400, "enabled must be an explicit boolean");
  assert.equal(existsSync(app.services.modelTogglesFile), false);
});

// --- the weekly tidy, end to end ---

const DAY = 24 * 60 * 60 * 1000;

// A rollup that spans wide enough for the rule to act, carrying traffic for
// exactly one model.
function seedRollup(file, busySlug, now) {
  const day = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);
  writeFileSync(file, JSON.stringify({
    version: 2,
    lastFoldedAt: new Date(now).toISOString(),
    days: {
      [day(40)]: {},
      [day(1)]: { [busySlug]: { requests: 500, ok: 500, errors: 0 } },
    },
  }), "utf8");
}

test("the tidy removes what nobody used, and leaves everything it is unsure about", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const now = Date.now();
  const busy = "deepseek-v4-flash@opencode-go";   // also the selected main model
  const quiet = "deepseek-v4-pro@opencode-go";
  const rescued = "glm-5@opencode-go";
  const fresh = "kimi-k2.5@opencode-go";

  seedRollup(app.services.usageRollupFile, busy, now);
  // Everything is old enough to judge except `fresh`, which arrived yesterday.
  const catalogNow = JSON.parse(await readFile(path.join(app.dir, "codex-model-catalog.json"), "utf8"));
  const firstSeen = {};
  for (const entry of catalogNow.models) firstSeen[entry.slug] = new Date(now - 60 * DAY).toISOString();
  firstSeen[fresh] = new Date(now - DAY).toISOString();
  writeLifecycle(app.services.modelLifecycleFile, { lastTidyAt: "", firstSeen });
  // A person already rescued this one; the tidy must not undo that.
  await setEnabled(app.base, rescued, true);

  const result = app.services.runModelTidy(now);
  assert.equal(result.run, true, "the window is wide enough and it has never run");
  assert.ok(result.parked.includes(quiet), "an unused model is parked");
  assert.ok(!result.parked.includes(busy), "the used (and selected) model stays");
  assert.ok(!result.parked.includes(rescued), "a switch a person set is not overruled");
  assert.ok(!result.parked.includes(fresh), "a model added yesterday has no thirty days to show");

  const slugs = JSON.parse(await readFile(path.join(app.dir, "codex-model-catalog.json"), "utf8"))
    .models.map((m) => m.slug);
  assert.ok(!slugs.includes(quiet), "and the picker Codex reads is rewritten");
  assert.ok(slugs.includes(busy) && slugs.includes(rescued) && slugs.includes(fresh));
});

test("the tidy holds off until the window is full, and then not again for a week", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const now = Date.now();
  const day = (n) => new Date(now - n * DAY).toISOString().slice(0, 10);

  // Eleven days of history: every zero here means "not yet", not "never".
  writeFileSync(app.services.usageRollupFile, JSON.stringify({
    version: 2, lastFoldedAt: new Date(now).toISOString(), days: { [day(11)]: {}, [day(1)]: {} },
  }), "utf8");
  const young = app.services.runModelTidy(now);
  assert.equal(young.run, false);
  assert.equal(young.reason, "window_incomplete");
  assert.deepEqual(young.parked, []);
  assert.equal(existsSync(app.services.modelTogglesFile), false, "nothing was parked on a fresh install");
  // The clock still starts on every model it saw, so the wait is not wasted.
  assert.ok(Object.keys(readLifecycle(app.services.modelLifecycleFile).firstSeen).length > 0);

  seedRollup(app.services.usageRollupFile, "deepseek-v4-flash@opencode-go", now);
  writeLifecycle(app.services.modelLifecycleFile, {
    lastTidyAt: new Date(now - 2 * DAY).toISOString(),
    firstSeen: readLifecycle(app.services.modelLifecycleFile).firstSeen,
  });
  const tooSoon = app.services.runModelTidy(now);
  assert.equal(tooSoon.run, false);
  assert.equal(tooSoon.reason, "ran_recently");
});

test("the periodic pass tidies too, not just the boot that started the gateway", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  const now = Date.now();
  const busy = "deepseek-v4-flash@opencode-go";

  // A gateway left running for weeks never boots again, so a boot-only tidy
  // never fires on exactly the installs that accumulate the most models.
  seedRollup(app.services.usageRollupFile, busy, now);
  const catalogNow = JSON.parse(await readFile(path.join(app.dir, "codex-model-catalog.json"), "utf8"));
  const firstSeen = {};
  for (const entry of catalogNow.models) firstSeen[entry.slug] = new Date(now - 60 * DAY).toISOString();
  writeLifecycle(app.services.modelLifecycleFile, { lastTidyAt: "", firstSeen });

  assert.equal(existsSync(app.services.modelTogglesFile), false, "nothing parked before the pass");
  await app.services.runScheduledMaintenance();

  const parked = Object.values(readModelToggles(app.services.modelTogglesFile)).filter((v) => v === false);
  assert.ok(parked.length > 0, "the periodic pass parked what the boot pass would have");
  assert.ok(readLifecycle(app.services.modelLifecycleFile).lastTidyAt, "and recorded the run");
});

test("the roster shows a native model's traffic, which is filed under its provider", async (t) => {
  const app = await startApp();
  t.after(app.stop);
  await writeFile(
    path.join(app.dir, "native-catalog.json"),
    JSON.stringify({ models: [{ slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", input_modalities: ["text"] }] }),
    "utf8",
  );
  await writeFile(path.join(app.dir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok" } }), "utf8");
  // Exactly how the relay records a native turn: a bare model plus provider
  // "openai", which rollupKey joins into "gpt-5.6-sol@openai".
  writeFileSync(app.services.usageRollupFile, JSON.stringify({
    version: 2,
    lastFoldedAt: new Date().toISOString(),
    days: {
      [new Date().toISOString().slice(0, 10)]: {
        "gpt-5.6-sol@openai": { requests: 1959, ok: 1959, in: 100, out: 50, cached: 0, ms: 1000, okOut: 50, okMs: 1000 },
      },
    },
  }), "utf8");

  const roster = await (await fetch(`${app.base}/api/models/roster`)).json();
  const sol = roster.models.find((entry) => entry.id === "gpt-5.6-sol");
  assert.ok(sol, "fixture check: the native model is listed");
  assert.equal(sol.usage?.requests, 1959, "its traffic is found, not read as never used");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import {
  TIDY_EVERY_DAYS,
  TIDY_WINDOW_DAYS,
  modelsToPark,
  rollupSpanDays,
  shouldTidy,
  stampFirstSeen,
} from "../src/model-tidy.mjs";
import { emptyLifecycle, readLifecycle, writeLifecycle } from "../src/model-lifecycle-state.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-20T12:00:00Z");
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const dayKey = (n) => daysAgo(n).slice(0, 10);

// A rollup whose earliest bucket is `spanDays` old, carrying whatever traffic
// the caller names.
function rollupSpanning(spanDays, traffic = {}) {
  const days = {};
  days[dayKey(spanDays)] = {};
  for (const [slug, requests] of Object.entries(traffic)) {
    days[dayKey(1)] = { ...(days[dayKey(1)] || {}), [slug]: { requests, ok: requests, errors: 0 } };
  }
  return { version: 2, lastFoldedAt: daysAgo(0), days };
}

const model = (id, extra = {}) => ({ id, provider: "opencode-go", ...extra });

// --- when it runs at all ---

test("the rule waits until the window it reasons about is actually full", () => {
  const young = shouldTidy({ lastTidyAt: "", rollup: rollupSpanning(TIDY_WINDOW_DAYS - 1), now: NOW });
  assert.equal(young.run, false);
  assert.equal(young.reason, "window_incomplete", "before then every zero means 'not yet', not 'never'");

  const ready = shouldTidy({ lastTidyAt: "", rollup: rollupSpanning(TIDY_WINDOW_DAYS + 5), now: NOW });
  assert.equal(ready.run, true);
  assert.equal(ready.reason, "first_run");
});

test("an empty rollup never triggers a tidy", () => {
  assert.equal(rollupSpanDays({ days: {} }, NOW), 0);
  assert.equal(shouldTidy({ lastTidyAt: "", rollup: { days: {} }, now: NOW }).run, false);
});

test("it runs weekly, measured from the last run rather than the calendar", () => {
  const rollup = rollupSpanning(TIDY_WINDOW_DAYS + 5);
  const justRan = shouldTidy({ lastTidyAt: daysAgo(TIDY_EVERY_DAYS - 1), rollup, now: NOW });
  assert.equal(justRan.run, false);
  assert.equal(justRan.reason, "ran_recently");

  assert.equal(shouldTidy({ lastTidyAt: daysAgo(TIDY_EVERY_DAYS + 1), rollup, now: NOW }).run, true);
  // A gateway that was off for a month does not owe five tidies on the morning
  // it comes back; one run brings it current.
  assert.equal(shouldTidy({ lastTidyAt: daysAgo(90), rollup, now: NOW }).reason, "due");
});

// --- what it parks ---

const base = {
  rollup: rollupSpanning(TIDY_WINDOW_DAYS + 5, { "busy@opencode-go": 400 }),
  now: NOW,
  firstSeen: {
    "busy@opencode-go": daysAgo(60),
    "quiet@opencode-go": daysAgo(60),
    "new@opencode-go": daysAgo(3),
    "pinned@opencode-go": daysAgo(60),
    "hidden@opencode-go": daysAgo(60),
    "chosen@opencode-go": daysAgo(60),
    "gpt-5.6-sol": daysAgo(60),
  },
};

test("a model with no traffic in the whole window is parked", () => {
  const parked = modelsToPark({
    ...base,
    models: [model("busy@opencode-go"), model("quiet@opencode-go")],
  });
  assert.deepEqual(parked, ["quiet@opencode-go"], "the used one stays, the silent one goes");
});

test("a model nobody has had thirty days to use is left alone", () => {
  const parked = modelsToPark({ ...base, models: [model("new@opencode-go")] });
  assert.deepEqual(parked, [], "a model added this week has no history to be judged on");

  const unstamped = modelsToPark({ ...base, models: [model("never-stamped@opencode-go")] });
  assert.deepEqual(unstamped, [], "and neither has one we have not started the clock on");
});

test("a switch a person has touched is never overruled, either way", () => {
  const parked = modelsToPark({
    ...base,
    models: [model("pinned@opencode-go"), model("hidden@opencode-go"), model("quiet@opencode-go")],
    toggles: { "pinned@opencode-go": true, "hidden@opencode-go": false },
  });
  assert.deepEqual(parked, ["quiet@opencode-go"], "only the model nobody has ruled on is touched");
});

test("the models the gateway is pointed at are not parked", () => {
  const parked = modelsToPark({
    ...base,
    models: [model("chosen@opencode-go"), model("quiet@opencode-go")],
    selected: new Set(["chosen@opencode-go"]),
  });
  assert.deepEqual(parked, ["quiet@opencode-go"]);
});

test("native models are Codex's to list, not ours to withhold", () => {
  const parked = modelsToPark({
    ...base,
    models: [model("gpt-5.6-sol", { provider: "openai", native: true }), model("quiet@opencode-go")],
  });
  assert.deepEqual(parked, ["quiet@opencode-go"]);
});

// --- the clock on each model ---

test("first-seen starts when a model appears, not when the rule looks at it", () => {
  const first = stampFirstSeen({}, [model("a@go"), model("b@go")], NOW);
  assert.equal(first.changed, true);
  assert.deepEqual(Object.keys(first.firstSeen).sort(), ["a@go", "b@go"]);

  const again = stampFirstSeen(first.firstSeen, [model("a@go"), model("b@go")], NOW + DAY);
  assert.equal(again.changed, false, "a model already known keeps its original date");
  assert.equal(again.firstSeen["a@go"], first.firstSeen["a@go"]);
});

test("a model that leaves the catalog starts its clock again if it returns", () => {
  const seeded = stampFirstSeen({}, [model("a@go"), model("gone@go")], NOW - 60 * DAY);
  const afterLeaving = stampFirstSeen(seeded.firstSeen, [model("a@go")], NOW);
  assert.equal(afterLeaving.changed, true);
  assert.equal(afterLeaving.firstSeen["gone@go"], undefined, "its stamp goes with it");

  const returned = stampFirstSeen(afterLeaving.firstSeen, [model("a@go"), model("gone@go")], NOW);
  assert.equal(
    Date.parse(returned.firstSeen["gone@go"]),
    NOW,
    "so it cannot be parked on the strength of an absence spent outside the catalog",
  );
});

// --- the state file ---

test("the lifecycle file survives a round trip and refuses a shape it does not know", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "model-lifecycle.json");

  assert.deepEqual(readLifecycle(file), emptyLifecycle(), "a missing file reads as nothing known");

  writeLifecycle(file, { lastTidyAt: daysAgo(2), firstSeen: { "a@go": daysAgo(40), "b@go": 7 } });
  const back = readLifecycle(file);
  assert.equal(back.lastTidyAt, daysAgo(2));
  assert.deepEqual(back.firstSeen, { "a@go": daysAgo(40) }, "a stamp that is not a date is not a stamp");
});

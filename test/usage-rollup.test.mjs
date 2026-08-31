// The rollup is the only record of usage older than about nine days, so the
// arithmetic and the retention both have to hold.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  ROLLUP_DAYS,
  ROLLUP_HOURS,
  emptyRollup,
  foldEvents,
  foldUsageFile,
  pruneRollup,
  rollupKey,
  rollupTotals,
  usageStats,
} from "../src/usage-rollup.mjs";

const event = (at, over = {}) => JSON.stringify({
  at, model: "deepseek-v4-flash", provider: "opencode-go",
  status: 200, durationMs: 1000, inputTokens: 100, outputTokens: 50, cachedTokens: 80,
  ...over,
});

test("a model is keyed by provider, because the same name serves from two", () => {
  assert.equal(rollupKey({ model: "deepseek-v4-flash", provider: "opencode-go" }), "deepseek-v4-flash@opencode-go");
  assert.equal(rollupKey({ model: "deepseek-v4-flash", provider: "deepseek-official" }), "deepseek-v4-flash@deepseek-official");
  // An already-qualified id is not qualified twice.
  assert.equal(rollupKey({ model: "kimi-k2.5@opencode-go", provider: "opencode-go" }), "kimi-k2.5@opencode-go");
});

test("folding sums into daily buckets", () => {
  const { rollup, folded } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z"),
    event("2026-08-18T02:00:00.000Z"),
    event("2026-08-19T01:00:00.000Z"),
  ], { now: "2026-08-19T12:00:00.000Z" });
  assert.equal(folded, 3);
  assert.deepEqual(Object.keys(rollup.days).sort(), ["2026-08-18", "2026-08-19"]);
  assert.equal(rollup.days["2026-08-18"]["deepseek-v4-flash@opencode-go"].requests, 2);
  assert.equal(rollup.days["2026-08-18"]["deepseek-v4-flash@opencode-go"].out, 100);
});

test("a second fold ignores what the first already counted", () => {
  const lines = [event("2026-08-18T01:00:00.000Z"), event("2026-08-18T02:00:00.000Z")];
  const first = foldEvents(emptyRollup(), lines, { now: "2026-08-18T03:00:00.000Z" });
  assert.equal(first.folded, 2);
  // Re-reading the same file must not double-count: the whole design rests on
  // this, because every fold reads both files from the top.
  const second = foldEvents(first.rollup, lines, { now: "2026-08-18T03:00:00.000Z" });
  assert.equal(second.folded, 0);
  assert.equal(second.rollup.days["2026-08-18"]["deepseek-v4-flash@opencode-go"].requests, 2);
});

test("only events newer than the last fold are counted", () => {
  const state = foldEvents(emptyRollup(), [event("2026-08-18T05:00:00.000Z")], { now: "2026-08-18T06:00:00.000Z" });
  const next = foldEvents(state.rollup, [
    event("2026-08-18T04:00:00.000Z"),
    event("2026-08-18T06:00:00.000Z"),
  ], { now: "2026-08-18T07:00:00.000Z" });
  assert.equal(next.folded, 1, "the older line is already accounted for");
});

test("unparseable and timestampless lines are skipped, not fatal", () => {
  const { folded } = foldEvents(emptyRollup(), [
    "not json", "", "{}", event("2026-08-18T01:00:00.000Z"),
  ], { now: "2026-08-18T02:00:00.000Z" });
  assert.equal(folded, 1);
});

test("days past the window are dropped", () => {
  const rollup = emptyRollup();
  rollup.days["2026-07-01"] = { m: { requests: 1 } };
  rollup.days["2026-08-18"] = { m: { requests: 1 } };
  pruneRollup(rollup, "2026-08-18T00:00:00.000Z");
  assert.deepEqual(Object.keys(rollup.days), ["2026-08-18"]);
});

test("the window keeps exactly ROLLUP_DAYS days", () => {
  const rollup = emptyRollup();
  for (let i = 0; i < 40; i += 1) {
    const day = new Date(Date.UTC(2026, 7, 18));
    day.setUTCDate(day.getUTCDate() - i);
    rollup.days[day.toISOString().slice(0, 10)] = { m: { requests: 1 } };
  }
  pruneRollup(rollup, "2026-08-18T00:00:00.000Z");
  assert.equal(Object.keys(rollup.days).length, ROLLUP_DAYS);
});

test("the rolling view keeps exactly ROLLUP_HOURS hourly buckets", () => {
  const now = new Date("2026-08-18T12:30:00.000Z");
  const lines = [];
  for (let index = 29; index >= 0; index -= 1) {
    const at = new Date(now);
    at.setUTCHours(at.getUTCHours() - index);
    lines.push(event(at.toISOString()));
  }
  const { rollup } = foldEvents(emptyRollup(), lines, { now: now.toISOString() });
  assert.equal(Object.keys(rollup.hours).length, ROLLUP_HOURS);
  assert.equal(Object.keys(rollup.hours).sort()[0], "2026-08-17T13:00:00.000Z");
});

test("totals divide sums, never averaging an average", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    // One short reply and one long one. A mean of per-request rates would call
    // this 30 tps; the honest figure weights by tokens and time.
    event("2026-08-18T01:00:00.000Z", { outputTokens: 10, durationMs: 1000, inputTokens: 100, cachedTokens: 0 }),
    event("2026-08-18T02:00:00.000Z", { outputTokens: 500, durationMs: 10000, inputTokens: 900, cachedTokens: 900 }),
  ], { now: "2026-08-18T03:00:00.000Z" });
  const row = rollupTotals(rollup)["deepseek-v4-flash@opencode-go"];
  assert.equal(row.out, 510);
  assert.equal(row.ms, 11000);
  assert.ok(Math.abs(row.tps - 510 / 11) < 1e-9, "tps is total tokens over total seconds");
  assert.ok(Math.abs(row.cacheRate - 900 / 1000) < 1e-9, "cache rate is total cached over total input");
  assert.equal(row.successRate, 1);
});

test("a failed request counts as traffic but not as success", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z", { status: 500, outputTokens: 0 }),
    event("2026-08-18T02:00:00.000Z"),
  ], { now: "2026-08-18T03:00:00.000Z" });
  const row = rollupTotals(rollup)["deepseek-v4-flash@opencode-go"];
  assert.equal(row.requests, 2);
  assert.equal(row.ok, 1);
  assert.equal(row.successRate, 0.5);
});

test("totals sum across days", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-17T01:00:00.000Z"),
    event("2026-08-18T01:00:00.000Z"),
  ], { now: "2026-08-18T02:00:00.000Z" });
  const total = rollupTotals(rollup)["deepseek-v4-flash@opencode-go"];
  assert.equal(total.popularity, 2);
  assert.equal(total.requests, 2, "the public legacy alias remains accurate");
});

test("heat weights recent days over equally-used older ones", () => {
  const rollup = emptyRollup();
  // Same request count per model, different age: today, exactly a week ago,
  // and two weeks ago. A flat sum would rank them equal; the decayed score
  // must order today > week-ago > two-weeks-ago.
  rollup.days["2026-08-18"] = { "recent@opencode-go": { requests: 14 } };
  rollup.days["2026-08-11"] = { "week@opencode-go": { requests: 14 } };
  rollup.days["2026-08-04"] = { "old@opencode-go": { requests: 14 } };
  const totals = rollupTotals(rollup, "2026-08-18T12:00:00.000Z");
  assert.equal(totals["recent@opencode-go"].popularity, 14, "popularity stays a flat 30-day total");
  assert.ok(Math.abs(totals["recent@opencode-go"].heat - 14) < 1e-9, "today is full weight");
  assert.ok(Math.abs(totals["week@opencode-go"].heat - 7) < 1e-9, "a week back is half");
  assert.ok(Math.abs(totals["old@opencode-go"].heat - 3.5) < 1e-9, "two weeks back is a quarter");
  assert.ok(
    totals["recent@opencode-go"].heat > totals["week@opencode-go"].heat
      && totals["week@opencode-go"].heat > totals["old@opencode-go"].heat,
    "recent traffic always outranks equally-used older traffic",
  );
});

test("heat handles a rollup with no time context", () => {
  const rollup = emptyRollup();
  rollup.days["2026-08-18"] = { "m@opencode-go": { requests: 4 } };
  const totals = rollupTotals(rollup, "not-a-date");
  assert.equal(totals["m@opencode-go"].heat, 4, "an unparseable now falls back to full weight");
});

test("throughput ignores the requests that produced nothing", () => {
  // Measured on the real log: counting failures put deepseek-v4-flash-free at
  // 421 tps, which is not a rate anything achieved - it is the arithmetic of
  // dividing by a denominator that excludes half the wall clock.
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z", { status: 200, outputTokens: 100, durationMs: 2000 }),
    event("2026-08-18T02:00:00.000Z", { status: 500, outputTokens: 0, durationMs: 8000 }),
  ], { now: "2026-08-18T03:00:00.000Z" });
  const row = rollupTotals(rollup)["deepseek-v4-flash@opencode-go"];
  assert.equal(row.tps, 50, "100 tokens over the 2s that produced them, not over 10s");
  assert.equal(row.ms, 10000, "total time still records the failure");
  assert.equal(row.successRate, 0.5);
});

test("a model that only ever failed reports no rate rather than a wrong one", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z", { status: 502, outputTokens: 0, durationMs: 3000 }),
  ], { now: "2026-08-18T02:00:00.000Z" });
  const row = rollupTotals(rollup)["deepseek-v4-flash@opencode-go"];
  assert.equal(row.tps, 0);
  assert.equal(row.requests, 1);
  assert.equal(row.successRate, 0);
});

test("throughput ignores a rate no model achieves", () => {
  // Nine days of real metering carried 897 events that were not generation:
  // a stubbed fetch answering in 3ms still routes, still records, and still
  // claims tokens. deepseek-v4-flash@deepseek-official read 1,214 tok/s on the
  // Models page - arithmetic over 613 tokens and 505 milliseconds.
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z", { outputTokens: 22, durationMs: 4 }),
    event("2026-08-18T02:00:00.000Z", { outputTokens: 100, durationMs: 2000 }),
  ], { now: "2026-08-18T03:00:00.000Z" });
  const row = rollupTotals(rollup)["deepseek-v4-flash@opencode-go"];
  assert.equal(row.requests, 2, "both still count as traffic");
  assert.equal(row.tps, 50, "only the one that could have been generated sets the rate");
});

test("a slow request is never mistaken for an implausible one", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z", { outputTokens: 800, durationMs: 4000 }),
  ], { now: "2026-08-18T02:00:00.000Z" });
  assert.equal(rollupTotals(rollup)["deepseek-v4-flash@opencode-go"].tps, 200);
});

test("stats expose bounded today, seven-day, and thirty-day completed usage", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-12T01:00:00.000Z", { inputTokens: 300, cachedTokens: 100, outputTokens: 30 }),
    event("2026-08-18T01:00:00.000Z", { inputTokens: 500, cachedTokens: 400, outputTokens: 50, durationMs: 2000 }),
    event("2026-08-18T02:00:00.000Z", { status: 500, inputTokens: 0, cachedTokens: 0, outputTokens: 0 }),
  ], { now: "2026-08-18T03:00:00.000Z" });
  const stats = usageStats(rollup, "2026-08-18T12:00:00.000Z");

  assert.equal(stats.timezone, "UTC");
  assert.equal(stats.days.length, ROLLUP_DAYS);
  assert.equal(stats.hours.length, ROLLUP_HOURS);
  assert.equal(stats.days.at(-1).day, "2026-08-18");
  assert.equal(stats.hours.at(-1).hour, "2026-08-18T12:00:00.000Z");
  assert.equal(stats.periods.today.totalTokens, 550);
  assert.equal(stats.periods.hours24.totalTokens, 550);
  assert.equal(stats.periods.today.completedRequests, 1, "failed traffic is not presented as completed work");
  assert.equal(stats.periods.days7.totalTokens, 880);
  assert.equal(stats.periods.days30.cachedTokens, 500);
  assert.equal(stats.periods.days30.newInputTokens, 300);
  assert.equal(stats.periods.days30.outputTps, 80 / 3);
  assert.ok(Math.abs(stats.periods.today.estimatedApiCostUsd - 0.0000578) < 1e-12);
  assert.ok(Math.abs(stats.periods.days30.estimatedApiCostUsd - 0.0001223) < 1e-12);
  assert.equal(stats.periods.days30.costCoverage, 1);
  assert.equal(stats.modelPeriods.today.models[0].totalTokens, 550);
  assert.equal(stats.modelPeriods.hours24.models[0].totalTokens, 550);
  assert.equal(stats.modelPeriods.days7.models[0].totalTokens, 880);
});

test("the 1D stats window is twenty-four UTC hours rather than one daily bucket", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-17T12:59:59.999Z", { inputTokens: 1000, outputTokens: 0 }),
    event("2026-08-17T13:00:00.000Z", { inputTokens: 200, outputTokens: 20 }),
    event("2026-08-18T12:15:00.000Z", { inputTokens: 300, outputTokens: 30 }),
  ], { now: "2026-08-18T12:30:00.000Z" });
  const stats = usageStats(rollup, "2026-08-18T12:30:00.000Z");

  assert.equal(stats.hours.length, 24);
  assert.equal(stats.hours[0].hour, "2026-08-17T13:00:00.000Z");
  assert.equal(stats.hours.at(-1).hour, "2026-08-18T12:00:00.000Z");
  assert.equal(stats.periods.hours24.totalTokens, 550, "the hour before the rolling window is excluded");
});

test("an existing daily-only rollup backfills recent hours without recounting days", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-hour-backfill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage-events.jsonl");
  const lines = [
    event("2026-08-18T10:05:00.000Z", { inputTokens: 200, outputTokens: 20 }),
    event("2026-08-18T11:05:00.000Z", { inputTokens: 300, outputTokens: 30 }),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  const existing = foldEvents(emptyRollup(), lines, { now: "2026-08-18T11:30:00.000Z" }).rollup;
  const dailyTotal = existing.days["2026-08-18"]["deepseek-v4-flash@opencode-go"].in;
  delete existing.hours;

  const result = foldUsageFile(existing, file, { now: "2026-08-18T12:00:00.000Z" });
  assert.equal(result.folded, 0, "already-folded daily events stay idempotent");
  assert.equal(result.changed, true, "the migration writes the reconstructed hourly view");
  assert.equal(result.rollup.days["2026-08-18"]["deepseek-v4-flash@opencode-go"].in, dailyTotal);
  assert.equal(result.rollup.hours["2026-08-18T10:00:00.000Z"]["deepseek-v4-flash@opencode-go"].in, 200);
  assert.equal(result.rollup.hours["2026-08-18T11:00:00.000Z"]["deepseek-v4-flash@opencode-go"].in, 300);
});

test("stats keep unknown provider traffic visible without inventing a price", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z", {
      model: "private-model", provider: "custom", inputTokens: 800, cachedTokens: 400, outputTokens: 200,
    }),
  ], { now: "2026-08-18T02:00:00.000Z" });
  const stats = usageStats(rollup, "2026-08-18T12:00:00.000Z");

  assert.equal(stats.periods.today.totalTokens, 1000);
  assert.equal(stats.periods.today.estimatedApiCostUsd, 0);
  assert.equal(stats.periods.today.pricedTokens, 0);
  assert.equal(stats.periods.today.unpricedTokens, 1000);
  assert.equal(stats.periods.today.costCoverage, 0);
});

test("stats keep model share bounded and aggregate the tail", () => {
  const rollup = emptyRollup();
  const day = "2026-08-18";
  rollup.days[day] = {};
  for (let index = 1; index <= 8; index += 1) {
    rollup.days[day][`model-${index}@provider-${index}`] = {
      requests: 1, ok: 1, in: index * 100, out: 0, cached: 0, ms: 1000, okOut: 0, okMs: 0,
    };
  }
  const stats = usageStats(rollup, `${day}T12:00:00.000Z`);

  assert.equal(stats.modelCount, 8);
  assert.equal(stats.models.length, 7, "six named models plus one bounded Other row");
  assert.equal(stats.models[0].id, "model-8@provider-8");
  assert.equal(stats.models.at(-1).id, "__other__");
  assert.equal(stats.models.at(-1).totalTokens, 300, "the two smallest models are preserved in Other");
});

// The coloured bars are only honest if a bucket's model stacks add back up to
// the same totals the summary cards print, and if the ranking that picks the
// colours is the one the donut uses.
test("stats attribute each bucket to the models that produced it", () => {
  const { rollup } = foldEvents(emptyRollup(), [
    event("2026-08-18T01:00:00.000Z", { inputTokens: 500, cachedTokens: 400, outputTokens: 50 }),
    event("2026-08-18T02:00:00.000Z", {
      model: "glm-5.3", provider: "opencode-go", inputTokens: 200, cachedTokens: 0, outputTokens: 20,
    }),
  ], { now: "2026-08-18T03:00:00.000Z" });
  const stats = usageStats(rollup, "2026-08-18T12:00:00.000Z");
  const day = stats.days.at(-1);

  assert.deepEqual(stats.modelLegend, ["deepseek-v4-flash@opencode-go", "glm-5.3@opencode-go"]);
  const { cost: firstCost, ...first } = day.byModel["deepseek-v4-flash@opencode-go"];
  const { cost: secondCost, ...second } = day.byModel["glm-5.3@opencode-go"];
  assert.deepEqual(first, { newInput: 100, cached: 400, output: 50, requests: 1 });
  assert.deepEqual(second, { newInput: 200, cached: 0, output: 20, requests: 1 });
  // Each model is priced on its own row, which is the whole point of the split.
  assert.ok(Math.abs(firstCost - 0.0000578) < 1e-9, "the cached half of the input is billed as cache");
  assert.ok(Math.abs(secondCost - 0.000368) < 1e-9);
  const sum = (field) => Object.values(day.byModel).reduce((total, row) => total + row[field], 0);
  assert.equal(sum("newInput") + sum("cached"), day.newInputTokens + day.cachedTokens);
  assert.equal(sum("output"), day.outputTokens);
  assert.equal(sum("requests"), day.completedRequests);
  assert.ok(Math.abs(sum("cost") - day.estimatedApiCostUsd) < 1e-5, "the spend stack cannot disagree with the spend bar");
});

test("a bucket folds models outside the legend into the same Other row as the donut", () => {
  const rollup = emptyRollup();
  const day = "2026-08-18";
  rollup.days[day] = {};
  for (let index = 1; index <= 8; index += 1) {
    rollup.days[day][`model-${index}@provider-${index}`] = {
      requests: 1, ok: 1, in: index * 100, out: 0, cached: 0, ms: 1000, okOut: 0, okMs: 0,
    };
  }
  const stats = usageStats(rollup, `${day}T12:00:00.000Z`);
  const bucket = stats.days.at(-1).byModel;

  assert.equal(Object.keys(bucket).length, 7, "six named models plus one bounded Other segment");
  assert.equal(stats.modelLegend.length, 6);
  assert.equal(bucket.__other__.newInput, 300, "the two smallest models are still on the bar");
  assert.equal(Object.values(bucket).reduce((total, row) => total + row.newInput, 0), stats.days.at(-1).newInputTokens);
});

// The rollup is the only record of usage older than about nine days, so the
// arithmetic and the retention both have to hold.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ROLLUP_DAYS,
  emptyRollup,
  foldEvents,
  pruneRollup,
  rollupKey,
  rollupTotals,
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
  assert.equal(rollupTotals(rollup)["deepseek-v4-flash@opencode-go"].requests, 2);
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

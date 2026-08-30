// Thirty-day usage per model, kept as daily sums, plus a bounded rolling
// twenty-four-hour view for the dashboard's 1D chart.
//
// The Models page cannot read this off the event log: usage-events.jsonl
// rotates at 5 MB keeping at most two files, which on a working machine is
// about nine days, and every rotation destroys the older half permanently. So
// the window has to be accumulated forward rather than computed backward -
// whatever is not folded in before a rotation is gone for good. A fresh install
// therefore starts at zero and fills in over the next thirty days.
//
// Sums, not averages. Averaging per-request rates weights a 5-token reply the
// same as a 5,000-token one; tps is total tokens over total time and cache rate
// is total cached over total input, both of which need the sums and neither of
// which can be recovered from a stored average.
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { estimateApiCost } from "./api-pricing.mjs";
import { stateFile } from "./state-dir.mjs";

// No model decodes this fast. A request that claims to have produced tokens
// far above it did not generate them - a canned reply from a stub, a replay,
// or a cached response returned whole. Counting those put
// deepseek-v4-flash@deepseek-official at 1,214 tok/s, which is arithmetic over
// 613 tokens and 505 milliseconds, not a rate anything achieved. The request
// still counts as traffic; only the throughput measure ignores it.
const MAX_PLAUSIBLE_TPS = 400;

export const ROLLUP_DAYS = 30;
export const ROLLUP_HOURS = 24;
// Heat for picker ordering: each day's request total is weighted
// down by how far back it sits, so a model you start using this week rises in
// days instead of having to out-count a month of old traffic. Days use the same
// UTC buckets the rollup prunes, so a fresh re-decay never needs a rescan.
export const POPULARITY_HALF_LIFE_DAYS = 7;
// Bumped when a bucket gains a field: readRollup discards an older shape
// rather than reporting zero for a metric the old buckets never recorded.
// The window refills from the event log, which still holds about nine days.
const ROLLUP_VERSION = 2;

export function usageRollupPath() {
  return stateFile("usage-rollup.json");
}

export function emptyRollup() {
  return { version: ROLLUP_VERSION, lastFoldedAt: "", days: {}, hours: {} };
}

export function readRollup(file = usageRollupPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version !== ROLLUP_VERSION || !parsed.days) return emptyRollup();
    return {
      ...parsed,
      // v2 initially carried only daily buckets. Keep those thirty days and
      // let foldUsageFile backfill this optional bounded view from the event
      // log instead of invalidating the whole rollup on upgrade.
      hours: parsed.hours && typeof parsed.hours === "object" ? parsed.hours : {},
    };
  } catch {
    return emptyRollup();
  }
}

export function writeRollup(file, rollup) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rollup), "utf8");
  renameSync(tmp, file);
  return file;
}

const dayOf = (iso) => String(iso || "").slice(0, 10);
const hourOf = (iso) => {
  const value = String(iso || "");
  return /^\d{4}-\d{2}-\d{2}T\d{2}:/.test(value) ? `${value.slice(0, 13)}:00:00.000Z` : "";
};

// The key is the published slug: two providers can serve a model of the same
// name (deepseek-v4-flash is on both opencode-go and deepseek-official) and
// their usage is not the same usage.
export function rollupKey(event) {
  const model = String(event?.model || "unknown");
  const provider = String(event?.provider || "unknown");
  return model.includes("@") ? model : `${model}@${provider}`;
}

function addEvent(bucket, event) {
  const entry = bucket[rollupKey(event)]
    || { requests: 0, ok: 0, in: 0, out: 0, cached: 0, ms: 0, okOut: 0, okMs: 0 };
  const ok = event.status >= 200 && event.status < 300;
  entry.requests += 1;
  if (ok) entry.ok += 1;
  entry.in += Number(event.inputTokens) || 0;
  entry.out += Number(event.outputTokens) || 0;
  entry.cached += Number(event.cachedTokens) || 0;
  entry.ms += Number(event.durationMs) || 0;
  // Throughput is measured over the requests that produced tokens. A 500 that
  // spent two seconds and wrote nothing is a failure, not slow generation, and
  // counting its time drags the rate of every model that ever errors.
  const outTokens = Number(event.outputTokens) || 0;
  const ms = Number(event.durationMs) || 0;
  const plausible = ms > 0 && outTokens / (ms / 1000) <= MAX_PLAUSIBLE_TPS;
  if (ok && plausible) {
    entry.okOut += Number(event.outputTokens) || 0;
    entry.okMs += Number(event.durationMs) || 0;
  }
  bucket[rollupKey(event)] = entry;
  return bucket;
}

// Both files, every fold. Seeking by byte offset would save perhaps 150 ms on a
// full 10 MB and would have to detect rotation to stay correct; at one fold per
// ten minutes that trade is not worth the bookkeeping. Correctness rests on a
// timestamp filter, which is idempotent, plus the fact that two rotations
// cannot happen inside one interval - 5 MB is about a week of traffic.
export function foldEvents(rollup, lines, { now = "", recordHours = true } = {}) {
  const since = rollup.lastFoldedAt || "";
  rollup.hours = rollup.hours && typeof rollup.hours === "object" ? rollup.hours : {};
  let latest = since;
  let folded = 0;
  for (const line of lines) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = String(event?.at || "");
    if (!at || at <= since) continue;
    const day = dayOf(at);
    rollup.days[day] = addEvent(rollup.days[day] || {}, event);
    const hour = hourOf(at);
    if (recordHours && hour) rollup.hours[hour] = addEvent(rollup.hours[hour] || {}, event);
    if (at > latest) latest = at;
    folded += 1;
  }
  rollup.lastFoldedAt = latest || now || since;
  pruneRollup(rollup, now || latest);
  return { rollup, folded };
}

export function pruneRollup(rollup, nowIso) {
  const days = Object.keys(rollup.days).sort();
  if (days.length) {
    const newest = dayOf(nowIso) || days[days.length - 1];
    const cutoff = new Date(`${newest}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - (ROLLUP_DAYS - 1));
    const oldest = cutoff.toISOString().slice(0, 10);
    for (const day of days) if (day < oldest) delete rollup.days[day];
  }

  rollup.hours = rollup.hours && typeof rollup.hours === "object" ? rollup.hours : {};
  const hours = Object.keys(rollup.hours).sort();
  const newestHour = hourOf(nowIso) || hours.at(-1) || "";
  const newestMs = Date.parse(newestHour);
  if (Number.isFinite(newestMs)) {
    const oldestMs = newestMs - ((ROLLUP_HOURS - 1) * 60 * 60 * 1000);
    for (const hour of hours) {
      const value = Date.parse(hour);
      if (!Number.isFinite(value) || value < oldestMs || value > newestMs) delete rollup.hours[hour];
    }
  }
  return rollup;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Calendar-day distance between two YYYY-MM-DD strings (first later than the
// second). UTC day arithmetic so DST can never shift a bucketed count.
function dayDistance(aDay, bDay) {
  const a = Date.parse(`${aDay}T00:00:00Z`);
  const b = Date.parse(`${bDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((a - b) / DAY_MS));
}

// Read side: sum the retained days into one row per model. This is what the
// page renders, so it stays O(days x models) with no file reading at all.
// `popularity` is the flat thirty-day use total; `heat` is the recency-weighted
// score that ranks models in the picker. Daily buckets retain `requests`, the
// literal count of events recorded on that day.
export function rollupTotals(rollup, now = new Date().toISOString()) {
  const totals = {};
  const today = dayOf(now);
  for (const [day, bucket] of Object.entries(rollup.days || {})) {
    const decay = Math.pow(0.5, dayDistance(today, day) / POPULARITY_HALF_LIFE_DAYS);
    for (const [key, entry] of Object.entries(bucket)) {
      const row = totals[key]
        || { popularity: 0, ok: 0, in: 0, out: 0, cached: 0, ms: 0, okOut: 0, okMs: 0, heat: 0 };
      row.popularity += entry.requests || 0;
      row.heat += (entry.requests || 0) * decay;
      row.ok += entry.ok || 0;
      row.in += entry.in || 0;
      row.out += entry.out || 0;
      row.cached += entry.cached || 0;
      row.ms += entry.ms || 0;
      row.okOut += entry.okOut || 0;
      row.okMs += entry.okMs || 0;
      totals[key] = row;
    }
  }
  for (const row of Object.values(totals)) {
    // The roster HTTP response used `requests` before the 30-day total gained
    // a name. Keep this alias at the boundary for existing dashboard clients;
    // all new internal code reads popularity so it cannot be confused with heat.
    row.requests = row.popularity;
    row.tps = row.okMs > 0 ? row.okOut / (row.okMs / 1000) : 0;
    row.cacheRate = row.in > 0 ? row.cached / row.in : 0;
    row.successRate = row.popularity > 0 ? row.ok / row.popularity : 0;
  }
  return totals;
}

function emptyStatsRow() {
  return {
    in: 0,
    out: 0,
    cached: 0,
    ok: 0,
    okOut: 0,
    okMs: 0,
    estimatedApiCostUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
  };
}

function addStatsRow(target, source = {}) {
  target.in += Number(source.in) || 0;
  target.out += Number(source.out) || 0;
  target.cached += Number(source.cached) || 0;
  target.ok += Number(source.ok) || 0;
  target.okOut += Number(source.okOut) || 0;
  target.okMs += Number(source.okMs) || 0;
  target.estimatedApiCostUsd += Number(source.estimatedApiCostUsd) || 0;
  target.pricedTokens += Number(source.pricedTokens) || 0;
  target.unpricedTokens += Number(source.unpricedTokens) || 0;
  return target;
}

function finishStatsRow(source = {}) {
  const inputTokens = Math.max(0, Number(source.in) || 0);
  const outputTokens = Math.max(0, Number(source.out) || 0);
  const cachedTokens = Math.max(0, Math.min(inputTokens, Number(source.cached) || 0));
  const outputMs = Math.max(0, Number(source.okMs) || 0);
  const pricedTokens = Math.max(0, Number(source.pricedTokens) || 0);
  const unpricedTokens = Math.max(0, Number(source.unpricedTokens) || 0);
  const costTokens = pricedTokens + unpricedTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens,
    newInputTokens: Math.max(0, inputTokens - cachedTokens),
    completedRequests: Math.max(0, Number(source.ok) || 0),
    cacheRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    outputTps: outputMs > 0 ? (Math.max(0, Number(source.okOut) || 0) / (outputMs / 1000)) : 0,
    estimatedApiCostUsd: Math.max(0, Number(source.estimatedApiCostUsd) || 0),
    pricedTokens,
    unpricedTokens,
    costCoverage: costTokens > 0 ? pricedTokens / costTokens : 0,
  };
}

function validUtcDay(value) {
  const day = dayOf(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
    ? day
    : "";
}

function shiftedUtcDay(day, offset) {
  const value = new Date(`${day}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function shiftedUtcHour(now, offset) {
  const value = new Date(now);
  value.setUTCMinutes(0, 0, 0);
  value.setUTCHours(value.getUTCHours() + offset);
  return value.toISOString();
}

function modelParts(key) {
  const split = String(key || "unknown@unknown").lastIndexOf("@");
  return split > 0
    ? { model: key.slice(0, split), provider: key.slice(split + 1) }
    : { model: String(key || "unknown"), provider: "unknown" };
}

function addPricedStatsRow(target, key, source = {}) {
  addStatsRow(target, source);
  const { model, provider } = modelParts(key);
  const cost = estimateApiCost({
    model,
    provider,
    inputTokens: source.in,
    cachedTokens: source.cached,
    outputTokens: source.out,
  });
  target.estimatedApiCostUsd += cost.usd;
  target.pricedTokens += cost.pricedTokens;
  target.unpricedTokens += cost.unpricedTokens;
  return target;
}

function statsModelsForBuckets(buckets, retainedKeys) {
  const byModel = new Map();
  for (const [bucketKey, bucket] of Object.entries(buckets || {})) {
    if (!retainedKeys.has(bucketKey)) continue;
    for (const [key, entry] of Object.entries(bucket || {})) {
      const raw = byModel.get(key) || emptyStatsRow();
      addPricedStatsRow(raw, key, entry);
      byModel.set(key, raw);
    }
  }
  const ranked = [...byModel.entries()]
    .map(([id, raw]) => ({ id, raw, ...modelParts(id), ...finishStatsRow(raw) }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.completedRequests - a.completedRequests || a.id.localeCompare(b.id));
  const models = ranked.slice(0, 6).map(({ raw, ...entry }) => entry);
  if (ranked.length > 6) {
    const raw = emptyStatsRow();
    for (const entry of ranked.slice(6)) addStatsRow(raw, entry.raw);
    models.push({ id: "__other__", model: "", provider: "", ...finishStatsRow(raw) });
  }
  return { models, modelCount: ranked.length };
}

// Aggregate-only dashboard data. The response is deliberately derived from the
// bounded daily/hourly rollup rather than the raw event log, so session/thread
// ids and every other per-request detail stay on disk and never reach the browser.
// `completedRequests` uses the durable success count; incomplete failure
// metering therefore cannot turn into a misleading success-rate claim.
export function usageStats(rollup, now = new Date().toISOString()) {
  const today = validUtcDay(now) || validUtcDay(new Date().toISOString());
  const rawDays = [];
  const days = [];
  for (let offset = -(ROLLUP_DAYS - 1); offset <= 0; offset += 1) {
    const day = shiftedUtcDay(today, offset);
    const raw = emptyStatsRow();
    for (const [key, entry] of Object.entries(rollup?.days?.[day] || {})) addPricedStatsRow(raw, key, entry);
    rawDays.push(raw);
    days.push({ day, ...finishStatsRow(raw) });
  }

  const rawHours = [];
  const hours = [];
  for (let offset = -(ROLLUP_HOURS - 1); offset <= 0; offset += 1) {
    const hour = shiftedUtcHour(now, offset);
    const raw = emptyStatsRow();
    for (const [key, entry] of Object.entries(rollup?.hours?.[hour] || {})) addPricedStatsRow(raw, key, entry);
    rawHours.push(raw);
    hours.push({ hour, ...finishStatsRow(raw) });
  }

  const period = (count) => {
    const raw = emptyStatsRow();
    for (const row of rawDays.slice(-count)) addStatsRow(raw, row);
    return finishStatsRow(raw);
  };

  const hours24 = emptyStatsRow();
  for (const row of rawHours) addStatsRow(hours24, row);

  const modelPeriods = {
    today: statsModelsForBuckets(rollup?.days, new Set(days.slice(-1).map((entry) => entry.day))),
    hours24: statsModelsForBuckets(rollup?.hours, new Set(hours.map((entry) => entry.hour))),
    days7: statsModelsForBuckets(rollup?.days, new Set(days.slice(-7).map((entry) => entry.day))),
    days30: statsModelsForBuckets(rollup?.days, new Set(days.map((entry) => entry.day))),
  };

  return {
    timezone: "UTC",
    windowDays: ROLLUP_DAYS,
    updatedAt: String(rollup?.lastFoldedAt || ""),
    periods: { today: period(1), hours24: finishStatsRow(hours24), days7: period(7), days30: period(ROLLUP_DAYS) },
    days,
    hours,
    modelPeriods,
    // Current clients read these as the thirty-day view. Keep the aliases while
    // the range-aware dashboard rolls out; they carry no extra data.
    models: modelPeriods.days30.models,
    modelCount: modelPeriods.days30.modelCount,
  };
}

function readLines(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

function rebuildRecentHours(lines, now) {
  const hours = {};
  const newestHour = shiftedUtcHour(now, 0);
  const newestMs = Date.parse(newestHour);
  const oldestMs = newestMs - ((ROLLUP_HOURS - 1) * 60 * 60 * 1000);
  for (const line of lines) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const hour = hourOf(event?.at);
    const value = Date.parse(hour);
    if (!hour || !Number.isFinite(value) || value < oldestMs || value > newestMs) continue;
    hours[hour] = addEvent(hours[hour] || {}, event);
  }
  return hours;
}

// The rotated half first: it holds the older events, and foldEvents only cares
// that each line is newer than the last fold, not what order they arrive in.
export function foldUsageFile(rollup, eventsFile, { now = new Date().toISOString() } = {}) {
  const lines = [...readLines(`${eventsFile}.1`), ...readLines(eventsFile)];
  rollup.hours = rollup.hours && typeof rollup.hours === "object" ? rollup.hours : {};
  const needsHourlyBackfill = Object.keys(rollup.hours).length === 0;
  const rebuiltHours = needsHourlyBackfill ? rebuildRecentHours(lines, now) : null;
  const backfilled = rebuiltHours && Object.keys(rebuiltHours).length > 0;
  if (backfilled) rollup.hours = rebuiltHours;
  const result = foldEvents(rollup, lines, { now, recordHours: !backfilled });
  return { ...result, changed: result.folded > 0 || Boolean(backfilled) };
}

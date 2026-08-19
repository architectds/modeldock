// Thirty-day usage per model, kept as daily sums.
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
import { stateFile } from "./state-dir.mjs";

export const ROLLUP_DAYS = 30;
// Bumped when a bucket gains a field: readRollup discards an older shape
// rather than reporting zero for a metric the old buckets never recorded.
// The window refills from the event log, which still holds about nine days.
export const ROLLUP_VERSION = 2;

export function usageRollupPath() {
  return stateFile("usage-rollup.json");
}

export function emptyRollup() {
  return { version: ROLLUP_VERSION, lastFoldedAt: "", days: {} };
}

export function readRollup(file = usageRollupPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version !== ROLLUP_VERSION || !parsed.days) return emptyRollup();
    return parsed;
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
  if (ok) {
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
export function foldEvents(rollup, lines, { now = "" } = {}) {
  const since = rollup.lastFoldedAt || "";
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
    if (at > latest) latest = at;
    folded += 1;
  }
  rollup.lastFoldedAt = latest || now || since;
  pruneRollup(rollup, now || latest);
  return { rollup, folded };
}

export function pruneRollup(rollup, nowIso) {
  const days = Object.keys(rollup.days).sort();
  if (!days.length) return rollup;
  const newest = dayOf(nowIso) || days[days.length - 1];
  const cutoff = new Date(`${newest}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (ROLLUP_DAYS - 1));
  const oldest = cutoff.toISOString().slice(0, 10);
  for (const day of days) if (day < oldest) delete rollup.days[day];
  return rollup;
}

// Read side: sum the retained days into one row per model. This is what the
// page renders, so it stays O(days x models) with no file reading at all.
export function rollupTotals(rollup) {
  const totals = {};
  for (const bucket of Object.values(rollup.days || {})) {
    for (const [key, entry] of Object.entries(bucket)) {
      const row = totals[key]
        || { requests: 0, ok: 0, in: 0, out: 0, cached: 0, ms: 0, okOut: 0, okMs: 0 };
      row.requests += entry.requests || 0;
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
    row.tps = row.okMs > 0 ? row.okOut / (row.okMs / 1000) : 0;
    row.cacheRate = row.in > 0 ? row.cached / row.in : 0;
    row.successRate = row.requests > 0 ? row.ok / row.requests : 0;
  }
  return totals;
}

function readLines(file) {
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

// The rotated half first: it holds the older events, and foldEvents only cares
// that each line is newer than the last fold, not what order they arrive in.
export function foldUsageFile(rollup, eventsFile, { now = new Date().toISOString() } = {}) {
  const lines = [...readLines(`${eventsFile}.1`), ...readLines(eventsFile)];
  return foldEvents(rollup, lines, { now });
}

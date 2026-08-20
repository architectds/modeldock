// The weekly tidy: models nobody has used in thirty days stop crowding the
// picker.
//
// Thirty days is not a guess about attention span, it is the width of the
// usage rollup - so "unused for thirty days" and "unused for as long as we can
// see" are the same sentence, and the rule never has to reason about a gap it
// cannot measure.
//
// Everything here is a reason NOT to park something. That asymmetry is the
// point: a picker missing a model the person wanted is a worse failure than a
// picker with one model too many in it, and the only way back is a page they
// may not know exists.
//
//   never ruled on   a person who has touched the switch has said something
//                    this is not entitled to overrule (see isRuleEligible)
//   not selected     the gateway routes to it; the catalog publishes it anyway
//   not native       native entries come from Codex's own catalog, which is
//                    authoritative for them - they are not ours to withhold
//   known long enough a model added last week has no thirty-day history to be
//                    judged on, only a short one that reads the same as disuse
//   window is full   a fresh install accumulates forward, so before the rollup
//                    spans thirty days every zero means "not yet", not "never"
import { rollupTotals } from "./usage-rollup.mjs";

export const TIDY_WINDOW_DAYS = 30;
// Weekly, and measured from the last run rather than scheduled: the gateway is
// not always running, and a tidy that fired on a calendar day would skip a
// machine that happened to be off that morning.
export const TIDY_EVERY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const asTime = (value) => {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
};

// How many days of history the rollup actually holds. Its buckets are daily and
// keyed by date, so the earliest key is the earliest thing it can answer for.
export function rollupSpanDays(rollup, now = Date.now()) {
  const days = Object.keys(rollup?.days || {}).sort();
  if (!days.length) return 0;
  const earliest = asTime(`${days[0]}T00:00:00Z`);
  if (!earliest) return 0;
  return Math.floor((now - earliest) / DAY_MS);
}

export function shouldTidy({ lastTidyAt, rollup, now = Date.now() }) {
  const span = rollupSpanDays(rollup, now);
  if (span < TIDY_WINDOW_DAYS) {
    return { run: false, reason: "window_incomplete", spanDays: span };
  }
  const last = asTime(lastTidyAt);
  if (last && now - last < TIDY_EVERY_DAYS * DAY_MS) {
    return { run: false, reason: "ran_recently", spanDays: span };
  }
  return { run: true, reason: last ? "due" : "first_run", spanDays: span };
}

// Which models this run would park. Pure: the caller decides what to do with
// the answer, which is what lets the same function back both the decision and
// the preview of it.
export function modelsToPark({
  models,
  rollup,
  toggles = {},
  selected = new Set(),
  firstSeen = {},
  now = Date.now(),
}) {
  const totals = rollupTotals(rollup);
  const parked = [];
  for (const model of models || []) {
    const slug = model?.id || model?.slug;
    if (!slug) continue;
    if (toggles[slug] !== undefined) continue;
    if (selected.has(slug)) continue;
    if (model.native || model.provider === "openai") continue;
    const seen = asTime(firstSeen[slug]);
    // An unstamped model is treated as new. Stamping happens on the same pass
    // that reads this, so the only way to be unstamped is to have just arrived.
    if (!seen || now - seen < TIDY_WINDOW_DAYS * DAY_MS) continue;
    if ((totals[slug]?.requests || 0) > 0) continue;
    parked.push(slug);
  }
  return parked;
}

// Record every model we can currently see, so that the thirty-day clock starts
// when a model appears rather than when the rule first looks at it. Returns the
// updated map and whether anything changed, so a caller can skip a write.
export function stampFirstSeen(firstSeen, models, now = Date.now()) {
  const next = { ...(firstSeen || {}) };
  const iso = new Date(now).toISOString();
  let changed = false;
  const live = new Set();
  for (const model of models || []) {
    const slug = model?.id || model?.slug;
    if (!slug) continue;
    live.add(slug);
    if (!next[slug]) {
      next[slug] = iso;
      changed = true;
    }
  }
  // A model that left the catalog loses its stamp: if it comes back it is new
  // again, and keeping the record would let a model be parked the day it
  // returns on the strength of an absence it spent outside the catalog.
  for (const slug of Object.keys(next)) {
    if (!live.has(slug)) {
      delete next[slug];
      changed = true;
    }
  }
  return { firstSeen: next, changed };
}

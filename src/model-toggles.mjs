// Which published models reach Codex's picker.
//
// The catalog answers "what can this gateway serve"; that is not the same
// question as "what does this person want to choose between". A working
// install publishes thirty-odd models and a person uses four, so the picker
// they scroll on every model switch is mostly models they will never pick.
// This file is the difference: the set they have switched off.
//
// Sparse: a model absent from the file is published, which is what makes a
// newly added model available without an edit here and keeps the file the size
// of the exceptions rather than the size of the catalog.
//
// Only `false` is written. Switching a model back on deletes its entry and
// restarts its thirty-day clock instead of recording `true`, because "I want
// this one back" is not "never judge this one again": an exemption that
// outlives the intent fills the picker with models enabled once and never
// opened. The clock restart is what stops the tidy parking a rescued model a
// week later on its old first-seen date.
//
// Older gateways wrote `true` on re-enable. The startup tidy migrates that
// legacy entry to an absent toggle plus a fresh thirty-day timestamp, so an
// upgrade cannot leave a formerly rescued model permanently exempt.
//
// Kept outside the catalog for the same reason context overrides are: an
// upgrade that ships a new model list cannot discard the choices somebody made
// about it, and clearing a choice restores the shipped behaviour rather than
// some earlier snapshot of it.
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stateFile } from "./state-dir.mjs";

export function modelTogglesPath() {
  return stateFile("model-toggles.json");
}

// Only booleans are meaningful on disk; anything else is a hand edit or an
// older shape and reads as "no opinion" rather than being guessed at.
export function readModelToggles(file = modelTogglesPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [slug, value] of Object.entries(parsed)) {
      if (typeof value === "boolean" && typeof slug === "string" && slug) clean[slug] = value;
    }
    return clean;
  } catch {
    return {};
  }
}

export function writeModelToggles(file, toggles) {
  mkdirSync(path.dirname(file), { recursive: true });
  const off = {};
  for (const [slug, value] of Object.entries(toggles || {})) {
    if (typeof value === "boolean" && slug) off[slug] = value;
  }
  if (!Object.keys(off).length) {
    // An empty file and no file mean the same thing; keep only one of them.
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
    return file;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(off, null, 2), "utf8");
  renameSync(tmp, file);
  return file;
}

// The one question every reader asks. Absence is published, which is why this
// tests for `false` rather than for truthiness: an unknown model is on.
export function isModelPublished(toggles, slug) {
  return (toggles || {})[slug] !== false;
}

// Whether the weekly tidy may decide this model's fate: only models with no
// entry at all. A `false` is already parked; legacy `true` entries are removed
// and restamped before the tidy evaluates the model.
export function isRuleEligible(toggles, slug) {
  return (toggles || {})[slug] === undefined;
}

// Models the gateway is itself pointed at cannot be withheld from the picker.
//
// Switching off the model you are currently routing to would leave Codex
// unable to name the model it is talking to: the request still routes, but the
// picker cannot show it and a model switch away from it is one-way. The
// selection is the stronger statement of intent, so it wins - and the roster
// renders these rows as locked rather than merely refusing the write.
export function selectedModelSlugs(config, subagentModel) {
  const slugs = new Set();
  for (const slug of [config?.mainModel, config?.visionModel, subagentModel]) {
    const value = typeof slug === "string" ? slug.trim() : "";
    if (value) slugs.add(value);
  }
  return slugs;
}

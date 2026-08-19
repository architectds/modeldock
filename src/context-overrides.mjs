// User-set context windows.
//
// Every published figure in the catalog is either measured against the endpoint
// or taken from the model maker's documentation, and neither is the same thing
// as what this endpoint serves today: a host can cap a 1M model at 128K, and a
// vendor can revise a number after we wrote it down. Whoever hits the 400 knows
// more than the table does, so the table has to be correctable without waiting
// for a release.
//
// Overrides live outside the catalog rather than editing it, so an upgrade that
// ships a better default cannot silently discard what somebody measured, and
// clearing one restores the shipped value rather than some earlier guess.
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stateFile } from "./state-dir.mjs";

// Below this a window cannot hold a system prompt plus one exchange; above it
// no model has ever gone, and both ends are far enough out to catch a typo
// (a dropped or an extra zero) without arguing with a real value.
export const MIN_CONTEXT_WINDOW = 4_096;
export const MAX_CONTEXT_WINDOW = 20_000_000;

export function contextOverridesPath() {
  return stateFile("context-overrides.json");
}

export function readContextOverrides(file = contextOverridesPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [id, value] of Object.entries(parsed)) {
      const window = Number(value);
      if (Number.isFinite(window) && window >= MIN_CONTEXT_WINDOW && window <= MAX_CONTEXT_WINDOW) {
        clean[id] = Math.round(window);
      }
    }
    return clean;
  } catch {
    return {};
  }
}

export function writeContextOverrides(file, overrides) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!Object.keys(overrides).length) {
    // An empty file and no file mean the same thing; keep only one of them.
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
    return file;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(overrides, null, 2), "utf8");
  renameSync(tmp, file);
  return file;
}

export function validateContextWindow(value) {
  const window = Number(value);
  if (!Number.isFinite(window) || window <= 0) return { ok: false, message: "A context window must be a positive number of tokens." };
  if (window < MIN_CONTEXT_WINDOW) return { ok: false, message: `A context window below ${MIN_CONTEXT_WINDOW} tokens cannot hold one exchange.` };
  if (window > MAX_CONTEXT_WINDOW) return { ok: false, message: `${window} tokens is larger than any model serves; check for an extra digit.` };
  return { ok: true, value: Math.round(window) };
}

// Stamp the overrides onto the live profile entries.
//
// The shipped figure is remembered on first overwrite, because the catalog is
// a module literal that is edited in place: without a copy, clearing an
// override had nothing to restore and the correction became permanent. This
// pass is therefore idempotent and reversible - call it with the current
// override set and every entry ends up right, whether it gained one, lost one,
// or never had one.
export function applyContextOverrides(profiles, overrides, { publishedSlugFor }) {
  let applied = 0;
  for (const profile of profiles) {
    for (const model of profile.availableModels || []) {
      const slug = publishedSlugFor(profile.id, model.id);
      const window = overrides[slug];
      if (window) {
        if (model.shippedContextWindow === undefined) {
          model.shippedContextWindow = model.contextWindow;
          model.shippedContextSource = model.contextSource || "";
        }
        model.contextWindow = window;
        // Not "vendor": the roster has to show an edited number as edited.
        model.contextSource = "user";
        applied += 1;
      } else if (model.shippedContextWindow !== undefined) {
        model.contextWindow = model.shippedContextWindow;
        model.contextSource = model.shippedContextSource;
        delete model.shippedContextWindow;
        delete model.shippedContextSource;
      }
    }
  }
  return applied;
}

// Bookkeeping the weekly tidy needs and nothing else does: when it last ran,
// and when each model first appeared.
//
// Separate from model-toggles.json because that file is the user's answers and
// this one is the gateway's notes. Mixing them would mean a hand edit of a
// preference could disturb the clock the rule runs on, and a reset of the
// clock could lose a preference.
import { readFileSync } from "node:fs";
import { atomicWriteJsonSync } from "./atomic-file.mjs";
import { stateFile } from "./state-dir.mjs";

const VERSION = 1;

export function modelLifecyclePath() {
  return stateFile("model-lifecycle.json");
}

export function emptyLifecycle() {
  return { version: VERSION, lastTidyAt: "", firstSeen: {} };
}

export function readLifecycle(file = modelLifecyclePath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // A shape from another version is discarded rather than migrated: every
    // field here is re-derivable on the next pass, and the cost of being wrong
    // about a stamp is parking a model that should have been left alone.
    if (parsed?.version !== VERSION) return emptyLifecycle();
    const firstSeen = {};
    for (const [slug, value] of Object.entries(parsed.firstSeen || {})) {
      if (typeof slug === "string" && slug && typeof value === "string" && value) firstSeen[slug] = value;
    }
    return {
      version: VERSION,
      lastTidyAt: typeof parsed.lastTidyAt === "string" ? parsed.lastTidyAt : "",
      firstSeen,
    };
  } catch {
    return emptyLifecycle();
  }
}

export function writeLifecycle(file, lifecycle) {
  atomicWriteJsonSync(file, { ...emptyLifecycle(), ...lifecycle, version: VERSION });
  return file;
}

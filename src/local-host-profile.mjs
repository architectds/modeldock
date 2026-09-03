// Local-host profile transition planning.
//
// Capacity selection belongs to each adapter's measured runtime calculator.
// This module only owns the shared lane limit and the catalog-safe transition
// order; it must not contain a second static capacity calculator.

import { positiveInteger, requiredText as text } from "./local-host-validation.mjs";

export const LOCAL_HOST_MAX_LANES = 3;
export const LOCAL_HOST_MIN_HEADROOM_BYTES = 1 * 1024 ** 3;

function sameProfileIdentity(current, target) {
  return current.adapterId === target.adapterId && current.modelId === target.modelId;
}

// Catalog order is a protocol safety property. A smaller declaration must
// reach Codex before the server becomes smaller; a larger declaration can only
// reach Codex after the larger server is ready. Lane-only changes retain the
// same declared context and therefore never require a catalog mutation.
export function planLocalHostProfileTransition({ current = null, target } = {}) {
  if (!target || typeof target !== "object" || !positiveInteger(target.laneCount, "A target lane count") || !positiveInteger(target.laneContextTokens, "A target lane context")) {
    throw new TypeError("A complete target local host lane profile is required.");
  }
  if (target.laneCount > LOCAL_HOST_MAX_LANES) throw new TypeError(`A local host supports at most ${LOCAL_HOST_MAX_LANES} GPU lanes.`);
  if (!current) {
    return Object.freeze({
      kind: "initial",
      requiresCodexRestart: true,
      steps: Object.freeze(["restart_and_verify_server", "publish_catalog", "require_codex_restart"]),
    });
  }
  if (!sameProfileIdentity(current, target)) throw new TypeError("A local host profile transition must retain adapter and model identity.");
  if (current.laneCount === target.laneCount && current.laneContextTokens === target.laneContextTokens) {
    return Object.freeze({ kind: "none", requiresCodexRestart: false, steps: Object.freeze([]) });
  }
  if (target.laneContextTokens < current.laneContextTokens) {
    return Object.freeze({
      kind: "smaller_context",
      requiresCodexRestart: true,
      steps: Object.freeze(["publish_catalog", "require_codex_restart", "drain", "restart_and_verify_server"]),
    });
  }
  if (target.laneContextTokens > current.laneContextTokens) {
    return Object.freeze({
      kind: "larger_context",
      requiresCodexRestart: true,
      steps: Object.freeze(["drain", "restart_and_verify_server", "publish_catalog", "require_codex_restart"]),
    });
  }
  return Object.freeze({
    kind: "lane_only",
    requiresCodexRestart: false,
    steps: Object.freeze(["drain", "restart_and_verify_server"]),
  });
}

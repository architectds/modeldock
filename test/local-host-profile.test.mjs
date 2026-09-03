import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_HOST_MAX_LANES,
  LOCAL_HOST_MIN_HEADROOM_BYTES,
  planLocalHostProfileTransition,
} from "../src/local-host-profile.mjs";

test("the shared lane limit remains three", () => {
  assert.equal(LOCAL_HOST_MAX_LANES, 3);
  assert.equal(LOCAL_HOST_MIN_HEADROOM_BYTES, 1024 ** 3);
});

test("profile transitions keep the catalog contract safe in both context directions", () => {
  const current = { adapterId: "llamacpp-nvidia", modelId: "qwen3.8:27b", laneCount: 1, laneContextTokens: 262_144 };
  const smaller = { ...current, laneCount: 2, laneContextTokens: 200_000 };
  const larger = { ...current, laneContextTokens: 262_144 };
  assert.deepEqual(planLocalHostProfileTransition({ current, target: smaller }), {
    kind: "smaller_context",
    requiresCodexRestart: true,
    steps: ["publish_catalog", "require_codex_restart", "drain", "restart_and_verify_server"],
  });
  assert.deepEqual(planLocalHostProfileTransition({ current: smaller, target: larger }), {
    kind: "larger_context",
    requiresCodexRestart: true,
    steps: ["drain", "restart_and_verify_server", "publish_catalog", "require_codex_restart"],
  });
  assert.deepEqual(planLocalHostProfileTransition({ current: smaller, target: { ...smaller, laneCount: 3 } }), {
    kind: "lane_only",
    requiresCodexRestart: false,
    steps: ["drain", "restart_and_verify_server"],
  });
});

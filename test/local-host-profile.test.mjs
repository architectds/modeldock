import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_HOST_MAX_LANES,
  LOCAL_HOST_MIN_HEADROOM_BYTES,
  LOCAL_HOST_PREFERRED_HEADROOM_BYTES,
  createLocalHostGpuAllocation,
  createLocalHostProfileInput,
  evaluateLocalHostLaneProfile,
  planLocalHostProfileTransition,
  selectLocalHostLaneProfile,
} from "../src/local-host-profile.mjs";

const GiB = 1024 ** 3;
const BASE = {
  adapterId: "llamacpp-nvidia",
  modelId: "qwen3.8:27b",
  modelMaxContextTokens: 262_144,
  // These are deliberately per-card ledgers. They must not be replaced by
  // summed VRAM or an assumed equal model split.
  gpus: [
    { id: "gpu-0", totalBytes: 16 * GiB, staticBytes: 12 * GiB, kvBytesPerToken: 8 * 1024 },
    { id: "gpu-1", totalBytes: 16 * GiB, staticBytes: 12 * GiB, kvBytesPerToken: 8 * 1024 },
  ],
};

test("static profile selection keeps a 16 GB pair at one long lane when two would drop below 75 percent context", () => {
  const selected = selectLocalHostLaneProfile(BASE);
  assert.equal(selected.laneCount, 1);
  assert.equal(selected.laneContextTokens, 262_144);
  assert.equal(selected.profileId, "static-p1-c262144");
  const two = selected.candidates.find((candidate) => candidate.laneCount === 2);
  assert.equal(two.meetsLongContextFloor, false);
  assert.ok(two.laneContextTokens < two.minimumLongContextTokens);
  assert.ok(two.gpus.every((gpu) => gpu.remainingBytes >= LOCAL_HOST_MIN_HEADROOM_BYTES));
});

test("a 24 GB pair can publish two equal long lanes from static per-GPU allocation", () => {
  const selected = selectLocalHostLaneProfile({
    ...BASE,
    gpus: BASE.gpus.map((gpu) => ({ ...gpu, totalBytes: 24 * GiB, staticBytes: 19 * GiB })),
  });
  assert.equal(selected.laneCount, 2);
  assert.equal(selected.meetsLongContextFloor, true);
  assert.ok(selected.laneContextTokens >= 196_608);
  assert.ok(selected.gpus.every((gpu) => gpu.remainingBytes >= LOCAL_HOST_MIN_HEADROOM_BYTES));
});

test("the planner exposes a three-lane ceiling even when much more VRAM exists", () => {
  const selected = selectLocalHostLaneProfile({
    ...BASE,
    gpus: BASE.gpus.map((gpu) => ({ ...gpu, totalBytes: 64 * GiB, staticBytes: 20 * GiB })),
  });
  assert.equal(LOCAL_HOST_MAX_LANES, 3);
  assert.equal(selected.laneCount, 3);
  assert.equal(selected.laneContextTokens, 262_144);
});

test("preferred headroom is selected when it preserves the long-context floor", () => {
  const input = createLocalHostProfileInput({
    ...BASE,
    gpus: BASE.gpus.map((gpu) => ({ ...gpu, totalBytes: 20 * GiB, staticBytes: 15 * GiB })),
  });
  const profile = evaluateLocalHostLaneProfile(input, 2);
  assert.equal(profile.headroomLevel, "preferred");
  assert.ok(profile.laneContextTokens >= profile.minimumLongContextTokens);
  assert.ok(profile.gpus.every((gpu) => gpu.remainingBytes >= LOCAL_HOST_PREFERRED_HEADROOM_BYTES));
});

test("parallel lanes require preferred headroom instead of riding the WDDM edge", () => {
  const selected = selectLocalHostLaneProfile({
    ...BASE,
    gpus: BASE.gpus.map((gpu) => ({
      ...gpu,
      totalBytes: 20 * GiB,
      staticBytes: Math.round(15.7 * GiB),
    })),
  });
  const two = selected.candidates.find((candidate) => candidate.laneCount === 2);
  assert.ok(two.minimumLaneContextTokens >= two.minimumLongContextTokens, "minimum reserve alone could expose P2");
  assert.ok(two.preferredLaneContextTokens < two.minimumLongContextTokens, "preferred reserve rejects the edge profile");
  assert.equal(selected.laneCount, 1);
  assert.equal(selected.laneContextTokens, 262_144);
});

test("profile inputs reject summed VRAM and malformed allocation facts", () => {
  assert.throws(() => createLocalHostGpuAllocation({ id: "gpu", totalBytes: 10, staticBytes: 10, kvBytesPerToken: 1 }), /leave some VRAM/);
  assert.throws(() => createLocalHostProfileInput({ ...BASE, gpus: [{ ...BASE.gpus[0] }, { ...BASE.gpus[0] }] }), /ids must be unique/);
  assert.throws(() => evaluateLocalHostLaneProfile(BASE, 4), /at most 3/);
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

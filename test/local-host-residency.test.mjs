import assert from "node:assert/strict";
import test from "node:test";
import {
  completeLocalHostResidency,
  createLocalHostResidency,
  leaseLocalHostResidency,
} from "../src/local-host-residency.mjs";
import { kvSessionKey } from "../src/local-host-kv-state.mjs";

const FINGERPRINT = "llama-b10549:qwen-q4:200000:q4_0:q4_0";
const A = kvSessionKey({ conversationId: "a" });
const B = kvSessionKey({ conversationId: "b" });
const C = kvSessionKey({ conversationId: "c" });
const at = (second) => `2026-08-24T13:00:0${second}.000Z`;

function commit(residency, lease, key, success = true, second = 1) {
  return completeLocalHostResidency(lease.residency, {
    slot: lease.slot,
    sessionKey: key,
    fingerprint: FINGERPRINT,
    success,
    at: at(second),
  });
}

test("residency keeps fixed hot lanes and sends new work to an empty lane", () => {
  let residency = createLocalHostResidency({ laneCount: 2 });
  const a = leaseLocalHostResidency(residency, { sessionKey: A, fingerprint: FINGERPRINT, at: at(1) });
  assert.equal(a.kind, "cold");
  assert.equal(a.slot, 0);
  residency = commit(residency, a, A, true, 2);
  const aAgain = leaseLocalHostResidency(residency, { sessionKey: A, fingerprint: FINGERPRINT, at: at(3) });
  assert.equal(aAgain.kind, "gpu");
  residency = commit(residency, aAgain, A, true, 4);
  const b = leaseLocalHostResidency(residency, { sessionKey: B, fingerprint: FINGERPRINT, at: at(5) });
  assert.equal(b.kind, "cold");
  assert.equal(b.slot, 1);
  assert.deepEqual(b.actions.map((entry) => entry.type), ["cold_prefill"]);
});

test("when all lanes are occupied the least-recent inactive state is saved before a restore", () => {
  let residency = createLocalHostResidency({ laneCount: 2, fingerprint: FINGERPRINT, lanes: [
    { slot: 0, state: "hot", sessionKey: A, fingerprint: FINGERPRINT, lastAccessedAt: at(1) },
    { slot: 1, state: "hot", sessionKey: B, fingerprint: FINGERPRINT, lastAccessedAt: at(2) },
  ] });
  const c = leaseLocalHostResidency(residency, { sessionKey: C, fingerprint: FINGERPRINT, hasSsdState: true, at: at(3) });
  assert.equal(c.kind, "ssd");
  assert.equal(c.slot, 0, "the LRU hot session is displaced");
  assert.deepEqual(c.actions.map((entry) => entry.type), ["save_lru_to_ssd", "restore_ssd"]);
  assert.equal(c.actions[0].sessionKey, A);
  residency = commit(residency, c, C, true, 4);
  assert.deepEqual(residency.lanes.map((lane) => lane.sessionKey), [C, B]);
});

test("all active lanes queue instead of evicting a streamed response", () => {
  const residency = createLocalHostResidency({ laneCount: 2, fingerprint: FINGERPRINT, lanes: [
    { slot: 0, state: "active", sessionKey: A, fingerprint: FINGERPRINT, lastAccessedAt: at(1) },
    { slot: 1, state: "active", sessionKey: B, fingerprint: FINGERPRINT, lastAccessedAt: at(2) },
  ] });
  const queued = leaseLocalHostResidency(residency, { sessionKey: C, fingerprint: FINGERPRINT, at: at(3) });
  assert.equal(queued.kind, "queue");
  assert.equal(queued.slot, -1);
  assert.deepEqual(queued.actions, []);
});

test("failed work never leaves a partial GPU state and a fingerprint change never crosses active work", () => {
  const initial = createLocalHostResidency({ laneCount: 1 });
  const leased = leaseLocalHostResidency(initial, { sessionKey: A, fingerprint: FINGERPRINT, at: at(1) });
  const failed = commit(initial, leased, A, false, 2);
  assert.equal(failed.lanes[0].state, "empty");

  const hot = createLocalHostResidency({ laneCount: 1, fingerprint: FINGERPRINT, lanes: [
    { slot: 0, state: "hot", sessionKey: A, fingerprint: FINGERPRINT, lastAccessedAt: at(1) },
  ] });
  const changed = leaseLocalHostResidency(hot, { sessionKey: B, fingerprint: "new-fingerprint", at: at(2) });
  assert.deepEqual(changed.actions.map((entry) => entry.type), ["invalidate_ssd", "erase_slot", "cold_prefill"]);

  const active = leaseLocalHostResidency(initial, { sessionKey: A, fingerprint: FINGERPRINT, at: at(1) }).residency;
  assert.throws(() => leaseLocalHostResidency(active, { sessionKey: B, fingerprint: "new-fingerprint", at: at(2) }), /while a lane is active/);
  assert.throws(() => createLocalHostResidency({ laneCount: 1, fingerprint: FINGERPRINT, lanes: [
    { slot: 0, state: "hot", sessionKey: A, fingerprint: "wrong-fingerprint", lastAccessedAt: at(1) },
  ] }), /must match the residency fingerprint/);
});

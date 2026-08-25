import assert from "node:assert/strict";
import test from "node:test";
import { kvSessionKey } from "../src/local-host-kv-state.mjs";
import { LocalHostKvCoordinator } from "../src/local-host-kv-coordinator.mjs";

const FINGERPRINT = "llama-b10549:qwen-q4:262144:q4_0:q4_0";

function fixture({ laneCount = 1, assignSlots = true } = {}) {
  const calls = [];
  const stored = new Map();
  const store = {
    async has({ sessionKey, fingerprint }) { return stored.get(sessionKey) === fingerprint; },
    async invalidateExcept({ fingerprint }) { calls.push({ action: "invalidate", fingerprint }); return { invalidated: [] }; },
    async save({ sessionKey, fingerprint }) {
      calls.push({ action: "save", sessionKey, fingerprint });
      stored.set(sessionKey, fingerprint);
      return { saved: true };
    },
    async restore({ sessionKey, fingerprint }) {
      calls.push({ action: "restore", sessionKey, fingerprint });
      return stored.get(sessionKey) === fingerprint
        ? { restored: true, restoreMs: 4 }
        : { restored: false, reason: "not_found" };
    },
  };
  const slotClient = { async erase() { calls.push({ action: "erase" }); return { erasedTokens: 1 }; } };
  const diagnostics = [];
  const coordinator = new LocalHostKvCoordinator({
    hostId: "host-qwen",
    laneCount,
    fingerprint: FINGERPRINT,
    store,
    slotClient,
    assignSlots,
    onDiagnostic: (value) => diagnostics.push(value),
  });
  return { calls, stored, diagnostics, coordinator, store, slotClient };
}

test("single-slot coordinator keeps the current conversation hot and restores an exact inactive conversation from SSD", async () => {
  const { coordinator, calls } = fixture();
  const a = { principalId: "local", conversationId: "a" };
  const b = { principalId: "local", conversationId: "b" };
  const seen = [];
  await coordinator.run({ ...a, run: async ({ cache }) => { seen.push(["a1", cache]); return { ok: true }; } });
  await coordinator.run({ ...a, run: async ({ cache }) => { seen.push(["a2", cache]); return { ok: true }; } });
  await coordinator.run({ ...b, run: async ({ cache }) => { seen.push(["b1", cache]); return { ok: true }; } });
  await coordinator.run({ ...a, run: async ({ cache }) => { seen.push(["a3", cache]); return { ok: true }; } });

  assert.deepEqual(seen, [
    ["a1", { tier: "cold" }],
    ["a2", { tier: "gpu" }],
    ["b1", { tier: "cold" }],
    // An SSD hit reports how long the restore took: the dashboard's tier view
    // charges the recovery time to the request that paid it.
    ["a3", { tier: "ssd", restoreMs: 4 }],
  ]);
  const aKey = kvSessionKey(a);
  const bKey = kvSessionKey(b);
  assert.ok(calls.some((call) => call.action === "save" && call.sessionKey === aKey));
  assert.ok(calls.some((call) => call.action === "save" && call.sessionKey === bKey));
  assert.ok(calls.some((call) => call.action === "restore" && call.sessionKey === aKey));
  assert.equal(coordinator.snapshot().activeCount, 0);
  assert.equal(coordinator.snapshot().pendingCount, 0);
  assert.equal(coordinator.snapshot().hotCount, 1);
});

test("restore and save faults degrade only the cache tier, never the user request", async () => {
  const { coordinator, store, diagnostics } = fixture();
  store.has = async () => true;
  store.restore = async () => { throw new Error("slot restore unavailable"); };
  store.save = async () => { throw new Error("slot save unavailable"); };
  const result = await coordinator.run({
    conversationId: "a",
    run: async ({ cache }) => ({ ok: true, cache }),
  });
  assert.deepEqual(result, { ok: true, cache: { tier: "cold" } });
  await coordinator.run({ conversationId: "b", run: async () => ({ ok: true }) });
  assert.ok(diagnostics.some((entry) => entry.kind === "slot_restore_failed"));
  assert.ok(diagnostics.some((entry) => entry.kind === "slot_save_failed"));
});

test("a failed model response clears its resident state before another conversation enters", async () => {
  const { coordinator, calls } = fixture();
  await coordinator.run({ conversationId: "a", run: async () => ({ ok: false }) });
  await coordinator.run({ conversationId: "b", run: async ({ cache }) => {
    assert.deepEqual(cache, { tier: "cold" });
    return { ok: true };
  } });
  assert.equal(calls.some((call) => call.action === "save"), false, "partial A state was never saved");
});

test("a managed restart checkpoints hot conversations before the server stops", async () => {
  const { coordinator, calls } = fixture();
  const session = { principalId: "local", conversationId: "resume-me" };
  await coordinator.run({ ...session, run: async () => ({ ok: true }) });
  const checkpoint = await coordinator.checkpointHotStates();
  assert.deepEqual(checkpoint, { saved: 1, failed: 0 });
  assert.ok(calls.some((call) => call.action === "save" && call.sessionKey === kvSessionKey(session)));
  assert.equal(coordinator.snapshot().hotCount, 1, "checkpointing preserves the running server's hot lane until it is stopped");
});

test("a restart is refused when the SSD budget cannot retain a hot conversation", async () => {
  const { coordinator, store, diagnostics } = fixture();
  await coordinator.run({ conversationId: "too-large", run: async () => ({ ok: true }) });
  store.save = async () => ({ saved: false, reason: "state_exceeds_budget", evicted: [] });
  const checkpoint = await coordinator.checkpointHotStates();
  assert.deepEqual(checkpoint, { saved: 0, failed: 1 });
  assert.ok(diagnostics.some((entry) => entry.kind === "slot_checkpoint_rejected"));
});

test("two managed lanes run concurrently and a third conversation waits automatically", async () => {
  const { coordinator } = fixture({ laneCount: 2 });
  const releases = [];
  const slots = [];
  const run = (conversationId) => coordinator.run({
    conversationId,
    run: async ({ slot }) => new Promise((resolve) => {
      slots.push(slot);
      releases.push(() => resolve({ ok: true }));
    }),
  });
  const a = run("a");
  const b = run("b");
  const c = run("c");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(slots.sort(), [0, 1]);
  assert.equal(coordinator.snapshot().activeCount, 2);
  assert.equal(coordinator.snapshot().pendingCount, 1);
  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slots.length, 3);
  for (const release of releases) release();
  await Promise.all([a, b, c]);
});

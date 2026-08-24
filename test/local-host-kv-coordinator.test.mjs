import assert from "node:assert/strict";
import test from "node:test";
import { kvSessionKey } from "../src/local-host-kv-state.mjs";
import { LocalHostKvCoordinator } from "../src/local-host-kv-coordinator.mjs";

const FINGERPRINT = "llama-b10549:qwen-q4:262144:q4_0:q4_0";

function fixture() {
  const calls = [];
  const stored = new Map();
  const store = {
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
  const coordinator = new LocalHostKvCoordinator({ hostId: "host-qwen", store, slotClient, onDiagnostic: (value) => diagnostics.push(value) });
  return { calls, stored, diagnostics, coordinator, store, slotClient };
}

test("single-slot coordinator keeps the current conversation hot and restores an exact inactive conversation from SSD", async () => {
  const { coordinator, calls } = fixture();
  const a = { principalId: "local", conversationId: "a" };
  const b = { principalId: "local", conversationId: "b" };
  const seen = [];
  await coordinator.run({ ...a, fingerprint: FINGERPRINT, run: async ({ cache }) => { seen.push(["a1", cache]); return { ok: true }; } });
  await coordinator.run({ ...a, fingerprint: FINGERPRINT, run: async ({ cache }) => { seen.push(["a2", cache]); return { ok: true }; } });
  await coordinator.run({ ...b, fingerprint: FINGERPRINT, run: async ({ cache }) => { seen.push(["b1", cache]); return { ok: true }; } });
  await coordinator.run({ ...a, fingerprint: FINGERPRINT, run: async ({ cache }) => { seen.push(["a3", cache]); return { ok: true }; } });

  assert.deepEqual(seen, [
    ["a1", { tier: "cold", reason: "not_found" }],
    ["a2", { tier: "gpu" }],
    ["b1", { tier: "cold", reason: "not_found" }],
    ["a3", { tier: "ssd", restoreMs: 4 }],
  ]);
  const aKey = kvSessionKey(a);
  const bKey = kvSessionKey(b);
  assert.ok(calls.some((call) => call.action === "save" && call.sessionKey === aKey));
  assert.ok(calls.some((call) => call.action === "save" && call.sessionKey === bKey));
  assert.ok(calls.some((call) => call.action === "restore" && call.sessionKey === aKey));
  assert.equal(coordinator.snapshot().activeCount, 0);
  assert.equal(coordinator.snapshot().pendingCount, 0);
  assert.equal(coordinator.snapshot().resident, true);
});

test("restore and save faults degrade only the cache tier, never the user request", async () => {
  const { coordinator, store, diagnostics } = fixture();
  store.restore = async () => { throw new Error("slot restore unavailable"); };
  store.save = async () => { throw new Error("slot save unavailable"); };
  const result = await coordinator.run({
    conversationId: "a",
    fingerprint: FINGERPRINT,
    run: async ({ cache }) => ({ ok: true, cache }),
  });
  assert.deepEqual(result, { ok: true, cache: { tier: "cold", reason: "restore_failed" } });
  await coordinator.run({ conversationId: "b", fingerprint: FINGERPRINT, run: async () => ({ ok: true }) });
  assert.deepEqual(diagnostics.map((entry) => entry.kind).sort(), ["slot_restore_failed", "slot_restore_failed", "slot_save_failed"]);
});

test("a failed model response clears its resident state before another conversation enters", async () => {
  const { coordinator, calls } = fixture();
  await coordinator.run({ conversationId: "a", fingerprint: FINGERPRINT, run: async () => ({ ok: false }) });
  await coordinator.run({ conversationId: "b", fingerprint: FINGERPRINT, run: async ({ cache }) => {
    assert.deepEqual(cache, { tier: "cold", reason: "not_found" });
    return { ok: true };
  } });
  assert.equal(calls.some((call) => call.action === "save"), false, "partial A state was never saved");
});

test("a changed host fingerprint invalidates old SSD states before forwarding work", async () => {
  const { coordinator, calls } = fixture();
  await coordinator.run({ conversationId: "a", fingerprint: FINGERPRINT, run: async () => ({ ok: true }) });
  await coordinator.run({ conversationId: "b", fingerprint: "new-build", run: async ({ cache }) => {
    assert.deepEqual(cache, { tier: "cold", reason: "not_found" });
    return { ok: true };
  } });
  assert.deepEqual(calls.filter((call) => call.action === "invalidate").map((call) => call.fingerprint), [FINGERPRINT, "new-build"]);
});

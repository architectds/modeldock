import assert from "node:assert/strict";
import test from "node:test";
import { kvSessionKey } from "../src/local-host-kv-state.mjs";
import { LocalHostKvCoordinator } from "../src/local-host-kv-coordinator.mjs";

const FINGERPRINT = "llama-b10549:qwen-q4:262144:q4_0:q4_0";

function fixture({ laneCount = 1, assignSlots = true } = {}) {
  const calls = [];
  const stored = new Map();
  const warmBaseKeys = new Map();
  const store = {
    async has({ sessionKey, fingerprint }) { return stored.get(sessionKey) === fingerprint; },
    async lookup({ sessionKey, fingerprint }) {
      return stored.get(sessionKey) === fingerprint ? { warmBaseKey: warmBaseKeys.get(sessionKey) || "" } : null;
    },
    async invalidateExcept({ fingerprint }) { calls.push({ action: "invalidate", fingerprint }); return { invalidated: [] }; },
    async save({ sessionKey, fingerprint, warmBaseKey }) {
      calls.push({ action: "save", sessionKey, fingerprint, ...(warmBaseKey ? { warmBaseKey } : {}) });
      stored.set(sessionKey, fingerprint);
      if (warmBaseKey) warmBaseKeys.set(sessionKey, warmBaseKey);
      else warmBaseKeys.delete(sessionKey);
      return { saved: true };
    },
    async restore({ sessionKey, fingerprint }) {
      calls.push({ action: "restore", sessionKey, fingerprint });
      return stored.get(sessionKey) === fingerprint
        ? { restored: true, restoreMs: 4 }
        : { restored: false, reason: "not_found" };
    },
    async remove({ sessionKey, fingerprint }) {
      calls.push({ action: "remove", sessionKey, fingerprint });
      if (stored.get(sessionKey) !== fingerprint) return { removed: false, removalFailures: [] };
      stored.delete(sessionKey);
      warmBaseKeys.delete(sessionKey);
      return { removed: true, removalFailures: [] };
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
  return { calls, stored, warmBaseKeys, diagnostics, coordinator, store, slotClient };
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

test("a new conversation can seed and reuse an immutable completed warm base without exposing its identity", async () => {
  const { coordinator, calls } = fixture();
  const warmBase = {
    sessionKey: "warm-base-fingerprint",
    async create({ slot }) {
      calls.push({ action: "create_warm_base", slot });
      return true;
    },
  };
  const seen = [];

  await coordinator.run({
    conversationId: "new-a",
    warmBase,
    run: async ({ cache, slot, warmBase: activeWarmBase }) => {
      seen.push({ cache, slot, activeWarmBase });
      return { ok: true };
    },
  });
  await coordinator.run({
    conversationId: "new-b",
    warmBase,
    run: async ({ cache, slot, warmBase: activeWarmBase }) => {
      seen.push({ cache, slot, activeWarmBase });
      return { ok: true };
    },
  });

  assert.equal(calls.filter((call) => call.action === "create_warm_base").length, 1);
  assert.ok(calls.some((call) => call.action === "save" && call.sessionKey === warmBase.sessionKey));
  assert.ok(calls.some((call) => call.action === "restore" && call.sessionKey === warmBase.sessionKey));
  assert.deepEqual(seen.map(({ cache, slot }) => ({ cache, slot })), [
    { cache: { tier: "warm" }, slot: 0 },
    { cache: { tier: "warm", restoreMs: 4 }, slot: 0 },
  ]);
  assert.equal(seen.every(({ activeWarmBase }) => activeWarmBase === warmBase), true);
  assert.equal(coordinator.snapshot().telemetry.events.some((event) => "sessionKey" in event || "conversationId" in event), false);
});

test("a rejected warm-base bootstrap degrades to an ordinary cold request", async () => {
  const { coordinator, calls } = fixture();
  const warmBase = {
    sessionKey: "warm-base-unavailable",
    async create() {
      calls.push({ action: "create_warm_base" });
      return false;
    },
  };
  const result = await coordinator.run({
    conversationId: "cold-safe",
    warmBase,
    run: async ({ cache, warmBase: activeWarmBase }) => ({ ok: true, cache, activeWarmBase }),
  });
  assert.deepEqual(result, { ok: true, cache: { tier: "cold" }, activeWarmBase: null });
  assert.equal(calls.filter((call) => call.action === "create_warm_base").length, 1);
  assert.equal(calls.some((call) => call.action === "save" && call.sessionKey === warmBase.sessionKey), false);
});

test("a changed bootstrap key invalidates a hot conversation before it can reuse a divergent prefix", async () => {
  const { coordinator, calls } = fixture();
  const baseA = { sessionKey: "a".repeat(64), async create() { calls.push({ action: "create_a" }); return true; } };
  const baseB = { sessionKey: "b".repeat(64), async create() { calls.push({ action: "create_b" }); return true; } };
  const seen = [];

  await coordinator.run({
    conversationId: "same-session",
    warmBase: baseA,
    run: async ({ cache, warmBase }) => { seen.push({ cache, warmBase }); return { ok: true }; },
  });
  await coordinator.run({
    conversationId: "same-session",
    warmBase: baseB,
    run: async ({ cache, warmBase }) => { seen.push({ cache, warmBase }); return { ok: true }; },
  });

  assert.equal(calls.some((call) => call.action === "create_a"), true);
  assert.equal(calls.some((call) => call.action === "create_b"), true);
  assert.equal(calls.filter((call) => call.action === "erase").length >= 2, true, "the initial cold lane and the divergent hot lane are erased");
  assert.equal(seen[1].cache.tier, "warm");
  assert.equal(seen[1].warmBase, baseB);
});

test("coordinator exposes bounded content-free lane events and measures cached-work savings from a cold baseline", async () => {
  const { coordinator } = fixture();
  await coordinator.run({
    conversationId: "cold",
    run: async () => ({
      ok: true,
      firstResponseLatencyMs: 2_000,
      usage: { input_tokens: 1_000, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } },
    }),
  });
  await coordinator.run({
    conversationId: "cold",
    run: async () => ({
      ok: true,
      firstResponseLatencyMs: 300,
      usage: { input_tokens: 1_000, output_tokens: 10, input_tokens_details: { cached_tokens: 800 } },
    }),
  });

  const telemetry = coordinator.snapshot().telemetry;
  assert.equal(telemetry.windowMs, 300_000);
  assert.equal(telemetry.totals.inputTokens, 2_000);
  assert.equal(telemetry.totals.cachedTokens, 800);
  assert.equal(telemetry.totals.outputTokens, 20);
  assert.equal(Math.round(telemetry.coldPrefillTps), 500);
  assert.equal(Math.round(telemetry.totals.timeSavedMs), 1_600);
  assert.ok(telemetry.events.some((event) => event.kind === "cold_prefill"));
  assert.ok(telemetry.events.some((event) => event.kind === "running"));
  assert.ok(telemetry.events.some((event) => event.kind === "hot"));
  assert.equal(telemetry.events.some((event) => "sessionKey" in event || "conversationId" in event), false,
    "monitor telemetry never exposes a conversation identity");
});

test("coordinator caps the five-minute swimlane event stream under repeated session switches", async () => {
  const { coordinator } = fixture();
  for (let index = 0; index < 150; index += 1) {
    await coordinator.run({ conversationId: `switch-${index}`, run: async () => ({ ok: true }) });
  }
  const events = coordinator.snapshot().telemetry.events;
  assert.ok(events.length <= 240, `telemetry retained ${events.length} events instead of its fixed cap`);
  assert.equal(events.some((event) => "sessionKey" in event || "conversationId" in event), false);
});

test("restore and save faults degrade only the cache tier, never the user request", async () => {
  const { coordinator, store, diagnostics } = fixture();
  store.has = async () => true;
  store.lookup = async () => ({});
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

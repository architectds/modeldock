import assert from "node:assert/strict";
import test from "node:test";
import { kvSessionKey } from "../src/local-host-kv-state.mjs";
import { LocalHostKvCoordinator } from "../src/local-host-kv-coordinator.mjs";

const FINGERPRINT = "llama-b10549:qwen-q4:262144:q4_0:q4_0";

function fixture({ laneCount = 1, assignSlots = true } = {}) {
  const calls = [];
  const stored = new Map();
  const prefixStates = new Map();
  const warmBaseTranscripts = new Map();
  const store = {
    async has({ sessionKey, fingerprint }) { return stored.get(sessionKey) === fingerprint; },
    async lookup({ sessionKey, fingerprint }) {
      return stored.get(sessionKey) === fingerprint ? {
        ...(prefixStates.has(sessionKey) ? prefixStates.get(sessionKey) : {}),
        ...(warmBaseTranscripts.has(sessionKey) ? { warmBaseTranscript: warmBaseTranscripts.get(sessionKey) } : {}),
      } : null;
    },
    async invalidateExcept({ fingerprint }) { calls.push({ action: "invalidate", fingerprint }); return { invalidated: [] }; },
    async save({ sessionKey, fingerprint, prefixKey, bootstrapInjected = false, warmBaseTranscript }) {
      calls.push({ action: "save", sessionKey, fingerprint, ...(prefixKey ? { prefixKey, bootstrapInjected } : {}), ...(warmBaseTranscript ? { warmBaseTranscript } : {}) });
      stored.set(sessionKey, fingerprint);
      if (prefixKey) prefixStates.set(sessionKey, { prefixKey, bootstrapInjected });
      else prefixStates.delete(sessionKey);
      if (warmBaseTranscript) warmBaseTranscripts.set(sessionKey, warmBaseTranscript);
      else warmBaseTranscripts.delete(sessionKey);
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
      prefixStates.delete(sessionKey);
      warmBaseTranscripts.delete(sessionKey);
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
  return { calls, stored, prefixStates, warmBaseTranscripts, diagnostics, coordinator, store, slotClient };
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

test("a cold-started conversation restores from SSD without injecting a bootstrap it never used", async () => {
  const { coordinator, calls } = fixture();
  const warmBase = {
    sessionKey: "d".repeat(64),
    requiresTranscript: true,
    messages: [{ role: "user", content: "Reply with exactly BOOTSTRAP_READY." }],
    async create() { throw new Error("a user request must not build the missing base"); },
  };
  const seen = [];
  for (const conversationId of ["a", "b", "a"]) {
    await coordinator.run({
      conversationId,
      warmBase,
      run: async ({ cache, warmBase: activeWarmBase }) => {
        seen.push({ conversationId, cache, activeWarmBase });
        return { ok: true };
      },
    });
  }

  assert.deepEqual(seen.map(({ conversationId, cache }) => ({ conversationId, cache })), [
    { conversationId: "a", cache: { tier: "cold" } },
    { conversationId: "b", cache: { tier: "cold" } },
    { conversationId: "a", cache: { tier: "ssd", restoreMs: 4 } },
  ]);
  assert.equal(seen.every(({ activeWarmBase }) => activeWarmBase === null), true,
    "restoring a full cold conversation must not insert a synthetic turn into its history");
  const aKey = kvSessionKey({ conversationId: "a" });
  const savedA = calls.find((call) => call.action === "save" && call.sessionKey === aKey);
  assert.deepEqual(
    { prefixKey: savedA?.prefixKey, bootstrapInjected: savedA?.bootstrapInjected },
    { prefixKey: warmBase.sessionKey, bootstrapInjected: false },
    "the checkpoint separately records prefix identity and bootstrap use",
  );
  assert.equal(calls.some((call) => call.action === "remove" && call.sessionKey === aKey), false,
    "an absent bootstrap marker is not a prefix change");
  assert.equal(calls.some((call) => call.action === "restore" && call.sessionKey === aKey), true);
});

test("managed setup seeds an immutable completed warm base before any user conversation", async () => {
  const { coordinator, calls } = fixture();
  const warmBase = {
    sessionKey: "warm-base-fingerprint",
    async create({ slot }) {
      calls.push({ action: "create_warm_base", slot });
      return true;
    },
  };
  const seen = [];

  const primed = await coordinator.primeWarmBase(warmBase);
  assert.deepEqual(primed, { primed: true, reused: false });

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

  assert.equal(calls.filter((call) => call.action === "create_warm_base").length, 1, "only managed setup creates the base");
  assert.ok(calls.some((call) => call.action === "save" && call.sessionKey === warmBase.sessionKey));
  assert.ok(calls.some((call) => call.action === "restore" && call.sessionKey === warmBase.sessionKey));
  assert.deepEqual(seen.map(({ cache, slot }) => ({ cache, slot })), [
    { cache: { tier: "warm", restoreMs: 4 }, slot: 0 },
    { cache: { tier: "warm", restoreMs: 4 }, slot: 0 },
  ]);
  assert.equal(seen.every(({ activeWarmBase }) => activeWarmBase === warmBase), true);
  assert.equal(coordinator.snapshot().telemetry.events.some((event) => "sessionKey" in event || "conversationId" in event), false);
});

test("a Qwen completed bootstrap retains its exact reasoning across a coordinator restart", async () => {
  const first = fixture();
  const warmBase = {
    sessionKey: "c".repeat(64),
    requiresTranscript: true,
    messages: [{ role: "user", content: "Reply with exactly BOOTSTRAP_READY. Do not call a tool." }],
    async create() {
      return { assistantContent: "BOOTSTRAP_READY", assistantReasoningContent: "I should provide the fixed response." };
    },
  };
  await first.coordinator.primeWarmBase(warmBase);
  let initial;
  await first.coordinator.run({
    conversationId: "first",
    warmBase,
    run: async ({ cache, warmBase: active }) => { initial = { cache, active }; return { ok: true }; },
  });
  assert.equal(initial.cache.tier, "warm");
  assert.equal(initial.active.messages[1].reasoning_content, "I should provide the fixed response.");
  assert.deepEqual(first.warmBaseTranscripts.get(warmBase.sessionKey), {
    assistantContent: "BOOTSTRAP_READY",
    assistantReasoningContent: "I should provide the fixed response.",
  });

  const restarted = new LocalHostKvCoordinator({
    hostId: "host-qwen", laneCount: 1, fingerprint: FINGERPRINT,
    store: first.store, slotClient: first.slotClient, assignSlots: true,
  });
  let restored;
  await restarted.run({
    conversationId: "second",
    warmBase,
    run: async ({ cache, warmBase: active }) => { restored = { cache, active }; return { ok: true }; },
  });
  assert.equal(restored.cache.tier, "warm");
  assert.equal(restored.active.messages[1].content, "BOOTSTRAP_READY");
  assert.equal(restored.active.messages[1].reasoning_content, "I should provide the fixed response.");
});

test("a missing warm base never turns a user's request into a bootstrap job", async () => {
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
  assert.equal(calls.filter((call) => call.action === "create_warm_base").length, 0);
  assert.equal(calls.some((call) => call.action === "save" && call.sessionKey === warmBase.sessionKey), false);
});

test("a changed bootstrap key invalidates a hot conversation before it can reuse a divergent prefix", async () => {
  const { coordinator, calls } = fixture();
  const baseA = { sessionKey: "a".repeat(64), async create() { calls.push({ action: "create_a" }); return true; } };
  const baseB = { sessionKey: "b".repeat(64), async create() { calls.push({ action: "create_b" }); return true; } };
  const seen = [];

  await coordinator.primeWarmBase(baseA);
  await coordinator.primeWarmBase(baseB);

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
      llamaTimings: { cacheTokens: 0, promptTokens: 1_000, promptMs: 2_000, promptTps: 500 },
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
  assert.equal(telemetry.totals.requests, 2);
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

test("llama-managed slots still count every managed-run request", async () => {
  const { coordinator } = fixture({ assignSlots: false });
  await coordinator.run({
    conversationId: "llama-auto",
    run: async ({ cache, slot }) => {
      assert.deepEqual(cache, { tier: "llama_auto" });
      assert.equal(slot, null);
      return {
        ok: true,
        usage: { input_tokens: 400, output_tokens: 20, input_tokens_details: { cached_tokens: 300 } },
        llamaTimings: { cacheTokens: 300, promptTokens: 100, promptMs: 200, promptTps: 500 },
      };
    },
  });
  assert.deepEqual(coordinator.snapshot().telemetry.totals, {
    requests: 1,
    inputTokens: 400,
    cachedTokens: 300,
    outputTokens: 20,
    timeSavedMs: 0,
  });
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

const BOOTSTRAP_TRANSCRIPT = { assistantContent: "BOOTSTRAP_READY" };

test("a prefix with no warm base says so once and still counts every cold turn", async () => {
  const f = fixture();
  // The unreachable base from a previous prefix generation: same host, a key no
  // request will ever ask for again.
  const staleKey = "e".repeat(64);
  f.store.bases = async () => [{ sessionKey: staleKey, bytes: 400 * 1048576, lastAccessedAt: "2026-09-12T04:59:59.853Z" }];
  // Two checkpoints of that gone prefix are still on disk: one bootstrapped, so
  // it is already dead, and one cold-started, which may still restore.
  f.store.orphans = async () => ({
    sessions: 2,
    bytes: 3_600 * 1048576,
    unreachable: 1,
    unreachableBytes: 3_400 * 1048576,
    prefixes: ["a".repeat(64), "b".repeat(64)],
  });
  const warmBase = {
    sessionKey: "d".repeat(64),
    requiresTranscript: true,
    messages: [{ role: "user", content: "Reply with exactly BOOTSTRAP_READY." }],
    async create() { return BOOTSTRAP_TRANSCRIPT; },
  };
  for (const conversationId of ["a", "b"]) {
    await f.coordinator.run({ conversationId, warmBase, run: async () => ({ ok: true }) });
  }
  const notes = f.diagnostics.filter((entry) => entry.kind === "warm_base_missing");
  assert.equal(notes.length, 1, "one line per prefix, not one per new conversation");
  assert.match(notes[0].message, /No warm base for prefix d{12}/);
  assert.match(notes[0].message, new RegExp(`${staleKey.slice(0, 12)} at 401 MiB`), "names what is on disk instead");
  assert.match(notes[0].message, /Orphaned checkpoints: 2 of 3600 MiB for prefixes a{12}, b{12}; 1 can never be restored \(3400 MiB\)\./,
    "says how much of the disk is checkpoint of a prefix that no longer exists");
  assert.equal(f.coordinator.snapshot().counters.warmBaseMissing, 2, "the turns are still counted");
});

test("the warm base diagnostic stays silent about orphans it cannot read", async () => {
  const f = fixture();
  const staleKey = "e".repeat(64);
  f.store.bases = async () => [{ sessionKey: staleKey, bytes: 1048576, lastAccessedAt: "2026-09-12T04:59:59.853Z" }];
  f.store.orphans = async () => { throw new Error("manifest unreadable"); };
  const warmBase = {
    sessionKey: "d".repeat(64),
    requiresTranscript: true,
    messages: [{ role: "user", content: "Reply with exactly BOOTSTRAP_READY." }],
    async create() { return BOOTSTRAP_TRANSCRIPT; },
  };
  await f.coordinator.run({ conversationId: "a", warmBase, run: async () => ({ ok: true }) });
  const notes = f.diagnostics.filter((entry) => entry.kind === "warm_base_missing");
  assert.equal(notes.length, 1, "an unreadable orphan census must not lose the original diagnostic");
  assert.match(notes[0].message, new RegExp(`${staleKey.slice(0, 12)} at 2 MiB`));
  assert.equal(notes[0].message.includes("Orphaned"), false);
  assert.equal(f.coordinator.snapshot().counters.warmBaseMissing, 1);
});

test("per-tier accounting separates a GPU hot hit from an SSD restore", async () => {
  const { coordinator } = fixture();
  const usage = (input, cached) => ({ ok: true, usage: { input_tokens: input, input_tokens_details: { cached_tokens: cached }, output_tokens: 5 } });
  await coordinator.run({ conversationId: "a", run: async () => usage(100, 0) });
  await coordinator.run({ conversationId: "a", run: async () => usage(120, 100) });
  await coordinator.run({ conversationId: "b", run: async () => usage(80, 0) });
  await coordinator.run({ conversationId: "a", run: async () => usage(140, 120) });
  assert.deepEqual(coordinator.snapshot().byTier, {
    cold: { requests: 2, inputTokens: 180, cachedTokens: 0, restoreMs: 0 },
    gpu: { requests: 1, inputTokens: 120, cachedTokens: 100, restoreMs: 0 },
    ssd: { requests: 1, inputTokens: 140, cachedTokens: 120, restoreMs: 4 },
  }, "a big cached-token total is only attributable to the tier that served it");
});

test("priming a base is refused on a route that can never read it back", async () => {
  const { coordinator, calls } = fixture({ laneCount: 2, assignSlots: false });
  const result = await coordinator.primeWarmBase({
    sessionKey: "d".repeat(64),
    async create({ slot }) { calls.push({ action: "create_warm_base", slot }); return BOOTSTRAP_TRANSCRIPT; },
  });
  assert.deepEqual(result, { primed: false, reason: "no_slot_affinity" });
  assert.equal(calls.some((call) => call.action === "create_warm_base"), false,
    "no prefix prefill is paid for a state the request path cannot restore");
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

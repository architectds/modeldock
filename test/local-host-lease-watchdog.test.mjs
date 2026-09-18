// The local host has one lane on the reference machine, so a single admitted
// request that never settles parks every later local request on every
// conversation - the failure actually observed on 2026-09-17, where the lane
// was last touched at 13:34Z, llama.cpp answered a direct request in 2.7 s with
// both GPUs at 0 %, four requests sat in flight, and nothing was logged.
// These tests own the three guarantees that make it survivable: the watchdog
// reclaims a dead lease, an abort reaches an active job, and the queue reports
// who is holding the lane and for how long.
import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { LocalHostScheduler } from "../src/local-host-scheduler.mjs";
import {
  abandonLocalHostResidency,
  completeLocalHostResidency,
  createLocalHostResidency,
  leaseLocalHostResidency,
} from "../src/local-host-residency.mjs";
import { kvSessionKey } from "../src/local-host-kv-state.mjs";
import { LocalHostKvCoordinator } from "../src/local-host-kv-coordinator.mjs";
import { LocalHostRuntime } from "../src/local-host-runtime.mjs";
import { createLocalHostRegistry, upsertLocalHost, writeLocalHostRegistry } from "../src/local-host-registry.mjs";
import { beginHostApply, createObservedHost, markHostApplying, markHostVerified, markHostVerifying, takeOverHost } from "../src/local-hosts.mjs";

const FINGERPRINT = "f".repeat(64);
const keyFor = (id) => kvSessionKey({ principalId: "local", conversationId: id });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function schedulerFixture(overrides = {}) {
  const reclaimed = [];
  const scheduler = new LocalHostScheduler({
    hostId: "host-qwen",
    maxActiveRequests: 1,
    maxLeaseMs: 200,
    stallMs: 60,
    reclaimGraceMs: 10,
    leaseTickMs: 5,
    onLeaseReclaimed: (event) => reclaimed.push(event),
    ...overrides,
  });
  return { scheduler, reclaimed };
}

test("a cancelled active job that ignores its signal loses the lane and the queue moves", async () => {
  const { scheduler, reclaimed } = schedulerFixture();
  const started = [];
  const controller = new AbortController();
  // The zombie: it observes its signal never, and never settles. This is the
  // relay stuck on a stream whose end was never seen.
  const zombie = scheduler.enqueue({
    principalId: "local",
    conversationId: "zombie",
    signal: controller.signal,
    run: () => new Promise(() => {}),
  });
  const next = scheduler.enqueue({
    principalId: "local",
    conversationId: "next",
    run: () => { started.push("next"); return "next-result"; },
  });
  await wait(10);
  assert.deepEqual(started, [], "the second conversation waits while the lane is held");
  controller.abort();
  await assert.rejects(zombie, (error) => error.name === "LocalHostLeaseError" && /cancelled/.test(error.message));
  // Reported twice on purpose: once when the lease was found dead (before the
  // grace), once when the lane actually had to be taken back.
  assert.deepEqual(reclaimed.map((event) => event.forced), [false, true]);
  assert.deepEqual(reclaimed.map((event) => event.reason), ["cancelled", "cancelled"]);
  assert.equal(reclaimed[0].conversationId, "zombie");
  assert.equal(await next, "next-result", "the lane was handed to the waiting conversation");
  assert.deepEqual(started, ["next"]);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.pendingCount, 0);
  assert.equal(snapshot.reclaims.forced, 1);
  assert.equal(snapshot.reclaims.detected, 1);
  assert.equal(snapshot.reclaims.cancelled, 1);
});

test("a stalled job that honours its cancellation keeps its lane and is still reported", async () => {
  const { coordinator, diagnostics } = coordinatorFixture({
    maxLeaseMs: 100_000, stallMs: 40, reclaimGraceMs: 5_000, leaseTickMs: 5,
  });
  // The common case: the relay observes its signal and unwinds. The watchdog
  // must not steal or discard a lane that is being released correctly, but the
  // stall still has to leave a trace in the log.
  const outcome = await coordinator.run({
    conversationId: "polite",
    run: ({ signal, progress }) => new Promise((resolve, reject) => {
      // Report progress first: the stall rule only arms for a stream that has
      // started, and `maxLeaseMs` here is deliberately huge so that the only
      // way this job can be interrupted is the stall rule itself.
      progress();
      signal.addEventListener("abort", () => reject(new Error("cancelled by the lease watchdog")), { once: true });
    }),
  }).then(() => "resolved", (error) => error.message);
  assert.equal(outcome, "cancelled by the lease watchdog");
  assert.ok(diagnostics.some((event) => event.kind === "lane_stalled"), diagnostics.map((event) => event.kind).join(","));
  assert.equal(diagnostics.some((event) => event.kind === "lane_reclaimed"), false, "nothing was stolen");
  assert.equal(coordinator.snapshot().counters.leaseReclaims, 0);
  // The lane is free and reusable, not abandoned.
  const next = await coordinator.run({ conversationId: "polite", run: async () => ({ ok: true }) });
  assert.equal(next.ok, true);
});

test("a wedged job is reclaimed by the absolute lease even when nobody cancels it", async () => {
  const { scheduler, reclaimed } = schedulerFixture({ stallMs: 10_000, maxLeaseMs: 80 });
  const outcome = await scheduler.enqueue({
    principalId: "local",
    conversationId: "wedged",
    run: () => new Promise(() => {}),
  }).then(() => "resolved", (error) => error.name);
  assert.equal(outcome, "LocalHostLeaseError");
  assert.equal(reclaimed[0].reason, "expired");
});

test("a stalled stream is reclaimed by name, and a live stream is never touched", async () => {
  const { scheduler, reclaimed } = schedulerFixture({ stallMs: 40, maxLeaseMs: 100_000 });
  const stalled = scheduler.enqueue({
    principalId: "local",
    conversationId: "stalled",
    run: async ({ progress }) => {
      progress();
      await new Promise(() => {});
    },
  });
  await assert.rejects(stalled, (error) => error.name === "LocalHostLeaseError" && /stalled/.test(error.message));
  assert.equal(reclaimed[0].reason, "stalled");

  // A request that keeps delivering must survive far beyond the stall window:
  // this is what keeps the watchdog from killing a legitimately slow turn.
  let ticks = 0;
  const alive = await scheduler.enqueue({
    principalId: "local",
    conversationId: "alive",
    run: async ({ progress, signal }) => {
      for (let index = 0; index < 12; index += 1) {
        if (signal.aborted) throw new Error("a live stream must not be reclaimed");
        await wait(12);
        ticks += 1;
        progress();
      }
      return "alive-result";
    },
  });
  assert.equal(alive, "alive-result");
  assert.ok(ticks >= 12, "the whole slow stream was delivered");
  assert.equal(scheduler.snapshot().reclaims.forced, 1, "only the stalled job lost its lane");
});

test("the snapshot names the holder of the lane, its age, and whether it is being reclaimed", async () => {
  const { scheduler } = schedulerFixture({ stallMs: 100_000, maxLeaseMs: 100_000 });
  const held = scheduler.enqueue({
    principalId: "local",
    conversationId: "holder",
    run: async ({ progress }) => {
      progress();
      await wait(60);
      return "done";
    },
  });
  const queued = scheduler.enqueue({ principalId: "local", conversationId: "waiter", run: async () => "ok" });
  await wait(15);
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.active[0].principalId, "local");
  assert.equal(snapshot.active[0].conversationId, "holder");
  assert.ok(snapshot.active[0].ageMs >= 10, "the holder reports how long it has owned the lane");
  assert.equal(snapshot.active[0].started, true, "it reported progress at least once");
  assert.equal(snapshot.active[0].reclaiming, false);
  assert.equal(snapshot.pending.length, 1);
  assert.equal(snapshot.pending[0].conversationId, "waiter");
  assert.ok(snapshot.pending[0].ageMs >= 10, "a waiter reports how long it has been parked");
  assert.equal(snapshot.maxLeaseMs, 100_000);
  assert.equal(snapshot.stallMs, 100_000);
  await held;
  await queued;
});

test("a reclaimed job that settles late cannot steal the lane it lost", async () => {
  const { scheduler } = schedulerFixture();
  let releaseZombie;
  const zombie = scheduler.enqueue({
    principalId: "local",
    conversationId: "zombie",
    run: () => new Promise((resolve) => { releaseZombie = resolve; }),
  });
  const first = scheduler.enqueue({ principalId: "local", conversationId: "first", run: async () => "first" });
  await assert.rejects(zombie, { name: "LocalHostLeaseError" });
  assert.equal(await first, "first");
  // The zombie wakes up after its replacement already came and went.
  releaseZombie("late");
  const second = await scheduler.enqueue({ principalId: "local", conversationId: "second", run: async () => "second" });
  assert.equal(second, "second");
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.activeCount, 0);
  assert.equal(snapshot.reclaims.forced, 1, "one reclaim, not two");
});

test("abandoning a lane frees it for the next conversation and is idempotent", () => {
  const start = createLocalHostResidency({ laneCount: 1, fingerprint: FINGERPRINT });
  const leased = leaseLocalHostResidency(start, { sessionKey: keyFor("a"), fingerprint: FINGERPRINT });
  assert.equal(leased.kind, "cold");
  // While it is active, nobody else can be served.
  const blocked = leaseLocalHostResidency(leased.residency, { sessionKey: keyFor("b"), fingerprint: FINGERPRINT });
  assert.equal(blocked.kind, "queue");
  const abandoned = abandonLocalHostResidency(leased.residency, { slot: leased.slot });
  assert.equal(abandoned.lanes[0].state, "empty");
  const served = leaseLocalHostResidency(abandoned, { sessionKey: keyFor("b"), fingerprint: FINGERPRINT });
  assert.equal(served.kind, "cold", "the lane is genuinely back in the pool");
  // Abandoning twice is safe: the second call sees an empty lane and changes
  // nothing, so a reclaim can never destroy somebody else's live lease by
  // accident on a retry.
  const reabandoned = abandonLocalHostResidency(abandoned, { slot: 0 });
  assert.equal(reabandoned.lanes[0].state, "empty");
  assert.deepEqual(reabandoned.lanes[0].sessionKey, "");
  const hot = completeLocalHostResidency(served.residency, {
    slot: served.slot,
    sessionKey: keyFor("b"),
    fingerprint: FINGERPRINT,
    success: true,
  });
  assert.equal(abandonLocalHostResidency(hot, { slot: 0 }).lanes[0].state, "hot", "a hot lane is never dropped");
});

function coordinatorFixture(lease) {
  const calls = [];
  const diagnostics = [];
  // The store and slot client are stand-ins for llama.cpp and the manifest: the
  // subject here is the lease, not the KV wire.
  const store = {
    async has() { return false; },
    async lookup() { return null; },
    async invalidateExcept() { return { invalidated: [] }; },
    async save() { calls.push("save"); return { saved: true }; },
    async restore() { return { restored: false, reason: "not_found" }; },
    async remove() { return { removed: true, removalFailures: [] }; },
  };
  const slotClient = { async erase() { calls.push("erase"); return { erasedTokens: 1 }; } };
  const coordinator = new LocalHostKvCoordinator({
    hostId: "host-qwen",
    laneCount: 1,
    fingerprint: FINGERPRINT,
    store,
    slotClient,
    onDiagnostic: (event) => diagnostics.push(event),
    ...(lease ? { lease } : {}),
  });
  return { coordinator, calls, diagnostics };
}

test("a relay that never returns does not park the local host: the next conversation is served", async () => {
  const { coordinator, calls, diagnostics } = coordinatorFixture({
    maxLeaseMs: 120, stallMs: 10_000, reclaimGraceMs: 10, leaseTickMs: 5,
  });
  // Today's exact transition: the engine finished, the relay never noticed, and
  // the request held the only lane forever.
  const zombie = coordinator.run({
    conversationId: "wedged-session",
    run: () => new Promise(() => {}),
  });
  const other = coordinator.run({
    conversationId: "other-session",
    run: async () => ({ ok: true }),
  });
  await assert.rejects(zombie, { name: "LocalHostLeaseError" });
  const served = await other;
  assert.equal(served.ok, true, "a different conversation was served after the reclaim");
  assert.equal(coordinator.snapshot().hotCount, 1, "the survivor owns the lane");
  assert.equal(coordinator.snapshot().counters.leaseReclaims, 1);
  assert.ok(coordinator.snapshot().reclaims.forced >= 1);
  assert.ok(diagnostics.some((event) => event.kind === "lane_reclaimed"), "the reclaim is logged, not silent");
  assert.ok(calls.includes("erase"), "the reclaimed slot's KV was discarded");
  // The wedged conversation can come back and work again afterwards.
  const retried = await coordinator.run({ conversationId: "wedged-session", run: async () => ({ ok: true }) });
  assert.equal(retried.ok, true);
});

test("a late completion after a reclaim is discarded and reported, never thrown", async () => {
  const { coordinator, diagnostics } = coordinatorFixture({
    maxLeaseMs: 100, stallMs: 10_000, reclaimGraceMs: 10, leaseTickMs: 5,
  });
  let releaseZombie;
  const zombie = coordinator.run({
    conversationId: "slow-relay",
    run: () => new Promise((resolve) => { releaseZombie = resolve; }),
  });
  await assert.rejects(zombie, { name: "LocalHostLeaseError" });
  await coordinator.run({ conversationId: "occupant", run: async () => ({ ok: true }) });
  // The abandoned relay finally returns; it must not evict the new occupant.
  releaseZombie({ ok: true });
  await wait(40);
  assert.equal(coordinator.snapshot().hotCount, 1);
  assert.ok(
    diagnostics.some((event) => event.kind === "late_completion_discarded"),
    diagnostics.map((event) => event.kind).join(","),
  );
  assert.equal(coordinator.snapshot().lanes[0].state, "hot");
});

// D: the whole point of the ages is that they reach the operator's status
// payload. This asserts the passthrough chain (scheduler -> coordinator ->
// runtime -> /api/status) rather than trusting that each layer forwards it.
//
// It also asserts the queue itself, because the same fixture caught a worse
// fault: two requests arriving before the lazy first load each built their own
// coordinator - and a coordinator owns its scheduler - so one lane really did
// admit two conversations at once while the status payload named neither.
test("the status payload names the lane holder, its age, and the watchdog settings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-lease-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryFile = path.join(root, "local-hosts.json");
  const endpoint = "http://127.0.0.1:9998/v1";
  const launch = { binary: "D:/llama/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] };
  let record = takeOverHost(createObservedHost({
    id: "llamacpp-11435",
    adapterId: "llamacpp-nvidia",
    endpoint,
    launch,
  }), { kvState: { directory: path.join(root, "states"), budgetBytes: 4 * 1024 ** 3 } });
  record = markHostVerified(record);
  const profile = {
    adapterId: "llamacpp-nvidia",
    modelId: "qwen",
    profileId: "static-p1-c262144",
    laneCount: 1,
    laneContextTokens: 262_144,
    totalContextTokens: 262_144,
  };
  record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
  record = markHostApplying(record);
  record = markHostVerifying(record);
  record = markHostVerified(record);
  await writeLocalHostRegistry(registryFile, upsertLocalHost(createLocalHostRegistry(), record));
  const runtime = new LocalHostRuntime({
    registryFile,
    manifestDirectory: path.join(root, "manifests"),
    fetchImpl: async () => new Response(JSON.stringify({ n_erased: 0 }), { status: 200 }),
  });
  // Nothing is managed until the first request builds the coordinator, so the
  // idle payload reports no holder and no watchdog limits.
  assert.equal(runtime.snapshot().lease.active.length, 0);
  assert.equal(runtime.snapshot().lease.maxLeaseMs, 0);

  const held = runtime.run({
    sessionId: "status-holder",
    run: ({ progress }) => new Promise((resolve) => {
      progress();
      setTimeout(resolve, 120);
    }),
  });
  const queued = runtime.run({ sessionId: "status-waiter", run: async () => "waited" });
  // The first request builds the coordinator lazily off the registry, so poll
  // for the holder instead of assuming how long that took.
  let lease = runtime.snapshot().lease;
  for (let attempt = 0; attempt < 60 && lease.active.length < 1; attempt += 1) {
    await wait(25);
    lease = runtime.snapshot().lease;
  }
  assert.equal(lease.active.length, 1, "the holder is named");
  assert.ok(lease.maxLeaseMs > 0 && lease.stallMs > 0, "the watchdog's own limits are reported");
  assert.equal(lease.active[0].conversationId, "status-holder");
  assert.equal(lease.active[0].started, true);
  assert.ok(lease.active[0].ageMs > 0, `expected an age, got ${lease.active[0].ageMs}`);
  assert.ok(Number.isSafeInteger(lease.active[0].quietMs), "the silence since the last stream event is reported");
  assert.deepEqual(lease.pending.map((job) => job.conversationId), ["status-waiter"]);
  assert.ok(lease.pending[0].ageMs > 0, "a waiter's park time is reported");
  await held;
  assert.equal(await queued, "waited");
});

test("racing first requests share one admission queue instead of double-booking the lane", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-lease-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryFile = path.join(root, "local-hosts.json");
  const launch = { binary: "D:/llama/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] };
  let record = takeOverHost(createObservedHost({
    id: "llamacpp-11435",
    adapterId: "llamacpp-nvidia",
    endpoint: "http://127.0.0.1:9997/v1",
    launch,
  }), { kvState: { directory: path.join(root, "states"), budgetBytes: 4 * 1024 ** 3 } });
  record = markHostVerified(record);
  const profile = {
    adapterId: "llamacpp-nvidia",
    modelId: "qwen",
    profileId: "static-p1-c262144",
    laneCount: 1,
    laneContextTokens: 262_144,
    totalContextTokens: 262_144,
  };
  record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
  record = markHostApplying(record);
  record = markHostVerifying(record);
  record = markHostVerified(record);
  await writeLocalHostRegistry(registryFile, upsertLocalHost(createLocalHostRegistry(), record));
  const runtime = new LocalHostRuntime({
    registryFile,
    manifestDirectory: path.join(root, "manifests"),
    fetchImpl: async () => new Response(JSON.stringify({ n_erased: 0 }), { status: 200 }),
  });

  // All three are issued while nothing is loaded yet, which is the exact window
  // Codex threads reopening together after a gateway restart fall into.
  let inFlight = 0;
  let peak = 0;
  const order = [];
  const start = (sessionId) => runtime.run({
    sessionId,
    run: async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      order.push(sessionId);
      await wait(80);
      inFlight -= 1;
      return { ok: true };
    },
  });
  const all = await Promise.all([start("race-a"), start("race-b"), start("race-c")]);
  assert.equal(all.length, 3, "all three were served");
  // One lane means one at a time. Before the lazy load was made single-flight,
  // each racing request built its own coordinator - and therefore its own
  // scheduler - and two of these ran on the llama slot at the same instant.
  assert.equal(peak, 1, `a single-lane host admitted ${peak} concurrent requests`);
  assert.deepEqual(order, ["race-a", "race-b", "race-c"], "the queue stays FIFO");
  assert.equal(runtime.snapshot().activeCount, 0, "the queue drained");
  assert.equal(runtime.snapshot().lease.active.length, 0);
});

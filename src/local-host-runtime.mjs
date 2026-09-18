// Live bridge from a durable managed-host record to the llama.cpp request path.
// The gateway can restart independently of llama-server: the first local turn
// lazily rebuilds this coordinator from local-hosts.json and the SSD manifest.

import path from "node:path";
import { createHash } from "node:crypto";
import { LlamaCppSlotStateClient } from "./llamacpp-slot-state.mjs";
import { LocalHostKvStateStore } from "./local-host-kv-store.mjs";
import { LocalHostKvCoordinator } from "./local-host-kv-coordinator.mjs";
import { readLocalHostRegistry } from "./local-host-registry.mjs";

function fingerprintFor(record) {
  return createHash("sha256").update(JSON.stringify({
    adapterId: record.adapterId,
    endpoint: record.endpoint,
    activeSpec: record.activeSpec,
    activeProfile: record.activeProfile,
    // New local sessions inject a completed synthetic bootstrap turn before
    // their first user message. Include this protocol in the fingerprint so
    // checkpoints made by an older gateway are cold-started once, never replayed
    // against a different Chat prefix.
    localChatWarmBootstrapVersion: 1,
    verifiedHost: {
      binaryBytes: record.capabilities?.verifiedBinaryBytes || 0,
      binaryMtimeMs: record.capabilities?.verifiedBinaryMtimeMs || 0,
      modelBytes: record.capabilities?.verifiedModelBytes || 0,
      modelMtimeMs: record.capabilities?.verifiedModelMtimeMs || 0,
      build: record.capabilities?.verifiedBuild || "",
    },
  })).digest("hex");
}

function dispatchableRecord(registry) {
  return Object.values(registry?.hosts || {}).find((record) => (
    record.adapterId === "llamacpp-nvidia"
      && record.state === "ready"
      && record.activeSpec
      && record.activeProfile?.laneCount
      && record.kvState
  )) || null;
}

// The lease watchdog defaults are sized for a real 27B turn on a consumer
// desktop, which is far longer than anything a test can wait for, and a support
// engineer diagnosing a "local model stopped answering" report needs to be able
// to prove the reclaim fires without editing source. Unset means the defaults.
function leaseOverrides(env) {
  const read = (name, key) => {
    const raw = String(env[`MODELDOCK_LOCAL_${name}`] ?? "").trim();
    if (!raw) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? { [key]: value } : null;
  };
  return Object.assign({}, read("LEASE_MS", "maxLeaseMs"), read("STALL_MS", "stallMs"), read("LEASE_TICK_MS", "leaseTickMs"));
}

export class LocalHostRuntime {
  #loaded = false;
  #record = null;
  #coordinator = null;
  #transition = null;
  #restartPreparation = null;
  #refreshing = null;
  #requestControllers = new Set();

  constructor({ registryFile, manifestDirectory, fetchImpl = fetch, onDiagnostic = () => {} } = {}) {
    if (!registryFile || !manifestDirectory) throw new TypeError("Local host runtime paths are required.");
    this.registryFile = registryFile;
    this.manifestDirectory = manifestDirectory;
    this.fetch = fetchImpl;
    this.onDiagnostic = onDiagnostic;
    this.lease = leaseOverrides(globalThis.process?.env || {});
  }

  async #build(record) {
    if (!record) {
      this.#record = null;
      this.#coordinator = null;
      return;
    }
    const fingerprint = fingerprintFor(record);
    const slotClient = new LlamaCppSlotStateClient({ baseUrl: record.endpoint, fetchImpl: this.fetch });
    const store = new LocalHostKvStateStore({
      hostId: record.id,
      storage: record.kvState,
      manifestFile: path.join(this.manifestDirectory, `${record.id}.json`),
      slotClient,
    });
    this.#record = record;
    this.#coordinator = new LocalHostKvCoordinator({
      hostId: record.id,
      laneCount: record.activeProfile.laneCount,
      fingerprint,
      store,
      slotClient,
      assignSlots: record.activeProfile.laneCount === 1 || record.capabilities?.requestSlotAffinity === true,
      onDiagnostic: this.onDiagnostic,
      ...(this.lease && Object.keys(this.lease).length ? { lease: this.lease } : {}),
    });
  }

  async refresh(record = undefined) {
    // One build at a time: two requests racing the first lazy refresh after
    // boot each constructed their own coordinator over the same slots and
    // manifest - double-booked residency and racing manifest writes. Explicit
    // refreshes queue behind the in-flight one and then run, so a takeover's
    // deliberate rebuild is never swallowed by a concurrent lazy load.
    while (this.#refreshing) await this.#refreshing.catch(() => {});
    // ...and a lazy refresh must never rebuild what it just waited for. Each
    // coordinator owns its own scheduler, so two of them over one llama.cpp
    // host means two independent admission queues: two Codex conversations were
    // measured starting their turns at the same instant on a profile with a
    // single lane, and the status payload - read from whichever coordinator was
    // installed last - reported no active request at all. Only an explicit
    // record asks for a rebuild.
    if (record === undefined && this.#loaded && this.#coordinator) return this.snapshot();
    const work = (async () => {
      let selected = null;
      if (record === undefined) {
        // A corrupt registry must degrade this host to unmanaged, not fail
        // every local relay turn until the file is repaired by hand.
        try {
          selected = dispatchableRecord(await readLocalHostRegistry(this.registryFile));
        } catch (error) {
          try {
            await this.onDiagnostic({ kind: "registry_unreadable", message: String(error?.message || error) });
          } catch {
            // Diagnostics must not prevent the degrade.
          }
        }
      } else {
        // An explicit record gets the same dispatchability bar as a scanned
        // one: installing a coordinator for a degraded or recovered record
        // would lane-schedule requests against a host that failed
        // verification.
        selected = dispatchableRecord({ hosts: record ? { [record.id]: record } : {} });
      }
      await this.#build(selected);
      this.#loaded = true;
      return this.snapshot();
    })();
    this.#refreshing = work;
    try {
      return await work;
    } finally {
      if (this.#refreshing === work) this.#refreshing = null;
    }
  }

  invalidate() {
    this.releaseGatewayRestartPreparation();
    this.#loaded = false;
    this.#record = null;
    this.#coordinator = null;
  }

  snapshot() {
    const live = this.#coordinator?.snapshot() || {};
    return Object.freeze({
      managed: Boolean(this.#record),
      hostId: this.#record?.id || "",
      profile: this.#record?.activeProfile || null,
      maxActiveRequests: live.maxActiveRequests || 0,
      activeCount: live.activeCount || 0,
      pendingCount: live.pendingCount || 0,
      hotCount: live.hotCount || 0,
      slotAffinity: Boolean(live.slotAffinity),
      // `sessionKey` is the opaque KV digest, never a raw conversation id. It is
      // what lets an operator answer the only question that matters during a
      // switch: *which* conversation owns the GPU slot right now - the one that
      // was reclaimed or the one that took its place.
      lanes: (live.lanes || []).map((lane) => ({
        slot: lane.slot,
        state: lane.state,
        sessionKey: lane.sessionKey || "",
        lastAccessedAt: lane.lastAccessedAt,
      })),
      ssd: live.ssd || null,
      counters: live.counters || null,
      telemetry: live.telemetry || null,
      // Who is holding the single lane, and for how long. A count alone cannot
      // tell "one request in flight" apart from "one request has been parked
      // behind a zombie lease for hours", which is exactly the state that was
      // undiagnosable from the outside.
      lease: Object.freeze({
        maxLeaseMs: live.maxLeaseMs || 0,
        stallMs: live.stallMs || 0,
        reclaims: live.reclaims || null,
        active: Object.freeze((live.active || []).map((job) => ({
          conversationId: job.conversationId,
          ageMs: job.ageMs,
          quietMs: job.quietMs,
          started: job.started,
          reclaiming: job.reclaiming,
          reclaimReason: job.reclaimReason,
        }))),
        pending: Object.freeze((live.pending || []).map((job) => ({
          conversationId: job.conversationId,
          ageMs: job.ageMs,
        }))),
      }),
    });
  }

  // Dashboard "Clear SSD cache": delegates to the coordinator's exclusive
  // lock so it cannot race an in-flight save. No coordinator means nothing
  // is managed and there is nothing this runtime owns to clear.
  async clearKvStates() {
    if (!this.#loaded) await this.refresh();
    if (!this.#coordinator || typeof this.#coordinator.clearSsdStates !== "function") return null;
    return this.#coordinator.clearSsdStates();
  }

  async checkpointHotStates() {
    if (!this.#loaded) await this.refresh();
    if (!this.#coordinator || typeof this.#coordinator.checkpointHotStates !== "function") return { saved: 0, failed: 0 };
    return this.#coordinator.checkpointHotStates();
  }

  async primeWarmBase(warmBase, { signal } = {}) {
    if (!this.#loaded) await this.refresh();
    if (!this.#coordinator || typeof this.#coordinator.primeWarmBase !== "function") {
      return { primed: false, reason: "unmanaged" };
    }
    return this.#coordinator.primeWarmBase(warmBase, { signal });
  }

  // Restart means stop now, not wait for an unbounded local generation. Close
  // admission first, cancel every admitted/waiting request, and give abort a
  // short opportunity to release its lane. Only completed hot lanes are safe
  // to checkpoint: an active lane can contain assistant tokens the Codex
  // client never received, so persisting it would corrupt a later retry.
  async prepareGatewayRestart({ timeoutMs = 3_000, holdMs = 45_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("A positive restart checkpoint timeout is required.");
    if (!Number.isSafeInteger(holdMs) || holdMs <= 0) throw new TypeError("A positive restart checkpoint hold is required.");
    if (this.#restartPreparation) return { ...this.#restartPreparation.result, alreadyPrepared: true };
    if (!this.#loaded) await this.refresh();
    if (!this.#coordinator) return { managed: false, saved: 0, failed: 0, holdMs: 0 };

    const releaseTransition = this.beginTransition();
    try {
      const interrupted = this.#requestControllers.size;
      for (const controller of this.#requestControllers) {
        controller.abort(new Error("Local model request interrupted by ModelDock restart."));
      }
      const idle = await this.drain({ timeoutMs });
      // If an upstream ignores cancellation, the outer restart still proceeds.
      // Do not enter the coordinator mutation lock behind a stuck request.
      const checkpoint = idle ? await this.checkpointHotStates() : { saved: 0, failed: 0 };
      const result = Object.freeze({
        managed: true,
        saved: checkpoint.saved,
        failed: checkpoint.failed,
        interrupted,
        idle,
        holdMs,
      });
      const release = () => {
        const preparation = this.#restartPreparation;
        if (!preparation) return false;
        this.#restartPreparation = null;
        clearTimeout(preparation.timer);
        releaseTransition();
        return true;
      };
      const timer = setTimeout(release, holdMs);
      timer.unref?.();
      this.#restartPreparation = { result, timer, release };
      return result;
    } catch (error) {
      releaseTransition();
      throw error;
    }
  }

  // A failed outer stop (for example an elevation mismatch on Windows) must
  // not leave local work paused for the full handoff timer. The restart script
  // calls this best-effort endpoint before it reports that the old gateway is
  // still serving.
  releaseGatewayRestartPreparation() {
    if (!this.#restartPreparation) return false;
    return this.#restartPreparation.release();
  }

  async status() {
    if (!this.#loaded) await this.refresh();
    return this.snapshot();
  }

  beginTransition() {
    if (this.#transition) throw new Error("A local host transition is already running.");
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    this.#transition = promise;
    return () => {
      if (this.#transition === promise) this.#transition = null;
      release();
    };
  }

  async drain({ timeoutMs = 120_000 } = {}) {
    if (!this.#loaded) await this.refresh();
    if (!this.#coordinator) return true;
    return this.#coordinator.waitForIdle({ timeoutMs });
  }

  async run({ sessionId, threadId, signal, warmBase = null, run } = {}) {
    if (typeof run !== "function") throw new TypeError("A local host runtime request needs a run function.");
    // Refresh can yield for disk IO. Recheck the transition barrier afterward
    // so a first request cannot slip between a takeover's admission close and
    // its drain snapshot.
    while (this.#transition) await this.#transition;
    if (!this.#loaded) await this.refresh();
    while (this.#transition) await this.#transition;
    const conversationId = String(sessionId || threadId || "").trim();
    if (!this.#coordinator || !conversationId) return run({ cache: { tier: "unmanaged" }, slot: null });
    const controller = new AbortController();
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    this.#requestControllers.add(controller);
    try {
      return await this.#coordinator.run({
        principalId: "local",
        conversationId,
        signal: requestSignal,
        warmBase,
        // The coordinator composes the caller's signal with the scheduler's lease
        // controller and forwards both the result and the progress callback, so
        // the relay can be cancelled by a disconnect *or* a reclaimed lease.
        run: (context = {}) => run(context),
      });
    } finally {
      this.#requestControllers.delete(controller);
    }
  }
}

export { fingerprintFor as localHostFingerprint };

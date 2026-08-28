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

export class LocalHostRuntime {
  #loaded = false;
  #record = null;
  #coordinator = null;
  #transition = null;
  #restartPreparation = null;
  #refreshing = null;

  constructor({ registryFile, manifestDirectory, fetchImpl = fetch, onDiagnostic = () => {} } = {}) {
    if (!registryFile || !manifestDirectory) throw new TypeError("Local host runtime paths are required.");
    this.registryFile = registryFile;
    this.manifestDirectory = manifestDirectory;
    this.fetch = fetchImpl;
    this.onDiagnostic = onDiagnostic;
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
    });
  }

  async refresh(record = undefined) {
    // One build at a time: two requests racing the first lazy refresh after
    // boot each constructed their own coordinator over the same slots and
    // manifest - double-booked residency and racing manifest writes. Explicit
    // refreshes queue behind the in-flight one and then run, so a takeover's
    // deliberate rebuild is never swallowed by a concurrent lazy load.
    while (this.#refreshing) await this.#refreshing.catch(() => {});
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
      lanes: (live.lanes || []).map((lane) => ({ slot: lane.slot, state: lane.state, lastAccessedAt: lane.lastAccessedAt })),
      ssd: live.ssd || null,
      counters: live.counters || null,
      telemetry: live.telemetry || null,
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

  // The outer gateway restart script cannot safely infer which Codex session
  // owns which llama.cpp slot. It asks the live runtime to close admission,
  // drain the already admitted turn, then checkpoint every hot lane while
  // that mapping still exists. Admission stays closed briefly so a request
  // cannot slip in between the checkpoint and the script stopping Node.
  async prepareGatewayRestart({ timeoutMs = 120_000, holdMs = 45_000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("A positive restart checkpoint timeout is required.");
    if (!Number.isSafeInteger(holdMs) || holdMs <= 0) throw new TypeError("A positive restart checkpoint hold is required.");
    if (this.#restartPreparation) return { ...this.#restartPreparation.result, alreadyPrepared: true };
    if (!this.#loaded) await this.refresh();
    if (!this.#coordinator) return { managed: false, saved: 0, failed: 0, holdMs: 0 };

    const releaseTransition = this.beginTransition();
    try {
      const idle = await this.drain({ timeoutMs });
      if (!idle) throw new Error("Timed out waiting for local model requests to finish before restart.");
      const checkpoint = await this.checkpointHotStates();
      if (checkpoint.failed) throw new Error("Could not checkpoint active local conversations before restart.");
      const result = Object.freeze({
        managed: true,
        saved: checkpoint.saved,
        failed: checkpoint.failed,
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
    return this.#coordinator.run({ principalId: "local", conversationId, signal, warmBase, run });
  }
}

export { fingerprintFor as localHostFingerprint };

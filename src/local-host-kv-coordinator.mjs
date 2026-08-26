// Managed llama.cpp conversation coordination.
//
// Codex keeps the authoritative conversation JSON. This layer owns only which
// fixed llama slot is hot, whether an inactive slot has an SSD checkpoint, and
// fair admission when more conversations are active than the selected profile
// can serve. A cache fault always degrades to a complete cold prefill.

import { kvSessionKey } from "./local-host-kv-state.mjs";
import { LocalHostScheduler } from "./local-host-scheduler.mjs";
import {
  completeLocalHostResidency,
  createLocalHostResidency,
  leaseLocalHostResidency,
} from "./local-host-residency.mjs";

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function noOp() {}

function diagnosticMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown KV state error.");
}

const TELEMETRY_WINDOW_MS = 300_000;
const TELEMETRY_EVENT_LIMIT = 240;
const COLD_PREFILL_SAMPLE_LIMIT = 8;
const MIN_COLD_PREFILL_TOKENS = 256;

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function median(values) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

export class LocalHostKvCoordinator {
  #residency;
  #mutation = Promise.resolve();
  #validatedFingerprint = false;
  // Lifetime tallies for the local dashboard: what the SSD cache is actually
  // doing, counted where the actions happen instead of re-derived from logs.
  #counters = { saves: 0, restores: 0, coldPrefills: 0, evictions: 0, expired: 0, cleared: 0 };
  // A content-free, time-bounded record of lane changes. It never contains a
  // Codex conversation id, prompt, or tool data; lanes are the only identity
  // the monitor needs to draw the scheduler's swimlanes.
  #events = [];
  #coldPrefillRates = [];
  #totals = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, timeSavedMs: 0 };

  constructor({ hostId, laneCount = 1, fingerprint, store, slotClient, assignSlots = true, onDiagnostic = noOp } = {}) {
    if (!store || typeof store.save !== "function" || typeof store.restore !== "function" || typeof store.invalidateExcept !== "function" || typeof store.has !== "function") {
      throw new TypeError("A KV coordinator needs a local KV state store.");
    }
    if (!slotClient || typeof slotClient.erase !== "function") throw new TypeError("A KV coordinator needs a llama.cpp slot client.");
    if (typeof onDiagnostic !== "function") throw new TypeError("A KV coordinator diagnostic handler must be a function.");
    this.hostId = text(hostId, "A local host id");
    this.fingerprint = text(fingerprint, "A KV host fingerprint");
    this.store = store;
    this.slotClient = slotClient;
    this.assignSlots = Boolean(assignSlots);
    this.onDiagnostic = onDiagnostic;
    this.scheduler = new LocalHostScheduler({ hostId: this.hostId, maxActiveRequests: Number(laneCount) });
    this.#residency = createLocalHostResidency({ laneCount: Number(laneCount) });
  }

  snapshot() {
    this.#pruneEvents();
    return Object.freeze({
      ...this.scheduler.snapshot(),
      fingerprint: this.fingerprint,
      slotAffinity: this.assignSlots,
      lanes: this.#residency.lanes.map((lane) => ({ ...lane })),
      hotCount: this.#residency.lanes.filter((lane) => lane.state === "hot").length,
      // Synchronous by design: this rides the status SSE broadcast, so it must
      // never touch the disk. The store keeps its last-known manifest totals.
      ssd: typeof this.store.totals === "function" ? this.store.totals() : null,
      counters: { ...this.#counters },
      telemetry: {
        windowMs: TELEMETRY_WINDOW_MS,
        events: this.#events.map((event) => ({ ...event })),
        totals: { ...this.#totals },
        coldPrefillTps: median(this.#coldPrefillRates),
        coldPrefillSamples: this.#coldPrefillRates.length,
      },
    });
  }

  #pruneEvents(now = Date.now()) {
    const cutoff = now - TELEMETRY_WINDOW_MS;
    const firstVisible = this.#events.findIndex((event) => event.at >= cutoff);
    if (firstVisible > 0) this.#events.splice(0, firstVisible);
    if (firstVisible === -1) this.#events.length = 0;
    if (this.#events.length > TELEMETRY_EVENT_LIMIT) this.#events.splice(0, this.#events.length - TELEMETRY_EVENT_LIMIT);
  }

  #recordEvent(kind, { slot = null, durationMs = 0, savedMs = 0 } = {}) {
    const event = { at: Date.now(), kind };
    if (Number.isSafeInteger(slot) && slot >= 0) event.slot = slot;
    if (nonNegativeNumber(durationMs) > 0) event.durationMs = Math.round(nonNegativeNumber(durationMs));
    if (nonNegativeNumber(savedMs) > 0) event.savedMs = Math.round(nonNegativeNumber(savedMs));
    this.#events.push(event);
    this.#pruneEvents(event.at);
  }

  #recordUsage(result, cache) {
    const usage = result?.usage;
    if (!usage || typeof usage !== "object") return 0;
    const inputTokens = nonNegativeNumber(usage.input_tokens);
    const cachedTokens = Math.min(inputTokens, nonNegativeNumber(usage.input_tokens_details?.cached_tokens));
    const outputTokens = nonNegativeNumber(usage.output_tokens);
    this.#totals.inputTokens += inputTokens;
    this.#totals.cachedTokens += cachedTokens;
    this.#totals.outputTokens += outputTokens;

    if (result?.ok === false) return 0;

    const firstResponseMs = nonNegativeNumber(result?.firstResponseLatencyMs);
    if (cache?.tier === "cold" && cachedTokens === 0 && inputTokens >= MIN_COLD_PREFILL_TOKENS && firstResponseMs > 0) {
      this.#coldPrefillRates.push(inputTokens / (firstResponseMs / 1000));
      if (this.#coldPrefillRates.length > COLD_PREFILL_SAMPLE_LIMIT) this.#coldPrefillRates.splice(0, this.#coldPrefillRates.length - COLD_PREFILL_SAMPLE_LIMIT);
    }

    const baselineTps = median(this.#coldPrefillRates);
    if (!baselineTps || !cachedTokens) return 0;
    // Cached prompt tokens are known from the upstream usage response. The
    // cold baseline is measured on this same managed host; restore time is
    // subtracted because it is work the current request actually paid for.
    const savedMs = Math.max(0, (cachedTokens / baselineTps) * 1000 - nonNegativeNumber(cache?.restoreMs));
    this.#totals.timeSavedMs += savedMs;
    return savedMs;
  }

  async waitForIdle({ timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = this.scheduler.snapshot();
      if (!snapshot.activeCount && !snapshot.pendingCount) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async #exclusive(operation) {
    const previous = this.#mutation;
    let release;
    this.#mutation = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #diagnose(kind, error) {
    try {
      await this.onDiagnostic({ kind, message: diagnosticMessage(error) });
    } catch {
      // Diagnostics must not prevent a local model request from continuing.
    }
  }

  async #erase(slot) {
    try {
      await this.slotClient.erase({ slot });
      return true;
    } catch (error) {
      await this.#diagnose("slot_erase_failed", error);
      return false;
    }
  }

  async #prepare(sessionKey, signal) {
    return this.#exclusive(async () => {
      if (!this.#validatedFingerprint) {
        try {
          if (typeof this.store.gcOrphans === "function") await this.store.gcOrphans();
          // Time-bounding runs at the same once-per-boot moment as the other
          // hygiene: space is already hard-capped by the budget, so the TTL's
          // only job is to stop dead conversations squatting in it for months.
          if (typeof this.store.expireStale === "function") {
            const expired = await this.store.expireStale();
            this.#counters.expired += expired?.expired?.length || 0;
          }
          await this.store.invalidateExcept({ fingerprint: this.fingerprint });
        } catch (error) {
          await this.#diagnose("state_startup_cleanup_failed", error);
        }
        this.#validatedFingerprint = true;
      }
      let hasSsdState = false;
      try {
        hasSsdState = await this.store.has({ sessionKey, fingerprint: this.fingerprint });
      } catch (error) {
        await this.#diagnose("state_lookup_failed", error);
      }
      const lease = leaseLocalHostResidency(this.#residency, {
        sessionKey,
        fingerprint: this.fingerprint,
        hasSsdState,
      });
      if (lease.kind === "queue") throw new Error("No local host lane became available after admission.");
      this.#residency = lease.residency;
      let tier = lease.kind;
      let restoreMs = 0;
      for (const action of lease.actions) {
        if (action.type === "use_gpu") continue;
        if (action.type === "invalidate_ssd") {
          try {
            await this.store.invalidateExcept({ fingerprint: this.fingerprint });
          } catch (error) {
            await this.#diagnose("state_invalidation_failed", error);
          }
          continue;
        }
        if (action.type === "erase_slot") {
          this.#recordEvent("switching", { slot: action.slot });
          await this.#erase(action.slot);
          continue;
        }
        if (action.type === "save_lru_to_ssd") {
          this.#recordEvent("switching", { slot: action.slot });
          try {
            const saved = await this.store.save({ sessionKey: action.sessionKey, fingerprint: action.fingerprint, slot: action.slot, signal });
            if (saved?.saved) {
              this.#counters.saves += 1;
              this.#recordEvent("checkpointed", { slot: action.slot });
            }
            this.#counters.evictions += saved?.evicted?.length || 0;
          } catch (error) {
            await this.#diagnose("slot_save_failed", error);
          }
          continue;
        }
        if (action.type === "restore_ssd") {
          this.#recordEvent("restoring", { slot: action.slot });
          try {
            const restored = await this.store.restore({ sessionKey, fingerprint: this.fingerprint, slot: action.slot, signal });
            if (!restored.restored) {
              tier = "cold";
              await this.#erase(action.slot);
            } else {
              this.#counters.restores += 1;
              restoreMs = Number(restored.restoreMs) || 0;
              this.#recordEvent("restored", { slot: action.slot, durationMs: restoreMs });
            }
          } catch (error) {
            tier = "cold";
            await this.#diagnose("slot_restore_failed", error);
            await this.#erase(action.slot);
          }
          continue;
        }
        if (action.type === "cold_prefill") {
          this.#counters.coldPrefills += 1;
          this.#recordEvent("cold_prefill", { slot: action.slot });
          await this.#erase(action.slot);
        }
      }
      if (tier === "gpu") this.#recordEvent("running", { slot: lease.slot });
      return { slot: lease.slot, tier, restoreMs };
    });
  }

  async #complete({ slot, sessionKey, success }) {
    if (!this.assignSlots) return;
    await this.#exclusive(async () => {
      this.#residency = completeLocalHostResidency(this.#residency, {
        slot,
        sessionKey,
        fingerprint: this.fingerprint,
        success,
      });
      if (!success) {
        this.#recordEvent("failed", { slot });
        await this.#erase(slot);
      } else {
        this.#recordEvent("hot", { slot });
      }
    });
  }

  // The explicit "give me my disk back" action. Runs under the same exclusive
  // lock as every store mutation so it cannot race an in-flight save; GPU
  // lanes stay hot - clearing checkpoints must not cost the live sessions
  // their warm state.
  async clearSsdStates() {
    return this.#exclusive(async () => {
      if (typeof this.store.clearAll !== "function") return { cleared: 0 };
      const result = await this.store.clearAll();
      const cleared = result?.cleared?.length || 0;
      this.#counters.cleared += cleared;
      return { cleared };
    });
  }

  // A managed restart has already closed admission and drained active work.
  // Persist every remaining hot lane before llama.cpp is stopped so the next
  // gateway/runtime can restore the exact conversation instead of prefilling
  // its complete Codex history again.
  async checkpointHotStates() {
    return this.#exclusive(async () => {
      let saved = 0;
      let failed = 0;
      for (const lane of this.#residency.lanes) {
        if (lane.state !== "hot") continue;
        try {
          const result = await this.store.save({
            sessionKey: lane.sessionKey,
            fingerprint: lane.fingerprint,
            slot: lane.slot,
          });
          if (result?.saved) {
            saved += 1;
            this.#recordEvent("checkpointed", { slot: lane.slot });
          } else {
            // A budget rejection is not a successful handoff. Restarting now
            // would discard the only hot state and turn a recoverable local
            // conversation into a full cold prefill, so surface it exactly
            // like an adapter save failure and keep the old gateway alive.
            failed += 1;
            await this.#diagnose("slot_checkpoint_rejected", new Error("The SSD KV budget cannot hold this local conversation state."));
          }
          this.#counters.evictions += result?.evicted?.length || 0;
        } catch (error) {
          failed += 1;
          await this.#diagnose("slot_checkpoint_failed", error);
        }
      }
      return { saved, failed };
    });
  }

  async run({ principalId = "local", conversationId, signal, run } = {}) {
    if (typeof run !== "function") throw new TypeError("A KV coordinator request needs a run function.");
    const normalizedPrincipalId = text(principalId, "A local principal id");
    const normalizedConversationId = text(conversationId, "A local conversation id");
    const sessionKey = kvSessionKey({ principalId: normalizedPrincipalId, conversationId: normalizedConversationId });
    const scheduler = this.scheduler.snapshot();
    if (scheduler.activeCount >= scheduler.maxActiveRequests || scheduler.pendingCount) this.#recordEvent("waiting");
    return this.scheduler.enqueue({
      principalId: normalizedPrincipalId,
      conversationId: normalizedConversationId,
      signal,
      run: async () => {
        // Builds without request-level slot affinity can still use llama.cpp's
        // own P-way scheduler. SSD swapping is disabled because restoring slot
        // N and then letting the server choose another slot would corrupt the
        // cache mapping; fair admission and complete Codex history remain safe.
        if (!this.assignSlots) return run({ cache: { tier: "llama_auto" }, slot: null });
        const prepared = await this.#prepare(sessionKey, signal);
        try {
          const result = await run({
            cache: { tier: prepared.tier, ...(prepared.restoreMs ? { restoreMs: prepared.restoreMs } : {}) },
            slot: prepared.slot,
          });
          const savedMs = this.#recordUsage(result, prepared);
          await this.#complete({ slot: prepared.slot, sessionKey, success: result?.ok !== false });
          if (savedMs) this.#recordEvent("time_saved", { slot: prepared.slot, savedMs });
          return result;
        } catch (error) {
          await this.#complete({ slot: prepared.slot, sessionKey, success: false });
          throw error;
        }
      },
    });
  }
}

// Single-slot session coordination for explicit SSD KV states.
//
// It sits above llama.cpp's slot endpoint and below the Responses relay. The
// coordinator does not alter request JSON: after an exact restore miss it lets
// the normal, complete Codex history perform a cold prefill.

import { kvSessionKey } from "./local-host-kv-state.mjs";
import { LocalHostScheduler } from "./local-host-scheduler.mjs";

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function noOp() {}

function diagnosticMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Unknown KV state error.");
}

export class LocalHostKvCoordinator {
  #resident = null;
  #fingerprint = "";

  constructor({ hostId, store, slotClient, onDiagnostic = noOp } = {}) {
    if (!store || typeof store.save !== "function" || typeof store.restore !== "function" || typeof store.invalidateExcept !== "function") {
      throw new TypeError("A KV coordinator needs a local KV state store.");
    }
    if (!slotClient || typeof slotClient.erase !== "function") throw new TypeError("A KV coordinator needs a llama.cpp slot client.");
    if (typeof onDiagnostic !== "function") throw new TypeError("A KV coordinator diagnostic handler must be a function.");
    this.hostId = text(hostId, "A local host id");
    this.store = store;
    this.slotClient = slotClient;
    this.onDiagnostic = onDiagnostic;
    // SSD state is the deliberate first implementation for one large slot.
    // Multi-slot coordination needs independently verified slot assignment and
    // stays outside this class until the adapter exposes it.
    this.scheduler = new LocalHostScheduler({ hostId: this.hostId, maxActiveRequests: 1 });
  }

  snapshot() {
    return Object.freeze({
      ...this.scheduler.snapshot(),
      resident: Boolean(this.#resident),
      fingerprint: this.#fingerprint,
    });
  }

  async #diagnose(kind, error) {
    try {
      await this.onDiagnostic({ kind, message: diagnosticMessage(error) });
    } catch {
      // Diagnostics must not prevent a local model request from continuing.
    }
  }

  async #clearSlot() {
    try {
      await this.slotClient.erase({ slot: 0 });
      return true;
    } catch (error) {
      await this.#diagnose("slot_erase_failed", error);
      return false;
    }
  }

  async #saveResident() {
    if (!this.#resident) return { saved: false, reason: "none" };
    const resident = this.#resident;
    this.#resident = null;
    try {
      return await this.store.save({ sessionKey: resident.sessionKey, fingerprint: resident.fingerprint, slot: 0 });
    } catch (error) {
      await this.#diagnose("slot_save_failed", error);
      return { saved: false, reason: "save_failed" };
    }
  }

  async #prepare({ sessionKey, fingerprint }) {
    if (this.#fingerprint !== fingerprint) {
      this.#resident = null;
      this.#fingerprint = fingerprint;
      try {
        await this.store.invalidateExcept({ fingerprint });
      } catch (error) {
        await this.#diagnose("state_invalidation_failed", error);
      }
      await this.#clearSlot();
    }
    if (this.#resident?.sessionKey === sessionKey && this.#resident.fingerprint === fingerprint) {
      return Object.freeze({ tier: "gpu" });
    }
    await this.#saveResident();
    try {
      const restored = await this.store.restore({ sessionKey, fingerprint, slot: 0 });
      if (restored.restored) return Object.freeze({ tier: "ssd", restoreMs: restored.restoreMs });
      await this.#clearSlot();
      return Object.freeze({ tier: "cold", reason: restored.reason });
    } catch (error) {
      await this.#diagnose("slot_restore_failed", error);
      await this.#clearSlot();
      return Object.freeze({ tier: "cold", reason: "restore_failed" });
    }
  }

  async run({ principalId = "local", conversationId, fingerprint, signal, run } = {}) {
    if (typeof run !== "function") throw new TypeError("A KV coordinator request needs a run function.");
    const normalizedPrincipalId = text(principalId, "A local principal id");
    const normalizedConversationId = text(conversationId, "A local conversation id");
    const normalizedFingerprint = text(fingerprint, "A KV host fingerprint");
    const sessionKey = kvSessionKey({ principalId: normalizedPrincipalId, conversationId: normalizedConversationId });
    return this.scheduler.enqueue({
      principalId: normalizedPrincipalId,
      conversationId: normalizedConversationId,
      signal,
      run: async () => {
        const cache = await this.#prepare({ sessionKey, fingerprint: normalizedFingerprint });
        try {
          const result = await run({ cache });
          // Do not preserve partial state after an upstream failure or a client
          // close. A completed response is the only safe hot prefix to carry.
          if (result?.ok === false) {
            this.#resident = null;
            await this.#clearSlot();
          } else {
            this.#resident = { sessionKey, fingerprint: normalizedFingerprint };
          }
          return result;
        } catch (error) {
          this.#resident = null;
          await this.#clearSlot();
          throw error;
        }
      },
    });
  }
}

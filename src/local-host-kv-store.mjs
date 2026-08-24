// Filesystem orchestration for explicit llama.cpp SSD slot state.
//
// The caller must already hold the host scheduler lease. This class never
// chooses a conversation, changes a llama-server launch command, or forwards a
// model request. It only persists a manifest around one adapter save/restore.

import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  createLocalHostKvStateManifest,
  createLocalHostKvStorage,
  findLocalHostKvState,
  invalidateLocalHostKvStates,
  planLocalHostKvStateWrite,
  removeLocalHostKvState,
  touchLocalHostKvState,
} from "./local-host-kv-state.mjs";

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function stateFilePath(storage, filename) {
  const root = path.resolve(storage.directory);
  const target = path.resolve(root, filename);
  if (path.dirname(target) !== root) throw new TypeError("KV state filename escapes its managed storage directory.");
  return target;
}

function stateFilename(id) {
  return `slot-${String(id).replace(/[^a-z0-9]/gi, "").toLowerCase()}.bin`;
}

function copy(value) {
  return structuredClone(value);
}

export class LocalHostKvStateStore {
  constructor({ hostId, storage, manifestFile, slotClient, makeId = randomUUID } = {}) {
    if (!slotClient || typeof slotClient.save !== "function" || typeof slotClient.restore !== "function") {
      throw new TypeError("A local KV state store needs a llama.cpp slot client.");
    }
    if (typeof makeId !== "function") throw new TypeError("A local KV state store needs a state filename generator.");
    this.hostId = text(hostId, "A local host id");
    this.storage = createLocalHostKvStorage(storage);
    this.manifestFile = text(manifestFile, "A local KV state manifest path");
    this.slotClient = slotClient;
    this.makeId = makeId;
  }

  async load() {
    let source;
    try {
      source = await readFile(this.manifestFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return createLocalHostKvStateManifest({ hostId: this.hostId, storage: this.storage });
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new TypeError("Local KV state manifest is not valid JSON.");
    }
    const manifest = createLocalHostKvStateManifest(parsed);
    if (manifest.hostId !== this.hostId) throw new TypeError("Local KV state manifest host does not match this store.");
    if (manifest.storage.directory !== this.storage.directory || manifest.storage.budgetBytes !== this.storage.budgetBytes) {
      throw new TypeError("Local KV state manifest storage policy does not match this managed host.");
    }
    return manifest;
  }

  async #write(manifest) {
    const normalized = createLocalHostKvStateManifest(manifest);
    const directory = path.dirname(this.manifestFile);
    const temporary = path.join(directory, `.${path.basename(this.manifestFile)}.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.manifestFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return normalized;
  }

  async #removeState(filename) {
    await rm(stateFilePath(this.storage, filename), { force: true });
  }

  async #removeEvicted(states) {
    const failed = [];
    for (const state of states) {
      try {
        await this.#removeState(state.filename);
      } catch (error) {
        // The manifest no longer refers to this file, so a later GC can remove
        // an orphan without risking a newly written state of the same name.
        failed.push({ filename: state.filename, error: String(error?.message || error) });
      }
    }
    return failed;
  }

  async save({ sessionKey, fingerprint, slot = 0, signal, at = new Date().toISOString() } = {}) {
    const filename = stateFilename(this.makeId());
    // The managed launch receives this same directory as --slot-save-path.
    // Create it before asking the adapter to write, rather than relying on a
    // build-specific llama.cpp mkdir behavior.
    await mkdir(this.storage.directory, { recursive: true });
    const saved = await this.slotClient.save({ slot, filename, signal });
    const target = stateFilePath(this.storage, filename);
    let actual;
    try {
      actual = await stat(target);
    } catch (error) {
      throw new Error(`llama.cpp reported a saved slot state that was not present on disk: ${error.message}`);
    }
    if (!actual.isFile() || actual.size !== saved.bytes) {
      await this.#removeState(filename).catch(() => {});
      throw new Error("llama.cpp saved slot state size does not match the file on disk.");
    }
    const current = await this.load();
    const plan = planLocalHostKvStateWrite(current, {
      sessionKey,
      fingerprint,
      filename,
      bytes: actual.size,
      promptTokens: saved.promptTokens,
      at,
    });
    if (!plan.accepted) {
      await this.#removeState(filename);
      return Object.freeze({ saved: false, reason: "state_exceeds_budget", discardedBytes: actual.size, evicted: Object.freeze([]) });
    }
    try {
      await this.#write(plan.manifest);
    } catch (error) {
      await this.#removeState(filename).catch(() => {});
      throw error;
    }
    const removalFailures = await this.#removeEvicted(plan.evicted);
    return Object.freeze({
      saved: true,
      state: findLocalHostKvState(plan.manifest, { sessionKey, fingerprint }),
      evicted: Object.freeze(plan.evicted.map(copy)),
      removalFailures: Object.freeze(removalFailures),
      saveMs: saved.saveMs,
    });
  }

  async restore({ sessionKey, fingerprint, slot = 0, signal, at = new Date().toISOString() } = {}) {
    let manifest = await this.load();
    const state = findLocalHostKvState(manifest, { sessionKey, fingerprint });
    if (!state) return Object.freeze({ restored: false, reason: "not_found" });
    try {
      const source = await stat(stateFilePath(this.storage, state.filename));
      if (!source.isFile() || source.size !== state.bytes) throw new Error("state file is missing or changed");
    } catch {
      const removed = removeLocalHostKvState(manifest, { filename: state.filename });
      await this.#write(removed.manifest);
      return Object.freeze({ restored: false, reason: "missing" });
    }
    const restored = await this.slotClient.restore({ slot, filename: state.filename, signal });
    manifest = touchLocalHostKvState(manifest, { sessionKey, fingerprint, at });
    await this.#write(manifest);
    return Object.freeze({ restored: true, state: findLocalHostKvState(manifest, { sessionKey, fingerprint }), restoreMs: restored.restoreMs });
  }

  async invalidateExcept({ fingerprint } = {}) {
    const current = await this.load();
    const result = invalidateLocalHostKvStates(current, { fingerprint });
    await this.#write(result.manifest);
    const removalFailures = await this.#removeEvicted(result.evicted);
    return Object.freeze({ invalidated: Object.freeze(result.evicted.map(copy)), removalFailures: Object.freeze(removalFailures) });
  }
}

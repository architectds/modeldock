// Filesystem orchestration for explicit llama.cpp SSD slot state.
//
// The caller must already hold the host scheduler lease. This class never
// chooses a conversation, changes a llama-server launch command, or forwards a
// model request. It only persists a manifest around one adapter save/restore.

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  createLocalHostKvStateManifest,
  createLocalHostKvStorage,
  expireLocalHostKvStates,
  findLocalHostKvState,
  invalidateLocalHostKvStates,
  planLocalHostKvStateWrite,
  removeLocalHostKvState,
  sameKvStorageDirectory,
  touchLocalHostKvState,
} from "./local-host-kv-state.mjs";

// How long an untouched session checkpoint may live. Seven days covers "back
// next week" without letting dead conversations squat in the budget for
// months; the space cap already bounds the worst case, and the price of an
// expired state that does return is one cold prefill.
export const KV_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

function hostFilePrefix(hostId) {
  return `slot-${createHash("sha256").update(hostId).digest("hex").slice(0, 12)}-`;
}

function stateFilename(prefix, id) {
  return `${prefix}${String(id).replace(/[^a-z0-9]/gi, "").toLowerCase()}.bin`;
}

function copy(value) {
  return structuredClone(value);
}

// LRU-fit a stored state list against a (possibly new) budget: drop the least
// recently used states until the survivors fit. Returns null when the list is
// too malformed to reason about, which sends the caller to quarantine instead.
function fitStatesToBudget(states, budgetBytes) {
  if (!Array.isArray(states)) return null;
  let total = 0;
  for (const state of states) {
    const bytes = Number(state?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    total += bytes;
  }
  const kept = [...states].sort((left, right) =>
    String(left?.lastAccessedAt || "").localeCompare(String(right?.lastAccessedAt || "")));
  const evicted = [];
  while (total > budgetBytes && kept.length) {
    const oldest = kept.shift();
    evicted.push(oldest);
    total -= Number(oldest.bytes);
  }
  return { kept, evicted };
}

export class LocalHostKvStateStore {
  // Last-known manifest totals, refreshed by every successful load/write. The
  // status SSE broadcast reads this synchronously; it must never cost a disk
  // read per broadcast.
  #lastTotals = null;

  constructor({ hostId, storage, manifestFile, slotClient, makeId = randomUUID } = {}) {
    if (!slotClient || typeof slotClient.save !== "function" || typeof slotClient.restore !== "function") {
      throw new TypeError("A local KV state store needs a llama.cpp slot client.");
    }
    if (typeof makeId !== "function") throw new TypeError("A local KV state store needs a state filename generator.");
    this.hostId = text(hostId, "A local host id");
    this.filePrefix = hostFilePrefix(this.hostId);
    this.storage = createLocalHostKvStorage(storage);
    this.manifestFile = text(manifestFile, "A local KV state manifest path");
    this.slotClient = slotClient;
    this.makeId = makeId;
  }

  // A manifest this store cannot use must never brick the subsystem. Before
  // this healed, corrupt JSON, a budget changed through unmanage -> re-manage,
  // and a Windows path-case drift all made every load() throw forever - the
  // SSD tier went silently dead, gcOrphans died with it, and the multi-GB
  // files the lost manifest referenced were never reclaimed (reproduced live
  // for all three triggers). Unusable manifests are quarantined beside the
  // original so the evidence survives; a merely re-spelled directory or a
  // changed budget is adopted, with LRU eviction down to the new budget.
  async #quarantine(reason) {
    const target = `${this.manifestFile}.corrupt-${Date.now()}`;
    await rename(this.manifestFile, target).catch(() => {});
    console.log(`[gate] local KV manifest quarantined to ${path.basename(target)}: ${String(reason?.message || reason)}`);
    return this.#remember(createLocalHostKvStateManifest({ hostId: this.hostId, storage: this.storage }));
  }

  #remember(manifest) {
    this.#lastTotals = Object.freeze({
      totalBytes: manifest.totalBytes,
      budgetBytes: manifest.storage.budgetBytes,
      states: manifest.states.length,
    });
    return manifest;
  }

  totals() {
    return this.#lastTotals;
  }

  async load() {
    let source;
    try {
      source = await readFile(this.manifestFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return this.#remember(createLocalHostKvStateManifest({ hostId: this.hostId, storage: this.storage }));
      throw error;
    }
    let stored;
    try {
      stored = JSON.parse(source);
    } catch {
      return this.#quarantine(new TypeError("Local KV state manifest is not valid JSON."));
    }
    if (stored?.hostId !== this.hostId) {
      return this.#quarantine(new TypeError("Local KV state manifest host does not match this store."));
    }
    if (!sameKvStorageDirectory(stored?.storage?.directory, this.storage.directory)) {
      // A genuinely different directory's manifest describes files that do not
      // live here; adopting its entries would point restores at nothing.
      return this.#quarantine(new TypeError("Local KV state manifest names a different storage directory."));
    }
    // Adopt the live storage policy (the directory's current spelling and the
    // current budget); the stored copy of the policy is a snapshot, not a veto.
    try {
      return this.#remember(createLocalHostKvStateManifest({ hostId: this.hostId, storage: this.storage, states: stored?.states || [] }));
    } catch (error) {
      const fit = fitStatesToBudget(stored?.states, this.storage.budgetBytes);
      if (!fit) return this.#quarantine(error);
      let manifest;
      try {
        manifest = createLocalHostKvStateManifest({ hostId: this.hostId, storage: this.storage, states: fit.kept });
      } catch (secondError) {
        return this.#quarantine(secondError);
      }
      await this.#write(manifest);
      await this.#removeEvicted(fit.evicted.map((state) => ({ filename: String(state?.filename || "") })));
      return manifest;
    }
  }

  async #write(manifest) {
    const normalized = createLocalHostKvStateManifest(manifest);
    const directory = path.dirname(this.manifestFile);
    const temporary = path.join(directory, `.${path.basename(this.manifestFile)}.${process.pid}.${randomUUID()}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.manifestFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
    return this.#remember(normalized);
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

  async gcOrphans() {
    const manifest = await this.load();
    const retained = new Set(manifest.states.map((state) => state.filename));
    await mkdir(this.storage.directory, { recursive: true, mode: 0o700 });
    const owned = new RegExp(`^${this.filePrefix}[a-f0-9]{32}\\.bin$`, "i");
    const removed = [];
    const failures = [];
    for (const entry of await readdir(this.storage.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !owned.test(entry.name) || retained.has(entry.name)) continue;
      try {
        await this.#removeState(entry.name);
        removed.push(entry.name);
      } catch (error) {
        failures.push({ filename: entry.name, error: String(error?.message || error) });
      }
    }
    return Object.freeze({ removed: Object.freeze(removed), failures: Object.freeze(failures) });
  }

  async save({ sessionKey, fingerprint, warmBaseKey, warmBaseTranscript, slot = 0, signal, at = new Date().toISOString() } = {}) {
    const filename = stateFilename(this.filePrefix, this.makeId());
    // The managed launch receives this same directory as --slot-save-path.
    // Create it before asking the adapter to write, rather than relying on a
    // build-specific llama.cpp mkdir behavior.
    await mkdir(this.storage.directory, { recursive: true, mode: 0o700 });
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
      ...(warmBaseKey ? { warmBaseKey } : {}),
      ...(warmBaseTranscript ? { warmBaseTranscript } : {}),
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

  async has({ sessionKey, fingerprint } = {}) {
    const manifest = await this.load();
    return Boolean(findLocalHostKvState(manifest, { sessionKey, fingerprint }));
  }

  // Metadata only: the coordinator needs the previous immutable bootstrap key
  // before it decides whether a restored conversation can keep using its slot.
  // It is a SHA-256 digest, never prompt or conversation content.
  async lookup({ sessionKey, fingerprint } = {}) {
    const manifest = await this.load();
    return findLocalHostKvState(manifest, { sessionKey, fingerprint });
  }

  // A changed static prefix makes an old session checkpoint incompatible with
  // its next Chat request. Remove it before cold-rebuilding, rather than leave
  // a stale multi-GB state until TTL or LRU happens to notice it.
  async remove({ sessionKey, fingerprint } = {}) {
    const current = await this.load();
    const state = findLocalHostKvState(current, { sessionKey, fingerprint });
    if (!state) return Object.freeze({ removed: false, removalFailures: Object.freeze([]) });
    const result = removeLocalHostKvState(current, { filename: state.filename });
    await this.#write(result.manifest);
    const removalFailures = await this.#removeEvicted(result.evicted);
    return Object.freeze({ removed: true, removalFailures: Object.freeze(removalFailures) });
  }

  async invalidateExcept({ fingerprint } = {}) {
    const current = await this.load();
    const result = invalidateLocalHostKvStates(current, { fingerprint });
    await this.#write(result.manifest);
    const removalFailures = await this.#removeEvicted(result.evicted);
    return Object.freeze({ invalidated: Object.freeze(result.evicted.map(copy)), removalFailures: Object.freeze(removalFailures) });
  }

  // Time-bounding for checkpoints the budget alone never touches: see the
  // KV_STATE_TTL_MS rationale. Skips the write entirely when nothing is stale.
  async expireStale({ maxAgeMs = KV_STATE_TTL_MS, now = Date.now() } = {}) {
    const current = await this.load();
    const result = expireLocalHostKvStates(current, { maxAgeMs, now });
    if (!result.evicted.length) {
      return Object.freeze({ expired: Object.freeze([]), removalFailures: Object.freeze([]) });
    }
    await this.#write(result.manifest);
    const removalFailures = await this.#removeEvicted(result.evicted);
    return Object.freeze({ expired: Object.freeze(result.evicted.map(copy)), removalFailures: Object.freeze(removalFailures) });
  }

  // The explicit destructive reclaim behind the dashboard's Clear button.
  // Manifest first, files second - the same crash ordering every other
  // mutation here uses: a crash in between leaves orphans for gcOrphans,
  // never a manifest pointing at deleted files.
  async clearAll() {
    const current = await this.load();
    if (!current.states.length) {
      return Object.freeze({ cleared: Object.freeze([]), removalFailures: Object.freeze([]) });
    }
    await this.#write(createLocalHostKvStateManifest({ hostId: this.hostId, storage: this.storage }));
    const removalFailures = await this.#removeEvicted(current.states);
    return Object.freeze({ cleared: Object.freeze(current.states.map(copy)), removalFailures: Object.freeze(removalFailures) });
  }
}

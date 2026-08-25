// Durable, SSD-backed KV state metadata for one managed local host.
//
// This module deliberately has no filesystem or llama.cpp calls. It owns the
// privacy-preserving manifest shape and deterministic eviction plan; the
// adapter performs the save/restore and file removal only after this layer has
// made the decision. Conversation history remains in Codex, never here.

import { createHash } from "node:crypto";

export const LOCAL_HOST_KV_STATE_VERSION = 1;

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer.`);
  return value;
}

function timestamp(value, label) {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result))) throw new TypeError(`${label} must be an ISO timestamp.`);
  return result;
}

function safeFilename(value) {
  const filename = text(value, "A KV state filename");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}\.bin$/i.test(filename)) {
    throw new TypeError("A KV state filename must be one simple .bin filename.");
  }
  return filename;
}

function sessionDigest(value) {
  const input = text(value, "A KV session key");
  return createHash("sha256").update(input).digest("hex");
}

function assertSessionKey(value) {
  const key = text(value, "A KV session key");
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new TypeError("A KV session key must be a SHA-256 digest.");
  return key.toLowerCase();
}

function copy(value) {
  return structuredClone(value);
}

function compareOldest(a, b) {
  const accessed = Date.parse(a.lastAccessedAt) - Date.parse(b.lastAccessedAt);
  if (accessed) return accessed;
  const saved = Date.parse(a.savedAt) - Date.parse(b.savedAt);
  if (saved) return saved;
  return a.filename.localeCompare(b.filename);
}

function normalizeState(value) {
  return Object.freeze({
    sessionKey: assertSessionKey(value?.sessionKey),
    fingerprint: text(value?.fingerprint, "A KV state host fingerprint"),
    filename: safeFilename(value?.filename),
    bytes: positiveInteger(value?.bytes, "A KV state byte count"),
    promptTokens: nonNegativeInteger(value?.promptTokens, "A KV state prompt token count"),
    savedAt: timestamp(value?.savedAt, "A KV state saved timestamp"),
    lastAccessedAt: timestamp(value?.lastAccessedAt || value?.savedAt, "A KV state access timestamp"),
  });
}

function normalizeStates(states) {
  if (!Array.isArray(states)) throw new TypeError("KV state manifest states must be an array.");
  const filenames = new Set();
  const normalized = states.map(normalizeState);
  for (const state of normalized) {
    if (filenames.has(state.filename)) throw new TypeError(`KV state filename is duplicated: ${state.filename}.`);
    filenames.add(state.filename);
  }
  return normalized;
}

// One spelling for "is this the same storage directory": Windows paths differ
// by case and trailing separators without naming a different place. Shared by
// the server's takeover flow and the store's manifest adoption - when the two
// disagreed (server compared case-insensitively, the store byte-for-byte), a
// re-spelled path permanently bricked the store.
export function sameKvStorageDirectory(left, right) {
  const a = String(left || "").trim().replace(/[\\/]+$/, "");
  const b = String(right || "").trim().replace(/[\\/]+$/, "");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function createLocalHostKvStorage({ directory, budgetBytes } = {}) {
  return Object.freeze({
    version: LOCAL_HOST_KV_STATE_VERSION,
    directory: text(directory, "A KV state directory"),
    budgetBytes: positiveInteger(budgetBytes, "A KV state disk budget"),
  });
}

export function kvSessionKey({ principalId = "local", conversationId } = {}) {
  const principal = text(principalId, "A KV principal id");
  const conversation = text(conversationId, "A KV conversation id");
  // Length framing prevents ambiguous concatenation. The raw ids never reach
  // the durable manifest or the filename.
  return sessionDigest(`${principal.length}:${principal}${conversation.length}:${conversation}`);
}

export function createLocalHostKvStateManifest({ hostId, storage, states = [] } = {}) {
  const normalizedStorage = createLocalHostKvStorage(storage);
  const normalizedStates = normalizeStates(states);
  const totalBytes = normalizedStates.reduce((sum, state) => sum + state.bytes, 0);
  if (totalBytes > normalizedStorage.budgetBytes) throw new TypeError("KV state manifest exceeds its disk budget.");
  return Object.freeze({
    version: LOCAL_HOST_KV_STATE_VERSION,
    hostId: text(hostId, "A local host id"),
    storage: normalizedStorage,
    states: Object.freeze(normalizedStates),
    totalBytes,
  });
}

export function findLocalHostKvState(manifest, { sessionKey, fingerprint } = {}) {
  const normalized = createLocalHostKvStateManifest(manifest);
  const key = assertSessionKey(sessionKey);
  const wantedFingerprint = text(fingerprint, "A KV state host fingerprint");
  return normalized.states.find((state) => state.sessionKey === key && state.fingerprint === wantedFingerprint) || null;
}

export function touchLocalHostKvState(manifest, { sessionKey, fingerprint, at = new Date().toISOString() } = {}) {
  const normalized = createLocalHostKvStateManifest(manifest);
  const key = assertSessionKey(sessionKey);
  const wantedFingerprint = text(fingerprint, "A KV state host fingerprint");
  const accessedAt = timestamp(at, "A KV state access timestamp");
  return createLocalHostKvStateManifest({
    ...normalized,
    states: normalized.states.map((state) => (
      state.sessionKey === key && state.fingerprint === wantedFingerprint
        ? { ...state, lastAccessedAt: accessedAt }
        : state
    )),
  });
}

// Called after llama.cpp has written a new state file and reported its exact
// size. The returned eviction list is safe to delete only after the returned
// manifest has been atomically persisted. If a single state cannot fit, the
// caller must delete that just-written file and retain the old manifest.
export function planLocalHostKvStateWrite(manifest, {
  sessionKey,
  fingerprint,
  filename,
  bytes,
  promptTokens,
  at = new Date().toISOString(),
} = {}) {
  const normalized = createLocalHostKvStateManifest(manifest);
  const state = normalizeState({
    sessionKey: assertSessionKey(sessionKey),
    fingerprint,
    filename,
    bytes,
    promptTokens,
    savedAt: at,
    lastAccessedAt: at,
  });
  if (state.bytes > normalized.storage.budgetBytes) {
    return Object.freeze({ accepted: false, manifest: normalized, evicted: Object.freeze([]), discard: state.filename });
  }

  // One state per logical conversation is sufficient. A new state replaces a
  // stale fingerprint for the same conversation as well as a same-fingerprint
  // predecessor, so a host configuration change cannot accumulate old slots.
  const replaced = normalized.states.filter((entry) => entry.sessionKey === state.sessionKey);
  let retained = normalized.states.filter((entry) => entry.sessionKey !== state.sessionKey);
  let totalBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0) + state.bytes;
  const evicted = [...replaced];
  for (const candidate of [...retained].sort(compareOldest)) {
    if (totalBytes <= normalized.storage.budgetBytes) break;
    retained = retained.filter((entry) => entry.filename !== candidate.filename);
    totalBytes -= candidate.bytes;
    evicted.push(candidate);
  }
  const next = createLocalHostKvStateManifest({
    ...normalized,
    states: [...retained, state],
  });
  return Object.freeze({
    accepted: true,
    manifest: next,
    evicted: Object.freeze(evicted.map(copy)),
    discard: "",
  });
}

export function invalidateLocalHostKvStates(manifest, { fingerprint } = {}) {
  const normalized = createLocalHostKvStateManifest(manifest);
  const wantedFingerprint = text(fingerprint, "A KV state host fingerprint");
  const evicted = normalized.states.filter((state) => state.fingerprint !== wantedFingerprint);
  return Object.freeze({
    manifest: createLocalHostKvStateManifest({
      ...normalized,
      states: normalized.states.filter((state) => state.fingerprint === wantedFingerprint),
    }),
    evicted: Object.freeze(evicted.map(copy)),
  });
}

// Space is already hard-capped by the budget; this bounds TIME. A conversation
// that never returns would otherwise squat in the budget until LRU pressure
// happened to reach it - on a roomy disk, for months. The cost of expiring a
// state that does come back is one cold prefill, so the window can stay
// generous.
export function expireLocalHostKvStates(manifest, { maxAgeMs, now = Date.now() } = {}) {
  const normalized = createLocalHostKvStateManifest(manifest);
  const age = positiveInteger(maxAgeMs, "A KV state maximum age");
  const isStale = (state) => {
    const accessed = Date.parse(state.lastAccessedAt);
    return !Number.isFinite(accessed) || now - accessed > age;
  };
  const evicted = normalized.states.filter(isStale);
  return Object.freeze({
    manifest: createLocalHostKvStateManifest({
      ...normalized,
      states: normalized.states.filter((state) => !isStale(state)),
    }),
    evicted: Object.freeze(evicted.map(copy)),
  });
}

export function removeLocalHostKvState(manifest, { filename } = {}) {
  const normalized = createLocalHostKvStateManifest(manifest);
  const wantedFilename = safeFilename(filename);
  const evicted = normalized.states.filter((state) => state.filename === wantedFilename);
  return Object.freeze({
    manifest: createLocalHostKvStateManifest({
      ...normalized,
      states: normalized.states.filter((state) => state.filename !== wantedFilename),
    }),
    evicted: Object.freeze(evicted.map(copy)),
  });
}

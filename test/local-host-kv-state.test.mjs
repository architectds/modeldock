import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalHostKvStateManifest,
  createLocalHostKvStorage,
  findLocalHostKvState,
  invalidateLocalHostKvStates,
  kvSessionKey,
  MAX_WARM_BASE_STATES,
  planLocalHostKvStateWrite,
  touchLocalHostKvState,
} from "../src/local-host-kv-state.mjs";

const STORAGE = { directory: "D:/ModelDock/KV", budgetBytes: 1000 };
const A = { principalId: "local", conversationId: "conversation-a" };
const B = { principalId: "local", conversationId: "conversation-b" };
const FINGERPRINT = "llama-b10549:qwen-q4:262144:q4_0:q4_0";

function emptyManifest() {
  return createLocalHostKvStateManifest({ hostId: "host-qwen", storage: STORAGE });
}

function plan(manifest, identity, filename, bytes, at, fingerprint = FINGERPRINT) {
  return planLocalHostKvStateWrite(manifest, {
    sessionKey: kvSessionKey(identity),
    fingerprint,
    filename,
    bytes,
    promptTokens: Math.floor(bytes / 2),
    at,
  });
}

test("managed KV storage has no implicit location or disk budget", () => {
  assert.deepEqual(createLocalHostKvStorage(STORAGE), { version: 1, ...STORAGE });
  assert.throws(() => createLocalHostKvStorage({ directory: "D:/ModelDock/KV" }), /disk budget/);
  assert.throws(() => createLocalHostKvStorage({ budgetBytes: 1 }), /directory/);
});

test("KV manifests retain only hashed session identity", () => {
  const key = kvSessionKey(A);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key.includes(A.conversationId), true);
  const result = plan(emptyManifest(), A, "a.bin", 400, "2026-08-23T01:00:00.000Z");
  const serialized = JSON.stringify(result.manifest);
  assert.doesNotMatch(serialized, /conversation-a/);
  assert.equal(findLocalHostKvState(result.manifest, { sessionKey: key, fingerprint: FINGERPRINT })?.filename, "a.bin");
});

// Each base is keyed by the exact prefix that built it, so a superseded one can
// never be read again: it is pure disk held against the conversations that
// could still be restored. The cap must not depend on budget pressure to bite.
test("only the newest warm bases survive; superseded prefixes are evicted", () => {
  const transcript = { assistantContent: "BOOTSTRAP_READY" };
  let manifest = emptyManifest();
  const writeBase = (letter, filename, at) => {
    const result = planLocalHostKvStateWrite(manifest, {
      sessionKey: letter.repeat(64),
      fingerprint: FINGERPRINT,
      filename,
      bytes: 100,
      promptTokens: 10,
      warmBaseTranscript: transcript,
      at,
    });
    manifest = result.manifest;
    return result;
  };

  const first3 = ["a", "b", "c"].map((letter, index) => writeBase(letter, `base-${letter}.bin`, `2026-08-2${index + 1}T01:00:00.000Z`));
  assert.deepEqual(first3.map((result) => result.evicted.length), [0, 0, 0], "the cap is not reached yet");
  assert.equal(manifest.states.length, MAX_WARM_BASE_STATES);

  const fourth = writeBase("d", "base-d.bin", "2026-08-24T01:00:00.000Z");
  assert.deepEqual(fourth.evicted.map((state) => state.filename), ["base-a.bin"], "the oldest unreachable base goes first");
  assert.deepEqual(manifest.states.map((state) => state.filename), ["base-b.bin", "base-c.bin", "base-d.bin"]);
  assert.equal(manifest.totalBytes, 300, "the evicted bytes return to the budget immediately");

  // A conversation checkpoint competes for space but never displaces a base set
  // that is already inside the cap.
  const conversation = plan(manifest, A, "conv.bin", 100, "2026-08-25T01:00:00.000Z");
  manifest = conversation.manifest;
  assert.deepEqual(conversation.evicted, []);
  assert.equal(manifest.states.filter((state) => state.warmBaseTranscript).length, MAX_WARM_BASE_STATES);
});

test("a warm base state retains only its fixed hidden assistant transcript", () => {
  const transcript = { assistantContent: "BOOTSTRAP_READY", assistantReasoningContent: "I should provide the fixed response." };
  const result = planLocalHostKvStateWrite(emptyManifest(), {
    sessionKey: "a".repeat(64),
    fingerprint: FINGERPRINT,
    filename: "base.bin",
    bytes: 400,
    promptTokens: 100,
    warmBaseTranscript: transcript,
    at: "2026-08-23T01:00:00.000Z",
  });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.manifest.states[0].warmBaseTranscript, transcript);
  assert.throws(() => planLocalHostKvStateWrite(emptyManifest(), {
    sessionKey: "b".repeat(64), fingerprint: FINGERPRINT, filename: "bad.bin", bytes: 400, promptTokens: 100,
    warmBaseTranscript: { assistantContent: "" }, at: "2026-08-23T01:00:00.000Z",
  }), /assistant content/);
});

test("legacy bootstrap metadata normalizes once into independent prefix state", () => {
  const normalized = createLocalHostKvStateManifest({
    hostId: "host-qwen",
    storage: STORAGE,
    states: [{
      sessionKey: "a".repeat(64),
      fingerprint: FINGERPRINT,
      filename: "old.bin",
      bytes: 400,
      promptTokens: 100,
      warmBaseKey: "b".repeat(64),
      savedAt: "2026-08-23T01:00:00.000Z",
      lastAccessedAt: "2026-08-23T01:00:00.000Z",
    }],
  });
  assert.equal(normalized.states[0].prefixKey, "b".repeat(64));
  assert.equal(normalized.states[0].bootstrapInjected, true);
  assert.equal("warmBaseKey" in normalized.states[0], false,
    "the obsolete combined representation is not maintained internally");
});

test("KV state LRU eviction honors an explicit user disk budget", () => {
  let manifest = plan(emptyManifest(), A, "a.bin", 400, "2026-08-23T01:00:00.000Z").manifest;
  manifest = plan(manifest, B, "b.bin", 400, "2026-08-23T01:01:00.000Z").manifest;
  manifest = touchLocalHostKvState(manifest, {
    sessionKey: kvSessionKey(A),
    fingerprint: FINGERPRINT,
    at: "2026-08-23T01:02:00.000Z",
  });
  const next = plan(manifest, { principalId: "local", conversationId: "conversation-c" }, "c.bin", 400, "2026-08-23T01:03:00.000Z");
  assert.equal(next.accepted, true);
  assert.equal(next.manifest.totalBytes, 800);
  assert.deepEqual(next.manifest.states.map((state) => state.filename).sort(), ["a.bin", "c.bin"]);
  assert.deepEqual(next.evicted.map((state) => state.filename), ["b.bin"]);
});

test("saving a newer state replaces the same conversation even across a host fingerprint change", () => {
  const first = plan(emptyManifest(), A, "old.bin", 400, "2026-08-23T01:00:00.000Z");
  const next = plan(first.manifest, A, "new.bin", 500, "2026-08-23T01:01:00.000Z", "llama-b10550:qwen-q4:262144:q4_0:q4_0");
  assert.equal(next.accepted, true);
  assert.equal(next.manifest.states.length, 1);
  assert.equal(next.manifest.states[0].filename, "new.bin");
  assert.deepEqual(next.evicted.map((state) => state.filename), ["old.bin"]);
});

test("a state larger than the declared user budget is discarded without evicting healthy cache", () => {
  const initial = plan(emptyManifest(), A, "a.bin", 400, "2026-08-23T01:00:00.000Z").manifest;
  const tooLarge = plan(initial, B, "b.bin", 1001, "2026-08-23T01:01:00.000Z");
  assert.equal(tooLarge.accepted, false);
  assert.equal(tooLarge.discard, "b.bin");
  assert.deepEqual(tooLarge.manifest, initial);
  assert.deepEqual(tooLarge.evicted, []);
});

test("host fingerprint invalidation returns exact stale files for adapter-owned removal", () => {
  let manifest = plan(emptyManifest(), A, "old.bin", 400, "2026-08-23T01:00:00.000Z", "old-build").manifest;
  manifest = plan(manifest, B, "current.bin", 400, "2026-08-23T01:01:00.000Z").manifest;
  const invalidated = invalidateLocalHostKvStates(manifest, { fingerprint: FINGERPRINT });
  assert.deepEqual(invalidated.manifest.states.map((state) => state.filename), ["current.bin"]);
  assert.deepEqual(invalidated.evicted.map((state) => state.filename), ["old.bin"]);
});

test("manifest rejects path-like filenames and unbounded stored bytes", () => {
  assert.throws(() => plan(emptyManifest(), A, "../escape.bin", 100, "2026-08-23T01:00:00.000Z"), /simple .bin filename/);
  assert.throws(() => createLocalHostKvStateManifest({ hostId: "host", storage: STORAGE, states: [{
    sessionKey: kvSessionKey(A), fingerprint: FINGERPRINT, filename: "a.bin", bytes: 1001, promptTokens: 1,
    savedAt: "2026-08-23T01:00:00.000Z", lastAccessedAt: "2026-08-23T01:00:00.000Z",
  }] }), /exceeds its disk budget/);
});

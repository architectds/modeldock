import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { kvSessionKey } from "../src/local-host-kv-state.mjs";
import { LocalHostKvStateStore } from "../src/local-host-kv-store.mjs";

const FINGERPRINT = "llama-b10549:qwen-q4:262144:q4_0:q4_0";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-kv-store-"));
  const storage = { directory: path.join(root, "slot-files"), budgetBytes: 1000 };
  const manifestFile = path.join(root, "manifest.json");
  const calls = [];
  const client = {
    async save({ filename }) {
      calls.push({ action: "save", filename });
      await writeFile(path.join(storage.directory, filename), Buffer.alloc(400), "utf8");
      return { bytes: 400, promptTokens: 20, saveMs: 3 };
    },
    async restore({ filename }) {
      calls.push({ action: "restore", filename });
      return { bytes: 400, promptTokens: 20, restoreMs: 4 };
    },
  };
  let nextId = 0;
  const store = new LocalHostKvStateStore({
    hostId: "host-qwen",
    storage,
    manifestFile,
    slotClient: client,
    makeId: () => `state-${++nextId}`,
  });
  return { root, storage, manifestFile, calls, store };
}

test("slot-state save persists an exact metadata manifest before removing LRU files", async () => {
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    const b = kvSessionKey({ conversationId: "b" });
    const first = await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    assert.equal(first.saved, true);
    assert.equal(first.state.filename, "slot-state1.bin");
    const second = await fixture.store.save({ sessionKey: b, fingerprint: FINGERPRINT, at: "2026-08-23T01:01:00.000Z" });
    assert.equal(second.saved, true);
    const manifest = await fixture.store.load();
    assert.equal(manifest.totalBytes, 800);
    assert.deepEqual(manifest.states.map((entry) => entry.filename), ["slot-state1.bin", "slot-state2.bin"]);
    assert.equal((await stat(path.join(fixture.storage.directory, "slot-state1.bin"))).size, 400);
    assert.match(await readFile(fixture.manifestFile, "utf8"), /"budgetBytes": 1000/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("store removes only manifest-evicted LRU files after a later state is durable", async () => {
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    const b = kvSessionKey({ conversationId: "b" });
    const c = kvSessionKey({ conversationId: "c" });
    await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    await fixture.store.save({ sessionKey: b, fingerprint: FINGERPRINT, at: "2026-08-23T01:01:00.000Z" });
    const third = await fixture.store.save({ sessionKey: c, fingerprint: FINGERPRINT, at: "2026-08-23T01:02:00.000Z" });
    assert.deepEqual(third.evicted.map((entry) => entry.filename), ["slot-state1.bin"]);
    const manifest = await fixture.store.load();
    assert.deepEqual(manifest.states.map((entry) => entry.filename), ["slot-state2.bin", "slot-state3.bin"]);
    assert.equal(await stat(path.join(fixture.storage.directory, "slot-state1.bin")).then(() => true, () => false), false);
    assert.equal(await stat(path.join(fixture.storage.directory, "slot-state2.bin")).then(() => true, () => false), true);
    assert.equal(await stat(path.join(fixture.storage.directory, "slot-state3.bin")).then(() => true, () => false), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("slot-state save refuses a file larger than the user budget and deletes only that new file", async () => {
  const fixture = await setup();
  try {
    fixture.store.slotClient.save = async ({ filename }) => {
      fixture.calls.push({ action: "save", filename });
      await writeFile(path.join(fixture.storage.directory, filename), Buffer.alloc(1001), "utf8");
      return { bytes: 1001, promptTokens: 50, saveMs: 3 };
    };
    const result = await fixture.store.save({ sessionKey: kvSessionKey({ conversationId: "a" }), fingerprint: FINGERPRINT });
    assert.deepEqual(result, { saved: false, reason: "state_exceeds_budget", discardedBytes: 1001, evicted: [] });
    assert.equal(await fixture.store.load().then((manifest) => manifest.states.length), 0);
    assert.equal(await stat(path.join(fixture.storage.directory, "slot-state1.bin")).then(() => true, () => false), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("slot-state restore is session- and fingerprint-exact, and a missing file becomes a safe cold miss", async () => {
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    const noCrossSession = await fixture.store.restore({ sessionKey: kvSessionKey({ conversationId: "b" }), fingerprint: FINGERPRINT });
    assert.deepEqual(noCrossSession, { restored: false, reason: "not_found" });
    const noCrossHost = await fixture.store.restore({ sessionKey: a, fingerprint: "changed-host" });
    assert.deepEqual(noCrossHost, { restored: false, reason: "not_found" });
    const restored = await fixture.store.restore({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:02:00.000Z" });
    assert.equal(restored.restored, true);
    assert.deepEqual(fixture.calls.at(-1), { action: "restore", filename: "slot-state1.bin" });

    await rm(path.join(fixture.storage.directory, "slot-state1.bin"));
    const missing = await fixture.store.restore({ sessionKey: a, fingerprint: FINGERPRINT });
    assert.deepEqual(missing, { restored: false, reason: "missing" });
    assert.equal((await fixture.store.load()).states.length, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fingerprint invalidation leaves only states compatible with the restarted host", async () => {
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT });
    const invalidated = await fixture.store.invalidateExcept({ fingerprint: "new-build" });
    assert.deepEqual(invalidated.invalidated.map((entry) => entry.filename), ["slot-state1.bin"]);
    assert.equal((await fixture.store.load()).states.length, 0);
    assert.equal(await stat(path.join(fixture.storage.directory, "slot-state1.bin")).then(() => true, () => false), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

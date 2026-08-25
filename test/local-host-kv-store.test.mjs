import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
    makeId: () => String(++nextId).padStart(32, "0"),
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
    assert.match(first.state.filename, /^slot-[a-f0-9]{12}-[a-f0-9]{32}\.bin$/);
    const second = await fixture.store.save({ sessionKey: b, fingerprint: FINGERPRINT, at: "2026-08-23T01:01:00.000Z" });
    assert.equal(second.saved, true);
    const manifest = await fixture.store.load();
    assert.equal(manifest.totalBytes, 800);
    assert.deepEqual(manifest.states.map((entry) => entry.filename), [first.state.filename, second.state.filename]);
    assert.equal((await stat(path.join(fixture.storage.directory, first.state.filename))).size, 400);
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
    const first = await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    const second = await fixture.store.save({ sessionKey: b, fingerprint: FINGERPRINT, at: "2026-08-23T01:01:00.000Z" });
    const third = await fixture.store.save({ sessionKey: c, fingerprint: FINGERPRINT, at: "2026-08-23T01:02:00.000Z" });
    assert.deepEqual(third.evicted.map((entry) => entry.filename), [first.state.filename]);
    const manifest = await fixture.store.load();
    assert.deepEqual(manifest.states.map((entry) => entry.filename), [second.state.filename, third.state.filename]);
    assert.equal(await stat(path.join(fixture.storage.directory, first.state.filename)).then(() => true, () => false), false);
    assert.equal(await stat(path.join(fixture.storage.directory, second.state.filename)).then(() => true, () => false), true);
    assert.equal(await stat(path.join(fixture.storage.directory, third.state.filename)).then(() => true, () => false), true);
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
    assert.equal(await stat(path.join(fixture.storage.directory, fixture.calls[0].filename)).then(() => true, () => false), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("slot-state restore is session- and fingerprint-exact, and a missing file becomes a safe cold miss", async () => {
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    const saved = await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    const noCrossSession = await fixture.store.restore({ sessionKey: kvSessionKey({ conversationId: "b" }), fingerprint: FINGERPRINT });
    assert.deepEqual(noCrossSession, { restored: false, reason: "not_found" });
    const noCrossHost = await fixture.store.restore({ sessionKey: a, fingerprint: "changed-host" });
    assert.deepEqual(noCrossHost, { restored: false, reason: "not_found" });
    const restored = await fixture.store.restore({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:02:00.000Z" });
    assert.equal(restored.restored, true);
    assert.deepEqual(fixture.calls.at(-1), { action: "restore", filename: saved.state.filename });

    await rm(path.join(fixture.storage.directory, saved.state.filename));
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
    const saved = await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT });
    const invalidated = await fixture.store.invalidateExcept({ fingerprint: "new-build" });
    assert.deepEqual(invalidated.invalidated.map((entry) => entry.filename), [saved.state.filename]);
    assert.equal((await fixture.store.load()).states.length, 0);
    assert.equal(await stat(path.join(fixture.storage.directory, saved.state.filename)).then(() => true, () => false), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("startup GC removes only this host's uncommitted slot files", async () => {
  const fixture = await setup();
  try {
    const saved = await fixture.store.save({
      sessionKey: kvSessionKey({ conversationId: "a" }),
      fingerprint: FINGERPRINT,
    });
    const orphan = saved.state.filename.replace(/[a-f0-9]{32}\.bin$/, `${"f".repeat(32)}.bin`);
    const unrelated = "slot-user-owned.bin";
    await writeFile(path.join(fixture.storage.directory, orphan), "orphan", "utf8");
    await writeFile(path.join(fixture.storage.directory, unrelated), "keep", "utf8");
    const result = await fixture.store.gcOrphans();
    assert.deepEqual(result.removed, [orphan]);
    assert.equal(await stat(path.join(fixture.storage.directory, saved.state.filename)).then(() => true, () => false), true);
    assert.equal(await stat(path.join(fixture.storage.directory, unrelated)).then(() => true, () => false), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an unusable manifest is quarantined instead of bricking the store", async () => {
  // Reproduced live before the heal: corrupt JSON made every load() throw
  // forever - SSD tier silently dead, gcOrphans dead with it, and the
  // referenced multi-GB files unreclaimable until a human deleted the file.
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    await writeFile(fixture.manifestFile, "{not json", "utf8");
    const healed = await fixture.store.load();
    assert.equal(healed.states.length, 0, "the store restarts empty");
    const quarantined = (await readdir(path.dirname(fixture.manifestFile)))
      .filter((name) => name.startsWith("manifest.json.corrupt-"));
    assert.equal(quarantined.length, 1, "the evidence survives beside the original");
    const next = await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:02:00.000Z" });
    assert.equal(next.saved, true, "the subsystem keeps working after the heal");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a lowered budget is adopted by evicting LRU states, not by refusing to load", async () => {
  // unmanage -> re-manage with a smaller GiB value used to make load() throw
  // "exceeds its disk budget" forever (reproduced live). The budget is policy,
  // not identity: adopt it and evict the least recently used states to fit.
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    const b = kvSessionKey({ conversationId: "b" });
    const first = await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    const second = await fixture.store.save({ sessionKey: b, fingerprint: FINGERPRINT, at: "2026-08-23T01:01:00.000Z" });
    const smaller = new LocalHostKvStateStore({
      hostId: "host-qwen",
      storage: { directory: fixture.storage.directory, budgetBytes: 500 },
      manifestFile: fixture.manifestFile,
      slotClient: { async save() { throw new Error("unused"); }, async restore() { throw new Error("unused"); } },
    });
    const manifest = await smaller.load();
    assert.equal(manifest.storage.budgetBytes, 500, "the live budget is adopted");
    assert.deepEqual(manifest.states.map((entry) => entry.filename), [second.state.filename], "LRU state evicted to fit");
    await assert.rejects(() => stat(path.join(fixture.storage.directory, first.state.filename)), /ENOENT/, "the evicted file is reclaimed");
    assert.equal((await stat(path.join(fixture.storage.directory, second.state.filename))).size, 400, "the survivor is untouched");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a re-spelled storage directory is the same directory on Windows", async () => {
  // The server compared case-insensitively while the store compared
  // byte-for-byte, so D:/ModelDock/KV vs d:/modeldock/kv bricked the store on
  // the platform this feature targets first (reproduced live).
  if (process.platform !== "win32") return;
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    const respelled = new LocalHostKvStateStore({
      hostId: "host-qwen",
      storage: { directory: fixture.storage.directory.toUpperCase(), budgetBytes: 1000 },
      manifestFile: fixture.manifestFile,
      slotClient: { async save() { throw new Error("unused"); }, async restore() { throw new Error("unused"); } },
    });
    const manifest = await respelled.load();
    assert.equal(manifest.states.length, 1, "the states survive a case drift");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("states untouched for a week expire at the boot hygiene pass", async () => {
  // Space is budget-capped; the TTL bounds time. A conversation that never
  // returns must not squat in the budget for months, and the price of an
  // expired state that does return is one cold prefill.
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    const b = kvSessionKey({ conversationId: "b" });
    const old = await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-10T01:00:00.000Z" });
    const fresh = await fixture.store.save({ sessionKey: b, fingerprint: FINGERPRINT, at: "2026-08-22T01:00:00.000Z" });
    const result = await fixture.store.expireStale({ now: Date.parse("2026-08-23T01:00:00.000Z") });
    assert.deepEqual(result.expired.map((state) => state.filename), [old.state.filename], "13 days idle is past the 7-day TTL");
    await assert.rejects(() => stat(path.join(fixture.storage.directory, old.state.filename)), /ENOENT/, "the expired file is reclaimed");
    const manifest = await fixture.store.load();
    assert.deepEqual(manifest.states.map((state) => state.filename), [fresh.state.filename], "the day-old state survives");
    const again = await fixture.store.expireStale({ now: Date.parse("2026-08-23T01:00:00.000Z") });
    assert.equal(again.expired.length, 0, "a quiet pass writes nothing");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("clearAll reclaims every checkpoint and reports synchronous totals", async () => {
  const fixture = await setup();
  try {
    const a = kvSessionKey({ conversationId: "a" });
    const b = kvSessionKey({ conversationId: "b" });
    await fixture.store.save({ sessionKey: a, fingerprint: FINGERPRINT, at: "2026-08-23T01:00:00.000Z" });
    await fixture.store.save({ sessionKey: b, fingerprint: FINGERPRINT, at: "2026-08-23T01:01:00.000Z" });
    assert.deepEqual(fixture.store.totals(), { totalBytes: 800, budgetBytes: 1000, states: 2 }, "totals answer without touching the disk");
    const result = await fixture.store.clearAll();
    assert.equal(result.cleared.length, 2);
    assert.deepEqual(fixture.store.totals(), { totalBytes: 0, budgetBytes: 1000, states: 0 }, "totals follow the clear");
    const leftover = (await readdir(fixture.storage.directory)).filter((name) => name.endsWith(".bin"));
    assert.deepEqual(leftover, [], "every checkpoint file is reclaimed");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

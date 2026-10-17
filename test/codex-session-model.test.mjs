import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { compactionThreadId, readCodexSessionModel } from "../src/codex-session-model.mjs";

const parent = "00000000-0000-0000-0000-000000000001";
const child = "00000000-0000-0000-0000-000000000002";
function home(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-session-model-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function database(root, version = 5, columns = "id TEXT PRIMARY KEY, model TEXT") {
  const db = new DatabaseSync(path.join(root, `state_${version}.sqlite`));
  db.exec(`CREATE TABLE threads (${columns})`);
  return db;
}

test("compaction identifies the actual thread, never its parent's affinity", () => {
  const headers = { session_id: parent, "x-codex-parent-thread-id": parent,
    "x-codex-turn-metadata": JSON.stringify({ thread_id: child, session_id: parent }) };
  assert.equal(compactionThreadId(headers), child);
  assert.equal(compactionThreadId(new Headers(headers)), child);
  assert.equal(compactionThreadId({ "x-codex-parent-thread-id": parent }), "");
  assert.equal(compactionThreadId({ session_id: "../../auth.json" }), "");
  assert.equal(compactionThreadId({ session_id: child, "x-codex-turn-metadata": "{" }), child);
  assert.equal(compactionThreadId({ "x-codex-thread-id": child, session_id: parent }), child);
  assert.equal(compactionThreadId({ session_id: [child] }), child);
});

test("compaction reads fresh per-thread picker settings without modifying the database", (t) => {
  const root = home(t);
  const db = database(root);
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(parent, "old@provider");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(child, "new@provider");
  const read = (id) => readCodexSessionModel(root, { session_id: id });
  assert.equal(read(parent), "old@provider");
  assert.equal(read(child), "new@provider");
  db.prepare("UPDATE threads SET model = ? WHERE id = ?").run("gpt-6.1-sol", child);
  assert.equal(read(child), "gpt-6.1-sol", "a switch must be visible before any request on the new model");
  db.close();
  const file = path.join(root, "state_5.sqlite");
  const before = readFileSync(file);
  const files = readdirSync(root);
  assert.equal(read(child), "gpt-6.1-sol");
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(root), files);
});

test("missing, malformed, incompatible or locked state preserves the request model", (t) => {
  const root = home(t);
  const headers = { session_id: child };
  assert.equal(readCodexSessionModel(root, headers), "");
  assert.deepEqual(readdirSync(root), [], "a lookup must not create a database");
  const db = database(root, 5);
  db.prepare("INSERT INTO threads VALUES (?, ?)").run(child, "stale@provider");
  db.close();
  const newest = database(root, 10);
  assert.equal(readCodexSessionModel(root, headers), "", "do not consult obsolete schemas on a miss");
  newest.prepare("INSERT INTO threads VALUES (?, ?)").run(child, "bad\nmodel");
  assert.equal(readCodexSessionModel(root, headers), "");
  newest.exec("BEGIN EXCLUSIVE");
  assert.equal(readCodexSessionModel(root, headers), "", "busy state must not block compaction");
  newest.exec("ROLLBACK"); newest.close();
  const future = database(root, 11, "id TEXT"); future.close();
  assert.equal(readCodexSessionModel(root, headers), "");
  writeFileSync(path.join(root, "state_12.sqlite"), "not sqlite");
  assert.equal(readCodexSessionModel(root, headers), "");
  assert.equal(readCodexSessionModel(root, {}), "");
});

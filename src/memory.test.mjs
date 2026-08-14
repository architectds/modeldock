import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_SCHEMA, MemoryStore, migrateLegacyMemory, nodeDbPathFor, scopeNodeId } from "./memory.mjs";

function memoryDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-memory-test-"));
  const memories = path.join(dir, "memories");
  mkdirSync(memories, { recursive: true });
  return { dir, memories };
}

function storeFor(dir) {
  return new MemoryStore({ memoryDir: path.join(dir, "vault") });
}

function writeFixture(memories, { baseline = true } = {}) {
  if (baseline) {
    writeFileSync(path.join(memories, "MEMORY.md"), [
      "# Task Group: StockScan QCM current baseline",
      "",
      "scope: baseline memory for stockscan.",
      "applies_to: cwd=\\\\?\\D:\\projects\\stockscan|\\\\?\\D:\\projects\\stockscan-backtest; reuse_rule=current until frozen.",
      "",
      "## Reusable knowledge",
      "",
      "The current QCM baseline is the DIVO cash-sleeve version with quality >= 280.",
      "",
    ].join("\n"), "utf8");
  }
  writeFileSync(path.join(memories, "memory_summary.md"), [
    "# Rolling summary",
    "",
    "General notes apply to every project.",
    "",
  ].join("\n"), "utf8");
}

test("capture indexes memory files and search finds them", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = storeFor(dir);
  try {
    const captured = store.captureCodexMemories(dir);
    assert.equal(captured.ok, true);
    assert.equal(captured.scanned, 2);
    assert.equal(captured.captured, 2);
    assert.equal(captured.skipped, 0);
    assert.ok(captured.units >= 2, `expected at least 2 units, got ${captured.units}`);

    const status = store.status();
    assert.equal(status.sources, 1);
    assert.equal(status.source_items, 2);
    assert.equal(status.source_revisions, 2);
    assert.equal(status.content_units, captured.units);

    const hit = store.search({ query: "DIVO cash-sleeve baseline" });
    assert.equal(hit.count, 1);
    assert.match(hit.text, /QCM current baseline/);
    assert.match(hit.text, /trusted_instruction/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall filters by working-directory scope", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = storeFor(dir);
  try {
    store.captureCodexMemories(dir);

    const scoped = store.search({ query: "baseline", scopeDir: "D:\\projects\\stockscan" });
    assert.ok(scoped.count >= 1, "scoped project can recall its baseline");
    assert.match(scoped.text, /StockScan/);

    const other = store.search({ query: "baseline", scopeDir: "D:\\projects\\other-project" });
    assert.ok(!other.text.includes("QCM current baseline"), "other project does not see stockscan memory");

    const unscoped = store.search({ query: "every project" });
    assert.equal(unscoped.count, 1, "unscoped unit matches everywhere");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scopeOnly restricts recall to the project bucket and never falls back to global", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const projA = path.join(dir, "proj-a");
  const projB = path.join(dir, "proj-b");
  mkdirSync(projA);
  try {
    store.storeMemory({ content: "General note visible everywhere.", scopeDir: null, kind: "knowledge" });
    store.storeMemory({
      content: "StockScan strict baseline lives in stockscan only.",
      scopeDir: projA,
      kind: "baseline",
    });

    const layered = store.search({ query: "visible everywhere", scopeDir: projB });
    assert.ok(layered.count >= 1, "layered recall falls back to global when the project misses");

    const strictMiss = store.search({
      query: "visible everywhere",
      scopeDir: projB,
      scopeOnly: true,
    });
    assert.equal(strictMiss.count, 0, "strict recall never sees global memory from another project");

    const strictHit = store.search({
      query: "strict baseline",
      scopeDir: projA,
      scopeOnly: true,
    });
    assert.ok(strictHit.count >= 1, "strict recall still finds the project's own memory");
    assert.match(strictHit.text, /StockScan/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storeMemory persists an explicit memory scoped to a project", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const project = path.join(dir, "proj-stockscan");
  mkdirSync(project);
  try {
    const saved = store.storeMemory({
      content: "The QCM baseline uses the DIVO cash-sleeve version with quality >= 280.",
      scopeDir: project,
      kind: "baseline",
    });
    assert.equal(saved.stored, true);
    assert.equal(saved.revision, 1);
    assert.equal(saved.units, 1);
    assert.equal(saved.scope, project);

    const hit = store.search({ query: "DIVO baseline", scopeDir: project });
    assert.equal(hit.count, 1);
    assert.match(hit.text, /\[1\] baseline/);
    assert.match(hit.text, /agent_output/);

    const other = store.search({ query: "DIVO baseline", scopeDir: "D:\\projects\\other-project" });
    assert.equal(other.count, 0, "scoped memory stays out of other projects");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search layers project hits first and falls back to global", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const project = path.join(dir, "proj-stockscan");
  mkdirSync(project);
  try {
    store.storeMemory({
      content: "The QCM baseline uses the DIVO cash-sleeve version.",
      scopeDir: project,
      kind: "baseline",
    });
    store.storeMemory({
      content: "A preference: always verify the baseline before claiming a fix.",
      kind: "preference",
    });

    const projectOnly = store.search({ query: "baseline", scopeDir: project, limit: 1 });
    assert.equal(projectOnly.count, 1, "the project-scoped hit fills the single slot");
    assert.match(projectOnly.text, /\[1\] baseline/);

    const layered = store.search({ query: "baseline", scopeDir: project, limit: 5 });
    assert.equal(layered.count, 2, "project miss falls back upward to the global bucket");
    assert.ok(
      layered.text.indexOf("[1] baseline") < layered.text.indexOf("[2] preference"),
      "project hits rank ahead of the global fallback",
    );

    const full = store.search({ query: "baseline" });
    assert.equal(full.count, 1, "without working-directory context the recall stays in the global node");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall falls back to permissive OR when the strict AND misses", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  try {
    store.storeMemory({
      content: "The benchmark harness proves ModelDock tools amplify DeepSeek on DeepSWE.",
      kind: "knowledge",
    });

    const hits = store.search({ query: "deepswe best practices" });
    assert.ok(hits.count >= 1, "extra query words must not empty the recall");
    assert.match(hits.text, /DeepSWE/);

    const scoped = store.search({ query: "deepswe best practices", scopeDir: "D:\\projects\\stockscan" });
    assert.ok(scoped.count >= 1, "the OR fallback still reaches unscoped global rows from a project scope");
    assert.match(scoped.text, /DeepSWE/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storeMemory dedupes identical content and supersedes via a stable key", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  try {
    const first = store.storeMemory({ content: "Prefer fast iteration.", kind: "preference", key: "iter-style" });
    assert.equal(first.stored, true);

    const duplicate = store.storeMemory({ content: "Prefer fast iteration.", kind: "preference", key: "iter-style" });
    assert.equal(duplicate.stored, false, "identical content with the same key is a no-op");

    const updated = store.storeMemory({
      content: "Prefer fast iteration with daily checkpoints.",
      kind: "preference",
      key: "iter-style",
    });
    assert.equal(updated.stored, true);
    assert.equal(updated.revision, 2, "same key creates a new revision");

    const hit = store.search({ query: "checkpoints" });
    assert.equal(hit.count, 1, "superseded revision is not recalled");
    assert.match(hit.text, /daily checkpoints/);
    assert.match(hit.text, /key: iter-style/, "recall output exposes the stable key");

    const states = store.nodeDb("global").prepare("SELECT memory_state, COUNT(*) AS n FROM content_units GROUP BY memory_state").all();
    const byState = Object.fromEntries(states.map((row) => [row.memory_state, row.n]));
    assert.ok(byState.superseded >= 1, "old key revision is marked superseded");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recall exposes the key so a later session can correct the entry", () => {
  const { dir } = memoryDir();
  let store = storeFor(dir);
  try {
    store.storeMemory({ content: "Trading rule: buy only above MA200.", kind: "baseline", key: "ma200-rule" });
    store.close();
    // A later session has only the recall output to work from.
    store = storeFor(dir);
    const hit = store.search({ query: "MA200" });
    assert.equal(hit.count, 1);
    assert.match(hit.text, /key: ma200-rule/);
    const key = /key: (\S+)/.exec(hit.text)?.[1];
    const updated = store.storeMemory({
      content: "Trading rule: buy above MA200 with a volume filter.",
      kind: "baseline",
      key,
    });
    assert.equal(updated.stored, true);
    assert.equal(updated.revision, 2, "same key from recall creates a new revision");
    const fresh = store.search({ query: "volume filter" });
    assert.equal(fresh.count, 1);
    assert.match(fresh.text, /volume filter/);
    assert.ok(!fresh.text.includes("buy only above"), "superseded text is not recalled");
  } finally {
    try {
      store.close();
    } catch {
      // Already closed by the test body.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory events and content view track stores and captures", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = storeFor(dir);
  const proj = path.join(dir, "proj-stockscan");
  mkdirSync(proj);
  try {
    store.captureCodexMemories(dir);
    store.storeMemory({ content: "Remember the DIVO baseline.", scopeDir: proj, kind: "baseline" });

    const events = store.recentEvents(10);
    assert.ok(events.some((event) => event.kind === "capture"), "capture event recorded");
    assert.ok(
      events.some((event) => event.kind === "store_memory" && event.scope === proj),
      "store event recorded with scope",
    );
    assert.ok(events.some((event) => event.detail.stored === true), "store event carries detail");

    const view = store.contentView(50);
    assert.ok(view.some((unit) => unit.head === "baseline"), "stored memory appears in content view");
    assert.ok(view.some((unit) => unit.source_adapter === "codex-memories"), "captured files appear in content view");
    assert.ok(view.every((unit) => typeof unit.text === "string" && unit.text.length <= 400), "content view truncates text");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unchanged files are no-ops and edits create superseded revisions", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = storeFor(dir);
  try {
    store.captureCodexMemories(dir);
    const second = store.captureCodexMemories(dir);
    assert.equal(second.skipped, 2, "identical bytes skip");

    writeFileSync(path.join(memories, "MEMORY.md"), [
      "# Task Group: StockScan QCM current baseline",
      "",
      "applies_to: cwd=\\\\?\\D:\\projects\\stockscan; reuse_rule=current until frozen.",
      "",
      "The baseline was updated: DIVO cash sleeve with a new threshold.",
      "",
    ].join("\n"), "utf8");
    const third = store.captureCodexMemories(dir);
    assert.equal(third.captured, 1);
    assert.equal(store.status().source_revisions, 3, "MEMORY.md gained a second revision");

    const latest = store.search({ query: "updated threshold", scopeDir: "D:\\projects\\stockscan" });
    assert.equal(latest.count, 1);
    const node = store.nodeDb("global");
    const states = node.prepare("SELECT memory_state, COUNT(*) AS n FROM content_units GROUP BY memory_state").all();
    const byState = Object.fromEntries(states.map((row) => [row.memory_state, row.n]));
    assert.ok(byState.superseded >= 1, "old revision units are superseded");
    assert.ok(byState.captured >= 1, "new revision units are captured");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("search rejects empty queries and punctuation-only input", () => {
  const { dir, memories } = memoryDir();
  writeFixture(memories);
  const store = storeFor(dir);
  try {
    store.captureCodexMemories(dir);
    assert.throws(() => store.search({ query: "   " }), /non-empty query/);
    assert.throws(() => store.search({ query: "--- !!!" }), /non-empty query/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope matching covers POSIX subdirectories, not just Windows backslashes", () => {
  const { dir, memories } = memoryDir();
  writeFileSync(path.join(memories, "MEMORY.md"), [
    "# POSIX scoped baseline",
    "",
    "scope: posix project.",
    "applies_to: cwd=/home/dev/stockscan; reuse_rule=current.",
    "",
    "## Reusable knowledge",
    "",
    "The POSIX project baseline is the stable version.",
    "",
  ].join("\n"), "utf8");
  const store = storeFor(dir);
  try {
    store.captureCodexMemories(dir);
    const hit = store.search({ query: "POSIX project baseline", scopeDir: "/home/dev/stockscan/subdir" });
    assert.ok(hit.count >= 1, "a project subdirectory should match the parent scope");
    assert.match(hit.text, /POSIX project baseline/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("old superseded revisions are pruned while the newest history survives", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  try {
    for (let i = 1; i <= 12; i += 1) {
      store.storeMemory({ content: `token${i} baseline`, key: "entry-key" });
    }
    const status = store.status();
    assert.equal(status.source_revisions, 10, "only the newest MAX_REVISIONS_KEPT revisions remain");
    const hit = store.search({ query: "token12 baseline" });
    assert.equal(hit.count, 1, "the newest revision is still recallable");
    const older = store.search({ query: "token1" });
    assert.equal(older.count, 0, "pruned superseded revisions are gone from recall");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-commit maintenance contention does not report a committed store as failed", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const globalFile = nodeDbPathFor(path.join(dir, "vault"), "global");
  const lock = new DatabaseSync(globalFile);
  const project = path.join(dir, "proj-locked");
  mkdirSync(project);
  try {
    lock.exec("BEGIN EXCLUSIVE");
    const startedAt = Date.now();
    const result = store.storeMemory({ content: "committed under event contention", scopeDir: project, key: "locked-event" });
    assert.equal(result.ok, true);
    assert.ok(Date.now() - startedAt < 2000, "soft event maintenance must not wait for the canonical-write busy timeout");
    const projectDb = store.nodeDb(scopeNodeId(project));
    assert.equal(projectDb.prepare("SELECT COUNT(*) AS n FROM source_revisions").get().n, 1, "the capture was committed");
  } finally {
    try { lock.exec("ROLLBACK"); } catch { /* already released */ }
    lock.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stores project memories in independent nodes and exposes node aggregates", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const project = path.join(dir, "proj-modeldock");
  mkdirSync(project);
  try {
    store.storeMemory({ content: "Project-only routing rule.", scopeDir: project, kind: "decision" });
    const projectNode = scopeNodeId(project);
    const projectDb = path.join(project, ".modeldock", "memory.db");
    assert.equal(existsSync(projectDb), true, "the project db lives inside the project folder");
    assert.equal(projectDb, store.nodes().find((node) => node.nodeId === projectNode)?.dbPath);
    assert.equal(store.nodeDb(projectNode).prepare("SELECT COUNT(*) AS n FROM content_units").get().n, 1);
    assert.equal(store.nodeDb("global").prepare("SELECT COUNT(*) AS n FROM content_units").get().n, 0);
    const registry = store.nodeDb("global").prepare("SELECT node_id, node_path, label FROM node_registry WHERE node_id = ?").get(projectNode);
    assert.ok(registry, "the project node is registered in the global index");
    assert.equal(registry.node_path, project);
    assert.deepEqual(store.status().nodes.sort(), ["global", projectNode].sort());
    assert.ok(store.contentView(20).some((row) => row.node === projectNode));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("global registry indexes project memories and discovery recalls them", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const stockscan = path.join(dir, "proj-stockscan");
  const voxel = path.join(dir, "proj-voxel");
  for (const scope of [stockscan, voxel]) mkdirSync(scope);
  try {
    store.storeMemory({ content: "DIVO cash-sleeve baseline with quality >= 280.", scopeDir: stockscan, kind: "baseline" });
    store.storeMemory({ content: "Deterministic frame capture pipeline.", scopeDir: voxel, kind: "knowledge" });

    const found = store.search({ query: "stockscan" });
    assert.equal(found.count, 1, "the registry surfaces the project node by name");
    assert.match(found.text, /project memory: /);
    assert.match(found.text, /node_registry/);

    const drilled = store.search({ query: "DIVO cash-sleeve", scopeDir: stockscan });
    assert.ok(drilled.count >= 1, "the project's own db is reachable through its registered path");
    assert.match(drilled.text, /DIVO cash-sleeve baseline/);

    const all = store.nodes().map((node) => node.nodeId);
    assert.ok(all.includes(scopeNodeId(stockscan)), "project nodes are enumerated through the registry");
    assert.ok(all.includes(scopeNodeId(voxel)));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-directory scope falls back to the centralized vault", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const blocker = path.join(dir, "not-a-directory");
  writeFileSync(blocker, "blocking file", "utf8");
  try {
    const result = store.storeMemory({ content: "Portable fallback memory.", scopeDir: blocker, kind: "knowledge" });
    assert.equal(result.ok, true);
    const nodeId = scopeNodeId(blocker);
    const node = store.nodeDb(nodeId);
    assert.ok(node, "the node still exists through the fallback");
    assert.equal(node.prepare("SELECT COUNT(*) AS n FROM content_units").get().n, 1);
    const hit = store.search({ query: "Portable fallback", scopeDir: blocker });
    assert.equal(hit.count, 1);
    const fallbackFile = path.join(dir, "vault", "nodes");
    assert.ok(
      existsSync(fallbackFile),
      "the fallback lives under the centralized vault rather than creating directories from a bogus scope",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("links compose recall across nodes without copying knowledge", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const project = path.join(dir, "proj-modeldock");
  const sharedCore = path.join(dir, "proj-shared-core");
  const linked = path.join(dir, "proj-shared-patterns");
  for (const scope of [project, sharedCore, linked]) mkdirSync(scope);
  try {
    store.storeMemory({ content: "Shared rule: preserve stable interfaces across tools.", scopeDir: sharedCore, kind: "knowledge" });
    store.storeMemory({ content: "Linked pattern: use append-only event records.", scopeDir: linked, kind: "knowledge" });
    store.storeMemory({ content: "Project fact: ModelDock uses a thin gateway.", scopeDir: project, kind: "baseline" });
    store.link({ fromScope: project, toScope: sharedCore, kind: "reference", label: "shared rule" });
    store.link({ fromScope: project, toScope: linked, kind: "reference", label: "shared pattern" });

    const hit = store.search({ query: "interfaces append-only", scopeDir: project, limit: 4 });
    assert.equal(hit.count, 2);
    assert.match(hit.text, /stable interfaces/);
    assert.match(hit.text, /append-only event records/);
    assert.match(hit.text, /via: shared pattern/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing project node still falls back to global", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  try {
    store.storeMemory({ content: "Global fallback guidance.", kind: "knowledge" });
    const hit = store.search({ query: "fallback guidance", scopeDir: "D:\\projects\\not-created-yet" });
    assert.equal(hit.count, 1);
    assert.match(hit.text, /Global fallback guidance/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy single database migrates into global and scoped node files", () => {
  const { dir } = memoryDir();
  const vault = path.join(dir, "vault");
  const legacyPath = path.join(vault, "memory.db");
  mkdirSync(vault, { recursive: true });
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(MEMORY_SCHEMA);
  legacy.prepare("INSERT INTO sources VALUES (?, ?, ?, ?)").run("src_1", "test", "fixture", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO source_items VALUES (?, ?, ?, ?, ?)").run("item_1", "src_1", "fixture", null, "memory");
  legacy.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?, ?)").run("rev_1", "item_1", 1, "sha-1", 10, "2026-01-01T00:00:00.000Z", null);
  legacy.prepare("INSERT INTO source_revisions VALUES (?, ?, ?, ?, ?, ?, ?)").run("rev_2", "item_1", 2, "sha-2", 11, "2026-01-02T00:00:00.000Z", "rev_1");
  legacy.prepare("INSERT INTO content_units VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "unit_1", "rev_1", "knowledge", "Global note", "Global portable note.", "hash-1", "{}", "agent_output", "captured", "", "2026-01-01T00:00:00.000Z",
  );
  legacy.prepare("INSERT INTO content_units VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "unit_2", "rev_2", "baseline", "Project note", "Project portable note.", "hash-2", "D:\\projects\\portable", "agent_output", "captured", "d:\\projects\\portable", "2026-01-02T00:00:00.000Z",
  );
  legacy.prepare("INSERT INTO content_fts VALUES (?, ?, ?)").run("unit_1", "Global note", "Global portable note.");
  legacy.prepare("INSERT INTO content_fts VALUES (?, ?, ?)").run("unit_2", "Project note", "Project portable note.");
  legacy.prepare("INSERT INTO memory_events VALUES (?, ?, ?, ?, ?)").run("evt_1", "store_memory", "global", "{}", "2026-01-01T00:00:00.000Z");
  legacy.close();

  try {
    const result = migrateLegacyMemory({ memoryDir: vault });
    assert.equal(result.skipped, false);
    assert.equal(result.units, 2);
    assert.equal(result.nodes, 2);
    assert.ok(result.backupFiles.length >= 1);
    assert.ok(result.archivePath);
    const store = storeFor(dir);
    try {
      assert.equal(store.search({ query: "portable note" }).count, 1);
      const scoped = store.search({ query: "project portable", scopeDir: "D:\\projects\\portable" });
      assert.equal(scoped.count, 2);
      assert.match(scoped.text, /Project note/);
      assert.equal(store.status().content_units, 2);
      assert.equal(store.status().events, 1);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("learn ingests a directory into scoped memory and supersedes on re-learn", () => {
  const { dir } = memoryDir();
  const store = storeFor(dir);
  const kb = path.join(dir, "kb");
  mkdirSync(kb, { recursive: true });
  writeFileSync(path.join(kb, "a.md"), "# Entry\n\nQuality >= 280.\n", "utf8");
  writeFileSync(path.join(kb, "b.md"), "# Exit\n\nSell on close.\n", "utf8");
  const scope = path.join(dir, "trading");
  try {
    const first = store.learn({ path: kb, scopeDir: scope });
    assert.equal(first.ingested, 2);
    assert.equal(first.skipped, 0);
    assert.equal(first.units, 2);
    assert.equal(first.provenance, "file");

    const hit = store.search({ query: "Quality", scopeDir: scope });
    assert.match(hit.text, /280/);

    const again = store.learn({ path: kb, scopeDir: scope });
    assert.equal(again.ingested, 0);
    assert.equal(again.skipped, 2);

    writeFileSync(path.join(kb, "a.md"), "# Entry\n\nQuality >= 300.\n", "utf8");
    const changed = store.learn({ path: kb, scopeDir: scope });
    assert.equal(changed.ingested, 1);
    assert.equal(changed.skipped, 1);

    const refreshed = store.search({ query: "Quality", scopeDir: scope });
    assert.match(refreshed.text, /300/);
    assert.doesNotMatch(refreshed.text, /280/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

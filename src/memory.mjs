// Persistent memory vault for ModelDock: capture, index, and recall.
//
// Write path is fully automatic and cheap: files are identity-hashed, only new
// revisions create content units, and the old revision's units flip to
// `superseded`. Read path is a permissive FTS5 recall (`recall_memory` MCP
// tool) that lets the model decide relevance; the vault never claims truth.
// The schema is a trimmed form of Backed 1.0's capture model: sources,
// source_items, source_revisions, content_units, plus an FTS5 index.
//
// The vault is node-based: every memory owner is its own SQLite database.
// Project nodes live inside the project folder (<project>/.modeldock/memory.db)
// so the knowledge travels with the project; a read-only or missing project
// folder falls back to a centralized copy under nodes/. `node_registry` in the
// global db indexes every project node (discovery), while `node_meta` holds
// the parent pointer (upward recall fallback) and `links` holds cross-node
// references (fusion). No index file is generated; tables are the only source
// of truth.

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  native_location TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(adapter, native_location)
);
CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  native_id TEXT NOT NULL,
  path TEXT,
  kind TEXT,
  UNIQUE(source_id, native_id)
);
CREATE TABLE IF NOT EXISTS source_revisions (
  id TEXT PRIMARY KEY,
  source_item_id TEXT NOT NULL REFERENCES source_items(id),
  revision INTEGER NOT NULL,
  blob_sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  supersedes_revision_id TEXT,
  UNIQUE(source_item_id, revision)
);
CREATE TABLE IF NOT EXISTS content_units (
  id TEXT PRIMARY KEY,
  source_revision_id TEXT NOT NULL REFERENCES source_revisions(id),
  kind TEXT NOT NULL,
  head TEXT,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  locator TEXT NOT NULL,
  trust_class TEXT NOT NULL,
  memory_state TEXT NOT NULL DEFAULT 'captured',
  scope_paths TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_revision ON content_units(source_revision_id);
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(id UNINDEXED, head, text);
CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS node_registry (
  node_id TEXT PRIMARY KEY,
  node_path TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
`;

const GLOBAL_NODE = "global";
// Revisions kept per source item before older superseded history is pruned,
// and the number of memory events retained (both are soft-history limits; the
// newest data is never touched).
const MAX_REVISIONS_KEPT = 10;
const MAX_EVENTS_KEPT = 2000;
const KNOWN_MEMORY_FILES = [
  { name: "MEMORY.md", trustClass: "trusted_instruction" },
  { name: "memory_summary.md", trustClass: "agent_output" },
  { name: "raw_memories.md", trustClass: "agent_output" },
];

const HEADING_RE = /^#(?!#)\s+(.+?)\s*$/;

function stableId(prefix, ...parts) {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
}

function stripVaultPrefix(raw) {
  return String(raw || "").replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
}

function normalizeScope(dir) {
  return stripVaultPrefix(dir).toLowerCase();
}

// Node identity for a scope: the normalized working directory, or the global
// node when no scope is given. Path-based ids are stable per machine; a link
// whose target db is missing on another machine degrades to a dangling ref.
export function scopeNodeId(scope) {
  return scope ? normalizeScope(scope) : GLOBAL_NODE;
}

function nodeSlug(nodeId) {
  const tail = String(nodeId).split(/[\\/]/).filter(Boolean).slice(-2).join("-");
  const slug = String(tail || "node")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "node";
  return `${slug}_${createHash("sha256").update(nodeId).digest("hex").slice(0, 8)}`;
}

export function nodeDbPathFor(memoryDir, nodeId) {
  if (!nodeId || nodeId === GLOBAL_NODE) return path.join(memoryDir, "global.db");
  return path.join(memoryDir, "nodes", `${nodeSlug(nodeId)}.db`);
}

function extractScopes(text) {
  const match = /applies_to:\s*cwd=([^\n]+)/i.exec(String(text || ""));
  if (!match) return [];
  return match[1]
    .split("|")
    .map((raw) => normalizeScope(String(raw || "").split(";")[0]))
    .filter(Boolean);
}

function splitUnits(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { head: match[1].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    } else if (line.trim()) {
      sections.push({ head: null, body: [line] });
    }
  }
  if (current) sections.push(current);
  return sections;
}

function matchesScope(scopePaths, cwd) {
  const paths = String(scopePaths || "").split("|").filter(Boolean);
  if (!paths.length) return true;
  return paths.some((scopePath) => {
    const base = String(scopePath);
    // Scope paths may come from either platform's layout; match both separators
    // so a POSIX project matches its subdirectories just like a Windows one.
    return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`);
  });
}

function formatHits(hits) {
  if (!hits.length) return "MEMORY_RECALL no hits";
  const lines = [`MEMORY_RECALL ${hits.length} hits`];
  hits.forEach((hit, index) => {
    let locator = {};
    try { locator = JSON.parse(hit.locator || "{}"); } catch { /* keep default */ }
    const source = locator.source || "memory";
    const heading = hit.head || "(untitled)";
    const snippet = String(hit.text || "").replace(/\s+/g, " ").trim().slice(0, 1200);
    lines.push("");
    lines.push(`[${index + 1}] ${heading} (${hit.trust_class}/${hit.memory_state})`);
    lines.push(`key: ${hit.key || "-"}`);
    lines.push(`source: ${source}${locator.heading ? ` > ${locator.heading}` : ""}`);
    if (hit.node && hit.node !== GLOBAL_NODE) lines.push(`node: ${hit.node}`);
    if (hit.provenance) lines.push(`via: ${hit.provenance}`);
    lines.push(snippet);
  });
  return lines.join("\n");
}

export class MemoryStore {
  constructor({ memoryDir }) {
    this.memoryDir = path.resolve(memoryDir);
    mkdirSync(path.join(this.memoryDir, "nodes"), { recursive: true });
    this.dbs = new Map();
    this.dbFiles = new Map();
    // The global node always exists; it is also the home of the event feed.
    this.db = this.#open(GLOBAL_NODE, { create: true });
  }

  close() {
    for (const db of this.dbs.values()) {
      try { db.close(); } catch { /* already closed */ }
    }
    this.dbs.clear();
    this.dbFiles.clear();
  }

  // Public accessor for tooling/tests; returns null when the node has no db.
  nodeDb(nodeId, { create = false } = {}) {
    return this.#open(nodeId || GLOBAL_NODE, { create });
  }

  ensureNode(nodeId) {
    return this.#ensureNode(nodeId || GLOBAL_NODE);
  }

  // Project nodes prefer <project>/.modeldock/memory.db (portable, travels with
  // the repo). A missing or read-only project folder falls back to the
  // centralized nodes/ store so a locked directory never loses a memory.
  #open(nodeId, { create = false, scopePath = null } = {}) {
    if (this.dbs.has(nodeId)) return this.dbs.get(nodeId);
    if (!nodeId || nodeId === GLOBAL_NODE) {
      const file = path.join(this.memoryDir, "global.db");
      if (!create && !existsSync(file)) return null;
      return this.#openFile(nodeId, file, { create });
    }
    let lastError;
    for (const file of this.#nodeCandidates(nodeId, scopePath)) {
      if (!create && !existsSync(file)) continue;
      try {
        if (create) mkdirSync(path.dirname(file), { recursive: true });
        return this.#openFile(nodeId, file, { create });
      } catch (error) {
        lastError = error;
      }
    }
    if (create) throw lastError || new Error(`cannot open memory node ${nodeId}`);
    return null;
  }

  // Ordered candidate files for a project node: the in-project db first (from
  // the caller's scope path or the global registry), then the centralized
  // fallback. Only existing directories are considered for in-project storage,
  // so a bogus scope never creates directories outside the vault.
  #nodeCandidates(nodeId, scopePath) {
    const fallback = path.join(this.memoryDir, "nodes", `${nodeSlug(nodeId)}.db`);
    const candidates = [];
    const knownPath = scopePath || this.#scopePathFor(nodeId);
    if (knownPath) {
      let resolved;
      try { resolved = path.resolve(knownPath); } catch { resolved = null; }
      if (resolved && existsSync(resolved) && statSync(resolved).isDirectory()) {
        candidates.push(path.join(resolved, ".modeldock", "memory.db"));
      }
    }
    candidates.push(fallback);
    return candidates;
  }

  // The registry is the discovery layer: it remembers where a project's db
  // lives so recall and enumeration can open it without the caller repeating
  // the scope path.
  #scopePathFor(nodeId) {
    if (!nodeId || nodeId === GLOBAL_NODE) return null;
    try {
      const row = this.db.prepare("SELECT node_path FROM node_registry WHERE node_id = ? AND status = 'active'").get(nodeId);
      return row?.node_path || null;
    } catch {
      return null;
    }
  }

  #openFile(nodeId, file, { create = false } = {}) {
    // Wait for the write lock instead of failing immediately when another
    // process (a second Codex session on the same project) holds it.
    const db = new DatabaseSync(file, { timeout: 5000 });
    if (create) {
      // A read-only project folder fails here and triggers the fallback.
      db.exec("PRAGMA journal_mode = WAL");
    } else {
      try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* read-only open still works */ }
    }
    db.exec(MEMORY_SCHEMA);
    this.dbs.set(nodeId, db);
    this.dbFiles.set(nodeId, file);
    return db;
  }

  // Explicit writes also register the node in the global discovery index. The
  // registry is cheap metadata; a busy or locked global db must never fail a
  // committed project write.
  #registerNode(nodeId, scopePath) {
    if (!nodeId || nodeId === GLOBAL_NODE || !scopePath) return;
    let resolved;
    try { resolved = path.resolve(scopePath); } catch { return; }
    const now = new Date().toISOString();
    const slug = nodeSlug(nodeId);
    const label = path.basename(resolved) || slug;
    // The registry is discovery metadata, not canonical memory: a locked
    // global db must never block a committed project write.
    this.#tryEventWrite(() => {
      this.db.prepare(`
        INSERT INTO node_registry (node_id, node_path, slug, label, first_seen, last_seen, status)
        VALUES (?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT(node_id) DO UPDATE SET
          node_path = excluded.node_path,
          label = excluded.label,
          last_seen = excluded.last_seen,
          status = 'active'
      `).run(nodeId, resolved, slug, label, now, now);
    });
  }

  #ensureNode(nodeId, scopePath = null) {
    const db = this.#open(nodeId, { create: true, scopePath });
    this.#setMeta(db, "node_id", nodeId);
    if (scopePath) {
      let resolved;
      try { resolved = path.resolve(scopePath); } catch { resolved = String(scopePath); }
      this.#setMeta(db, "scope_path", resolved);
    }
    if (nodeId !== GLOBAL_NODE && !this.#getMeta(db, "parent_id")) {
      this.#setMeta(db, "parent_id", GLOBAL_NODE);
    }
    return db;
  }

  #setMeta(db, key, value) {
    db.prepare("INSERT OR REPLACE INTO node_meta (key, value) VALUES (?, ?)").run(key, String(value));
  }

  #getMeta(db, key) {
    return db.prepare("SELECT value FROM node_meta WHERE key = ?").get(key)?.value ?? "";
  }

  #upsert(db, table, id, columns) {
    const keys = ["id", ...Object.keys(columns)];
    const sql = `INSERT OR IGNORE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
    db.prepare(sql).run(id, ...Object.keys(columns).map((key) => columns[key]));
  }

  // Capture one text file as an immutable source revision. A file whose bytes
  // are unchanged is a no-op; a changed file creates a new revision and marks
  // the previous revision's units superseded.
  captureFile({ filePath, sourceDir, adapter = "folder", trustClass = "external_content" }) {
    const text = readFileSync(filePath, "utf8");
    return this.captureText({
      text,
      sourceDir,
      fileName: path.basename(filePath),
      filePath,
      adapter,
      trustClass,
      nodeId: GLOBAL_NODE,
    });
  }

  // Core write path shared by file capture and explicit store_memory writes.
  // A `key` makes the item updatable (new revisions supersede the old one);
  // without a key the item is a standalone entry that only dedupes on
  // identical content. `nodeId` selects the owning node db; every unit of one
  // source lives in the same node.
  captureText({ text, sourceDir, fileName, filePath = null, adapter, trustClass, itemKey = null, nodeId = GLOBAL_NODE }) {
    const sha = createHash("sha256").update(text).digest("hex");
    const sourceDirAbs = sourceDir ? path.resolve(sourceDir) : "<global>";
    const db = this.#ensureNode(nodeId, nodeId === GLOBAL_NODE ? null : sourceDirAbs);
    if (nodeId !== GLOBAL_NODE) this.#registerNode(nodeId, sourceDirAbs);
    // One write transaction per capture: a concurrent second writer (another
    // session on the same scope) must never observe the "old revision marked
    // superseded, new one not yet inserted" intermediate state.
    db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    let result;
    try {
      const sourceId = stableId("src", adapter, sourceDirAbs);
      this.#upsert(db, "sources", sourceId, { adapter, native_location: sourceDirAbs, created_at: new Date().toISOString() });

      const itemSeed = itemKey || fileName;
      const itemId = stableId("item", sourceId, itemSeed);
      this.#upsert(db, "source_items", itemId, {
        source_id: sourceId,
        native_id: itemSeed,
        path: filePath,
        kind: adapter === "agent_written" ? "memory" : "file",
      });

      const previous = db
        .prepare("SELECT id, revision, blob_sha256 FROM source_revisions WHERE source_item_id = ? ORDER BY revision DESC LIMIT 1")
        .get(itemId);
      if (previous && previous.blob_sha256 === sha) {
        db.exec("COMMIT");
        transactionOpen = false;
        return { skipped: true, revision: previous.revision, sha };
      }

      const revision = previous ? previous.revision + 1 : 1;
      const revisionId = stableId("rev", itemId, revision);
      const observedAt = new Date().toISOString();
      db
        .prepare("INSERT INTO source_revisions (id, source_item_id, revision, blob_sha256, size, observed_at, supersedes_revision_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(revisionId, itemId, revision, sha, Buffer.byteLength(text), observedAt, previous?.id || null);
      if (previous) {
        db.prepare("UPDATE content_units SET memory_state = 'superseded' WHERE source_revision_id = ?").run(previous.id);
      }

      const fileScopes = extractScopes(text);
      const insertUnit = db.prepare(
        "INSERT INTO content_units (id, source_revision_id, kind, head, text, text_hash, locator, trust_class, memory_state, scope_paths, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'captured', ?, ?)",
      );
      const insertFts = db.prepare("INSERT INTO content_fts (id, head, text) VALUES (?, ?, ?)");
      const sections = splitUnits(text);
      let units = 0;
      sections.forEach((section, index) => {
        const body = section.body.join("\n").trim();
        if (!body) return;
        const unitId = stableId("cu", revisionId, index);
        const textHash = createHash("sha256").update(body).digest("hex");
        const locator = JSON.stringify({ source: fileName, heading: section.head, index });
        const sectionScopes = section.body.some((line) => /applies_to/i.test(line))
          ? extractScopes(section.body.join("\n"))
          : fileScopes;
        insertUnit.run(unitId, revisionId, "section", section.head, body, textHash, locator, trustClass, sectionScopes.join("|"), observedAt);
        insertFts.run(unitId, section.head || "", body);
        units += 1;
      });
      db.exec("COMMIT");
      transactionOpen = false;
      result = { skipped: false, revision, units, sha };
    } catch (error) {
      if (transactionOpen) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the transaction error */ }
      }
      throw error;
    }
    // Pruning is soft maintenance after the durable capture. A busy global event
    // database must not turn a committed memory write into an apparent failure;
    // report the deferred maintenance condition to callers instead.
    try {
      this.#pruneNode(db);
    } catch (error) {
      result.maintenanceError = error.message;
    }
    return result;
  }

  // Soft-history limits: drop superseded revisions older than the newest
  // MAX_REVISIONS_KEPT (with their units and FTS rows) and cap the global
  // event feed. Runs on every successful write, so the vault never grows
  // without bound while the recent history stays fully intact.
  #pruneNode(db) {
    const pruneRevisions = () => {
      const old = db
        .prepare(`
          SELECT sr.id FROM source_revisions sr
          WHERE sr.revision <= (
            SELECT MAX(revision) - ? FROM source_revisions s2 WHERE s2.source_item_id = sr.source_item_id
          )
        `)
        .all(MAX_REVISIONS_KEPT);
      if (!old.length) return;
      const unitIds = db.prepare("SELECT id FROM content_units WHERE source_revision_id = ?");
      const deleteFts = db.prepare("DELETE FROM content_fts WHERE id = ?");
      const deleteUnit = db.prepare("DELETE FROM content_units WHERE id = ?");
      const deleteRevision = db.prepare("DELETE FROM source_revisions WHERE id = ?");
      for (const row of old) {
        for (const unit of unitIds.all(row.id)) {
          deleteFts.run(unit.id);
          deleteUnit.run(unit.id);
        }
        deleteRevision.run(row.id);
      }
    };
    db.exec("BEGIN");
    try {
      pruneRevisions();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.#tryEventWrite(() => this.db.exec(`
      DELETE FROM memory_events
      WHERE rowid NOT IN (SELECT rowid FROM memory_events ORDER BY rowid DESC LIMIT ${MAX_EVENTS_KEPT})
    `));
  }

  // Explicit write path: the model asks to persist something from the
  // conversation. A stable `key` updates an existing entry; without it every
  // store is a standalone item, deduped on identical kind + content. The write
  // lands in the scope's own node db (global when no scope is given).
  storeMemory({ content, scopeDir = null, kind = "knowledge", key = null }) {
    const text = String(content || "").trim();
    if (!text) throw new Error("store_memory requires non-empty content");
    const heading = String(kind || "knowledge").trim() || "knowledge";
    const scopeLine = scopeDir ? `applies_to: cwd=${scopeDir}` : "";
    const marked = [`# ${heading}`, scopeLine, text].filter(Boolean).join("\n\n");
    const sha = createHash("sha256").update(marked).digest("hex");
    const fileName = `${heading}:${sha.slice(0, 16)}`;
    const captured = this.captureText({
      text: marked,
      sourceDir: scopeDir || null,
      fileName,
      adapter: "agent_written",
      trustClass: "agent_output",
      itemKey: key || null,
      nodeId: scopeNodeId(scopeDir),
    });
    const result = {
      ok: true,
      stored: !captured.skipped,
      revision: captured.revision,
      units: captured.units || 0,
      kind: heading,
      scope: scopeDir || "global",
    };
    this.#recordEvent("store_memory", result.scope, {
      stored: result.stored,
      revision: result.revision,
      units: result.units,
      kind: heading,
      key: key || null,
    });
    return result;
  }

  // Cross-node reference: a link in the source node's own db pointing at a
  // target node. Recall resolves links one level so global memory can fuse
  // specific project experience without copying its text.
  link({ fromScope = null, toScope, kind = "ref", label = "" }) {
    const fromNode = scopeNodeId(fromScope);
    const toNode = scopeNodeId(toScope);
    if (!toScope) throw new Error("link_memory requires a target scope");
    const db = this.#ensureNode(fromNode, fromScope);
    this.#registerNode(fromNode, fromScope);
    this.#registerNode(toNode, toScope);
    const id = stableId("lnk", fromNode, toNode, kind, label);
    db.prepare("INSERT OR IGNORE INTO links (id, kind, target_node_id, label, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, kind, toNode, label, new Date().toISOString());
    this.#recordEvent("link", fromNode, { to: toNode, kind, label });
    return { ok: true, from: fromNode, to: toNode, kind, label };
  }

  // Capture the Codex client's persistent memory files (~/.codex/memories).
  // MEMORY.md is trusted instruction material; summaries and raw memories are
  // agent output and stay reference material. Captured files land in the
  // global node; their applies_to scopes keep filtering project recall.
  captureCodexMemories(codexHome) {
    const dir = path.join(codexHome, "memories");
    if (!existsSync(dir)) return { ok: false, error: `no memories directory: ${dir}` };
    const result = { ok: true, scanned: 0, captured: 0, skipped: 0, units: 0, files: [] };
    for (const file of KNOWN_MEMORY_FILES) {
      const filePath = path.join(dir, file.name);
      if (!existsSync(filePath)) continue;
      result.scanned += 1;
      const captured = this.captureFile({
        filePath,
        sourceDir: dir,
        adapter: "codex-memories",
        trustClass: file.trustClass,
      });
      result.units += captured.units || 0;
      if (captured.skipped) result.skipped += 1;
      else result.captured += 1;
      result.files.push({ name: file.name, ...captured });
    }
    if (result.ok) {
      this.#recordEvent("capture", dir, {
        scanned: result.scanned,
        captured: result.captured,
        skipped: result.skipped,
        units: result.units,
        files: result.files.map((file) => file.name),
      });
    }
    return result;
  }

  #query(db, exact, loose, limitRows) {
    const sql = `
      SELECT u.id, u.head, u.text, u.trust_class, u.memory_state, u.locator, u.scope_paths,
             si.native_id AS key,
             bm25(content_fts) AS score
      FROM content_fts f
      JOIN content_units u ON u.id = f.id
      JOIN source_revisions sr ON sr.id = u.source_revision_id
      JOIN source_items si ON si.id = sr.source_item_id
      WHERE content_fts MATCH ?
        AND u.memory_state = 'captured'
      ORDER BY score DESC
      LIMIT ?
    `;
    let rows = db.prepare(sql).all(exact, limitRows);
    if (!rows.length) rows = db.prepare(sql).all(loose, limitRows);
    return rows;
  }

  #parentChain(nodeId) {
    const chain = [];
    const seen = new Set();
    let current = nodeId;
    for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
      seen.add(current);
      chain.push(current);
      const db = this.#open(current);
      if (!db) {
        if (current !== GLOBAL_NODE) current = GLOBAL_NODE;
        else break;
        continue;
      }
      const parent = this.#getMeta(db, "parent_id");
      if (!parent) {
        if (current !== GLOBAL_NODE) current = GLOBAL_NODE;
        else break;
        continue;
      }
      current = parent;
    }
    return chain;
  }

  // Permissive recall: BM25 over the FTS index. With a working directory the
  // recall is layered - the scope's own node hits come first, then linked
  // nodes (one level of fusion), then the parent chain upward (project ->
  // global), so project noise never drowns global preferences and a miss falls
  // back upward. Without a scope it recalls the global node (plus anything
  // global links to). scopeOnly (used by the stdio bridge's MODELDOCK_MEMORY_SCOPE
  // isolation mode) restricts recall to the scope's own node and never falls
  // back, so a disposable test memory can neither read nor pollute the shared
  // vault.
  search({ query, scopeDir = null, limit = 8, scopeOnly = false } = {}) {
    const terms = String(query || "").match(/[\p{L}\p{N}_]+/gu) || [];
    if (!terms.length) throw new Error("recall_memory requires a non-empty query");
    const quote = (term) => `"${term.replace(/"/g, "")}"`;
    const exact = terms.map(quote).join(" AND ");
    const loose = terms.map(quote).join(" OR ");
    const limitRows = Math.max(limit * 10, 50);
    const cwd = normalizeScope(scopeDir);
    const start = scopeNodeId(scopeDir);

    const merged = [];
    const seen = new Set();
    const pushNode = (nodeId, { filterScope = false, provenance = null, scopePath = null } = {}) => {
      const db = this.#open(nodeId, { scopePath });
      if (!db) return;
      let rows = this.#query(db, exact, loose, limitRows);
      if (filterScope && cwd) {
        // Inside the global fallback, scope-labeled units (captured MEMORY.md
        // sections) rank before unscoped rows, matching the old single-db
        // project-then-global split without mixing other projects in.
        const scoped = rows.filter((row) => String(row.scope_paths || "") && matchesScope(row.scope_paths, cwd));
        const unscoped = rows.filter((row) => !String(row.scope_paths || ""));
        rows = [...scoped, ...unscoped];
      }
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        merged.push({ ...row, node: nodeId, provenance });
        if (merged.length >= limitRows) return;
      }
    };

    if (scopeOnly) {
      pushNode(start);
      const hits = merged.slice(0, limit);
      return { count: hits.length, text: formatHits(hits) };
    }

    pushNode(start, { filterScope: false, scopePath: scopeDir });
    const startDb = this.#open(start);
    if (startDb) {
      const links = startDb.prepare("SELECT kind, target_node_id, label FROM links ORDER BY created_at").all();
      for (const link of links) {
        pushNode(link.target_node_id, { provenance: link.label || link.kind });
      }
    }
    for (const parent of this.#parentChain(start).slice(1)) {
      pushNode(parent, { filterScope: parent === GLOBAL_NODE });
    }
    // Project discovery: the global registry maps project names to their
    // in-project memory dbs, so an unscoped recall can find a project and the
    // model can drill into it with an explicit scope_dir.
    for (const row of this.#registryRows(terms)) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
      if (merged.length >= limitRows) break;
    }
    const hits = merged.slice(0, limit);
    return { count: hits.length, text: formatHits(hits) };
  }

  #registryRows(terms) {
    try {
      const clauses = terms.map(() => "(label LIKE ? OR slug LIKE ? OR node_path LIKE ?)").join(" OR ");
      const params = terms.flatMap((term) => [`%${term}%`, `%${term}%`, `%${term}%`]);
      const rows = this.db
        .prepare(`SELECT node_id, node_path, slug, label FROM node_registry WHERE status = 'active' AND ${clauses}`)
        .all(...params);
      return rows.map((row) => ({
        id: `registry_${row.node_id}`,
        head: row.label || row.slug,
        text: `project memory: ${row.node_path}\nrecall with scope_dir "${row.node_path}" for project-scoped hits`,
        trust_class: "node_registry",
        memory_state: "captured",
        locator: JSON.stringify({ source: "node_registry", heading: row.label || row.slug }),
        key: row.node_id,
        node: row.node_id,
        provenance: "project index",
      }));
    } catch {
      return [];
    }
  }

  #nodeFiles() {
    const files = [{ nodeId: GLOBAL_NODE, path: nodeDbPathFor(this.memoryDir, GLOBAL_NODE) }];
    const byNode = new Map();
    const nodesDir = path.join(this.memoryDir, "nodes");
    if (existsSync(nodesDir)) {
      for (const name of readdirSync(nodesDir)) {
        if (!name.endsWith(".db")) continue;
        const filePath = path.join(nodesDir, name);
        let nodeId = null;
        try {
          const db = new DatabaseSync(filePath);
          nodeId = db.prepare("SELECT value FROM node_meta WHERE key = 'node_id'").get()?.value || null;
          db.close();
        } catch {
          // Ignore incomplete or non-ModelDock database files.
        }
        if (nodeId && !byNode.has(nodeId)) byNode.set(nodeId, filePath);
      }
    }
    // In-project dbs (discovered through the registry) take precedence over a
    // centralized fallback for the same node.
    try {
      const rows = this.db.prepare("SELECT node_id, node_path FROM node_registry WHERE status = 'active'").all();
      for (const row of rows) {
        if (!row.node_path) continue;
        const file = path.join(path.resolve(row.node_path), ".modeldock", "memory.db");
        if (existsSync(file)) byNode.set(row.node_id, file);
      }
    } catch {
      // Registry is best-effort discovery.
    }
    for (const [nodeId, filePath] of byNode) files.push({ nodeId, path: filePath });
    return files;
  }

  #counts(db) {
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return {
      sources: count("sources"),
      source_items: count("source_items"),
      source_revisions: count("source_revisions"),
      content_units: count("content_units"),
      links: count("links"),
    };
  }

  nodes() {
    const list = [];
    for (const file of this.#nodeFiles()) {
      const db = this.#open(file.nodeId || GLOBAL_NODE);
      if (!db) continue;
      const nodeId = this.#getMeta(db, "node_id") || file.nodeId || GLOBAL_NODE;
      list.push({
        nodeId,
        parentId: this.#getMeta(db, "parent_id"),
        dbPath: this.dbFiles.get(nodeId) || nodeDbPathFor(this.memoryDir, nodeId),
        ...this.#counts(db),
      });
    }
    return list;
  }

  status() {
    const totals = { sources: 0, source_items: 0, source_revisions: 0, content_units: 0, links: 0 };
    for (const file of this.#nodeFiles()) {
      const db = this.#open(file.nodeId || GLOBAL_NODE);
      if (!db) continue;
      const counts = this.#counts(db);
      for (const key of Object.keys(totals)) totals[key] += counts[key];
    }
    return {
      enabled: true,
      dbPath: nodeDbPathFor(this.memoryDir, GLOBAL_NODE),
      ...totals,
      events: this.db.prepare("SELECT COUNT(*) AS n FROM memory_events").get().n,
      nodes: this.nodes().map((node) => node.nodeId),
    };
  }

  #recordEvent(kind, scope, detail) {
    const id = stableId("evt", kind, scope, detail, Date.now());
    return this.#tryEventWrite(() => {
      this.db
        .prepare("INSERT INTO memory_events (id, kind, scope, detail, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, kind, scope, JSON.stringify(detail), new Date().toISOString());
    });
  }

  #tryEventWrite(write) {
    // The event feed is telemetry, not canonical memory. Do not inherit the
    // five-second canonical-write timeout here: a locked event DB must neither
    // fail nor delay a completed store/link operation.
    this.db.exec("PRAGMA busy_timeout = 0");
    try {
      write();
      return true;
    } catch {
      return false;
    } finally {
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  // Lightweight event feed for the memory page: newest first.
  recentEvents(limit = 50) {
    return this.db
      .prepare(`
        SELECT kind, scope, detail, created_at
        FROM memory_events
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => {
        let detail = {};
        try { detail = JSON.parse(row.detail || "{}"); } catch { /* keep default */ }
        return { ...row, detail };
      });
  }

  // Flat view of captured units across every node for the memory page, newest
  // revision first.
  contentView(limit = 100) {
    const perNode = Math.max(limit, 50);
    const rows = [];
    for (const file of this.#nodeFiles()) {
      const db = this.#open(file.nodeId || GLOBAL_NODE);
      if (!db) continue;
      const nodeId = this.#getMeta(db, "node_id") || file.nodeId || GLOBAL_NODE;
      const nodeRows = db
        .prepare(`
          SELECT u.head, u.kind, u.trust_class, u.memory_state, u.scope_paths,
                 u.created_at, s.adapter AS source_adapter, i.native_id, r.revision,
                 substr(u.text, 1, 400) AS text
          FROM content_units u
          JOIN source_revisions r ON r.id = u.source_revision_id
          JOIN source_items i ON i.id = r.source_item_id
          JOIN sources s ON s.id = i.source_id
          ORDER BY r.observed_at DESC, u.rowid DESC
          LIMIT ?
        `)
        .all(perNode)
        .map((row) => ({ ...row, node: nodeId }));
      rows.push(...nodeRows);
    }
    return rows
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, limit);
  }

  purgeScope(scopeDir) {
    const nodeId = scopeNodeId(scopeDir);
    const db = this.#open(nodeId, { scopePath: scopeDir });
    if (!db) return { ok: true, nodeId, deleted: 0, fts: 0 };

    if (nodeId !== GLOBAL_NODE) {
      const counts = this.#counts(db);
      db.exec("BEGIN");
      try {
        db.exec("DELETE FROM content_fts");
        db.exec("DELETE FROM content_units");
        db.exec("DELETE FROM source_revisions");
        db.exec("DELETE FROM source_items");
        db.exec("DELETE FROM sources");
        db.exec("DELETE FROM links");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { ok: true, nodeId, deleted: counts.content_units, fts: counts.content_units };
    }

    const normalized = normalizeScope(scopeDir);
    const like = `%${normalized}%`;
    const ids = db.prepare("SELECT id, source_revision_id FROM content_units WHERE scope_paths LIKE ?").all(like);
    if (!ids.length) return { ok: true, nodeId, deleted: 0, fts: 0 };
    db.exec("BEGIN");
    try {
      const deleteFts = db.prepare("DELETE FROM content_fts WHERE id = ?");
      const deleteUnit = db.prepare("DELETE FROM content_units WHERE id = ?");
      for (const row of ids) {
        deleteFts.run(row.id);
        deleteUnit.run(row.id);
      }
      db.exec(`
        DELETE FROM source_revisions
        WHERE id NOT IN (SELECT source_revision_id FROM content_units)
      `);
      db.exec(`
        DELETE FROM source_items
        WHERE id NOT IN (SELECT source_item_id FROM source_revisions)
      `);
      db.exec(`
        DELETE FROM sources
        WHERE id NOT IN (SELECT source_id FROM source_items)
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { ok: true, nodeId, deleted: ids.length, fts: ids.length };
  }
}

function legacyRows(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all();
}

function copyRow(db, table, columns, row) {
  const values = columns.map((column) => row[column]);
  db.prepare(
    `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...values);
}

function migrationTargets(scopePaths) {
  const scopes = String(scopePaths || "").split("|").map((value) => normalizeScope(value)).filter(Boolean);
  return scopes.length ? scopes : [GLOBAL_NODE];
}

function backupLegacyFiles(legacyPath, backupDir) {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const files = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${legacyPath}${suffix}`;
    if (!existsSync(source)) continue;
    const target = path.join(backupDir, `memory.db.${stamp}${suffix}`);
    copyFileSync(source, target);
    files.push(target);
  }
  return files;
}

export function migrateLegacyMemory({ memoryDir, legacyPath = path.join(memoryDir, "memory.db"), backupDir = path.join(memoryDir, "legacy-backups"), archiveLegacy = true } = {}) {
  const resolvedMemoryDir = path.resolve(memoryDir);
  const resolvedLegacyPath = path.resolve(legacyPath);
  if (!existsSync(resolvedLegacyPath)) return { ok: true, skipped: true, reason: "legacy database not found", nodes: 0, units: 0 };

  const backupFiles = backupLegacyFiles(resolvedLegacyPath, backupDir);
  const legacy = new DatabaseSync(resolvedLegacyPath);
  const store = new MemoryStore({ memoryDir: resolvedMemoryDir });
  const sourceRows = legacyRows(legacy, "sources");
  const itemRows = legacyRows(legacy, "source_items");
  const revisionRows = legacyRows(legacy, "source_revisions");
  const unitRows = legacyRows(legacy, "content_units");
  const eventRows = legacyRows(legacy, "memory_events");
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const itemById = new Map(itemRows.map((row) => [row.id, row]));
  const revisionById = new Map(revisionRows.map((row) => [row.id, row]));
  const nodeIds = new Set([GLOBAL_NODE]);
  let copiedUnits = 0;

  let result;
  try {
    for (const unit of unitRows) {
      for (const nodeId of migrationTargets(unit.scope_paths)) {
        const db = store.ensureNode(nodeId);
        const revision = revisionById.get(unit.source_revision_id);
        const item = revision && itemById.get(revision.source_item_id);
        const source = item && sourceById.get(item.source_id);
        if (!revision || !item || !source) continue;
        copyRow(db, "sources", ["id", "adapter", "native_location", "created_at"], source);
        copyRow(db, "source_items", ["id", "source_id", "native_id", "path", "kind"], item);
        copyRow(db, "source_revisions", ["id", "source_item_id", "revision", "blob_sha256", "size", "observed_at", "supersedes_revision_id"], revision);
        copyRow(db, "content_units", ["id", "source_revision_id", "kind", "head", "text", "text_hash", "locator", "trust_class", "memory_state", "scope_paths", "created_at"], unit);
        copyRow(db, "content_fts", ["id", "head", "text"], { id: unit.id, head: unit.head || "", text: unit.text });
        nodeIds.add(nodeId);
        copiedUnits += 1;
      }
    }
    for (const event of eventRows) {
      copyRow(store.db, "memory_events", ["id", "kind", "scope", "detail", "created_at"], event);
    }
    result = { ok: true, skipped: false, backupFiles, nodes: nodeIds.size, units: copiedUnits, archived: archiveLegacy };
  } finally {
    legacy.close();
    store.close();
  }
  if (archiveLegacy) {
    const archivePath = `${resolvedLegacyPath}.legacy-${Date.now()}`;
    renameSync(resolvedLegacyPath, archivePath);
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${resolvedLegacyPath}${suffix}`;
      if (existsSync(source)) renameSync(source, `${archivePath}${suffix}`);
    }
    result.archivePath = archivePath;
  }
  return result;
}

// Open the vault only when MODELDOCK_MEMORY is enabled; null keeps the gateway
// in its thin default shape.
export function memoryStoreFor(config) {
  if (!config?.memoryEnabled) return null;
  return new MemoryStore({ memoryDir: config.memoryDir });
}

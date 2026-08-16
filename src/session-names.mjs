import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";

// Session display names come from Codex's own rollout files, not from request
// headers. A real conversation always has one
// (sessions/<year>/<month>/<day>/rollout-<timestamp>-<sessionId>.jsonl); the
// one-shot background calls the dashboard wants to hide (vision probes, native
// subagent flashes) never do, and that absence is exactly how the dashboard
// tells real sessions from noise.
//
// Lookup is O(1) after a lazy index: the sessions tree is walked once per
// process and every rollout filename carries its full session id, so finding a
// session never re-scans the tree. A miss falls back to today's date directory
// only, because a brand-new conversation can only have been created moments
// ago.

const ROLLOUT_ID = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const HEAD_BYTES = 64 * 1024;

function walk(root, visit) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(entry, full);
  }
}

function buildIndex(sessionsRoot) {
  const index = new Map();
  if (existsSync(sessionsRoot)) {
    walk(sessionsRoot, (_entry, full) => {
      const match = ROLLOUT_ID.exec(path.basename(full));
      if (match) index.set(match[1], full);
    });
  }
  return index;
}

// Read only the head of the rollout file: the first session_meta line carries
// the cwd, whose basename is the project label. A bounded read is enough and a
// multi-megabyte history is never loaded.
export function sessionInfoFromFile(filePath) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const head = buffer.subarray(0, read).toString("utf8");
    let cwd = "";
    for (const line of head.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // partial JSON at the read boundary; earlier lines still parsed
      }
      if (entry.type === "session_meta") {
        cwd = typeof entry.payload?.cwd === "string" ? entry.payload.cwd : "";
      }
    }
    // The rollout cwd is a path from the machine Codex actually ran on, which
    // may be Windows (backslashes) even when the dashboard is not. basename()
    // only splits on the host separator, so split on both explicitly.
    const name = cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
    return { label: name || null, cwd };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class SessionNames {
  constructor({ sessionsRoot, dateDir = () => {
    const now = new Date();
    return path.join(String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  } } = {}) {
    this.sessionsRoot = sessionsRoot;
    this.dateDir = dateDir;
    this.index = null;
    this.labels = new Map();
  }

  labelFor(sessionId) {
    if (!sessionId) return null;
    if (this.labels.has(sessionId)) return this.labels.get(sessionId);
    let result = null;
    const filePath = this.#fileFor(sessionId);
    if (filePath) result = sessionInfoFromFile(filePath);
    this.labels.set(sessionId, result);
    return result;
  }

  #fileFor(sessionId) {
    if (!this.index) this.index = buildIndex(this.sessionsRoot);
    if (this.index.has(sessionId)) return this.index.get(sessionId);
    // A session created after the index was built can only live in today's
    // directory; checking one small folder beats re-walking the tree per call.
    const today = path.join(this.sessionsRoot, this.dateDir());
    let entries = [];
    try {
      entries = readdirSync(today, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (path.basename(entry.name).includes(sessionId)) {
        const full = path.join(today, entry.name);
        this.index.set(sessionId, full);
        return full;
      }
    }
    return null;
  }
}

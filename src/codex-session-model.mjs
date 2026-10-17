import { readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function header(headers, name) {
  const value = typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
  return String(Array.isArray(value) ? value[0] || "" : value || "").trim();
}

export function compactionThreadId(headers) {
  // A subagent's cache/session affinity can name its parent. Core's metadata
  // identifies the actual thread; never use x-codex-parent-thread-id here.
  let metadata;
  const raw = header(headers, "x-codex-turn-metadata");
  if (raw.length <= 64 * 1024) {
    try { metadata = JSON.parse(raw); } catch { /* older clients omit it */ }
  }
  return [metadata?.thread_id, metadata?.session_id,
    header(headers, "x-codex-thread-id"), header(headers, "thread-id"), header(headers, "thread_id"),
    header(headers, "session_id"), header(headers, "session-id"), header(headers, "x-codex-session-id"),
  ].find((id) => typeof id === "string" && UUID.test(id)) || "";
}

// Codex pre-turn compaction intentionally sends the PREVIOUS model in the
// request, before the new model has sampled at all. threads.model is the
// current picker setting, already committed before that request. A traffic
// affinity map, global mainModel, or the last rollout turn_context is stale.
// Read just this thread's model, locally and read-only; no auth or transcript
// is loaded. Open/close per compact avoids long-lived locks and stale snapshots.
// Missing/newer schemas and busy databases are a safe miss, not a relay error.
export function readCodexSessionModel(codexHome, headers) {
  const id = compactionThreadId(headers);
  if (!codexHome || !id) return "";
  let db;
  try {
    const latest = readdirSync(codexHome)
      .map((name) => ({ name, version: /^state_(\d+)\.sqlite$/.exec(name)?.[1] }))
      .filter((entry) => entry.version)
      .sort((a, b) => Number(b.version) - Number(a.version))[0];
    if (!latest) return "";
    // Do not fall back to an older schema: it can contain an obsolete choice.
    db = new DatabaseSync(path.join(codexHome, latest.name), { readOnly: true, timeout: 0 });
    const model = db.prepare("SELECT model FROM threads WHERE id = ?").get(id)?.model;
    return typeof model === "string" && model.length <= 1024 && model && !/\s|[\x00-\x1f\x7f]/.test(model) ? model : "";
  } catch {
    return "";
  } finally {
    db?.close();
  }
}

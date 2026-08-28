// Read the static opening envelope of the most recently active Codex task.
// This is used only while preparing a managed local host: no prompt/tool text
// is persisted by ModelDock, only the resulting llama.cpp KV checkpoint and
// its cryptographic fingerprint.

import path from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

async function collectJsonl(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJsonl(target, files);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
  }));
}

function readOpeningEnvelope(text) {
  const lines = String(text || "").split(/\r?\n/);
  let meta = null;
  const developerMessages = [];
  for (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return null;
    }
    if (record.type === "session_meta") {
      meta = record.payload || null;
      continue;
    }
    if (!meta || record.type !== "response_item" || record.payload?.type !== "message") continue;
    const role = record.payload.role;
    if (role === "user") break;
    if (role === "developer" || role === "system") developerMessages.push(record.payload);
  }
  const instructions = typeof meta?.base_instructions?.text === "string" ? meta.base_instructions.text : "";
  const tools = Array.isArray(meta?.dynamic_tools) ? meta.dynamic_tools : [];
  if (!instructions || !tools.length) return null;
  return Object.freeze({
    instructions,
    tools,
    developerMessages: Object.freeze(developerMessages),
    ...(typeof meta.session_id === "string" ? { sessionId: meta.session_id } : {}),
  });
}

// Latest is deliberately chosen by filesystem activity rather than an id from
// the dashboard: the dashboard is not tied to one Codex task. A candidate must
// contain both the global base instructions and the complete dynamic tool
// envelope; partial or corrupt session logs are simply ignored.
export async function latestCodexSessionOpening({ sessionsRoot, maxCandidates = 12 } = {}) {
  if (typeof sessionsRoot !== "string" || !sessionsRoot.trim()) return null;
  const files = [];
  await collectJsonl(sessionsRoot, files);
  const dated = await Promise.all(files.map(async (file) => {
    try {
      return { file, mtimeMs: (await stat(file)).mtimeMs };
    } catch {
      return null;
    }
  }));
  const candidates = dated.filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, maxCandidates);
  for (const candidate of candidates) {
    try {
      const opening = readOpeningEnvelope(await readFile(candidate.file, "utf8"));
      if (opening) return opening;
    } catch {
      // An in-flight JSONL can end mid-write; the next candidate is safe.
    }
  }
  return null;
}

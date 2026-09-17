// Read the static opening envelope of a Codex task: by preference the one that
// really used this host, otherwise the most recently active one.
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

// A KV base is only useful for the conversation that will ask for it, so the
// caller can hand over the conversations that actually sent traffic to this
// host (see `readRecentConversations`); their files are read first. The newest
// file by filesystem activity remains the fallback, because the dashboard is
// not tied to one Codex task and a fresh install has no local traffic at all.
// A candidate must contain both the global base instructions and the complete
// dynamic tool envelope; partial or corrupt session logs are simply ignored.
export async function latestCodexSessionOpening({ sessionsRoot, maxCandidates = 12, preferredSessionIds = [] } = {}) {
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
  const byMtime = dated.filter(Boolean).sort((left, right) => right.mtimeMs - left.mtimeMs);
  const preferred = new Set((Array.isArray(preferredSessionIds) ? preferredSessionIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean));
  if (!preferred.size) {
    for (const candidate of byMtime.slice(0, maxCandidates)) {
      const opening = await readCandidate(candidate);
      if (opening) return opening;
    }
    return null;
  }
  // Codex names each rollout after the session that wrote it, so a preferred
  // conversation is usually found without opening anything else. A resumed
  // thread is the exception: its newest log carries the original thread id only
  // inside `session_meta`, so the recent logs are still checked by content.
  const named = (file) => [...preferred].some((id) => path.basename(file).includes(id));
  const ordered = [...byMtime.filter((candidate) => named(candidate.file)), ...byMtime];
  const seen = new Set();
  let first = null;
  for (const candidate of ordered) {
    if (seen.has(candidate.file)) continue;
    if (seen.size >= maxCandidates * 2) break;
    seen.add(candidate.file);
    const opening = await readCandidate(candidate);
    if (!opening) continue;
    if (named(candidate.file) || (opening.sessionId && preferred.has(opening.sessionId))) return opening;
    first = first || opening;
  }
  // Nothing preferred had a usable envelope: the newest complete one is still a
  // better answer than no base at all, and the next boot can do better.
  return first;
}

// An in-flight JSONL can end mid-write and a task log can be removed while the
// listing is being read: either way the next candidate is safe, so a failure to
// read is reported as "no envelope here" rather than an exception.
async function readCandidate(candidate) {
  try {
    return readOpeningEnvelope(await readFile(candidate.file, "utf8"));
  } catch {
    return null;
  }
}

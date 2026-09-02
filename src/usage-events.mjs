import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Append-only usage metering that survives gateway restarts. The in-memory
// Metrics snapshot resets every restart (and this gateway restarts often during
// development); this file is the durable record the dashboard and future
// reporting can read back.
//
// One JSON object per line. Telemetry must never interrupt or fail a model
// request: every write is wrapped and errors are swallowed.

const USAGE_EVENTS_PATH = path.join(os.homedir(), ".modeldock", "usage-events.jsonl");

// Tests and packaging can redirect the metering file without touching the real
// ~/.modeldock state (mirrors MODELDOCK_SETTINGS_EVENTS_FILE in settings-events.mjs).
export function usageEventsPath() {
  return process.env.MODELDOCK_USAGE_EVENTS_FILE || USAGE_EVENTS_PATH;
}

// A single rotation keeps the active file bounded without a log-management
// dependency: when the file passes the cap it becomes `.1` (replacing the
// previous `.1`), so at most two files exist.
const ROTATE_BYTES = 5 * 1024 * 1024;
const PRIMARY_MODEL_ROUTES = new Set(["client_selected", "default_main", "native_passthrough"]);

// Active file size, maintained across appends so the hot path stats once per
// process (or per redirect) instead of once per relay request.
let sizeCache = { path: "", bytes: 0 };

function safeText(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

export function recordUsageEvent({
  model,
  provider,
  route,
  status,
  durationMs,
  inputTokens,
  outputTokens,
  totalTokens,
  cachedTokens,
  reasoningTokens,
  sessionId,
  threadId,
  compression,
  at = Date.now(),
  filePath = usageEventsPath(),
} = {}) {
  const fromChars = safeCount(compression?.fromChars);
  const toChars = safeCount(compression?.toChars);
  const event = {
    meteringVersion: 2,
    at: new Date(at).toISOString(),
    model: safeText(model, "unknown"),
    provider: safeText(provider, "unknown"),
    ...(route ? { route: safeText(route, "") } : {}),
    status: Number.isInteger(status) ? status : 0,
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    ...(safeCount(inputTokens) !== undefined ? { inputTokens: safeCount(inputTokens) } : {}),
    ...(safeCount(outputTokens) !== undefined ? { outputTokens: safeCount(outputTokens) } : {}),
    ...(safeCount(totalTokens) !== undefined ? { totalTokens: safeCount(totalTokens) } : {}),
    ...(safeCount(cachedTokens) !== undefined ? { cachedTokens: safeCount(cachedTokens) } : {}),
    ...(safeCount(reasoningTokens) !== undefined ? { reasoningTokens: safeCount(reasoningTokens) } : {}),
    ...(safeText(sessionId, "") ? { sessionId: safeText(sessionId, "") } : {}),
    ...(safeText(threadId, "") ? { threadId: safeText(threadId, "") } : {}),
    ...(fromChars !== undefined && toChars !== undefined ? { compression: { fromChars, toChars } } : {}),
  };
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    // The size is tracked, not stat'ed: this append runs on every relay, and
    // the counter only has to be roughly right - rotation still triggers
    // within one event of the cap. Re-seeded from disk on first use or when
    // the path changes; an external truncation desyncs it by at most one
    // rotation cycle, which telemetry can afford.
    if (sizeCache.path !== filePath) {
      let size = 0;
      try {
        size = statSync(filePath).size;
      } catch {
        // Missing file: starts at zero.
      }
      sizeCache = { path: filePath, bytes: size };
    }
    if (sizeCache.bytes > ROTATE_BYTES) {
      try {
        renameSync(filePath, `${filePath}.1`);
        sizeCache.bytes = 0;
      } catch {
        // Missing file: nothing to rotate.
      }
    }
    const line = `${JSON.stringify(event)}\n`;
    appendFileSync(filePath, line, "utf8");
    sizeCache.bytes += Buffer.byteLength(line);
  } catch {
    // Metering must never take a request down.
  }
  return event;
}

export function usageFromRelayResult(result, { model, provider } = {}) {
  const usage = result?.usage || {};
  return {
    model: model || result?.route?.model,
    provider: provider || result?.upstream,
    route: result?.route?.reason,
    status: result?.httpStatus,
    durationMs: result?.latencyMs,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

// The dashboard's read-only current-model block follows actual primary Codex
// traffic. Vision escalation, tool continuation and compaction are work done on
// behalf of that model, not a new main-model choice, so they cannot replace it.
export function mainRouteFromUsageEvent(event) {
  const model = safeText(event?.model, "");
  const provider = safeText(event?.provider, "");
  const route = safeText(event?.route, "");
  const status = Number(event?.status);
  const at = String(event?.at || "");
  if (!model || !provider || !PRIMARY_MODEL_ROUTES.has(route)) return null;
  if (!Number.isInteger(status) || status < 200 || status >= 300) return null;
  if (!Number.isFinite(Date.parse(at))) return null;
  return { model, provider, at };
}

// Reuse the existing bounded metering log as the durable source. Reading at
// gateway boot costs at most two 5 MiB files and avoids a second latest-model
// cache that could drift from the events Stats already trusts.
export function readLatestMainRoute(filePath = usageEventsPath()) {
  let latest = null;
  let latestAt = -1;
  for (const file of [`${filePath}.1`, filePath]) {
    let lines;
    try {
      lines = readFileSync(file, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const candidate = mainRouteFromUsageEvent(event);
      const candidateAt = candidate ? Date.parse(candidate.at) : -1;
      if (candidate && candidateAt >= latestAt) {
        latest = candidate;
        latestAt = candidateAt;
      }
    }
  }
  return latest;
}

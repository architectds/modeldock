import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
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
    try {
      if (statSync(filePath).size > ROTATE_BYTES) renameSync(filePath, `${filePath}.1`);
    } catch {
      // Missing file: nothing to rotate.
    }
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
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

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Durable, append-only audit events for dashboard settings changes. Values and
// request bodies must never be written here: this file is for change diagnosis,
// not secret storage.
const SETTINGS_EVENTS_PATH = path.join(os.homedir(), ".modeldock", "settings-events.jsonl");

const ROTATE_BYTES = 5 * 1024 * 1024;

// Tests and packaging can redirect the audit file without touching the real
// ~/.modeldock state.
function settingsEventsPath() {
  return process.env.MODELDOCK_SETTINGS_EVENTS_FILE || SETTINGS_EVENTS_PATH;
}

function safeText(value, fallback = "unknown") {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 160);
}

function safeProviders(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string").map((item) => safeText(item, "")).filter(Boolean))].slice(0, 16);
}

export function recordSettingsEvent({
  action = "settings_update",
  providers = [],
  ok = true,
  error,
  at = Date.now(),
  filePath = settingsEventsPath(),
} = {}) {
  const event = {
    settingsVersion: 1,
    at: new Date(at).toISOString(),
    action: safeText(action, "settings_update"),
    providers: safeProviders(providers),
    ok: Boolean(ok),
    ...(error ? { error: safeText(error, "settings_failed") } : {}),
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
    // Settings auditing must never make a settings request fail.
  }
  return event;
}

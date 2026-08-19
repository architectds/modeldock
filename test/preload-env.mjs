// Test-runner preload (node --import). Every test file runs in its own child
// process; this module runs first in each of them and redirects the ModelDock
// audit files away from the real ~/.modeldock state.
//
// Background: recordSettingsEvent / recordUsageEvent default to the live
// install's files (~/.modeldock/settings-events.jsonl, usage-events.jsonl).
// Unit tests exercise those paths in-process (loadConfig records a
// placeholder-token event, settings saves record audit events, relay tests
// record usage), so a test run used to pollute the running gateway's real
// files with fake entries. The two MODELDOCK_*_EVENTS_FILE variables redirect
// every write into one temp dir per test process, which the sandbox cleanup
// (scripts/cleanup-sandbox.mjs, "modeldock-*" prefix) reaps later.
//
// MODELDOCK_ENV_FILE is intentionally NOT set here: install/restart tests
// spawn real install.sh/restart.sh children that must keep reading their own
// root/.env (envFileFor gives MODELDOCK_ENV_FILE top priority).
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-test-events-"));
process.env.MODELDOCK_SETTINGS_EVENTS_FILE ||= path.join(dir, "settings-events.jsonl");
process.env.MODELDOCK_USAGE_EVENTS_FILE ||= path.join(dir, "usage-events.jsonl");
// The endpoint list belongs here for the same reason: loadConfig() reads it
// directly, so isolating the services object is not enough - a test that adds
// an endpoint writes the running gateway's real list without it.
process.env.MODELDOCK_CUSTOM_ENDPOINTS_FILE ||= path.join(dir, "custom-endpoints.json");

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeEnvFile } from "../src/config.mjs";
import { recordSettingsEvent } from "../src/settings-events.mjs";

function tempDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("settings events are durable and never contain token values", () => {
  const dir = tempDir("modeldock-settings-events-");
  try {
    const filePath = path.join(dir, "settings-events.jsonl");
    const event = recordSettingsEvent({
      providers: ["opencode-go"],
      ok: false,
      error: "invalid_opencode_go_token",
      filePath,
    });
    assert.equal(event.ok, false);
    const line = readFileSync(filePath, "utf8").trim();
    assert.deepEqual(JSON.parse(line), event);
    assert.doesNotMatch(line, /token-value-that-must-not-appear/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secret env updates keep a pre-write backup", () => {
  const dir = tempDir("modeldock-settings-env-");
  try {
    const filePath = path.join(dir, ".env");
    writeFileSync(filePath, "OPENCODE_GO_TOKEN=old-value\nOTHER=value\n", "utf8");
    writeEnvFile({ OPENCODE_GO_TOKEN: "new-value-that-is-long-enough" }, filePath);
    const backups = readdirSync(dir).filter((name) => name.startsWith(".env.bak-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(dir, backups[0]), "utf8"), "OPENCODE_GO_TOKEN=old-value\nOTHER=value\n");
    assert.notEqual(readFileSync(filePath, "utf8"), "OPENCODE_GO_TOKEN=old-value\nOTHER=value\n");
    assert.ok(existsSync(filePath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


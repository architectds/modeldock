import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSecretKey,
  encryptSecret,
  decryptSecret,
  dpapiSupported,
  PREFIX,
} from "./secrets.mjs";
import { loadConfig, migrateEnvSecrets, parseEnvFile } from "./config.mjs";

test("recognizes only the token keys as secrets", () => {
  assert.equal(isSecretKey("OPENCODE_GO_TOKEN"), true);
  assert.equal(isSecretKey("DEEPSEEK_API_KEY"), true);
  assert.equal(isSecretKey("EXA_API_KEY"), true);
  assert.equal(isSecretKey("MODELDOCK_CUSTOM_API_KEY"), true);
  assert.equal(isSecretKey("MODELDOCK_PORT"), false);
  assert.equal(isSecretKey("MODELDOCK_HOST"), false);
});

test("plaintext values pass through unchanged (backward compat)", () => {
  // On non-Windows, encryptSecret leaves values as plaintext. On Windows it encrypts,
  // but the READ path (decryptSecret) always passes plaintext through unchanged.
  if (!dpapiSupported()) assert.equal(encryptSecret("sk-plain"), "sk-plain");
  assert.equal(decryptSecret("sk-plain"), "sk-plain");
  assert.equal(decryptSecret(""), "");
  assert.equal(encryptSecret(""), "");
});

test("already-encrypted values pass through unchanged", () => {
  assert.equal(encryptSecret(`${PREFIX}abc`), `${PREFIX}abc`);
});

test("encrypt then decrypt round-trips to the original", () => {
  const token = "sk-roundtrip-123";
  const encrypted = encryptSecret(token);
  // On non-Windows the value stays plaintext, so the round-trip is trivially exact.
  assert.equal(decryptSecret(encrypted), token);
});

// Holds on every platform: on non-Windows the dpapi: branch returns early, on
// Windows the DPAPI unprotect fails for this junk payload and the catch branch
// returns "". Either way decryptSecret never throws.
test("dpapi-prefixed value that cannot be decrypted reads back as empty, never crashes", () => {
  assert.equal(decryptSecret(`${PREFIX}not-valid-base64!`), "");
});

test("migrateEnvSecrets is safe and non-destructive on every platform", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-secrets-"));
  const file = path.join(dir, ".env");
  const original = [
    "# comment line",
    "MODELDOCK_PORT=4097",
    "OPENCODE_GO_TOKEN=sk-migrate-plain",
    "DEEPSEEK_API_KEY=",
    "EXA_API_KEY=exa-plain",
    "",
  ].join("\n");
  writeFileSync(file, original, "utf8");

  const result = migrateEnvSecrets(file);
  const after = readFileSync(file, "utf8");
  const entries = parseEnvFile(after);

  if (!dpapiSupported()) {
    assert.equal(result.reason, "non-windows");
    // File is byte-for-byte untouched outside Windows.
    assert.equal(after, original);
    return;
  }

  // Windows: plaintext secrets are encrypted, comments/blanks/empty keys preserved.
  assert.equal(result.migrated, 2);
  assert.ok(existsSync(result.backup));
  assert.match(after, /^# comment line$/m);
  assert.match(after, /^MODELDOCK_PORT=4097$/m);
  assert.ok(String(entries.OPENCODE_GO_TOKEN).startsWith(PREFIX));
  assert.ok(String(entries.EXA_API_KEY).startsWith(PREFIX));
  assert.equal(entries.DEEPSEEK_API_KEY, "");
  // And it still decrypts back to the originals.
  assert.equal(decryptSecret(entries.OPENCODE_GO_TOKEN), "sk-migrate-plain");
  assert.equal(decryptSecret(entries.EXA_API_KEY), "exa-plain");
});

test("migrateEnvSecrets does nothing when there is nothing to migrate", (t) => {
  if (!dpapiSupported()) return t.skip("DPAPI is supported here");
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-secrets-"));
  const file = path.join(dir, ".env");
  writeFileSync(file, `OPENCODE_GO_TOKEN=${PREFIX}c2stYWxyZWFkeQ==\n`, "utf8");
  const result = migrateEnvSecrets(file);
  assert.equal(result.migrated, 0);
  assert.equal(result.reason, "none-plain");
});

test("loadConfig ignores placeholder tokens from .env and records an audit event", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-loadguard-"));
  const envFile = path.join(dir, ".env");
  const eventsFile = path.join(dir, "settings-events.jsonl");
  const codexHome = path.join(dir, "codex");
  writeFileSync(
    envFile,
    "OPENCODE_GO_TOKEN=x\nDEEPSEEK_API_KEY=sk-good-key-that-is-long-enough\n",
    "utf8",
  );
  const saved = {
    MODELDOCK_ENV_FILE: process.env.MODELDOCK_ENV_FILE,
    MODELDOCK_CODEX_HOME: process.env.MODELDOCK_CODEX_HOME,
    MODELDOCK_SETTINGS_EVENTS_FILE: process.env.MODELDOCK_SETTINGS_EVENTS_FILE,
    OPENCODE_GO_TOKEN: process.env.OPENCODE_GO_TOKEN,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  };
  process.env.MODELDOCK_ENV_FILE = envFile;
  process.env.MODELDOCK_CODEX_HOME = codexHome;
  process.env.MODELDOCK_SETTINGS_EVENTS_FILE = eventsFile;
  delete process.env.OPENCODE_GO_TOKEN;
  delete process.env.DEEPSEEK_API_KEY;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const config = loadConfig();
  assert.equal(config.tokens["opencode-go"], "", "a placeholder never routes as a token");
  assert.equal(config.tokens["deepseek-official"], "sk-good-key-that-is-long-enough");
  const event = JSON.parse(readFileSync(eventsFile, "utf8").trim());
  assert.equal(event.action, "env_placeholder_ignored");
  assert.equal(event.ok, false);
  assert.deepEqual(event.providers, ["opencode-go"]);
  assert.equal(event.error, "placeholder_token_ignored");
});

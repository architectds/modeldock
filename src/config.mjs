import process from "node:process";
import os from "node:os";
import path from "node:path";
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, renameSync, copyFileSync, rmSync } from "node:fs";
import { allProfiles, PROVIDER_SEPARATOR, applyCustomProfile, applyLocalEngineProfile, applyOllamaProfile, profileById, publishedSlugFor } from "./profiles.mjs";
import { normalizeBaseUrl } from "./custom-endpoint.mjs";
import { OLLAMA_DEFAULT_BASE, ollamaSnapshotPath, readOllamaSnapshot } from "./ollama.mjs";
import { readLocalEnginesSnapshot } from "./local-engines.mjs";
import { applyContextOverrides, readContextOverrides } from "./context-overrides.mjs";
import { readModelToggles } from "./model-toggles.mjs";
import { readCustomEndpoints } from "./custom-endpoints.mjs";
import { encryptSecret, decryptSecret, isSecretKey } from "./secrets.mjs";
import { defaultStateDir, stateDir, stateFile } from "./state-dir.mjs";
import { recordSettingsEvent } from "./settings-events.mjs";
import { isLoopbackHost } from "./loopback.mjs";
import { protectPrivateFile } from "./caller-key.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";

// Resolve the user configuration (.env) file. Priority:
//   1. MODELDOCK_ENV_FILE (explicit path)
//   2. MODELDOCK_CONFIG_DIR/.env
//   3. ~/.modeldock/.env when it exists (installed layout; cwd is not controllable)
//   4. <cwd>/.env (dev layout)
// When nothing exists yet, fall back to ~/.modeldock/.env so first-run settings saves
// land in a cwd-independent location. The resolved path is recorded on the config so
// the settings API can write back to it.
// Whether the .env this process resolved belongs to this install.
//
// envFileFor falls back to ~/.modeldock/.env whenever MODELDOCK_ENV_FILE and
// MODELDOCK_CONFIG_DIR are unset, which is the case for every gateway the
// install tests spawn: they redirect the state directory and the Codex home,
// but not this. A one-time migration that writes .env therefore rewrote the
// developer live .env on every `npm test`. Reading it there is fine; writing
// it is not ours to do.
export function ownsEnvFile(file) {
  const resolved = path.resolve(file || envFileFor());
  const ourState = path.resolve(stateDir());
  if (resolved === path.join(ourState, ".env")) return true;
  // The default install .env belongs to the default install.
  return ourState === path.resolve(defaultStateDir());
}

export function envFileFor() {
  if (process.env.MODELDOCK_ENV_FILE) return path.resolve(process.env.MODELDOCK_ENV_FILE);
  if (process.env.MODELDOCK_CONFIG_DIR) return path.join(path.resolve(process.env.MODELDOCK_CONFIG_DIR), ".env");
  const installed = path.join(os.homedir(), ".modeldock", ".env");
  if (existsSync(installed)) return installed;
  const dev = path.resolve(".env");
  if (existsSync(dev)) return dev;
  return installed;
}

export function parseEnvFile(source) {
  const entries = {};
  for (const line of String(source || "").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const double = value.startsWith('"') && value.endsWith('"');
    const single = value.startsWith("'") && value.endsWith("'");
    if (double || single) value = value.slice(1, -1);
    entries[match[1]] = value;
  }
  return entries;
}

// The .env format is line-based, so a value carrying a newline would inject
// additional KEY=VALUE lines that take effect on the next load (e.g. a crafted
// custom-model id turning MODELDOCK_REQUIRE_CALLER_KEY off). No legitimate value
// here (token, url, model id) contains a CR/LF, so strip them at every write.
function sanitizeEnvValue(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

// One spelling of "on" and one of "off" for every boolean env var. These were
// written out per flag and drifted: MODELDOCK_CUSTOM_MAIN accepted "true" while
// MODELDOCK_MEMORY honoured "no" while
// MODELDOCK_MD_MEMORY did not - so the same word switched one feature and was
// silently ignored by the next.
const TRUE_WORDS = new Set(["1", "true", "on", "yes"]);
const FALSE_WORDS = new Set(["0", "false", "off", "no"]);

// Opt-in flag: off unless the value says otherwise.
function envOn(name) {
  return TRUE_WORDS.has(String(process.env[name] || "").trim().toLowerCase());
}

// Opt-out flag: on unless the value says otherwise (an unset or unrecognised
// value keeps the default).
export function envOff(name) {
  return FALSE_WORDS.has(String(process.env[name] || "").trim().toLowerCase());
}

// A value that can never be a real credential: missing, too short, or a
// placeholder/masked shape. Rejected before it reaches the disk or the relay so
// a bad settings save can never silently take the gateway down (the 401
// incident class: a literal "x" persisted and routed).
export function isPlaceholderToken(value) {
  const token = String(value || "").trim();
  if (!token) return true;
  if (token.length < 12) return true;
  if (/^[xX]+$/.test(token)) return true;
  if (/^[\u2022.*_-]+$/.test(token)) return true;
  return false;
}

// Load a .env file into process.env without overriding real environment variables.
// Secret keys are decrypted on the way in, so callers always see the plaintext token;
// plaintext values (an old unencrypted file) pass through unchanged.
function applyEnvFile(file) {
  if (!existsSync(file)) return;
  const entries = parseEnvFile(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(entries)) {
    if (process.env[key] === undefined) {
      process.env[key] = isSecretKey(key) ? decryptSecret(value) : value;
    }
  }
}

// Merge the given entries into the user .env file, preserving comments, blank lines and
// unrelated keys (a line-preserving merge), creating the directory if needed.
export function writeEnvFile(updates, file = envFileFor()) {
  if (!file) file = envFileFor();
  const raw = existsSync(file) ? readFileSync(file, "utf8") : "";
  const hasSecretUpdate = Object.keys(updates).some((key) => isSecretKey(key));
  let backup;
  if (hasSecretUpdate && existsSync(file)) {
    backup = `${file}.bak-${Date.now()}`;
    copyFileSync(file, backup);
    // The backup is a full copy of every secret in .env; on macOS/Linux those
    // are plaintext, and copyFileSync inherits whatever mode the source had -
    // which for a pre-hardening install is world-readable. POSIX only: on
    // Windows the values are DPAPI-sealed and icacls would be a spawn per save.
    if (process.platform !== "win32") {
      try { protectPrivateFile(backup); } catch { /* hardening is best effort */ }
    }
  }
  try {
    const lines = raw.split(/\r?\n/);
    const updated = new Set(Object.keys(updates));
    const next = [];
    for (const line of lines) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match && updated.has(match[1])) {
        // Secrets are stored encrypted on disk; everything else stays as given
        // (minus any CR/LF, which would inject extra .env lines - see sanitizeEnvValue).
        const value = isSecretKey(match[1]) ? encryptSecret(updates[match[1]]) : sanitizeEnvValue(updates[match[1]]);
        next.push(`${match[1]}=${value}`);
        updated.delete(match[1]);
      } else {
        next.push(line);
      }
    }
    for (const key of updated) {
      const value = isSecretKey(key) ? encryptSecret(updates[key]) : sanitizeEnvValue(updates[key]);
      next.push(`${key}=${value}`);
    }
    const content = next.join("\n").replace(/\n+$/, "\n");
    // Write-verify: the on-disk file must decrypt back to exactly the intended
    // plaintext. A silent DPAPI failure would otherwise persist a corrupt value
    // that only surfaces on the next restart.
    if (hasSecretUpdate) {
      const persisted = parseEnvFile(content);
      for (const key of Object.keys(updates)) {
        if (!isSecretKey(key)) continue;
        const plain = String(updates[key]);
        const stored = persisted[key] ?? "";
        // Clearing a secret leaves nothing to decrypt, so the check is that
        // nothing is what landed. Reading an empty value as a failed
        // round-trip made "forget this key" the one write that could not
        // succeed - which is how a retired endpoint kept coming back.
        if (plain === "") {
          if (stored === "") continue;
          const failed = new Error(`Secret ${key} was not cleared; .env was left unchanged.`);
          failed.code = "env_write_verify_failed";
          throw failed;
        }
        if (!stored || decryptSecret(stored) !== plain) {
          const error = new Error(`Secret round-trip check failed for ${key}; .env was left unchanged.`);
          error.code = "env_write_verify_failed";
          throw error;
        }
      }
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    // mode on the temp file (rename preserves it): on macOS/Linux the tokens in
    // .env are plaintext by design, so the file mode is their only protection.
    writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
    try {
      renameSync(tmp, file);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* keep the original error */ }
      throw error;
    }
    if (process.platform !== "win32") {
      try { protectPrivateFile(file); } catch { /* hardening is best effort */ }
    }
    if (hasSecretUpdate) pruneEnvBackups(file);
    for (const [key, value] of Object.entries(updates)) {
      if (value) process.env[key] = isSecretKey(key) ? decryptSecret(encryptSecret(value)) : value;
      else delete process.env[key];
    }
    return file;
  } catch (error) {
    if (backup && existsSync(backup)) {
      try {
        copyFileSync(backup, file);
      } catch {
        // Keep the original error; restoration is best effort.
      }
    }
    throw error;
  }
}

function pruneEnvBackups(file, keep = 5) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-`;
  let backups;
  try {
    backups = readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
  } catch {
    return;
  }
  for (const name of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      rmSync(path.join(dir, name), { force: true });
    } catch {
      // Best effort: an unremovable backup is harmless.
    }
  }
}

// One-time migration of a plaintext .env to encrypted secrets. Backs up the original,
// rewrites only the secret keys, then re-reads the file and verifies the round-trip;
// on any failure the backup is restored and the file is left untouched. Non-Windows is
// a no-op (values are kept plaintext there by design).
export function migrateEnvSecrets(file = envFileFor()) {
  if (!existsSync(file)) return { file, migrated: 0, reason: "missing" };
  if (process.platform !== "win32") return { file, migrated: 0, reason: "non-windows" };
  const raw = readFileSync(file, "utf8");
  const entries = parseEnvFile(raw);
  const plainSecrets = Object.entries(entries).filter(
    ([key, value]) => isSecretKey(key) && value && !String(value).startsWith("dpapi:")
  );
  if (plainSecrets.length === 0) return { file, migrated: 0, reason: "none-plain" };

  const backup = `${file}.plain.bak-${Date.now()}`;
  copyFileSync(file, backup);
  // A cleartext dump of every secret about to be encrypted; keep it readable
  // by the current user only for the short window it exists (and permanently,
  // when a verify failure retains it as the rollback copy). This migration
  // path is Windows-only (checked above), where the cleartext copy is exactly
  // what DPAPI cannot cover yet - so here the ACL pass is worth its spawn.
  try { protectPrivateFile(backup); } catch { /* hardening is best effort */ }
  const updates = {};
  for (const [key, value] of plainSecrets) updates[key] = value;
  writeEnvFile(updates, file);

  // Verify the file really decrypts back to what we started with; restore on failure.
  const after = parseEnvFile(readFileSync(file, "utf8"));
  for (const [key, original] of plainSecrets) {
    if (decryptSecret(after[key]) !== original) {
      copyFileSync(backup, file);
      return { file, migrated: 0, reason: "verify-failed", backup };
    }
  }
  // The backup exists only as the rollback for the round-trip check above. Once
  // the encrypted file verifies, it is a cleartext copy of every secret we just
  // encrypted, so keeping it is worse than the migration it protected against.
  try {
    rmSync(backup, { force: true });
  } catch {
    // Best effort: a leftover backup is handled by pruneEnvBackups-like cleanup.
  }
  return { file, migrated: plainSecrets.length, backup };
}

function integer(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizedBaseUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported upstream protocol: ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function tomlStringValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return "";
}

export function tokenFromCodexToml(source) {
  let provider = "";
  for (const line of String(source || "").split(/\r?\n/)) {
    const section = line.match(/^\s*\[model_providers\.([^\]]+)\]\s*(?:#.*)?$/i);
    if (section) {
      provider = section[1].replace(/^['"]|['"]$/g, "").toLowerCase();
      continue;
    }
    if (/^\s*\[/.test(line)) {
      provider = "";
      continue;
    }
    if (!new Set(["opencode", "opencode_go", "console_go"]).has(provider)) continue;
    const token = line.match(/^\s*experimental_bearer_token\s*=\s*(.+?)\s*(?:#.*)?$/i);
    if (token) return tomlStringValue(token[1]);
  }
  return "";
}

function discoverCodexGoToken(codexHome) {
  try {
    const candidates = readdirSync(codexHome)
      .filter((name) => name === "config.toml" || name.startsWith("config.toml.bak"))
      .map((name) => {
        const file = path.join(codexHome, name);
        return { file, modified: statSync(file).mtimeMs };
      })
      .sort((left, right) => right.modified - left.modified);
    for (const candidate of candidates) {
      const token = tokenFromCodexToml(readFileSync(candidate.file, "utf8"));
      if (token && token !== "local-modeldock") return { token, source: "codex-config-backup" };
    }
  } catch {
    // An environment token remains the explicit fallback if discovery is unavailable.
  }
  return { token: "", source: "missing" };
}

// Does the Codex home directory carry a ChatGPT/Codex sign-in (auth.json)?
// ModelDock never holds native credentials itself: it forwards whatever headers
// the Codex client sends, so a missing sign-in means every published native GPT
// model answers 401. Detecting the sign-in here lets the published catalog skip
// the native merge for logged-out users instead of advertising dead models.
// The file is parsed in codex-auth.mjs, which is also where the native image
// call reads its token - one reader, so the two cannot disagree about the shape.
export { hasChatGptLogin };

export function loadConfig() {
  applyEnvFile(envFileFor());
  const rawHost = process.env.MODELDOCK_HOST || "127.0.0.1";
  if (!isLoopbackHost(rawHost)) {
    throw new Error("MODELDOCK_HOST must be a loopback address for this MVP");
  }
  // Canonicalize the spelling, not just the meaning: createMcpExpressApp turns
  // on its DNS-rebinding Host guard only when the host is exactly "127.0.0.1",
  // "localhost", or "::1". isLoopbackHost also admits "LOCALHOST" and "[::1]",
  // so an uncanonicalized value would pass the check above and silently start
  // the app without Host validation.
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");

  const codexHome = path.resolve(process.env.MODELDOCK_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  const profileId = (process.env.MODELDOCK_PROFILE || "opencode-go").trim().toLowerCase();
  const profile = profileById(profileId);

  // Load-side write protection: a placeholder or unreadable token in .env is
  // treated as unset and (for OpenCode Go) falls back to the Codex config
  // backup instead of being routed. A bad persisted value therefore degrades to
  // "no token" plus an audit event, never to a silent 401 wall.
  const rawOpencodeToken = process.env.OPENCODE_GO_TOKEN || "";
  const rawDeepseekToken = process.env.DEEPSEEK_API_KEY || "";
  const ignoredTokens = [];
  if (rawOpencodeToken && isPlaceholderToken(rawOpencodeToken)) ignoredTokens.push("opencode-go");
  if (rawDeepseekToken && isPlaceholderToken(rawDeepseekToken)) ignoredTokens.push("deepseek-official");
  if (ignoredTokens.length) {
    recordSettingsEvent({ action: "env_placeholder_ignored", providers: ignoredTokens, ok: false, error: "placeholder_token_ignored" });
  }
  // The effective OpenCode token: a non-placeholder env value wins, otherwise
  // the Codex config backup. Token and source come from the same decision so
  // the dashboard's tokenSource never claims "environment" for a token that
  // actually came from the backup (a placeholder env value is ignored). The Go
  // camp is profile-independent: a DeepSeek main model still routes its
  // vision/web harness through it, so discovery applies to every profile.
  const opencodeEnvValid = Boolean(rawOpencodeToken) && !isPlaceholderToken(rawOpencodeToken);
  const backupOpenCode = discoverCodexGoToken(codexHome);
  const opencodeGoToken = opencodeEnvValid ? rawOpencodeToken : backupOpenCode.token;
  const opencodeGoSource = opencodeEnvValid ? "environment" : backupOpenCode.source;
  const deepseekToken = rawDeepseekToken && !isPlaceholderToken(rawDeepseekToken) ? rawDeepseekToken : "";
  // Custom endpoint (dashboard "Custom model" section): a user-configured
  // Responses provider. Empty until the Add flow writes these keys into .env.
  // The list is the source of truth. The single MODELDOCK_CUSTOM_* slot is
  // read as a migration path: an install that predates the list keeps working
  // and its endpoint becomes the first entry.
  // The list is the only source. An install that predates it has its single
  // MODELDOCK_CUSTOM_* slot folded in by migrateLegacyCustomEndpoint, which
  // runs once at gateway startup - not here: this function is read-only, and
  // a loader that writes .env writes whichever .env it resolves, which under
  // `node --test` is the user's real one.
  const customEndpoints = readCustomEndpoints();
  // Native models are appended to the published set rather than living in a
  // profile, so the stamping pass at the end cannot reach them; the catalog and
  // the pickers read this map instead. Without it, editing a native model's
  // window returned 200 and changed neither the page nor the file Codex reads.
  const contextOverrides = readContextOverrides();
  // Which published models reach Codex's picker. Read here so every consumer of
  // a config - the catalog writer, the roster, a test fixture - sees the same
  // set without each of them reaching for the file.
  const modelToggles = readModelToggles();
  const customBaseUrl = customEndpoints[0]?.baseUrl || "";
  const customApiKey = customEndpoints[0]?.apiKey || "";
  const customModel = customEndpoints[0]?.modelId || "";
  const customVision = Boolean(customEndpoints[0]?.supportsVision);
  // Advertised context window of the custom endpoint model (e.g. 32768 for a
  // local 32K llama.cpp serve). Written by the Add flow from /v1/models
  // meta.n_ctx so compaction thresholds match the real backend, not the 250K fallback.
  const customContextWindow = Number(customEndpoints[0]?.contextWindow) || 0;
  // Ollama connection snapshot: the model list captured at connect time, restored
  // on every boot so a restart never has to re-contact Ollama. Reconnect refreshes.
  const ollamaSnapshotFile = ollamaSnapshotPath();
  const ollamaSnapshot = readOllamaSnapshot(ollamaSnapshotFile);
  const tokens = {
    "opencode-go": opencodeGoToken,
    "deepseek-official": deepseekToken,
    ...(customApiKey ? { custom: customApiKey } : {}),
  };

  // A model reference may come from an older .env as a bare id (gpt-5.6-luna). Publish
  // the provider-qualified slug when the id needs one so the Codex picker and internal
  // routing agree on what is ours versus the native backend's GPT-5.6-Luna.
  const modelRef = (raw) => {
    const id = String(raw || "").trim();
    return !id || id.includes(PROVIDER_SEPARATOR) ? id : publishedSlugFor(profileId, id);
  };
  const customSlug = customModel ? `${customModel}${PROVIDER_SEPARATOR}custom` : "";
  // Connecting a backend publishes a model; it does not select one. Publishing
  // is the whole of what "can be the main model" means - the Codex picker
  // chooses per session, and the routing fallback is derived per session and
  // bootstrapped from the native config default (see gateway.mjs). This value
  // is only a display/catalog default.
  const mainModel = modelRef("deepseek-v4-flash");
  // Mode-aware default vision model. ON mode (paid native-GPT merge) defaults to
  // Luna so image turns never route to the zen free endpoint, whose empty-output
  // bug burns the whole output budget and returns nothing (200 + output:[] or a
  // bare response.completed). OFF has no native GPT to fall back on, so it keeps
  // the free vision model unless explicitly overridden via MODELDOCK_VISION_MODEL.
  // Wizard-managed native-GPT merge: off for users without a ChatGPT/Codex
  // subscription so the picker never advertises models that 401 on request.
  // Defaults to the signed-in state when the env key is unset: a detected
  // ~/.codex/auth.json keeps the merge (subscriber behavior unchanged), no
  // sign-in means the native GPT models stay out of the published catalog.
  const nativeMerge = (() => {
    const raw = String(process.env.MODELDOCK_NATIVE_MERGE || "").toLowerCase();
    if (raw) return !["0", "false", "off"].includes(raw);
    return hasChatGptLogin(codexHome);
  })();
  const defaultVisionModel = !nativeMerge ? "mimo-v2.5-free" : "gpt-5.6-luna";
  const configuredVision = String(process.env.MODELDOCK_VISION_MODEL || "").trim();
  // "none" is the durable representation for a provider with no vision model.
  // An empty env value cannot represent this because it intentionally falls back
  // to the mode-aware default above on the next process start.
  const visionModel = configuredVision.toLowerCase() === "none"
    ? ""
    : modelRef(configuredVision || (customVision && customSlug ? customSlug : defaultVisionModel));

  const debug = {
    enabled: envOn("MODELDOCK_DEBUG"),
    noReasoning: envOn("MODELDOCK_NO_REASONING"),
    dumpDir: process.env.MODELDOCK_DUMP_DIR || "",
    dumpAll: envOn("MODELDOCK_DUMP_ALL"),
  };
  // How the managed [mcp_servers.modeldock] entry connects: "stdio" (default) spawns
  // src/mcp-standalone.mjs as a Codex-owned child that survives gateway restarts;
  // "url" points Codex at the gateway's caller-key-protected HTTP MCP endpoint instead.
  const mcpTransportRaw = (process.env.MODELDOCK_MCP_TRANSPORT || "stdio").trim().toLowerCase();
  const mcpTransport = ["stdio", "url"].includes(mcpTransportRaw) ? mcpTransportRaw : "stdio";

  const config = Object.freeze({
    host,
    port: integer("MODELDOCK_PORT", 4097, { min: 1, max: 65535 }),
    profile,
    profileId: profile.id,
    debug,
    // Per-camp base URLs: the OpenCode Go camp is profile-independent so a DeepSeek main
    // model can still route its vision/web harness to the Go camp, and vice versa.
    opencodeBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1"),
    goBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_UPSTREAM_BASE_URL || "https://opencode.ai/zen/go/v1"),
    deepseekBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_DEEPSEEK_BASE_URL || "https://api.deepseek.com"),
    // Zen free tier: the free models route here instead of zen/go. Overridable
    // so sandbox/CI can point free traffic at a mock upstream.
    zenBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_ZEN_BASE_URL || "https://opencode.ai/zen/v1"),
    goTokenSource: opencodeGoSource,
    tokens,
    customEndpoints,
    contextOverrides,
    modelToggles,
    customBaseUrl,
    customApiKey,
    customModel,
    customVision,
    customContextWindow,
    ollamaBaseUrl: String(ollamaSnapshot?.baseUrl || OLLAMA_DEFAULT_BASE),
    ollamaSnapshotFile,
    mainModel,
    visionModel,
    // Wizard-managed native-GPT merge: off for users without a ChatGPT/Codex
    // subscription so the picker never advertises models that 401 on request.
    // Defaults to the signed-in state when the env key is unset (see above).
    nativeMerge,
    mcpTransport,
    visionTimeoutMs: integer("MODELDOCK_VISION_TIMEOUT_MS", 90_000, { min: 1_000, max: 300_000 }),
    mediaTtlMs: integer("MODELDOCK_MEDIA_TTL_MS", 30 * 24 * 3_600_000, { min: 60_000 }),
    mediaMaxBytes: integer("MODELDOCK_MEDIA_MAX_BYTES", 10 * 1024 * 1024, { min: 1_024 }),
    mediaMaxEntries: integer("MODELDOCK_MEDIA_MAX_ENTRIES", 4_096, { min: 1, max: 10_000 }),
    mediaMaxStoredBytes: integer("MODELDOCK_MEDIA_MAX_STORED_BYTES", 256 * 1024 * 1024, { min: 1_024 * 1_024 }),
    mediaDir: process.env.MODELDOCK_MEDIA_DIR
      ? path.resolve(process.env.MODELDOCK_MEDIA_DIR)
      : stateFile("media"),
    // Persistent memory vault (recall_memory tool). Always on; MODELDOCK_MEMORY=0
    // opts out for the rare install that wants to stay thin.
    memoryEnabled: !envOff("MODELDOCK_MEMORY"),
    memoryDir: process.env.MODELDOCK_MEMORY_DIR
      ? path.resolve(process.env.MODELDOCK_MEMORY_DIR)
      : path.join(os.homedir(), ".modeldock", "memory"),
    memoryRefreshHours: Number(process.env.MODELDOCK_MEMORY_REFRESH_HOURS || 6),
    exaMcpUrl: normalizedBaseUrl(process.env.EXA_MCP_URL || "https://mcp.exa.ai/mcp"),
    exaApiKey: process.env.EXA_API_KEY || "",
    recentLimit: integer("MODELDOCK_RECENT_LIMIT", 200, { min: 10, max: 500 }),
    modelRefreshHours: Number(process.env.MODELDOCK_MODEL_REFRESH_HOURS || 24),
    // Model catalog refresh. Off by default: the shipped curated catalog in catalog.mjs
    // is the primary source and is published with the release. When enabled it only does a
    // light GET /models merge (new ids appended, vision metadata untouched). The heavier
    // vision probe/evaluation code in server.mjs is dev-only test tooling and is never
    // triggered here or at startup.
    modelProbeEnabled: envOn("MODELDOCK_MODEL_PROBE_ENABLED"),
    // Native GPT models captured from the Codex desktop CLI, merged into the
    // published catalog so they stay selectable in the App picker. The cache
    // lives at ~/.modeldock/native-catalog.json by default.
    nativeCatalogFile: process.env.MODELDOCK_NATIVE_CATALOG_FILE
      ? path.resolve(process.env.MODELDOCK_NATIVE_CATALOG_FILE)
      : "",
    refreshNativeCatalog: !envOff("MODELDOCK_REFRESH_NATIVE_CATALOG"),
    codexHome,
    envFile: envFileFor(),
  });
  // Populate the custom provider profile so catalog building and per-model
  // routing see the configured endpoint/model (see profiles.mjs).
  applyCustomProfile(config);
  // Populate the ollama profile from the connection snapshot so local models stay
  // published across restarts without re-contacting Ollama.
  applyOllamaProfile(config, ollamaSnapshot);
  // Same contract for the keyless OpenAI-dialect engines: republish what the
  // last connect saw, without probing a machine that may be offline now.
  const localSnapshot = readLocalEnginesSnapshot() || {};
  for (const engineId of ["llamacpp", "vllm"]) applyLocalEngineProfile(engineId, localSnapshot[engineId]);
  // Last, so a user correction wins over the shipped catalog and over
  // whatever a local engine just reported about itself.
  applyContextOverrides(allProfiles(), contextOverrides, { publishedSlugFor });
  return config;
}

export function publicConfig(config) {
  return {
    bind: `${config.host}:${config.port}`,
    profile: config.profileId,
    goBaseUrl: config.goBaseUrl,
    opencodeBaseUrl: config.opencodeBaseUrl,
    deepseekBaseUrl: config.deepseekBaseUrl,
    mainModel: config.mainModel,
    visionModel: config.visionModel,
    exaMcpUrl: config.exaMcpUrl,
    // Provider tokens live in one place: the per-provider map. goToken was the
    // pre-multi-provider single field and is gone; readers must use tokens.
    tokenConfigured: Boolean(Object.values(config.tokens || {}).some(Boolean)),
    tokenSource: config.goTokenSource || (config.tokens?.["opencode-go"] ? "configured" : "missing"),
    debug: {
      enabled: Boolean(config.debug?.enabled),
      noReasoning: Boolean(config.debug?.noReasoning),
      dumpDir: config.debug?.dumpDir || "",
      dumpAll: Boolean(config.debug?.dumpAll),
    },
  };
}

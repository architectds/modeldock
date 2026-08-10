import process from "node:process";
import os from "node:os";
import path from "node:path";
import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { PROVIDER_SEPARATOR, applyCustomProfile, profileById, publishedSlugFor } from "./profiles.mjs";
import { normalizeBaseUrl } from "./custom-endpoint.mjs";
import { encryptSecret, decryptSecret, isSecretKey } from "./secrets.mjs";
import { recordSettingsEvent } from "./settings-events.mjs";

// Resolve the user configuration (.env) file. Priority:
//   1. MODELDOCK_ENV_FILE (explicit path)
//   2. MODELDOCK_CONFIG_DIR/.env
//   3. ~/.modeldock/.env when it exists (installed layout; cwd is not controllable)
//   4. <cwd>/.env (dev layout)
// When nothing exists yet, fall back to ~/.modeldock/.env so first-run settings saves
// land in a cwd-independent location. The resolved path is recorded on the config so
// the settings API can write back to it.
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
export function sanitizeEnvValue(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

export function serializeEnvFile(entries) {
  return Object.entries(entries)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${sanitizeEnvValue(value)}`)
    .join("\n") + "\n";
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
        const stored = persisted[key];
        if (!stored || decryptSecret(stored) !== plain) {
          const error = new Error(`Secret round-trip check failed for ${key}; .env was left unchanged.`);
          error.code = "env_write_verify_failed";
          throw error;
        }
      }
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
    if (hasSecretUpdate) pruneEnvBackups(file);
    for (const [key, value] of Object.entries(updates)) {
      if (value) process.env[key] = isSecretKey(key) ? decryptSecret(encryptSecret(value)) : value;
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
// A refresh token is treated as a sign-in too (Codex refreshes it silently).
export function hasChatGptLogin(codexHome) {
  try {
    const authFile = path.join(codexHome, "auth.json");
    if (!existsSync(authFile)) return false;
    const parsed = JSON.parse(readFileSync(authFile, "utf8"));
    const tokens = parsed?.tokens || {};
    return Boolean(tokens.access_token || tokens.refresh_token || parsed?.OPENAI_API_KEY);
  } catch {
    return false;
  }
}

export function loadConfig() {
  applyEnvFile(envFileFor());
  const host = process.env.MODELDOCK_HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("MODELDOCK_HOST must be a loopback address for this MVP");
  }

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
  const customBaseUrl = normalizeBaseUrl(process.env.MODELDOCK_CUSTOM_BASE_URL || "");
  const customApiKey = process.env.MODELDOCK_CUSTOM_API_KEY || "";
  const customModel = String(process.env.MODELDOCK_CUSTOM_MODEL || "").trim();
  const customMain = ["1", "true", "on", "yes"].includes(String(process.env.MODELDOCK_CUSTOM_MAIN || "").toLowerCase());
  const customVision = ["1", "true", "on", "yes"].includes(String(process.env.MODELDOCK_CUSTOM_VISION || "").toLowerCase());
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
  const mainModel = modelRef(process.env.MODELDOCK_MAIN_MODEL || (customMain && customSlug ? customSlug : "deepseek-v4-flash"));
  // Mode-aware default vision model. ON mode (paid native-GPT merge) defaults to
  // Luna so image turns never route to the zen free endpoint, whose empty-output
  // bug burns the whole output budget and returns nothing (200 + output:[] or a
  // bare response.completed). Trial is the fixed free pair and OFF has no native
  // GPT to fall back on, so both keep the free vision model unless explicitly
  // overridden via MODELDOCK_VISION_MODEL.
  const trialMode = process.env.MODELDOCK_TRIAL === "1";
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
  const defaultVisionModel = trialMode || !nativeMerge ? "mimo-v2.5-free" : "gpt-5.6-luna";
  const configuredVision = String(process.env.MODELDOCK_VISION_MODEL || "").trim();
  // "none" is the durable representation for a provider with no vision model.
  // An empty env value cannot represent this because it intentionally falls back
  // to the mode-aware default above on the next process start.
  const visionModel = configuredVision.toLowerCase() === "none"
    ? ""
    : modelRef(configuredVision || (customVision && customSlug ? customSlug : defaultVisionModel));
  const visionFallbackModel = modelRef(process.env.MODELDOCK_VISION_FALLBACK_MODEL || "minimax-m3");

  const debug = {
    enabled: process.env.MODELDOCK_DEBUG === "1" || process.env.MODELDOCK_DEBUG === "true",
    noReasoning: process.env.MODELDOCK_NO_REASONING === "1",
    dumpDir: process.env.MODELDOCK_DUMP_DIR || "",
    dumpAll: process.env.MODELDOCK_DUMP_ALL === "1",
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
    // Zen free tier (trial): the fixed free models route here instead of zen/go.
    // Overridable so sandbox/CI can point trial at a mock upstream.
    zenBaseUrl: normalizedBaseUrl(process.env.MODELDOCK_ZEN_BASE_URL || "https://opencode.ai/zen/v1"),
    goTokenSource: opencodeGoSource,
    tokens,
    customBaseUrl,
    customApiKey,
    customModel,
    customMain,
    customVision,
    mainModel,
    visionModel,
    visionFallbackModel,
    // Trial mode: the fixed zen-free model pair (deepseek-v4-flash-free /
    // mimo-v2.5-free) on the opencode-go profile with a free-only catalog and
    // trial-specific upstream error copy. Managed by /api/config/mode.
    trialMode,
    // Wizard-managed native-GPT merge: off for users without a ChatGPT/Codex
    // subscription so the picker never advertises models that 401 on request.
    // Defaults to the signed-in state when the env key is unset (see above).
    nativeMerge,
    mcpTransport,
    visionTimeoutMs: integer("MODELDOCK_VISION_TIMEOUT_MS", 90_000, { min: 1_000, max: 300_000 }),
    mediaTtlMs: integer("MODELDOCK_MEDIA_TTL_MS", 3_600_000, { min: 60_000 }),
    mediaMaxBytes: integer("MODELDOCK_MEDIA_MAX_BYTES", 10 * 1024 * 1024, { min: 1_024 }),
    mediaMaxEntries: integer("MODELDOCK_MEDIA_MAX_ENTRIES", 64, { min: 1, max: 1_024 }),
    mediaDir: process.env.MODELDOCK_MEDIA_DIR
      ? path.resolve(process.env.MODELDOCK_MEDIA_DIR)
      : path.join(os.homedir(), ".modeldock", "media"),
    // Persistent memory vault (recall_memory tool). Always on; MODELDOCK_MEMORY=0
    // opts out for the rare install that wants to stay thin.
    memoryEnabled: !["0", "false", "off", "no"].includes(String(process.env.MODELDOCK_MEMORY || "").toLowerCase()),
    memoryDir: process.env.MODELDOCK_MEMORY_DIR
      ? path.resolve(process.env.MODELDOCK_MEMORY_DIR)
      : path.join(os.homedir(), ".modeldock", "memory"),
    memoryRefreshHours: Number(process.env.MODELDOCK_MEMORY_REFRESH_HOURS || 6),
    exaMcpUrl: normalizedBaseUrl(process.env.EXA_MCP_URL || "https://mcp.exa.ai/mcp"),
    exaApiKey: process.env.EXA_API_KEY || "",
    recentLimit: integer("MODELDOCK_RECENT_LIMIT", 50, { min: 10, max: 500 }),
    modelRefreshHours: Number(process.env.MODELDOCK_MODEL_REFRESH_HOURS || 24),
    // md_memory: the whole memory-compression line (rolling summaries, the assistant
    // sliding window, reasoning clipping, anti-breakpoint revival) behind one switch.
    // Set MODELDOCK_MD_MEMORY=0 to hand context management back to the client and
    // compare the two - the code stays in place either way.
    mdMemory: !["0", "false", "off"].includes(String(process.env.MODELDOCK_MD_MEMORY || "").toLowerCase()),
    // Model catalog refresh. Off by default: the shipped curated catalog in catalog.mjs
    // is the primary source and is published with the release. When enabled it only does a
    // light GET /models merge (new ids appended, vision metadata untouched). The heavier
    // vision probe/evaluation code in server.mjs is dev-only test tooling and is never
    // triggered here or at startup.
    modelProbeEnabled: process.env.MODELDOCK_MODEL_PROBE_ENABLED === "1",
    // Native GPT models captured from the Codex desktop CLI, merged into the
    // published catalog so they stay selectable in the App picker. The cache
    // lives at ~/.modeldock/native-catalog.json by default.
    nativeCatalogFile: process.env.MODELDOCK_NATIVE_CATALOG_FILE
      ? path.resolve(process.env.MODELDOCK_NATIVE_CATALOG_FILE)
      : "",
    refreshNativeCatalog: !["0", "false", "off"].includes(
      String(process.env.MODELDOCK_REFRESH_NATIVE_CATALOG || "").toLowerCase(),
    ),
    codexHome,
    envFile: envFileFor(),
  });
  // Populate the custom provider profile so catalog building and per-model
  // routing see the configured endpoint/model (see profiles.mjs).
  applyCustomProfile(config);
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
    visionFallbackModel: config.visionFallbackModel,
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

import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { appendConfigManifest, assertConfigWriteSafe } from "./toml-guard.mjs";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

// The transparent mode keeps the built-in openai provider and only redirects its
// API base to the local gate (the codex-router shape). This makes the App keep
// listing native GPT models beside ours, keeps the ChatGPT subscription intact,
// and leaves uses_codex_backend() true so the picker keeps refreshing. The managed
// fields live inside a sentinel block so detection and restore are exact.
const MANAGED_BEGIN = /^\s*#\s*BEGIN\s+modeldock-managed\s*(?:#.*)?$/m;
const MANAGED_END = /^\s*#\s*END\s+modeldock-managed\s*(?:#.*)?$/m;
const MANAGED_ORIGINAL_EXISTED = /^\s*#\s*ModelDock original config existed:\s*(true|false)\s*$/im;
const CODERX_ROUTER_BEGIN = /^\s*#\s*BEGIN\s+codex-router-managed\s*(?:#.*)?$/m;

// Every top-level key ModelDock may write. Restoring a backup puts the user's own
// values back, and enable() overwrites them with the managed block.
const MANAGED_TOP_LEVEL_KEYS = [
  "model",
  "model_provider",
  "web_search",
  "model_catalog_json",
  "openai_base_url",
  "experimental_realtime_webrtc_call_base_url",
  "experimental_realtime_ws_base_url",
];

function providerSection(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^\s*\[model_providers\.modeldock_go\]\s*(?:#.*)?$/i.test(line));
  if (start < 0) return [];
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  return lines.slice(start, end);
}

function isLegacyManaged(source) {
  return topLevelString(source, "model_provider") === "modeldock_go" || providerSection(source).length > 0;
}

function isNewManaged(source) {
  return MANAGED_BEGIN.test(source) && MANAGED_END.test(source);
}

function hasManagedRoute(source) {
  return isLegacyManaged(source) || isNewManaged(source);
}

function hasCodexRouterBlock(source) {
  return CODERX_ROUTER_BEGIN.test(source);
}

function extractManagedBlock(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const block = [];
  let inBlock = false;
  for (const line of lines) {
    if (MANAGED_BEGIN.test(line)) {
      inBlock = true;
      block.push(line.trim());
      continue;
    }
    if (inBlock) {
      if (MANAGED_END.test(line)) {
        inBlock = false;
        block.push(line.trim());
      } else if (line.trim() && !line.trim().startsWith("#")) {
        block.push(line.trim());
      }
    }
  }
  return block;
}

// The top-level `model` key is deliberately NOT part of the signature: the Codex
// App picker rewrites it on every model selection, and the whole catalog exists
// so the picker can drive routing. Treating a picker change as foreign drift
// made the dashboard scream and disable() refuse to restore after normal use.
function topLevelLine(source, key) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const matcher = new RegExp(`^\\s*${key}\\s*=`);
  return lines.slice(0, limit).find((line) => matcher.test(line)) || null;
}

function topLevelString(source, key) {
  const line = topLevelLine(source, key);
  if (!line) return null;
  const match = line.match(/=\s*(["'])(.*?)\1/);
  return match ? match[2] : null;
}

// Remove everything ModelDock wrote: the sentinel block, the legacy
// [model_providers.modeldock_go] section, our [mcp_servers.modeldock] section,
// and any managed top-level key (the original values are restored separately).
function removeManagedRoute(lines) {
  const output = [];
  let inSentinel = false;
  let skippingProvider = false;
  let skippingMcp = false;
  for (const line of lines) {
    if (MANAGED_BEGIN.test(line)) {
      inSentinel = true;
      continue;
    }
    if (inSentinel) {
      if (MANAGED_END.test(line)) inSentinel = false;
      continue;
    }
    if (/^\s*\[model_providers\.modeldock_go\]/.test(line)) {
      skippingProvider = true;
      continue;
    }
    if (skippingProvider && /^\s*\[/.test(line)) skippingProvider = false;
    if (skippingProvider) continue;
    if (/^\s*\[mcp_servers\.modeldock\]/.test(line)) {
      skippingMcp = true;
      continue;
    }
    if (skippingMcp && /^\s*\[/.test(line)) skippingMcp = false;
    if (skippingMcp) continue;
    if (/^\s*#\s*Managed by ModelDock/i.test(line)) continue;
    output.push(line);
  }

  const firstTable = output.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? output.length : firstTable;
  const matchers = MANAGED_TOP_LEVEL_KEYS.map((key) => new RegExp(`^\\s*${key}\\s*=`));
  const stripped = [];
  for (let index = 0; index < output.length; index += 1) {
    if (index < limit && matchers.some((matcher) => matcher.test(output[index]))) continue;
    stripped.push(output[index]);
  }
  return stripped;
}

function restoreTopLevel(lines, key, originalLine) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const matcher = new RegExp(`^\\s*${key}\\s*=`);
  for (let index = limit - 1; index >= 0; index -= 1) if (matcher.test(lines[index])) lines.splice(index, 1);
  if (originalLine) {
    const insertAt = lines.findIndex((line) => /^\s*\[/.test(line));
    lines.splice(insertAt < 0 ? lines.length : insertAt, 0, originalLine);
  }
}

function mergeRestoredCodexConfig(current, original) {
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const originalSection = providerSection(original);
  const lines = removeManagedRoute(current.replace(/\r\n/g, "\n").split("\n"));
  for (const key of MANAGED_TOP_LEVEL_KEYS) restoreTopLevel(lines, key, topLevelLine(original, key));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (originalSection.length) lines.push("", ...originalSection);
  return `${lines.join("\n").replace(/\n/g, newline)}${newline}`;
}

function setTopLevel(lines, key, value) {
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable < 0 ? lines.length : firstTable;
  const matcher = new RegExp(`^\\s*${key}\\s*=`);
  const matches = [];
  for (let index = 0; index < limit; index += 1) if (matcher.test(lines[index])) matches.push(index);
  if (matches.length) {
    lines[matches[0]] = `${key} = ${tomlString(value)}`;
    for (const index of matches.slice(1).reverse()) lines.splice(index, 1);
    return lines;
  }
  lines.splice(limit, 0, `${key} = ${tomlString(value)}`);
  return lines;
}

// Build the transparent managed config: the built-in openai provider stays, its
// base URL is redirected to the local gate, and the realtime endpoints point at
// OpenAI so Codex Voice never dials the loopback. The catalog file keeps naming
// our models in the App picker (openai/codex#32119 only affects custom providers).
export function buildManagedCodexConfig(source, { baseUrl, model, catalogFile = "", mcpUrl = "", mcpCommand = "", mcpArgs = [], mcpEnv = {}, originalExisted = true }) {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let lines = removeManagedRoute(source.replace(/\r\n/g, "\n").split("\n"));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  lines = setTopLevel(lines, "model", model);

  const managed = [
    "# BEGIN modeldock-managed",
    "# Managed by ModelDock: keeps the built-in openai provider and points it at the local gate.",
    `# ModelDock original config existed: ${originalExisted ? "true" : "false"}`,
    `openai_base_url = ${tomlString(baseUrl)}`,
  ];
  if (catalogFile) managed.push(`model_catalog_json = ${tomlString(catalogFile)}`);
  managed.push(
    'experimental_realtime_webrtc_call_base_url = "https://chatgpt.com/backend-api/codex"',
    'experimental_realtime_ws_base_url = "https://api.openai.com/v1"',
    "# END modeldock-managed",
  );
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  lines.splice(firstTable < 0 ? lines.length : firstTable, 0, "", ...managed);

  if (mcpUrl) {
    lines.push(
      "",
      "[mcp_servers.modeldock]",
      "# Managed by ModelDock: web_search_exa / vision_inspect / speak / hear sidecar.",
      `url = ${tomlString(mcpUrl)}`,
    );
  } else if (mcpCommand) {
    lines.push(
      "",
      "[mcp_servers.modeldock]",
      "# Managed by ModelDock: web_search_exa / vision_inspect / speak / hear stdio bridge.",
      `command = ${tomlString(mcpCommand)}`,
      `args = [${mcpArgs.map((arg) => tomlString(arg)).join(", ")}]`,
    );
    const envEntries = Object.entries(mcpEnv);
    if (envEntries.length) {
      lines.push(`env = { ${envEntries.map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(", ")} }`);
    }
  }
  return `${lines.join("\n").replace(/\n/g, newline)}${newline}`;
}

export class CodexConfigSwitcher {
  // Either a fixed model id or a function returning the caller's current
  // selection. Passing the function makes `model` a view of that selection
  // rather than a third copy of it: the snapshot form went stale whenever the
  // model changed elsewhere (Codex's own picker moved it without telling the
  // switcher), and a later enable then wrote the outdated id into config.toml.
  #model;

  constructor({ codexHome, baseUrl, model, catalogFile = "", mcpUrl = "", mcpCommand = "", mcpArgs = [], mcpEnv = {} }) {
    this.codexHome = path.resolve(codexHome || path.join(process.cwd(), ".modeldock-codex-home"));
    this.configPath = path.join(this.codexHome, "config.toml");
    this.stateDir = path.join(this.codexHome, "modeldock");
    this.statePath = path.join(this.stateDir, "config-switch-state.json");
    this.baseUrl = baseUrl;
    this.#model = model;
    this.catalogFile = catalogFile;
    this.mcpUrl = mcpUrl;
    this.mcpCommand = mcpCommand;
    this.mcpArgs = mcpArgs;
    this.mcpEnv = mcpEnv;
  }

  get model() {
    return typeof this.#model === "function" ? this.#model() : this.#model;
  }

  set model(value) {
    this.#model = value;
  }

  async #readState() {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return { enabled: false, restartRequired: false, onboarded: false };
      return { enabled: false, restartRequired: false, onboarded: false, stateError: error.message };
    }
  }

  async #writeState(state) {
    await mkdir(this.stateDir, { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await copyFile(temporary, this.statePath);
    await unlink(temporary);
  }

  async status() {
    const state = await this.#readState();
    let currentHash = null;
    let configExists = true;
    try {
      currentHash = sha256(await readFile(this.configPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") configExists = false;
      else throw error;
    }
    let current = "";
    if (configExists) current = await readFile(this.configPath, "utf8");
    const routeActive = hasManagedRoute(current);
    return {
      enabled: Boolean(state.enabled && routeActive),
      managed: Boolean(state.enabled && routeActive),
      externallyRestored: Boolean(state.enabled && !routeActive),
      restartRequired: Boolean(state.restartRequired),
      configExists,
      configPath: this.configPath,
      backupPath: state.backupPath || state.lastBackupPath || null,
      changedAt: state.changedAt || null,
      onboarded: Boolean(state.onboarded),
      onboardedAt: state.onboardedAt || null,
      targetModel: this.model,
      targetProvider: "openai",
      targetMode: "openai_base_url",
      needsMigration: Boolean(state.enabled && routeActive && !isNewManaged(current) && isLegacyManaged(current)),
      codexRouterConflict: hasCodexRouterBlock(current),
      stateError: state.stateError || null,
    };
  }

  async #readCurrent() {
    try {
      return await readFile(this.configPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  }

  async enable() {
    const state = await this.#readState();
    if (state.stateError) throw Object.assign(new Error(`Cannot read switch state: ${state.stateError}`), { code: "STATE_INVALID" });
    if (state.enabled) {
      const status = await this.status();
      if (status.enabled) {
        // Re-write the config once when it still carries the pre-transparent
        // modeldock_go provider shape, so upgrades land on openai_base_url.
        if (status.needsMigration) {
          await this.disable();
          return this.enable();
        }
        return status;
      }
      await this.disable();
      return this.enable();
    }

    let original = "";
    let originalExisted = true;
    try {
      original = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      originalExisted = false;
    }
    // Crash recovery: enable() only runs with state.enabled false, but a crash
    // between the config write and the state write of a prior enable() leaves the
    // config already managed while state says disabled. Backing that up as the
    // "original" would poison the backup chain - a later disable, seeing the
    // managed hash match, would restore a still-managed config and leave Codex
    // routed at a dead gateway. Strip our managed route first so the backup we take
    // is the true pre-ModelDock baseline.
    let originalWasManaged = false;
    if (originalExisted && hasManagedRoute(original)) {
      originalWasManaged = true;
      const existenceMarker = MANAGED_ORIGINAL_EXISTED.exec(original)?.[1]?.toLowerCase();
      const nl = original.includes("\r\n") ? "\r\n" : "\n";
      original = `${removeManagedRoute(original.replace(/\r\n/g, "\n").split("\n")).join("\n").replace(/\n/g, nl)}${nl}`;
      // New managed configs carry this crash-recovery marker. For older configs,
      // a managed-only file is the best available proof that config.toml did not
      // exist before enable() wrote it.
      if (existenceMarker === "false" || (!existenceMarker && !original.trim())) {
        originalExisted = false;
        original = "";
      }
    }
    if (hasCodexRouterBlock(original)) {
      throw Object.assign(
        new Error("codex-router also manages openai_base_url; disable its integration before enabling ModelDock."),
        { code: "EXTERNAL_MANAGED" },
      );
    }
    // Duplicate-key guard: a duplicated TOML key would make Codex refuse to
    // start, and writing over a broken config would bake the broken state in.
    // Abort before touching anything (the user's config stays untouched).
    if (originalExisted) assertConfigWriteSafe(original);

    const backupPath = path.join(this.codexHome, `config.toml.modeldock-backup-${timestamp()}-${randomUUID().slice(0, 8)}`);
    if (originalExisted && originalWasManaged) {
      // Persist the stripped baseline, not the managed file still on disk.
      await writeFile(backupPath, original, { encoding: "utf8", mode: 0o600 });
    } else if (originalExisted) {
      await copyFile(this.configPath, backupPath);
    } else {
      await writeFile(backupPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
    }

    const managed = buildManagedCodexConfig(original, {
      baseUrl: this.baseUrl,
      model: this.model,
      catalogFile: this.catalogFile,
      mcpUrl: this.mcpUrl,
      mcpCommand: this.mcpCommand,
      mcpArgs: this.mcpArgs,
      mcpEnv: this.mcpEnv,
      originalExisted,
    });
    // Defensive: the writer must never emit duplicates either (setTopLevel
    // dedupes `model`, the managed block owns its keys, but a future edit could
    // regress). Abort before the disk write.
    assertConfigWriteSafe(managed);
    try {
      await writeFile(this.configPath, managed, { encoding: "utf8", mode: 0o600 });
      await this.#writeState({
        version: 2,
        enabled: true,
        restartRequired: true,
        backupPath,
        originalExisted,
        originalHash: sha256(original),
        managedHash: sha256(managed),
        changedAt: new Date().toISOString(),
        onboarded: state.onboarded,
        onboardedAt: state.onboardedAt,
      });
      await appendConfigManifest(this.stateDir, {
        operation: "enable",
        configPath: this.configPath,
        backupPath,
        originalExisted,
        originalHash: sha256(original),
        managedHash: sha256(managed),
      });
    } catch (error) {
      if (originalExisted) await writeFile(this.configPath, original, { encoding: "utf8", mode: 0o600 });
      else await unlink(this.configPath).catch(() => {});
      throw error;
    }
    return this.status();
  }

  async disable() {
    const state = await this.#readState();
    if (!state.enabled) return this.status();
    let current = await this.#readCurrent();
    const routeActive = hasManagedRoute(current);
    let backup = "";
    if (routeActive) {
      try {
        backup = await readFile(state.backupPath, "utf8");
      } catch (error) {
        throw Object.assign(new Error("ModelDock backup is missing while its route is still active; restore requires manual review."), {
          code: "STATE_INVALID",
          cause: error,
        });
      }
    }
    try {
      if (routeActive && state.originalExisted) {
        const restored = sha256(current) === state.managedHash ? backup : mergeRestoredCodexConfig(current, backup);
        assertConfigWriteSafe(restored);
        await writeFile(this.configPath, restored, { encoding: "utf8", mode: 0o600 });
      } else if (routeActive) await unlink(this.configPath);
      await this.#writeState({
        version: 2,
        enabled: false,
        restartRequired: routeActive ? true : Boolean(state.restartRequired),
        lastBackupPath: state.backupPath,
        changedAt: new Date().toISOString(),
        onboarded: state.onboarded,
        onboardedAt: state.onboardedAt,
      });
      await appendConfigManifest(this.stateDir, {
        operation: "disable",
        configPath: this.configPath,
        lastBackupPath: state.backupPath,
        restoredFromBackup: sha256(current) === state.managedHash,
      });
    } catch (error) {
      await writeFile(this.configPath, current, { encoding: "utf8", mode: 0o600 });
      throw error;
    }
    return this.status();
  }

  async acknowledgeRestart() {
    const state = await this.#readState();
    if (state.stateError) throw new Error(`Cannot read switch state: ${state.stateError}`);
    await this.#writeState({ ...state, restartRequired: false });
    return this.status();
  }

  // Non-config files Codex only reads at startup (e.g. agent files) need the
  // same "restart Codex" banner as an enable/disable switch.
  async markRestartRequired() {
    const state = await this.#readState();
    await this.#writeState({ ...state, restartRequired: true });
    return this.status();
  }

  async markOnboarded() {
    const state = await this.#readState();
    if (state.stateError) throw new Error(`Cannot read switch state: ${state.stateError}`);
    await this.#writeState({ ...state, onboarded: true, onboardedAt: new Date().toISOString() });
    return this.status();
  }
}

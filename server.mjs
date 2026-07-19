import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MODELDOCK_PORT || 8765);
const CODEX_EXE = process.env.MODELDOCK_CODEX_EXE || "codex";
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120000;
const COMMAND_OUTPUT_LIMIT = 16000;
const PROVIDER_TIMEOUT_MS = 45000;
const CUSTOM_PROVIDER_RESERVED = new Set(["openai", "ollama", "lmstudio", "amazon-bedrock"]);

function defaultCodexHome() {
  if (process.env.MODELDOCK_CODEX_HOME) return process.env.MODELDOCK_CODEX_HOME;
  const envHome = process.env.CODEX_HOME;
  if (envHome) return envHome;
  return path.join(os.homedir(), ".codex");
}

export async function resolveCodexPaths() {
  const codexHome = defaultCodexHome();
  const realCodexHome = existsSync(codexHome) ? await fs.realpath(codexHome) : codexHome;
  return {
    codexHome,
    realCodexHome,
    configPath: path.join(codexHome, "config.toml"),
    backupsDir: path.join(codexHome, "modeldock-backups"),
    profilesDir: codexHome
  };
}

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback;
    throw error;
  }
}

function tomlQuote(value) {
  return JSON.stringify(String(value ?? ""));
}

function cleanIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function parseSummary(configText) {
  const summary = {
    model: "",
    modelProvider: "",
    reasoningEffort: "",
    verbosity: "",
    providers: []
  };
  const lines = configText.split(/\r?\n/);
  let section = "";
  const providerMap = new Map();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      const providerMatch = section.match(/^model_providers\.([A-Za-z0-9_-]+)$/);
      if (providerMatch && !providerMap.has(providerMatch[1])) {
        providerMap.set(providerMatch[1], { id: providerMatch[1], name: "", baseUrl: "", wireApi: "", envKey: "" });
      }
      continue;
    }
    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    const rawValue = keyMatch[2].replace(/\s+#.*$/, "").trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (!section) {
      if (key === "model") summary.model = value;
      if (key === "model_provider") summary.modelProvider = value;
      if (key === "model_reasoning_effort") summary.reasoningEffort = value;
      if (key === "model_verbosity") summary.verbosity = value;
    }
    const providerMatch = section.match(/^model_providers\.([A-Za-z0-9_-]+)$/);
    if (providerMatch) {
      const provider = providerMap.get(providerMatch[1]);
      if (key === "name") provider.name = value;
      if (key === "base_url") provider.baseUrl = value;
      if (key === "wire_api") provider.wireApi = value;
      if (key === "env_key") provider.envKey = value;
    }
  }
  summary.providers = [...providerMap.values()];
  return summary;
}

function splitSections(configText) {
  const lines = configText.split(/\r?\n/);
  const sections = [];
  let current = { name: "", start: 0, end: lines.length };
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].trim().match(/^\[([^\]]+)\]$/);
    if (match) {
      current.end = index;
      sections.push(current);
      current = { name: match[1], start: index, end: lines.length };
    }
  }
  sections.push(current);
  return { lines, sections };
}

function setTopLevelKey(configText, key, value) {
  let { lines, sections } = splitSections(configText);
  const firstSectionStart = sections.find((section) => section.name)?.start ?? lines.length;
  let replaced = false;
  const output = lines.map((line, index) => {
    if (index >= firstSectionStart) return line;
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      replaced = true;
      return `${key} = ${tomlQuote(value)}`;
    }
    return line;
  });
  if (!replaced) {
    let insertAt = 0;
    while (insertAt < firstSectionStart && output[insertAt]?.trim().startsWith("#")) insertAt += 1;
    output.splice(insertAt, 0, `${key} = ${tomlQuote(value)}`);
  }
  return output.join("\n");
}

function removeTopLevelKey(configText, key) {
  const { lines, sections } = splitSections(configText);
  const firstSectionStart = sections.find((section) => section.name)?.start ?? lines.length;
  return lines
    .filter((line, index) => index >= firstSectionStart || !new RegExp(`^\\s*${key}\\s*=`).test(line))
    .join("\n");
}

function removeSection(configText, sectionName) {
  const { lines, sections } = splitSections(configText);
  const removals = sections.filter((section) => section.name === sectionName || section.name.startsWith(`${sectionName}.`));
  if (!removals.length) return configText;
  const removeIndexes = new Set();
  for (const removal of removals) {
    for (let index = removal.start; index < removal.end; index += 1) removeIndexes.add(index);
  }
  return lines.filter((_, index) => !removeIndexes.has(index)).join("\n").replace(/\n{3,}/g, "\n\n");
}

function shouldWriteProviderBlock(preset) {
  if (!CUSTOM_PROVIDER_RESERVED.has(preset.providerId)) return true;
  return Boolean(preset.baseUrl || preset.envKey);
}

function appendProviderBlock(configText, preset) {
  if (!shouldWriteProviderBlock(preset)) return configText;
  const lines = [
    "",
    `[model_providers.${preset.providerId}]`,
    `name = ${tomlQuote(preset.providerName || preset.providerId)}`,
    `base_url = ${tomlQuote(preset.baseUrl || "")}`
  ];
  if (preset.wireApi) lines.push(`wire_api = ${tomlQuote(preset.wireApi)}`);
  if (preset.envKey) lines.push(`env_key = ${tomlQuote(preset.envKey)}`);
  return `${configText.replace(/\s+$/g, "")}\n${lines.join("\n")}\n`;
}

function renderProfileConfig(preset) {
  let text = "";
  text += `model_provider = ${tomlQuote(preset.providerId)}\n`;
  if (preset.model) text += `model = ${tomlQuote(preset.model)}\n`;
  if (preset.reasoningEffort) text += `model_reasoning_effort = ${tomlQuote(preset.reasoningEffort)}\n`;
  if (preset.verbosity) text += `model_verbosity = ${tomlQuote(preset.verbosity)}\n`;
  if (shouldWriteProviderBlock(preset)) {
    text += `\n[model_providers.${preset.providerId}]\n`;
    text += `name = ${tomlQuote(preset.providerName || preset.providerId)}\n`;
    text += `base_url = ${tomlQuote(preset.baseUrl || "")}\n`;
    if (preset.wireApi) text += `wire_api = ${tomlQuote(preset.wireApi)}\n`;
    if (preset.envKey) text += `env_key = ${tomlQuote(preset.envKey)}\n`;
  }
  return text;
}

export function normalizePreset(input) {
  const providerId = cleanIdentifier(input.providerId);
  if (!providerId) throw new Error("Provider id is required.");
  return {
    providerId,
    providerName: String(input.providerName || providerId).trim(),
    model: String(input.model || "").trim(),
    reasoningEffort: String(input.reasoningEffort || "").trim(),
    verbosity: String(input.verbosity || "").trim(),
    wireApi: String(input.wireApi || "").trim(),
    baseUrl: String(input.baseUrl || "").trim(),
    envKey: String(input.envKey || "").trim()
  };
}

export async function makeBackup(configPath, backupsDir, reason = "manual") {
  await fs.mkdir(backupsDir, { recursive: true });
  const backupName = `${timestampSlug()}-${reason}-${randomUUID().slice(0, 8)}.config.toml`;
  const backupPath = path.join(backupsDir, backupName);
  const current = await readText(configPath, "");
  await fs.writeFile(backupPath, current, "utf8");
  return backupPath;
}

export async function atomicWrite(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, text, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function listBackups(backupsDir) {
  try {
    const files = await fs.readdir(backupsDir, { withFileTypes: true });
    const backups = [];
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".config.toml")) continue;
      const fullPath = path.join(backupsDir, file.name);
      const stat = await fs.stat(fullPath);
      backups.push({ name: file.name, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    return backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readPresets() {
  return JSON.parse(await readText(path.join(__dirname, "data", "presets.json"), "[]"));
}

export async function applyPresetToConfig(paths, presetInput) {
  const preset = normalizePreset(presetInput);
  const current = await readText(paths.configPath, "");
  const backupPath = await makeBackup(paths.configPath, paths.backupsDir, "apply");
  let next = current;
  next = setTopLevelKey(next, "model_provider", preset.providerId);
  if (preset.model) next = setTopLevelKey(next, "model", preset.model);
  if (preset.reasoningEffort) next = setTopLevelKey(next, "model_reasoning_effort", preset.reasoningEffort);
  else next = removeTopLevelKey(next, "model_reasoning_effort");
  if (preset.verbosity) next = setTopLevelKey(next, "model_verbosity", preset.verbosity);
  else next = removeTopLevelKey(next, "model_verbosity");
  next = removeSection(next, `model_providers.${preset.providerId}`);
  next = appendProviderBlock(next, preset);
  await atomicWrite(paths.configPath, next);
  return { preset, backupPath };
}

export async function saveProfileConfig(paths, profileNameInput, presetInput) {
  const profileName = cleanIdentifier(profileNameInput);
  if (!profileName) throw new Error("Profile name is required.");
  const preset = normalizePreset(presetInput);
  const profilePath = path.join(paths.profilesDir, `${profileName}.config.toml`);
  if (existsSync(profilePath)) await makeBackup(profilePath, paths.backupsDir, `profile-${profileName}`);
  await atomicWrite(profilePath, renderProfileConfig(preset));
  return { profileName, profilePath, preset };
}

export async function restoreConfigBackup(paths, backupNameInput) {
  const backupName = path.basename(String(backupNameInput || ""));
  if (!backupName.endsWith(".config.toml")) throw new Error("Invalid backup name.");
  const backupPath = path.join(paths.backupsDir, backupName);
  if (!existsSync(backupPath)) throw new Error("Backup not found.");
  const restoreBackupPath = await makeBackup(paths.configPath, paths.backupsDir, "pre-restore");
  const backupText = await fs.readFile(backupPath, "utf8");
  await atomicWrite(paths.configPath, backupText);
  return { restoreBackupPath, backupPath };
}

async function sendJson(response, status, data) {
  const body = JSON.stringify(data, null, 2);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function serveStatic(response, urlPath) {
  const normalized = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(__dirname, "public", normalized));
  const publicRoot = path.join(__dirname, "public");
  if (!filePath.startsWith(publicRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/html";
    response.writeHead(200, { "content-type": `${contentType}; charset=utf-8` });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd || __dirname,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs || COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (data) => {
      stdout += data.toString();
      if (stdout.length > COMMAND_OUTPUT_LIMIT) stdout = `${stdout.slice(0, COMMAND_OUTPUT_LIMIT)}\n...[truncated]`;
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > COMMAND_OUTPUT_LIMIT) stderr = `${stderr.slice(0, COMMAND_OUTPUT_LIMIT)}\n...[truncated]`;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, durationMs: Date.now() - startedAt, stdout, stderr: String(error.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, durationMs: Date.now() - startedAt, stdout, stderr });
    });
  });
}

function providerApiUrl(baseUrl, endpoint) {
  const base = String(baseUrl || "").trim().replace(/\/+$/g, "");
  if (!base) throw new Error("Base URL is required for provider model discovery.");
  return `${base}${endpoint}`;
}

function isAnthropicPreset(preset) {
  const provider = `${preset.providerId} ${preset.providerName} ${preset.baseUrl}`.toLowerCase();
  return provider.includes("anthropic") || provider.includes("api.anthropic.com");
}

function providerModelsUrl(preset) {
  const base = String(preset.baseUrl || "").trim().replace(/\/+$/g, "");
  if (!base) throw new Error("Base URL is required for provider model discovery.");
  if (isAnthropicPreset(preset) && !base.endsWith("/v1")) return `${base}/v1/models`;
  return `${base}/models`;
}

function envValue(name) {
  const envKey = String(name || "").trim();
  if (!envKey) return "";
  return process.env[envKey] || "";
}

function normalizeProviderModels(data) {
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
  return list
    .map((item) => {
      const id = String(item?.id || item?.name || item?.model || "").trim();
      if (!id) return null;
      return {
        id,
        name: String(item?.name || item?.display_name || id),
        contextLength: item?.context_length || item?.contextLength || item?.top_provider?.context_length || null,
        promptPrice: item?.pricing?.prompt || null,
        completionPrice: item?.pricing?.completion || null,
        raw: item
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProviderModels(presetInput) {
  const preset = normalizePreset(presetInput);
  const apiKey = envValue(preset.envKey);
  const headers = { accept: "application/json" };
  if (apiKey && isAnthropicPreset(preset)) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetchWithTimeout(providerModelsUrl(preset), { headers });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Provider returned non-JSON from /models: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || text.slice(0, 500) || response.statusText;
    throw new Error(`/models failed (${response.status}): ${message}`);
  }
  return { preset, models: normalizeProviderModels(data) };
}

async function handleApi(request, response, pathname) {
  const paths = await resolveCodexPaths();
  if (request.method === "GET" && pathname === "/api/status") {
    const configText = await readText(paths.configPath, "");
    return sendJson(response, 200, {
      ...paths,
      codexExe: CODEX_EXE,
      current: parseSummary(configText),
      configText,
      presets: await readPresets(),
      backups: await listBackups(paths.backupsDir),
      restartRequiredNote: "Restart Codex Desktop after applying provider/model changes."
    });
  }

  if (request.method === "POST" && pathname === "/api/apply") {
    const body = await readBody(request);
    const { backupPath } = await applyPresetToConfig(paths, body);
    return sendJson(response, 200, {
      ok: true,
      backupPath,
      message: "Applied to config.toml. Restart Codex Desktop for provider/model changes to fully apply."
    });
  }

  if (request.method === "POST" && pathname === "/api/profile") {
    const body = await readBody(request);
    const { profileName, profilePath } = await saveProfileConfig(paths, body.profileName, body);
    return sendJson(response, 200, {
      ok: true,
      profilePath,
      command: `codex --profile ${profileName}`,
      message: "Profile saved. CLI can load it with --profile; Desktop uses the main config.toml unless you apply it."
    });
  }

  if (request.method === "POST" && pathname === "/api/restore") {
    const body = await readBody(request);
    const { restoreBackupPath } = await restoreConfigBackup(paths, body.backupName);
    return sendJson(response, 200, {
      ok: true,
      restoreBackupPath,
      message: "Restored config.toml. Restart Codex Desktop for changes to fully apply."
    });
  }

  if (request.method === "POST" && pathname === "/api/test") {
    const body = await readBody(request);
    const kind = String(body.kind || "");
    const cwd = String(body.cwd || __dirname);
    let result;
    if (kind === "doctor") {
      result = await runCommand(CODEX_EXE, ["doctor", "--summary", "--ascii", "--no-color"], { cwd, timeoutMs: 45000 });
    } else if (kind === "models") {
      result = await runCommand(CODEX_EXE, ["debug", "models"], { cwd, timeoutMs: 45000 });
    } else if (kind === "exec") {
      const prompt = String(body.prompt || "Reply exactly: MODELDOCK_OK");
      result = await runCommand(CODEX_EXE, ["exec", "--ask-for-approval", "never", "--sandbox", "read-only", "-C", cwd, prompt], {
        cwd,
        timeoutMs: COMMAND_TIMEOUT_MS
      });
    } else {
      throw new Error("Unknown test kind.");
    }
    return sendJson(response, 200, { ok: result.ok, kind, command: kind, result });
  }

  if (request.method === "POST" && pathname === "/api/provider-models") {
    const body = await readBody(request);
    const result = await fetchProviderModels(body);
    return sendJson(response, 200, {
      ok: true,
      providerId: result.preset.providerId,
      baseUrl: result.preset.baseUrl,
      count: result.models.length,
      models: result.models
    });
  }

  return sendJson(response, 404, { error: "Unknown API route." });
}

export const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
      return;
    }
    await serveStatic(response, url.pathname);
  } catch (error) {
    await sendJson(response, 500, { error: String(error.message || error) });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`ModelDock running at http://127.0.0.1:${PORT}`);
  });
}

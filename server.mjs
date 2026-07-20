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
const DEFAULT_CONFIG_BACKUP_NAME = "2026-07-19T22-09-27-089Z-apply-b7814a6e.config.toml";
const DEFAULT_CONFIG_TEXT = 'model_provider = "openai"\nmodel = "gpt-5.5"\n';
const CHAT_PROXY_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    modelsUrl: "https://api.deepseek.com/models",
    envKeys: ["DEEPSEEK_API_KEY"],
    maxTokensField: "max_tokens",
    extraBody: { thinking: { type: "disabled" } },
    toolPolicy: "coding",
    toolInstructions:
      "Use the provided tools through standard Chat Completions tool_calls only. Do not write XML, DSML, markdown code blocks, or fake tool transcripts."
  },
  kimi: {
    label: "Kimi",
    endpoint: "https://api.moonshot.ai/v1/chat/completions",
    modelsUrl: "https://api.moonshot.ai/v1/models",
    envKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
    maxTokensField: "max_completion_tokens",
    toolPolicy: "coding",
    toolInstructions:
      "Use the provided tools through standard Chat Completions tool_calls only. Do not explain that you will use a tool; call it."
  }
};
const TOOL_POLICIES = {
  minimal: new Set(["shell_command"]),
  coding: new Set(["shell_command", "apply_patch", "update_plan"]),
  full: null
};

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

function isReservedProviderOverride(preset) {
  return CUSTOM_PROVIDER_RESERVED.has(preset.providerId) && Boolean(preset.baseUrl || preset.envKey);
}

function isDirectAnthropicProvider(preset) {
  return preset.providerId === "anthropic" || preset.baseUrl.toLowerCase().includes("api.anthropic.com");
}

function isUnsupportedChatWire(preset) {
  return preset.wireApi.toLowerCase() === "chat";
}

function isModelDockProxyPreset(preset) {
  const providerId = String(preset.providerId || "").trim().toLowerCase();
  const baseUrl = String(preset.baseUrl || "").trim().toLowerCase();
  return providerId.endsWith("_proxy") || (baseUrl.includes("127.0.0.1") && baseUrl.includes("/proxy/"));
}

function assertCanWriteConfig(preset) {
  if (isReservedProviderOverride(preset)) {
    throw new Error(
      `Provider ID "${preset.providerId}" is reserved by Codex and cannot be overridden. Use a custom provider ID such as "deepseek" or "${preset.providerId}-custom".`
    );
  }
  if (isDirectAnthropicProvider(preset)) {
    throw new Error(
      "Direct Anthropic uses /v1/messages, which is not supported by this Codex wire API setting yet. Use Anthropic through OpenRouter or another OpenAI-compatible gateway for now."
    );
  }
  if (isUnsupportedChatWire(preset)) {
    throw new Error(
      'This provider expects /chat/completions, but the current Codex CLI no longer supports wire_api = "chat". Use a /responses-compatible gateway or proxy before applying this provider.'
    );
  }
}

function shouldWriteProviderBlock(preset) {
  return !CUSTOM_PROVIDER_RESERVED.has(preset.providerId);
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
  const preset = {
    providerId,
    providerName: String(input.providerName || providerId).trim(),
    model: String(input.model || "").trim(),
    reasoningEffort: String(input.reasoningEffort || "").trim(),
    verbosity: String(input.verbosity || "").trim(),
    wireApi: String(input.wireApi || "").trim(),
    baseUrl: String(input.baseUrl || "").trim(),
    envKey: String(input.envKey || "").trim()
  };
  if (isModelDockProxyPreset(preset)) preset.envKey = "";
  return preset;
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
  assertCanWriteConfig(preset);
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
  assertCanWriteConfig(preset);
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

export async function restoreDefaultConfig(paths) {
  const restoreBackupPath = await makeBackup(paths.configPath, paths.backupsDir, "pre-restore-default");
  const defaultBackupPath = path.join(paths.backupsDir, DEFAULT_CONFIG_BACKUP_NAME);
  if (existsSync(defaultBackupPath)) {
    const backupText = await fs.readFile(defaultBackupPath, "utf8");
    await atomicWrite(paths.configPath, backupText);
    return { restoreBackupPath, source: "backup", backupPath: defaultBackupPath };
  }
  await atomicWrite(paths.configPath, DEFAULT_CONFIG_TEXT);
  return { restoreBackupPath, source: "built-in", backupPath: "" };
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
  return isDirectAnthropicProvider(preset);
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

function configuredChatProxy(providerId) {
  const id = cleanIdentifier(providerId);
  const provider = CHAT_PROXY_PROVIDERS[id];
  if (!provider) throw new Error(`Unknown chat proxy provider: ${providerId}`);
  const envPrefix = `MODELDOCK_PROXY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  return {
    id,
    ...provider,
    endpoint: process.env[`${envPrefix}_ENDPOINT`] || provider.endpoint,
    modelsUrl: process.env[`${envPrefix}_MODELS_URL`] || provider.modelsUrl
  };
}

function chatProxyApiKey(provider) {
  for (const key of provider.envKeys) {
    const value = envValue(key);
    if (value) return { key, value };
  }
  throw new Error(`${provider.label} proxy needs one of these environment variables: ${provider.envKeys.join(", ")}`);
}

function contentPartToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (typeof part.input_text === "string") return part.input_text;
  if (typeof part.output_text === "string") return part.output_text;
  return "";
}

function responseContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentPartToText).filter(Boolean).join("\n");
  return contentPartToText(content);
}

function responseInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || `call_${randomUUID().replace(/-/g, "")}`,
            type: "function",
            function: {
              name: item.name || "unknown_tool",
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
            }
          }
        ]
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: responseContentToText(item.output ?? item.content ?? item.text ?? "")
      });
      continue;
    }
    if (item.type && !["message", "input_text", "output_text"].includes(item.type) && !item.role) continue;
    const content = responseContentToText(item.content ?? item.text ?? item);
    if (!content) continue;
    const role = ["system", "developer", "user", "assistant"].includes(item.role) ? item.role : "user";
    messages.push({ role: role === "developer" ? "system" : role, content });
  }
  return messages;
}

function normalizeToolSource(tool) {
  if (tool?.type !== "function") return null;
  const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
  if (!source.name) return null;
  return source;
}

function toolPolicyAllows(provider, toolName) {
  const policy = TOOL_POLICIES[provider.toolPolicy || "full"];
  return !policy || policy.has(toolName);
}

function compactParameters(toolName, parameters) {
  if (toolName === "shell_command") {
    return {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "PowerShell command to run."
        },
        workdir: {
          type: "string",
          description: "Working directory. Defaults to the task cwd."
        }
      },
      required: ["command"],
      additionalProperties: false
    };
  }
  if (!parameters || typeof parameters !== "object") return { type: "object", properties: {} };
  const copy = structuredClone(parameters);
  const stripDescriptions = (value) => {
    if (!value || typeof value !== "object") return;
    delete value.description;
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const item of child) stripDescriptions(item);
      } else {
        stripDescriptions(child);
      }
    }
  };
  stripDescriptions(copy);
  return copy;
}

function compactToolDescription(toolName, description) {
  if (toolName === "shell_command") return "Execute a PowerShell command and return the result.";
  if (toolName === "apply_patch") return "Apply a patch to files in the workspace.";
  if (toolName === "update_plan") return "Update the visible task plan.";
  return String(description || "").split(/\r?\n/)[0].slice(0, 240);
}

function normalizeChatTools(tools, provider) {
  if (!Array.isArray(tools)) return undefined;
  const normalized = tools
    .map((tool) => {
      const source = normalizeToolSource(tool);
      if (!source || !toolPolicyAllows(provider, source.name)) return null;
      return {
        type: "function",
        function: {
          name: source.name,
          description: compactToolDescription(source.name, source.description),
          parameters: compactParameters(source.name, source.parameters),
          ...(typeof source.strict === "boolean" ? { strict: source.strict } : {})
        }
      };
    })
    .filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function shellToolName(tools) {
  if (!Array.isArray(tools)) return "";
  const functionTools = tools
    .filter((tool) => tool?.type === "function")
    .map((tool) => (tool.function && typeof tool.function === "object" ? tool.function : tool));
  const exact = functionTools.find((tool) => ["shell_command", "exec_command", "bash", "shell"].includes(tool.name));
  if (exact?.name) return exact.name;
  const described = functionTools.find((tool) => /shell|bash|powershell|command/i.test(`${tool.name || ""} ${tool.description || ""}`));
  return described?.name || "";
}

function cleanExtractedCommand(command) {
  const trimmed = String(command || "").trim().replace(/^<!\[CDATA\[\s*/i, "").replace(/\s*\]\]>$/i, "");
  const assignmentMatch = trimmed.match(/^\$?command\s*=\s*["']([\s\S]*)["']$/i);
  if (assignmentMatch?.[1]?.trim()) {
    return assignmentMatch[1].replace(/\\"/g, "\"").replace(/\\'/g, "'").trim();
  }
  return trimmed;
}

function extractShellCommand(text) {
  const value = String(text || "");
  const tagMatch = value.match(/<(?:bash|shell|powershell)>\s*([\s\S]*?)\s*<\/(?:bash|shell|powershell)>/i);
  if (tagMatch?.[1]?.trim()) return cleanExtractedCommand(tagMatch[1]);
  const functionCommandMatch = value.match(/<functions?>[\s\S]*?<(?:command|code)>\s*([\s\S]*?)\s*<\/(?:command|code)>[\s\S]*?<\/functions?>/i);
  if (functionCommandMatch?.[1]?.trim()) return cleanExtractedCommand(functionCommandMatch[1]);
  const functionArgumentsMatch = value.match(/<functions?>[\s\S]*?<arguments>\s*([\s\S]*?)\s*<\/arguments>[\s\S]*?<\/functions?>/i);
  if (functionArgumentsMatch?.[1]?.trim()) {
    try {
      const args = JSON.parse(functionArgumentsMatch[1].trim());
      if (args?.command) return cleanExtractedCommand(args.command);
    } catch {
      return cleanExtractedCommand(functionArgumentsMatch[1]);
    }
  }
  const namedCommandMatch = value.match(/<[^>]+\sname=["']command["'][^>]*>\s*([\s\S]*?)\s*<\//i);
  if (namedCommandMatch?.[1]?.trim()) return cleanExtractedCommand(namedCommandMatch[1]);
  const dsmlCommandMatch = value.match(/parameter\s+name=["']command["'][^>]*>\s*([\s\S]*?)\s*<\//i);
  if (dsmlCommandMatch?.[1]?.trim()) return cleanExtractedCommand(dsmlCommandMatch[1]);
  const fenceMatch = value.match(/```(?:bash|sh|shell|powershell|ps1)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]?.trim()) return cleanExtractedCommand(fenceMatch[1]);
  return "";
}

function responseFunctionCallItem(toolCall) {
  const fn = toolCall?.function || {};
  const callId = toolCall?.id || `call_${randomUUID().replace(/-/g, "")}`;
  const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {});
  return {
    id: `fc_${randomUUID().replace(/-/g, "")}`,
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: fn.name || "unknown_tool",
    arguments: args
  };
}

function numericUsage(value) {
  return Number.isFinite(value) ? value : 0;
}

function addSystemInstruction(messages, instruction) {
  const text = String(instruction || "").trim();
  if (!text) return;
  const existing = messages.find((message) => message.role === "system");
  if (existing) {
    existing.content = `${existing.content || ""}\n\n${text}`.trim();
    return;
  }
  messages.unshift({ role: "system", content: text });
}

export function responsesToChatRequest(providerId, body) {
  const provider = configuredChatProxy(providerId);
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions.trim() });
  }
  messages.push(...responseInputToMessages(body.input));
  if (!messages.length && typeof body.prompt === "string") {
    messages.push({ role: "user", content: body.prompt });
  }
  if (!messages.length) throw new Error("Responses proxy could not find text input to forward.");

  const chatBody = {
    model: String(body.model || "").trim(),
    messages,
    stream: false
  };
  if (!chatBody.model) throw new Error("Responses proxy request is missing model.");
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chatBody[provider.maxTokensField] = body.max_output_tokens;
  if (provider.extraBody) Object.assign(chatBody, provider.extraBody);
  const tools = normalizeChatTools(body.tools, provider);
  if (tools) {
    addSystemInstruction(messages, provider.toolInstructions);
    chatBody.tools = tools;
    chatBody.tool_choice = body.tool_choice || "auto";
  }
  return chatBody;
}

export function chatCompletionToResponse(responsesBody, chatData) {
  const choice = Array.isArray(chatData?.choices) ? chatData.choices[0] : null;
  const message = choice?.message || {};
  const content = responseContentToText(message.content) || responseContentToText(message.reasoning_content);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(responseFunctionCallItem) : [];
  if (!toolCalls.length) {
    const command = extractShellCommand(content);
    const name = command ? shellToolName(responsesBody.tools) || "shell_command" : "";
    if (name) {
      toolCalls.push(
        responseFunctionCallItem({
          id: `call_${randomUUID().replace(/-/g, "")}`,
          function: { name, arguments: JSON.stringify({ command }) }
        })
      );
    }
  }
  const cleanedContent = toolCalls.length ? "" : content || "";
  const output = [];
  if (cleanedContent || !toolCalls.length) {
    output.push({
      id: `msg_${randomUUID().replace(/-/g, "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: cleanedContent || "",
          annotations: []
        }
      ]
    });
  }
  output.push(...toolCalls);
  const createdAt = chatData?.created || Math.floor(Date.now() / 1000);
  const usage = chatData?.usage || {};
  return {
    id: chatData?.id || `resp_${randomUUID().replace(/-/g, "")}`,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model: chatData?.model || responsesBody.model,
    output,
    output_text: cleanedContent || "",
    usage: {
      input_tokens: numericUsage(usage.prompt_tokens),
      output_tokens: numericUsage(usage.completion_tokens),
      total_tokens: numericUsage(usage.total_tokens)
    }
  };
}

function ssePayload(type, sequenceNumber, data) {
  return {
    type,
    sequence_number: sequenceNumber,
    ...data
  };
}

function sendSseEvent(response, type, sequenceNumber, data) {
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify(ssePayload(type, sequenceNumber, data))}\n\n`);
}

function responseWantsSse(request, body) {
  return body.stream === true || String(request.headers.accept || "").toLowerCase().includes("text/event-stream");
}

function sendMessageItemSse(response, sequenceNumber, outputIndex, item) {
  const contentPart = item.content?.[0] || { type: "output_text", text: "", annotations: [] };
  sendSseEvent(response, "response.output_item.added", sequenceNumber++, { output_index: outputIndex, item: { ...item, content: [] } });
  sendSseEvent(response, "response.content_part.added", sequenceNumber++, {
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    part: { ...contentPart, text: "" }
  });
  if (contentPart.text) {
    sendSseEvent(response, "response.output_text.delta", sequenceNumber++, {
      item_id: item.id,
      output_index: outputIndex,
      content_index: 0,
      delta: contentPart.text
    });
  }
  sendSseEvent(response, "response.output_text.done", sequenceNumber++, {
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    text: contentPart.text || ""
  });
  sendSseEvent(response, "response.content_part.done", sequenceNumber++, {
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    part: contentPart
  });
  sendSseEvent(response, "response.output_item.done", sequenceNumber++, { output_index: outputIndex, item });
  return sequenceNumber;
}

function sendFunctionCallItemSse(response, sequenceNumber, outputIndex, item) {
  sendSseEvent(response, "response.output_item.added", sequenceNumber++, {
    output_index: outputIndex,
    item: { ...item, status: "in_progress", arguments: "" }
  });
  if (item.arguments) {
    sendSseEvent(response, "response.function_call_arguments.delta", sequenceNumber++, {
      item_id: item.id,
      output_index: outputIndex,
      delta: item.arguments
    });
  }
  sendSseEvent(response, "response.function_call_arguments.done", sequenceNumber++, {
    item_id: item.id,
    output_index: outputIndex,
    arguments: item.arguments || ""
  });
  sendSseEvent(response, "response.output_item.done", sequenceNumber++, { output_index: outputIndex, item });
  return sequenceNumber;
}

function sendResponseSse(response, responseBody) {
  const inProgressResponse = {
    ...responseBody,
    status: "in_progress",
    output: []
  };
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  let sequenceNumber = 0;
  sendSseEvent(response, "response.created", sequenceNumber++, { response: inProgressResponse });
  sendSseEvent(response, "response.in_progress", sequenceNumber++, { response: inProgressResponse });
  const output = Array.isArray(responseBody.output) && responseBody.output.length
    ? responseBody.output
    : [
        {
          id: `msg_${randomUUID().replace(/-/g, "")}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: responseBody.output_text || "", annotations: [] }]
        }
      ];
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const item = output[outputIndex];
    if (item.type === "function_call") {
      sequenceNumber = sendFunctionCallItemSse(response, sequenceNumber, outputIndex, item);
    } else {
      sequenceNumber = sendMessageItemSse(response, sequenceNumber, outputIndex, item);
    }
  }
  sendSseEvent(response, "response.completed", sequenceNumber++, { response: responseBody });
  response.end();
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

async function handleChatProxy(request, response, providerId, endpointName) {
  const provider = configuredChatProxy(providerId);
  const { value: apiKey } = chatProxyApiKey(provider);
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`
  };

  if (endpointName === "models") {
    if (request.method !== "GET") return sendJson(response, 405, { error: "Use GET for proxy /models." });
    const upstream = await fetchWithTimeout(provider.modelsUrl, { headers });
    const text = await upstream.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      return sendJson(response, 502, { error: `${provider.label} proxy returned non-JSON from /models: ${text.slice(0, 500)}` });
    }
    if (!upstream.ok) return sendJson(response, upstream.status, data || { error: `${provider.label} /models failed.` });
    return sendJson(response, 200, {
      models: normalizeProviderModels(data).map((model) => ({
        id: model.id,
        slug: model.id,
        name: model.name || model.id,
        display_name: model.name || model.id,
        description: `${provider.label} model routed through ModelDock chat proxy.`,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Faster responses with lighter reasoning" },
          { effort: "medium", description: "Balanced reasoning" },
          { effort: "high", description: "More reasoning for complex work" }
        ],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 50,
        additional_speed_tiers: [],
        service_tiers: [],
        availability_nux: null,
        upgrade: null,
        base_instructions: "",
        model_messages: null,
        include_skills_usage_instructions: false,
        default_reasoning_summary: "none",
        support_verbosity: false,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text_and_image",
        truncation_policy: { mode: "tokens", limit: 10000 },
        supports_parallel_tool_calls: false,
        supports_image_detail_original: false,
        context_window: model.contextLength || 64000,
        max_context_window: model.contextLength || 64000,
        comp_hash: "modeldock-proxy",
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ["text"],
        supports_search_tool: false,
        use_responses_lite: true,
        tool_mode: "code_mode_only",
        multi_agent_version: "v2",
        max_output_tokens: null,
        supports_reasoning_summaries: false
      }))
    });
  }

  if (endpointName !== "responses") return sendJson(response, 404, { error: "Unknown proxy route." });
  if (request.method !== "POST") return sendJson(response, 405, { error: "Use POST for proxy /responses." });

  const body = await readBody(request);
  const chatBody = responsesToChatRequest(provider.id, body);
  const upstream = await fetchWithTimeout(provider.endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json"
    },
    body: JSON.stringify(chatBody)
  });
  const text = await upstream.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    return sendJson(response, 502, { error: `${provider.label} proxy returned non-JSON: ${text.slice(0, 500)}` });
  }
  if (!upstream.ok) {
    return sendJson(response, upstream.status, data || { error: `${provider.label} proxy failed.` });
  }
  const responseBody = chatCompletionToResponse(body, data);
  if (responseWantsSse(request, body)) {
    sendResponseSse(response, responseBody);
    return;
  }
  return sendJson(response, 200, responseBody);
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
      defaultRestore: {
        label: "OpenAI Default",
        modelProvider: "openai",
        model: "gpt-5.5",
        backupName: DEFAULT_CONFIG_BACKUP_NAME
      },
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

  if (request.method === "POST" && pathname === "/api/restore-default") {
    const { restoreBackupPath, source, backupPath } = await restoreDefaultConfig(paths);
    return sendJson(response, 200, {
      ok: true,
      source,
      backupPath,
      restoreBackupPath,
      message: "Restored OpenAI default baseline. Restart Codex Desktop for changes to fully apply."
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
    const proxyMatch = url.pathname.match(/^\/proxy\/([a-z0-9_-]+)\/v1\/(responses|models)$/);
    if (proxyMatch) {
      await handleChatProxy(request, response, proxyMatch[1], proxyMatch[2]);
      return;
    }
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

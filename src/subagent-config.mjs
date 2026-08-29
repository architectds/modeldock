import path from "node:path";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { SUBAGENT_AGENT_FILE } from "./config-switcher.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";
import { modelOptions, providerOptions } from "./model-options.mjs";

// Sub Agent selector: the dashboard writes a ModelDock-managed Codex agent file
// (~/.codex/agents/modeldock-subagent.toml) whose `model`/`model_provider` fields
// define the role Codex exposes for spawned subagents. The picker mirrors the
// main provider/model pair, and every native GPT slug is selectable alongside
// the routed catalog so subagents stop silently defaulting to native models.
// Native roles keep the built-in "openai" provider (base_url pointed at this
// gate in transparent mode); routed roles keep the published "@provider" slug,
// which the gateway parses for upstream routing.
export const SUBAGENT_DEFAULT_MODEL = "deepseek-v4-flash@opencode-go";
// One spelling, shared with the disable() path that has to remove it.
export const SUBAGENT_FILE_NAME = SUBAGENT_AGENT_FILE;
// The built-in native ChatGPT provider, shared by the subagent and vision
// pickers: one spelling, one label, everywhere it is offered.
export const NATIVE_PROVIDER = { id: "openai", label: "ChatGPT (native)" };

export function subagentModelOptions(config) {
  // The published model set already includes native GPT slugs while signed in
  // (modelOptions -> appendNativeModels); the subagent picker is that same set.
  return modelOptions(config, config.profileId);
}

export function subagentProviders(config) {
  const providers = providerOptions(config).map((entry) => ({ id: entry.id, label: entry.label }));
  if (hasChatGptLogin(config.codexHome)) providers.push(NATIVE_PROVIDER);
  return providers;
}

export function subagentAgentFilePath(config) {
  if (!config.codexHome) return null;
  return path.join(config.codexHome, "agents", SUBAGENT_FILE_NAME);
}

// Read on every dashboard broadcast (statusPayload -> subagentPayload), which
// made each metrics "change" cost a file read plus a regex - three or more
// times per relay request with a dashboard open. One stat replaces the read:
// the in-process writer below invalidates directly (covering the same-ms
// write an mtime check alone would miss), and the switcher's disable() only
// deletes the file, which the stat sees as ENOENT.
let subagentCache = { file: "", mtimeMs: -1, model: null };

export function readSubagentModel(config) {
  const file = subagentAgentFilePath(config);
  if (!file) return null;
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    subagentCache = { file, mtimeMs: -1, model: null };
    return null;
  }
  if (subagentCache.file === file && subagentCache.mtimeMs === mtimeMs) return subagentCache.model;
  try {
    const source = readFileSync(file, "utf8");
    const model = source.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || null;
    subagentCache = { file, mtimeMs, model };
    return model;
  } catch {
    return null;
  }
}

export function writeSubagentAgentFile(config, model) {
  const agentsDir = path.join(config.codexHome, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, SUBAGENT_FILE_NAME);
  subagentCache = { file: "", mtimeMs: -1, model: null };
  const content = [
    "# Managed by ModelDock. Edit this file from the ModelDock dashboard; a full Codex restart is required after changes.",
    'name = "modeldock_subagent"',
    'description = "Default ModelDock-managed role for ordinary delegation; use another named role only when the user explicitly requests it."',
    'model_provider = "openai"',
    `model = "${model}"`,
    'model_reasoning_effort = "high"',
    'developer_instructions = """',
    "Complete the bounded task assigned by the parent agent.",
    "Respect repository instructions, keep changes surgical, and run relevant verification.",
    "Return a concise summary of work completed, checks run, and remaining risks.",
    '"""',
    "",
  ].join("\n");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, file);
}


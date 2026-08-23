import path from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function readSubagentModel(config) {
  try {
    const source = readFileSync(subagentAgentFilePath(config), "utf8");
    return source.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || null;
  } catch {
    return null;
  }
}

export function writeSubagentAgentFile(config, model) {
  const agentsDir = path.join(config.codexHome, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, SUBAGENT_FILE_NAME);
  const content = [
    "# Managed by ModelDock. Edit this file from the ModelDock dashboard; a full Codex restart is required after changes.",
    'name = "modeldock_subagent"',
    'description = "Subagent routed through the local ModelDock gate (managed by ModelDock)."',
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


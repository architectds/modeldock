import path from "node:path";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { atomicWriteTextSync } from "./atomic-file.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";
import { codexModelRef, internalModelRef } from "./model-ref.mjs";
import { modelOptions, providerOptions } from "./model-options.mjs";
import { NATIVE_PROVIDER } from "./native-provider.mjs";
export { NATIVE_PROVIDER } from "./native-provider.mjs";

// The pick is stored in this file and nowhere else. Codex reads <codexHome>/agents
// at startup, so the switcher has to remove it on disable: the file pins
// model_provider = "openai" to a ModelDock-published slug, and once the managed
// openai_base_url is gone that provider means the real OpenAI backend, where the
// slug does not exist - Codex then fails to start. The name is defined here,
// beside the writer that fixes the format, and the remover imports it, because
// one spelling is what keeps the two in step.
export const SUBAGENT_AGENT_FILE = "modeldock-subagent.toml";

// Sub Agent selector: the dashboard writes a ModelDock-managed Codex agent file
// (~/.codex/agents/modeldock-subagent.toml) whose `model`/`model_provider` fields
// define the role Codex exposes for spawned subagents. The picker mirrors the
// main provider/model pair, and every native GPT slug is selectable alongside
// the routed catalog so subagents stop silently defaulting to native models.
// Native roles keep the built-in "openai" provider (base_url pointed at this
// gate in transparent mode); routed roles carry the Codex-facing slug that
// codexModelRef encodes, which the gateway parses for upstream routing.
//
// That encoding exists because this file is the one place ModelDock hands a
// model name to the Codex client itself rather than to an upstream: Codex tags
// its own metrics and session records with the model string it reads here, and
// the internal "@provider" address is rejected by that telemetry layer. The
// internal address stays the one identity for the dashboard, persisted
// preferences and usage rollups; only this wire value is encoded, and reading
// decodes it back.
export const SUBAGENT_DEFAULT_MODEL = "deepseek-v4-flash@opencode-go";
// The built-in native ChatGPT provider, shared by the subagent and vision
// pickers: one spelling, one label, everywhere it is offered.
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
  return path.join(config.codexHome, "agents", SUBAGENT_AGENT_FILE);
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
    const written = source.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || null;
    // The file holds the Codex-facing slug; every consumer of this value (the
    // picker, the catalog's forced-publish set, the collaboration relay) speaks
    // the internal address, so the boundary is crossed here, once.
    const model = written ? internalModelRef(written) : null;
    subagentCache = { file, mtimeMs, model };
    return model;
  } catch {
    return null;
  }
}

// One-time upgrade of the ModelDock-owned agent file. Older releases wrote the
// readable internal address directly into a Codex-facing field, which makes
// Codex reject every metric carrying that model tag. Keep the selected model,
// rewrite only the representation, and let the caller request a Codex restart.
export function migrateSubagentAgentFile(config) {
  const file = subagentAgentFilePath(config);
  if (!file) return false;
  try {
    const source = readFileSync(file, "utf8");
    const written = source.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || "";
    if (!written) return false;
    const model = internalModelRef(written);
    if (written === codexModelRef(model)) return false;
    writeSubagentAgentFile(config, model);
    return true;
  } catch {
    return false;
  }
}

export function writeSubagentAgentFile(config, model) {
  const agentsDir = path.join(config.codexHome, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const file = path.join(agentsDir, SUBAGENT_AGENT_FILE);
  subagentCache = { file: "", mtimeMs: -1, model: null };
  const content = [
    "# Managed by ModelDock. Edit this file from the ModelDock dashboard; a full Codex restart is required after changes.",
    'name = "modeldock_subagent"',
    'description = "Default ModelDock-managed role for ordinary delegation; use another named role only when the user explicitly requests it."',
    `model_provider = "${NATIVE_PROVIDER.id}"`,
    `model = "${codexModelRef(model)}"`,
    'model_reasoning_effort = "high"',
    'developer_instructions = """',
    "Complete the bounded task assigned by the parent agent.",
    "Respect repository instructions, keep changes surgical, and run relevant verification.",
    "Return a concise summary of work completed, checks run, and remaining risks.",
    '"""',
    "",
  ].join("\n");
  atomicWriteTextSync(file, content);
}


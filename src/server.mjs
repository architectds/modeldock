import path from "node:path";
import os from "node:os";
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import zlib from "node:zlib";
import { Decompress as ZstdFallbackDecoder } from "fzstd";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { loadConfig, publicConfig, writeEnvFile, envFileFor, migrateEnvSecrets, isPlaceholderToken } from "./config.mjs";
import { catalogFor } from "./catalog.mjs";
import { nativeModelSlugs, readNativeCatalog, refreshNativeCatalog } from "./native-catalog.mjs";
import { MediaStore } from "./media-store.mjs";
import { Metrics } from "./metrics.mjs";
import { NATIVE_IMAGE_PATHS, relayNativeImage, relayResponses as relayGatewayResponses } from "./gateway.mjs";
import { createUpstreams } from "./upstreams.mjs";
import { createMcpNodeHandler } from "./mcp.mjs";
import { memoryStoreFor } from "./memory.mjs";
import { CodexConfigSwitcher } from "./config-switcher.mjs";
import { createAutostart } from "./autostart.mjs";
import { createUpdater, localVersion } from "./update.mjs";
import { clearOwnerFile, describeOwnerConflict, writeOwnerFile } from "./instance-owner.mjs";
import { CALLER_PATH_PREFIX, callerBasePath, callerKeyEqual, callerRootPath, loadOrCreateCallerKey } from "./caller-key.mjs";
import { validateProviderToken } from "./token-validate.mjs";
import { RouteAffinity } from "./router.mjs";
import { PROVIDER_SEPARATOR, applyCustomProfile, applyOllamaProfile, bareModelId, profileOptions, profileById, providerForModel, publishedSlugFor, tokenFor, TRIAL_MAIN_MODEL, TRIAL_VISION_MODEL } from "./profiles.mjs";
import { CustomEndpointError, listEndpointModels, normalizeBaseUrl, probeCustomResponses } from "./custom-endpoint.mjs";
import { OLLAMA_DEFAULT_BASE, OllamaError, clearOllamaSnapshot, listOllamaModels, normalizeOllamaBase, ollamaSnapshotPath, probeOllamaResponses, readOllamaSnapshot, writeOllamaSnapshot } from "./ollama.mjs";
import { recordSettingsEvent } from "./settings-events.mjs";
import { stateFile } from "./state-dir.mjs";
import staticFiles from "./static-inline.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(dirname, "../public");
const assetsDir = path.resolve(dirname, "../assets");
const hasInlineStatic = staticFiles !== null && typeof staticFiles === "object";

const STATIC_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function contentTypeFor(file) {
  const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
  return STATIC_MIME[ext] || "application/octet-stream";
}

// Serve the dashboard from the inlined frontend tree when running the release bundle
// (single file, no on-disk assets). Falls through to the on-disk public/ and assets/
// directories in dev (npm run dev / node src/server.mjs / npm test).
function serveInlineStatic(app) {
  if (!hasInlineStatic) return;
  const publicTree = staticFiles.public || {};
  const assetTree = staticFiles.assets || {};
  const serve = (req, res, tree, stripPrefix) => {
    const rel = req.path.slice(stripPrefix.length).replace(/^\/+/, "");
    const file = rel || "index.html";
    if (!(file in tree)) return false;
    const body = tree[file];
    res.setHeader("Content-Type", contentTypeFor(file));
    res.setHeader("Cache-Control", stripPrefix ? "public, max-age=604800" : "no-cache");
    res.send(body);
    return true;
  };
  app.use("/assets", (req, res, next) => { if (!serve(req, res, assetTree, "/assets")) next(); });
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (!serve(req, res, publicTree, "")) next();
  });
}

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const VISION_TIER_LABELS = { strong: "High", medium: "Mid", basic: "Low", poor: "Weak" };
const SPEED_SCORES = { fast: 1.0, medium: 0.6, slow: 0.2 };
const QUOTA_SCORES = [
  { min: 10000, score: 1.0 },
  { min: 2000, score: 0.8 },
  { min: 500, score: 0.5 },
  { min: 0, score: 0.15 },
];

function quotaScore(quota5h) {
  if (typeof quota5h !== "number") return 0;
  return QUOTA_SCORES.find((band) => quota5h >= band.min)?.score || 0.15;
}

function balanceScoreFor(model) {
  const capability = model.visionScore != null && model.visionMaxScore ? model.visionScore / model.visionMaxScore : 0;
  const speed = SPEED_SCORES[model.speedTier] ?? 0;
  const cheap = quotaScore(model.quota5h);
  const freeBoost = model.free ? 0.05 : 0;
  return Number(((capability + speed + cheap) / 3 + freeBoost).toFixed(3));
}

function withTierLabel(model) {
  const decorated = { ...model };
  if (decorated.visionTier) {
    decorated.tierLabel = VISION_TIER_LABELS[decorated.visionTier] || decorated.visionTier;
  }
  if (decorated.supportsVision) {
    decorated.balanceScore = balanceScoreFor(decorated);
  }
  return decorated;
}

// Bare ids an older install could still reference: every model the default
// provider (opencode-go) owns that is not a reserved native slot. gpt-5.6-luna is
// excluded because its bare id belongs to the native GPT pipeline, not to us.
function legacyBareIds(config) {
  const ids = new Set();
  const defaultProfile = profileById("opencode-go");
  for (const model of defaultProfile?.availableModels || []) {
    if (model?.id && !model.ownerQualified && model.status !== "unavailable") ids.add(model.id);
  }
  return ids;
}

// The slugs this gate can serve: every provider's published catalog plus the
// legacy bare ids above. Used to decide whether a client-chosen model is one this
// gate can route (anything else is native GPT traffic). The legacy bare ids keep
// an old thread selection on the routed path (providerForModel sends it to
// opencode-go) instead of letting isNativeModel misroute it to ChatGPT.
function publishedModelIds(config) {
  const ids = new Set();
  for (const model of codexModelCatalog(config).models || []) {
    if (model?.slug) ids.add(model.slug);
  }
  for (const id of legacyBareIds(config)) ids.add(id);
  return ids;
}

function modelOptions(config, profileId) {
  const all = [];
  for (const entry of enabledProviders(config)) {
    const profile = profileById(entry.id);
    for (const model of profile?.availableModels || []) {
      if (model.status === "unavailable" || model.endpoint === "chat") continue;
      const id = publishedSlugFor(entry.id, model);
      if (all.some((existing) => existing.id === id)) continue;
      all.push({ ...withTierLabel(model), id, provider: entry.id });
    }
  }
  // Config ids may be published slugs or bare legacy ids. Only add an id when
  // its real owner is enabled and actually catalogs that model; assigning a
  // stale OpenCode fallback to the active DeepSeek profile would manufacture a
  // vision route that DeepSeek does not provide.
  for (const id of [config.mainModel, config.visionModel, config.visionFallbackModel]) {
    if (!id) continue;
    const owner = providerForModel(config, id);
    if (!enabledProviders(config).some((provider) => provider.id === owner)) continue;
    const known = profileById(owner)?.availableModels?.find((model) => model.id === bareModelId(id));
    if (!known || known.status === "unavailable" || known.endpoint === "chat") continue;
    const resolved = publishedSlugFor(owner, known);
    if (all.some((existing) => existing.id === resolved)) continue;
    all.push({ ...withTierLabel(known), id: resolved, provider: owner });
  }
  return all;
}

function modelCatalogModels(config, profileId) {
  const active = profileId || config.profileId;
  return modelOptions(config, active).filter((entry) => entry.provider === active);
}

function providerOptions(config) {
  return enabledProviders(config);
}

// Only providers with a configured token (or the active profile, which may resolve
// its token from the Codex config backup) are shown in the picker and published in
// the catalog. A provider with no key cannot serve requests, so it stays hidden.
function enabledProviders(config) {
  const all = profileOptions();
  const active = config.profileId || "opencode-go";
  return all.filter((entry) => {
    if (entry.id === active) return true;
    // Ollama needs no credential; a connected profile is publishable.
    if (entry.id === "ollama") return Boolean(profileById("ollama").availableModels?.length);
    const token = config.tokens?.[entry.id];
    return Boolean(token);
  });
}

function providerModels(providerId) {
  return (profileById(providerId)?.availableModels || [])
    .filter((model) => model.status !== "unavailable" && model.endpoint !== "chat");
}

function providerTokenConfigured(config, providerId) {
  return Boolean(config.tokens?.[providerId] && providerModels(providerId).length);
}

function anyProviderTokenConfigured(config) {
  return profileOptions().some((provider) => providerTokenConfigured(config, provider.id));
}

// Pick one complete route for ON mode. The current provider wins when it is
// usable; otherwise the first configured provider becomes active. Main and
// vision are selected from that same provider so a DeepSeek-only install does
// not keep advertising an unauthenticated OpenCode vision route.
function onModeSelection(services) {
  const { config, modelSelection } = services;
  const currentProvider = providerForModel(config, modelSelection.mainModel);
  const providerId = providerTokenConfigured(config, currentProvider)
    ? currentProvider
    : ["opencode-go", "deepseek-official", "custom"]
      .find((id) => providerTokenConfigured(config, id));
  if (!providerId) return null;

  const models = providerModels(providerId);
  const currentMain = models.find((model) => (
    providerForModel(config, modelSelection.mainModel) === providerId
      && model.id === bareModelId(modelSelection.mainModel)
  ));
  const main = currentMain || models[0];
  const visionModels = models.filter((model) => model.supportsVision);
  const currentVision = visionModels.find((model) => (
    providerForModel(config, modelSelection.visionModel) === providerId
      && model.id === bareModelId(modelSelection.visionModel)
  ));
  const vision = currentVision || visionModels[0] || null;
  return {
    providerId,
    profile: profileById(providerId),
    mainModel: publishedSlugFor(providerId, main),
    visionModel: vision ? publishedSlugFor(providerId, vision) : "",
  };
}

// Trial mode narrows the dashboard options to the fixed free pair so the pickers
// and route card cannot advertise paid models while the free experience runs.
function visibleModelOptions(config, options) {
  if (!config.trialMode) return options;
  const trial = new Set([TRIAL_MAIN_MODEL, TRIAL_VISION_MODEL]);
  return options.filter((entry) => trial.has(bareModelId(entry.id)));
}

function modelsPayload(services) {
  const options = visibleModelOptions(services.config, modelOptions(services.config, services.config.profileId));
  const selected = services.modelSelection;
  const visionOptions = options.filter((entry) => entry.supportsVision);
  const visionProviders = providerOptions(services.config).filter((provider) => visionOptions.some((model) => model.provider === provider.id));
  return {
    selected,
    options,
    providers: providerOptions(services.config),
    // Derive the provider from the model actually selected, the same way the
    // vision and subagent pickers do. Reporting config.profileId here let the two
    // drift apart: selecting a custom/ollama model as main updates mainModel but
    // never touches profileId, so the dashboard rendered impossible pairs like
    // "OpenCode Go / qwen3.8:27b". profileId remains the fallback for a model the
    // catalog cannot place.
    selectedProvider: modelProviderOf(options, selected.mainModel) || services.config.profileId || "opencode-go",
    visionProviders,
    selectedVisionProvider: selected.visionModel ? modelProviderOf(options, selected.visionModel) || services.config.profileId : "",
  };
}

// The provider that owns a published model id, or "" when the catalog cannot
// place it. Returning a placeholder here instead made every `modelProviderOf(...)
// || config.profileId` fallback dead code, since the placeholder is truthy.
function modelProviderOf(options, modelId) {
  return options.find((entry) => entry.id === modelId)?.provider || "";
}

// Sub Agent selector: the dashboard writes a ModelDock-managed Codex agent file
// (~/.codex/agents/modeldock-subagent.toml) whose `model`/`model_provider` fields
// define the role Codex exposes for spawned subagents. The picker mirrors the
// main provider/model pair, and every native GPT slug is selectable alongside
// the routed catalog so subagents stop silently defaulting to native models.
// Native roles keep the built-in "openai" provider (base_url pointed at this
// gate in transparent mode); routed roles keep the published "@provider" slug,
// which the gateway parses for upstream routing.
const SUBAGENT_DEFAULT_MODEL = "deepseek-v4-flash@opencode-go";
const SUBAGENT_FILE_NAME = "modeldock-subagent.toml";
const SUBAGENT_PROVIDER = { id: "openai", label: "ChatGPT (native)" };

function subagentModelOptions(config) {
  const options = modelOptions(config, config.profileId);
  for (const model of readNativeCatalog(config)?.models || []) {
    if (typeof model?.slug !== "string" || !model.slug) continue;
    if (options.some((entry) => entry.id === model.slug)) continue;
    options.push({
      id: model.slug,
      label: model.display_name || model.slug,
      provider: SUBAGENT_PROVIDER.id,
      native: true,
    });
  }
  return options;
}

function subagentProviders(config) {
  return [...providerOptions(config).map((entry) => ({ id: entry.id, label: entry.label })), SUBAGENT_PROVIDER];
}

function subagentAgentFilePath(config) {
  if (!config.codexHome) return null;
  return path.join(config.codexHome, "agents", SUBAGENT_FILE_NAME);
}

function readSubagentModel(config) {
  try {
    const source = readFileSync(subagentAgentFilePath(config), "utf8");
    return source.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || null;
  } catch {
    return null;
  }
}

function writeSubagentAgentFile(config, model) {
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

function subagentPayload(services) {
  const options = subagentModelOptions(services.config);
  const selected = readSubagentModel(services.config) || SUBAGENT_DEFAULT_MODEL;
  const selectedEntry = options.find((entry) => entry.id === selected);
  return {
    selected: selectedEntry ? selected : (options[0]?.id || SUBAGENT_DEFAULT_MODEL),
    options,
    providers: subagentProviders(services.config),
    selectedProvider: selectedEntry?.provider || options[0]?.provider || SUBAGENT_PROVIDER.id,
  };
}

function statusPayload(services) {
  const { config, metrics, mediaStore, routeAffinity, modelSelection, autostart, updater } = services;
  const selected = modelSelection || { mainModel: config.mainModel, visionModel: config.visionModel };
  const mainTokenReady = Boolean(tokenFor(config, selected.mainModel));
  // Which provider owns the selected main model is a display fact, and the picker
  // already answers it from the published catalog. Deriving it a second way here
  // (providerForModel, which resolves the routing question and always returns an
  // answer) let the route card and the picker disagree about the same model.
  // Routing itself still uses providerForModel - see upstreamBaseForModel.
  const models = modelsPayload(services);
  const mainProvider = models.selectedProvider;
  const providerLabel = providerOptions(config).find((p) => p.id === mainProvider)?.label || mainProvider;
  // The route card shows the most recent actual request first, falling back to
  // the dashboard selection. Native passthrough (reason "native_passthrough")
  // never rewrites modelSelection, so without this the card would keep showing
  // the last relayed model while native traffic runs.
  const ROUTE_PROVIDER_LABELS = {
    "openai": "ChatGPT (native)",
    "opencode-go": "OpenCode Go",
    "deepseek-official": "DeepSeek Official",
  };
  const lastRequest = metrics.recent.find((record) => record.kind === "responses" && record.model);
  const routeModel = lastRequest?.model || selected.mainModel;
  const routeProvider = lastRequest?.upstream || mainProvider;
  const routeProviderLabel = ROUTE_PROVIDER_LABELS[routeProvider] || providerOptions(config).find((p) => p.id === routeProvider)?.label || routeProvider;
  return metrics.snapshot({
    ready: mainTokenReady,
    config: {
      ...publicConfig({ ...config, mainModel: selected.mainModel, visionModel: selected.visionModel }),
      // Trial mode marker for the dashboard's OFF/TRIAL/ON mode picker.
      trial: Boolean(config.trialMode),
      // Selection-aware routing facts for the route card and forwarding map: which
      // provider owns the selected main model, which base URL and wire style it hits.
      mainProvider,
      routeModel,
      routeProviderLabel,
      mainProviderLabel: providerLabel,
      mainUpstreamUrl: upstreamBaseForModel(config, selected.mainModel),
      mainWire: "responses",
      visionUpstreamUrl: selected.visionModel ? upstreamBaseForModel(config, selected.visionModel) : "",
    },
    // One source of truth for the model block. This used to be a hand-copied
    // duplicate of modelsPayload, and the copies drifted: /api/models derived the
    // provider from the selected model while /api/status still reported
    // config.profileId, so the same state produced two different answers and the
    // dashboard showed a provider that did not own the model beside it.
    models,
    subagent: subagentPayload(services),
    media: mediaStore.snapshot(),
    routing: routeAffinity?.snapshot?.() || { activeCallIds: 0 },
    runtime: {
      nodeVersion: process.version,
      zstdBackend: typeof zlib.zstdDecompress === "function" ? "native" : "fallback",
      migrationRequired: Number(process.versions.node.split(".", 1)[0]) < 24,
    },
    autostart: {
      supported: Boolean(autostart?.supported?.()),
      enabled: Boolean(autostart?.enabled?.()),
    },
    update: updater?.state?.() || null,
  });
}

function settingsPayload(services) {
  const { config, autostart, modelSelection } = services;
  const mainToken = config.tokens?.["opencode-go"] || "";
  const deepseekToken = config.tokens?.["deepseek-official"] || "";
  const ollamaProfile = profileById("ollama");
  const ollamaConnected = Boolean(ollamaProfile.availableModels?.length);
  const ollamaMain = modelSelection.mainModel && providerForModel(config, modelSelection.mainModel) === "ollama"
    ? bareModelId(modelSelection.mainModel)
    : "";
  const ollamaVision = modelSelection.visionModel && providerForModel(config, modelSelection.visionModel) === "ollama"
    ? bareModelId(modelSelection.visionModel)
    : "";
  return {
    tokenConfigured: anyProviderTokenConfigured(config),
    providers: [
      { id: "opencode-go", label: "OpenCode Go", tokenConfigured: Boolean(mainToken) },
      { id: "deepseek-official", label: "DeepSeek (Official)", tokenConfigured: Boolean(deepseekToken) },
      ...(ollamaConnected ? [{ id: "ollama", label: "Ollama (local)", tokenConfigured: true }] : []),
    ],
    custom: {
      baseUrl: config.customBaseUrl || "",
      model: config.customModel || "",
      apiKeyConfigured: Boolean(config.tokens?.["custom"]),
      asMain: Boolean(config.customMain),
      asVision: Boolean(config.customVision),
    },
    ollama: {
      baseUrl: config.ollamaBaseUrl || OLLAMA_DEFAULT_BASE,
      connected: ollamaConnected,
      models: (ollamaProfile.availableModels || []).map((model) => ({
        id: model.id,
        upstreamId: model.upstreamId,
        label: model.label || model.id,
        supportsVision: Boolean(model.supportsVision),
        contextWindow: model.contextWindow || null,
      })),
      mainModel: ollamaMain,
      visionModel: ollamaVision,
    },
    models: {
      mainModel: modelSelection?.mainModel || config.mainModel,
      visionModel: modelSelection?.visionModel || config.visionModel,
      visionFallbackModel: config.visionFallbackModel || "",
    },
    autostart: {
      supported: Boolean(autostart?.supported?.()),
      enabled: Boolean(autostart?.enabled?.()),
    },
  };
}

// Verify a newly entered provider token with the same near-free Responses probe
// the custom-endpoint Add flow uses. The token is only persisted when its own
// upstream accepts it, so a well-formed but wrong key cannot be written and then
// surface as a 401 wall after the next restart.
async function probeSettingsToken(config, provider, token) {
  const profile = profileById(provider);
  const baseUrl = provider === "deepseek-official"
    ? (config.deepseekBaseUrl || profile.baseUrl)
    : (config.opencodeBaseUrl || config.goBaseUrl || profile.baseUrl);
  const model = profile.availableModels?.[0]?.id || config.mainModel;
  return probeCustomResponses({ baseUrl, apiKey: token, modelId: model });
}

function configMutationGuard(config) {
  const allowedOrigins = new Set([
    `http://${urlHost(config.host)}:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: { type: "origin_not_allowed", message: "Config changes are allowed only from this local dashboard." } });
    }
    if (!req.is("application/json")) {
      return res.status(415).json({ error: { type: "content_type_required", message: "Config changes require application/json." } });
    }
    return next();
  };
}

// The MCP tool endpoint is reached by Codex / the stdio bridge, which are not
// browsers and send no Origin header. Reject any request that DOES carry a
// cross-origin Origin so a malicious web page (or a DNS-rebinding attack that
// makes itself same-host) cannot drive vision_inspect/speak against this loopback
// gateway. The route also carries the caller capability key; Origin filtering
// remains useful defense in depth for browser callers that somehow learn it.
function crossOriginGuard(config) {
  const allowedOrigins = new Set([
    `http://${urlHost(config.host)}:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      return res.status(403).json({ error: { type: "origin_not_allowed", message: "Cross-origin requests are not allowed on this endpoint." } });
    }
    return next();
  };
}

function recordConfigAction(metrics, operation, result) {
  const now = Date.now();
  metrics.recent.unshift({
    id: `config-${now}`,
    kind: "config",
    operation,
    startedAt: now,
    finishedAt: now,
    latencyMs: 0,
    status: result.ok ? "ok" : "error",
    ...(result.error ? { error: result.error } : {}),
  });
  metrics.recent.length = Math.min(metrics.recent.length, metrics.recentLimit);
  metrics.emit("change");
}

const ZEN_FREE_BASE = "https://opencode.ai/zen/v1";

function upstreamBaseForModel(config, model) {
  const provider = providerForModel(config, model);
  if (provider === "custom") return (config.customBaseUrl || "").replace(/\/$/, "");
  if (provider === "deepseek-official") return (config.deepseekBaseUrl || profileById("deepseek-official").baseUrl).replace(/\/$/, "");
  if (provider === "ollama") return (config.ollamaBaseUrl || profileById("ollama").baseUrl).replace(/\/$/, "");
  const upstream = bareModelId(model);
  if (upstream && (upstream.endsWith("-free") || upstream === "big-pickle")) return ZEN_FREE_BASE;
  return (config.opencodeBaseUrl || config.goBaseUrl).replace(/\/$/, "");
}

export function codexModelCatalog(config) {
  return catalogFor(config);
}

function serveModels(req, res, { config, modelSelection }) {
  // Advertise the dashboard-selected main model (with its modalities/plugins) so Codex
  // starts conversations with the model the user actually picked.
  return res.json(codexModelCatalog({
    ...config,
    mainModel: modelSelection?.mainModel || config.mainModel,
    visionModel: modelSelection?.visionModel ?? config.visionModel,
  }));
}

const VISION_MODEL_HINTS = ["luna", "omni", "vision", "vl", "mimi", "glm-5", "grok", "kimi"];

function labelForModelId(id) {
  return id
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Endpoint capability from live probing (2026-08-04): most models accept BOTH responses and
// chat/completions; minimax-m2.5/m3 and qwen* only accept chat (responses returns 401);
// grok-4.5 only accepts responses (chat returns 500). Prefer responses (native Codex dialect).
function modelEndpoint(modelId) {
  if (/^(minimax-m2\.5|minimax-m3|qwen)/.test(modelId)) return "chat";
  return "responses";
}

// Image used to probe whether an upstream model can actually see images. In the release
// bundle this is the inlined dashboard.png; in dev it falls back to a tiny 32x24 RGB-bar
// data URL so the probe needs no on-disk asset and works from any layout.
const inlineDashboardPng = hasInlineStatic ? staticFiles.assets?.["dashboard.png"] : null;
const VISION_PROBE_IMAGE = inlineDashboardPng
  ? `data:image/png;base64,${Buffer.from(inlineDashboardPng).toString("base64")}`
  : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAIAAAAUMWhjAAAALElEQVR4nGP47+CAHzkcSCCACv7jQQyjFoxaMGrBqAWjFoxaMGrBqAVDwwIALqWKRWv2VpsAAAAASUVORK5CYII=";

function visionProbeUrlAndBody(modelId, config, imageUrl) {
  const provider = providerForModel(config, modelId);
  const base = (provider === "deepseek-official" ? profileById("deepseek-official").baseUrl : config.goBaseUrl).replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(config, modelId)}` };
  const upstream = bareModelId(modelId);
  if (["gpt-5.6-luna", "grok-4.5"].includes(upstream)) {
    return {
      url: `${base}/responses`,
      headers,
      body: JSON.stringify({
        model: upstream,
        input: [{ role: "user", content: [{ type: "input_text", text: "What is this?" }, { type: "input_image", image_url: imageUrl }] }],
        stream: false,
        max_output_tokens: 64,
      }),
    };
  }
  const zenFree = upstream.endsWith("-free") || upstream === "big-pickle";
  return {
    url: zenFree ? "https://opencode.ai/zen/v1/chat/completions" : `${base}/chat/completions`,
    headers,
    body: JSON.stringify({
      model: upstream,
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image_url", image_url: { url: imageUrl } }] }],
    }),
  };
}

async function callVisionModel(modelId, config, imageUrl, question, maxTokens = 64) {
  const { url, headers, body } = visionProbeUrlAndBody(modelId, config, imageUrl);
  const parsed = JSON.parse(body);
  if (url.endsWith("/responses")) {
    parsed.input[0].content[0].text = question;
    parsed.max_output_tokens = maxTokens;
  } else {
    parsed.messages[0].content[0].text = question;
    parsed.max_tokens = maxTokens;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(parsed),
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    return { error: `HTTP ${response.status} ${detail}` };
  }
  const data = await response.json();
  if (url.endsWith("/responses")) {
    const text = (data.output || [])
      .filter((entry) => entry.type === "message" && entry.content)
      .flatMap((entry) => entry.content)
      .filter((part) => part.type === "output_text")
      .map((part) => part.text)
      .join("");
    return { text };
  }
  return { text: data.choices?.[0]?.message?.content || "" };
}

async function probeImageSupport(modelId, config) {
  try {
    const result = await callVisionModel(modelId, config, VISION_PROBE_IMAGE, "What is this?", 64);
    if (result.error) {
      if (result.error.includes("Unsupported model") || result.error.includes("ModelNotFound") || result.error.includes("Router.Unavailable")) {
        return { capability: "text", status: "unavailable" };
      }
      return { capability: "text", status: "available" };
    }
    return { capability: "vision", status: "available" };
  } catch {
    return { capability: "unknown", status: "unknown" };
  }
}

// Thin-gateway path: relay through src/gateway.mjs (byte passthrough, tee usage,
// image escalation, affinity).
async function relayGatewayRequest(req, res, services) {
  const { config, metrics, mediaStore, routeAffinity, modelSelection } = services;
  // Abort the upstream call when Codex disconnects (user hits stop, or its own
  // timeout fires). Without this, a client that drops during the pre-first-byte
  // "thinking" wait or a buffered leg (compaction arrayBuffer, free non-stream
  // text) leaves the upstream fetch running to completion - burning tokens - and
  // Codex's retry then issues a duplicate. The streaming leg already tears down
  // on res "close"; the signal covers the phases before/around it.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const result = await relayGatewayResponses(req.body, res, {
    config,
    metrics,
    mediaStore,
    routeAffinity,
    knownModels: publishedModelIds(config),
    nativeSlugs: services.nativeSlugs,
    mainModel: modelSelection?.mainModel || config.mainModel,
    visionModel: modelSelection?.visionModel || config.visionModel,
    // The native passthrough leg forwards these to ChatGPT's backend untouched.
    incomingHeaders: req.headers,
    requestUrl: req.originalUrl,
    signal: controller.signal,
  });
  if (result?.route?.reason === "client_selected" && modelSelection && result.route.model !== modelSelection.mainModel) {
    modelSelection.mainModel = result.route.model;
  }
  return result;
}

let JUDGE_MODEL = null;

function judgeText(text) {
  if (!text || !text.trim()) return 0;
  const lower = text.toLowerCase();
  if (/(can't|cannot|couldn't|no image|not an image|can not see|unable to see|no picture)/.test(lower)) return 0;
  return 1;
}

async function scoreDashboardTask(modelId, config) {
  const imageUrl = VISION_PROBE_IMAGE;
  if (!imageUrl) return 0;
  const question = "Describe this dashboard screenshot in detail. List the specific metrics, numbers, and charts you can see.";
  const result = await callVisionModel(modelId, config, imageUrl, question, 256);
  if (result.error) return 0;
  const base = judgeText(result.text);
  if (base === 0) return 0;
  const hasNumbers = /\d[\d.,%]*(%|k|m|K|M)?/.test(result.text);
  const hasMetricWords = /\b(cpu|gpu|memory|ram|requests|latency|error|tokens|usage|active|model|time|duration|rate|total|count)\b/i.test(result.text);
  return (hasNumbers ? 1 : 0) + (hasMetricWords ? 1 : 0);
}

async function evaluateVision(modelId, config) {
  const { TASKS, loadTaskImage, scoreTask, tierForScore } = await import("./vision-eval.mjs");
  const results = [];
  let deterministicScore = 0;
  let maxDeterministic = 0;
  for (const task of TASKS) {
    const taskImage = loadTaskImage(task);
    if (!taskImage) {
      // The assets/vision set is missing in this checkout: report the task as
      // unattempted instead of sending a broken data URL to the vision model.
      results.push({ task: task.id, difficulty: task.difficulty, passed: false, skipped: true });
      maxDeterministic += 1;
      continue;
    }
    const imageUrl = `data:image/png;base64,${taskImage}`;
    const answer = await callVisionModel(modelId, config, imageUrl, task.question, 48);
    const score = answer.error ? 0 : scoreTask(task, answer.text);
    deterministicScore += score;
    maxDeterministic += 1;
    results.push({ task: task.id, difficulty: task.difficulty, passed: score === 1 });
  }
  const dashboardScore = deterministicScore >= 3 ? await scoreDashboardTask(modelId, config) : 0;
  const total = deterministicScore + dashboardScore;
  const maxTotal = maxDeterministic + 2;
  return {
    deterministic: deterministicScore,
    dashboard: dashboardScore,
    score: total,
    maxScore: maxTotal,
    tier: tierForScore(total, maxTotal),
    results,
  };
}

async function probeVisionCandidates(profile, candidates, config) {
  const results = await Promise.all(
    candidates.map(async (model) => ({ id: model.id, ...(await probeImageSupport(model.id, config)) })),
  );
  profile.availableModels = profile.availableModels.map((model) => {
    const result = results.find((entry) => entry.id === model.id);
    if (!result) return model;
    return {
      ...model,
      endpoint: modelEndpoint(model.id),
      supportsVision: result.capability === "vision",
      visionStatus: result.capability,
      status: result.status,
    };
  });
  const vision = results.filter((r) => r.capability === "vision").map((r) => r.id);
  const unavailable = results.filter((r) => r.status === "unavailable").map((r) => r.id);
  console.log(`[gate] vision probe done: vision=[${vision.join(", ") || "none"}] unavailable=[${unavailable.join(", ") || "none"}]`);
  const VISION_SCORE_THRESHOLD = 4;
  const visionModels = profile.availableModels.filter((model) => model.supportsVision);
  if (visionModels.length) {
    const evaluations = await Promise.all(
      visionModels.map(async (model) => ({ id: model.id, evaluation: await evaluateVision(model.id, config) })),
    );
    profile.availableModels = profile.availableModels.map((model) => {
      const evalEntry = evaluations.find((entry) => entry.id === model.id);
      if (!evalEntry) return model;
      const evaluation = evalEntry.evaluation;
      const qualified = evaluation.score >= VISION_SCORE_THRESHOLD;
      return {
        ...model,
        visionScore: evaluation.score,
        visionMaxScore: evaluation.maxScore,
        visionTier: evaluation.tier,
        visionResults: evaluation.results,
        supportsVision: qualified,
        visionStatus: qualified ? "vision" : "no-vision",
      };
    });
    const ranked = evaluations
      .sort((a, b) => b.evaluation.score - a.evaluation.score)
      .map((entry) => `${entry.id}=${entry.evaluation.score}/${entry.evaluation.maxScore}(${entry.evaluation.tier})${entry.evaluation.score >= VISION_SCORE_THRESHOLD ? "" : "-rejected"}`);
    console.log(`[gate] vision evaluation done: ${ranked.join(", ")}`);
  }
}

async function refreshProfileModels(profile, config) {
  if (!profile || profile.id !== "opencode-go") return;
  const opencodeToken = config.tokens?.["opencode-go"];
  if (!opencodeToken) return;
  if (!config.goBaseUrl.includes("opencode.ai")) return;
  // Model catalog refresh, opt-in via MODELDOCK_MODEL_PROBE_ENABLED=1. The shipped
  // curated catalog (profiles.mjs) is the primary model source and ships with the
  // release; users do not need to re-probe. This only does a light GET /models merge
  // so newly added upstream ids appear alongside the curated ones. Vision
  // probing/evaluation (probeVisionCandidates/evaluateVision) is dev-only test
  // tooling and is NOT wired into this path or into startup.
  if (config.modelProbeEnabled === false) return;
  try {
    const base = config.goBaseUrl.replace(/\/$/, "");
    const headers = { Authorization: `Bearer ${opencodeToken}` };
    const goRes = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
    const goIds = goRes.ok ? ((await goRes.json())?.data || []).map((entry) => entry?.id).filter((id) => typeof id === "string" && id) : [];
    const fetchedIds = [...new Set(goIds)];
    if (!fetchedIds.length) return;
    const existing = profile.availableModels || [];
    const existingById = new Map(existing.map((model) => [model.id, model]));
    const unknown = fetchedIds.filter((id) => !existingById.has(id)).sort((a, b) => a.localeCompare(b));
    const models = [
      ...existing,
      ...unknown.map((id) => ({
        id,
        label: labelForModelId(id),
        endpoint: modelEndpoint(id),
        supportsVision: false,
        visionStatus: "unknown",
        status: "available",
      })),
    ];
    profile.availableModels = models;
    console.log(`[gate] refreshed opencode-go model catalog: ${models.length} models (${existing.length} curated, ${unknown.length} new)`);
  } catch (error) {
    console.log(`[gate] model catalog refresh failed: ${error.message}`);
  }
}
export function createServices(config = loadConfig()) {
  const mutableConfig = { ...config };
  // loadConfig always supplies `tokens`; test fixtures build config objects by
  // hand, so make the runtime copy self-consistent before routes mutate it.
  mutableConfig.tokens = mutableConfig.tokens || {};
  // Provider tokens have a single source of truth: the per-provider map.
  // The legacy boot-time goToken mirror (hand-built test configs, older
  // persisted shapes) is folded into it here and dropped, so no reader can
  // disagree with the just-saved token again.
  if (mutableConfig.goToken && !mutableConfig.tokens["opencode-go"]) {
    mutableConfig.tokens["opencode-go"] = mutableConfig.goToken;
  }
  delete mutableConfig.goToken;
  const metrics = new Metrics({ recentLimit: mutableConfig.recentLimit });
  const mediaStore = new MediaStore({
    ttlMs: mutableConfig.mediaTtlMs,
    maxBytes: mutableConfig.mediaMaxBytes,
    maxEntries: mutableConfig.mediaMaxEntries,
    stateDir: mutableConfig.mediaDir,
  });
  const modelSelection = { mainModel: mutableConfig.mainModel, visionModel: mutableConfig.visionModel };
  const services = {};
  const memoryStore = memoryStoreFor(mutableConfig);
  const upstreams = createUpstreams({
    config: mutableConfig,
    metrics,
    mediaStore,
    memoryStore,
    getVisionModel: () => modelSelection.visionModel,
  });
  let memoryTimer = null;
  if (memoryStore) {
    const captureMemories = () => {
      try {
        const result = memoryStore.captureCodexMemories(mutableConfig.codexHome);
        if (result?.error) console.log(`[gate] memory capture: ${result.error}`);
      } catch (error) {
        console.log(`[gate] memory capture failed: ${error.message}`);
      }
    };
    captureMemories();
    const memoryRefreshHours = Number(mutableConfig.memoryRefreshHours || 6);
    if (memoryRefreshHours > 0) {
      memoryTimer = setInterval(captureMemories, memoryRefreshHours * 3_600_000);
      memoryTimer.unref();
    }
  }
  // The catalog file follows the same MODELDOCK_STATE_DIR redirect as owner
  // records (instance-owner.mjs), so a gateway started from a throwaway install
  // (mock-install tests) writes its own catalog instead of rewriting the real
  // ~/.modeldock file with paths baked from the temp root.
  const catalogFile = mutableConfig.codexCatalogFile
    || stateFile("codex-model-catalog.json");
  // The Ollama connection snapshot follows the same state-dir redirect. Real
  // configs restore it during loadConfig; this re-apply covers hand-built test
  // configs (which opt in by setting ollamaSnapshotFile) and keeps the running
  // profile in sync with whatever the connect/disconnect routes write.
  const ollamaSnapshotFile = mutableConfig.ollamaSnapshotFile || ollamaSnapshotPath();
  if (mutableConfig.ollamaSnapshotFile) {
    const snapshot = readOllamaSnapshot(mutableConfig.ollamaSnapshotFile);
    if (snapshot) applyOllamaProfile(mutableConfig, snapshot);
  }
  // The capability key rides in the base URL Codex reads from config.toml, so a
  // hostile local web page cannot reach the relay endpoints (see caller-key.mjs).
  const callerKey = mutableConfig.callerKey || loadOrCreateCallerKey();
  const gatewayUrl = `http://${urlHost(mutableConfig.host)}:${mutableConfig.port}`;
  const mcpUrl = `${gatewayUrl}${callerRootPath(callerKey)}/mcp`;
  const configSwitcher = new CodexConfigSwitcher({
    codexHome: mutableConfig.codexHome,
    baseUrl: `${gatewayUrl}${callerBasePath(callerKey)}`,
    // stdio (default) spawns the standalone bridge as a Codex-owned child so gateway
    // restarts never kill the session's MCP tools; url keeps the old HTTP wiring.
    mcpUrl: mutableConfig.mcpTransport === "url" ? mcpUrl : "",
    mcpCommand: mutableConfig.mcpTransport === "stdio" ? process.execPath : "",
    mcpArgs: mutableConfig.mcpTransport === "stdio" ? [path.join(dirname, "mcp-standalone.mjs")] : [],
    mcpEnv: mutableConfig.mcpTransport === "stdio" ? { MODELDOCK_GATEWAY_URL: mcpUrl.replace(/\/mcp$/, "") } : {},
    model: mutableConfig.mainModel,
    catalogFile,
  });
  const autostart = createAutostart();
  autostart.refresh().catch(() => {});
  // Re-check periodically so the Update button stays current without a restart;
  // the check is fire-and-forget and costs one small API call every 6h.
  const updater = createUpdater({ autoCheckMs: 6 * 60 * 60 * 1000 });
  updater.check().catch(() => {});
  const routeAffinity = new RouteAffinity();
  const runtime = { profile: mutableConfig.profile, profileId: mutableConfig.profileId };
  // Captured native GPT slugs from the Codex desktop CLI (see native-catalog.mjs).
  // Requests for these go to the ChatGPT backend even though they are published
  // in our catalog for the App picker.
  const nativeSlugs = nativeModelSlugs(mutableConfig);
  // The Codex App never fetches a custom provider's /models: its refresh predicate is
  // `uses_codex_backend() || has_command_auth()`, and an API-key provider satisfies
  // neither (openai/codex#32119), so the App picker shows "Custom" for everything it
  // cannot name locally. It does read a catalog file named by `model_catalog_json`, so
  // publish the same catalog we serve over HTTP to disk and point the managed Codex
  // config at it. The CLI keeps using /v1/models; both then see one list.
  const writeCatalogFile = () => {
    try {
      const catalog = codexModelCatalog({
        ...mutableConfig,
        mainModel: modelSelection.mainModel,
        visionModel: modelSelection.visionModel,
      });
      mkdirSync(path.dirname(catalogFile), { recursive: true });
      // Atomic replace: Codex reads this file on its own schedule, so a
      // half-written JSON must never be observable. Same-directory rename is
      // atomic on both Windows and POSIX.
      const tmp = `${catalogFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(catalog, null, 2), "utf8");
      renameSync(tmp, catalogFile);
      return catalog.models?.length || 0;
    } catch (error) {
      console.log(`[gate] model catalog file write failed: ${error.message}`);
      return 0;
    }
  };
  const refreshModelCatalog = () => Promise.all([
    refreshProfileModels(mutableConfig.profile, mutableConfig),
    // Opt-out keeps the desktop-app refresh out of unit tests; production turns
    // it on by default so the picker keeps showing native GPT models.
    mutableConfig.refreshNativeCatalog === false
      ? null
      : refreshNativeCatalog(mutableConfig).then((models) => {
          if (models?.length) {
            nativeSlugs.clear();
            for (const model of models) {
              if (typeof model?.slug === "string" && model.slug) nativeSlugs.add(model.slug);
            }
          }
          return models;
        }),
  ]).then(
    ([, nativeModels]) => {
      const written = writeCatalogFile();
      console.log(`[gate] model refresh done, availableModels=${(mutableConfig.profile?.availableModels || []).length}, native=${nativeModels?.length || 0}, catalog file=${written} models`);
    },
    (error) => console.log(`[gate] model refresh error: ${error.message}`),
  );
  // Write once at boot so the file exists even when the refresh is disabled or fails.
  writeCatalogFile();
  refreshModelCatalog();
  const refreshIntervalHours = Number(mutableConfig.modelRefreshHours || 24);
  const modelRefreshTimer = refreshIntervalHours > 0
    ? setInterval(refreshModelCatalog, refreshIntervalHours * 3_600_000)
    : null;
  if (modelRefreshTimer) modelRefreshTimer.unref();
  return Object.assign(services, {
    config: mutableConfig, runtime, metrics, mediaStore, upstreams, configSwitcher,
    autostart, updater, routeAffinity, modelSelection, callerKey, nativeSlugs,
    memoryStore, memoryTimer,
    refreshModelCatalog, writeCatalogFile, modelRefreshTimer, ollamaSnapshotFile,
  });
}

// Codex compresses some request bodies (observed on remote compact tasks) with
// Content-Encoding: zstd, which body-parser does not speak - it 415s before any
// route runs, taking down the whole turn. body-parser's json handler skips a
// request whose stream is already consumed (onFinished.isFinished) and keeps a
// pre-set req.body, so this outer middleware drains + decompresses zstd bodies
// itself and hands the parsed JSON through. gzip/deflate/br stay with
// body-parser, which supports them natively.
function isCallerKeyEnforced() {
  const raw = String(process.env.MODELDOCK_REQUIRE_CALLER_KEY || "").toLowerCase();
  return raw === "" || !["0", "false", "off"].includes(raw);
}

function protectedRelayPath(pathname) {
  return pathname === "/v1/responses"
    || pathname === "/responses"
    || pathname === "/v1/responses/compact"
    || pathname === "/responses/compact"
    || [...NATIVE_IMAGE_PATHS].includes(pathname);
}

function zstdRequestDecoder(callerKey) {
  const maxInput = 16 * 1024 * 1024;
  const maxOutput = 64 * 1024 * 1024;
  return (req, res, next) => {
    if (String(req.headers["content-encoding"] || "").toLowerCase() !== "zstd") return next();
    const pathname = String(req.url || "").split("?", 1)[0];
    const keyMatch = pathname.match(/^\/c\/([^/]+)/);
    if (keyMatch && (!callerKey || !callerKeyEqual(keyMatch[1], callerKey))) {
      return res.status(401).json({ error: { type: "invalid_caller_key", message: "Unknown caller key." } });
    }
    if (!keyMatch && protectedRelayPath(pathname) && isCallerKeyEnforced()) {
      return res.status(401).json({ error: { type: "caller_key_required", message: "This gateway requires the keyed base URL." } });
    }
    const chunks = [];
    let received = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      received += chunk.length;
      if (received > maxInput) {
        tooLarge = true;
        res.status(413).json({ error: { type: "payload_too_large", message: `zstd request body exceeds the ${maxInput}-byte limit` } });
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", next);
    req.on("end", () => {
      if (tooLarge) return;
      const compressed = Buffer.concat(chunks);
      const onDecoded = (error, body) => {
        if (error) {
          if (error.code === "ERR_BUFFER_TOO_LARGE") {
            return res.status(413).json({ error: { type: "payload_too_large", message: `zstd request decompresses beyond the ${maxOutput}-byte limit` } });
          }
          return res.status(400).json({ error: { type: "bad_request", message: `zstd request decode failed: ${error.message}` } });
        }
        try {
          req.headers["content-encoding"] = "identity";
          req.headers["content-length"] = String(body.length);
          req.body = JSON.parse(body.toString("utf8"));
          next();
        } catch (decodeError) {
          res.status(400).json({ error: { type: "bad_request", message: `zstd request decode failed: ${decodeError.message}` } });
        }
      };
      decodeZstdBody(compressed, maxOutput).then(
        (body) => onDecoded(null, body),
        (error) => onDecoded(error),
      );
    });
  };
}

export function decodeZstdBody(compressed, maxOutput = 64 * 1024 * 1024, nativeDecoder = zlib.zstdDecompress) {
  if (typeof nativeDecoder === "function") {
    return new Promise((resolve, reject) => {
      nativeDecoder(compressed, { maxOutputLength: maxOutput }, (error, body) => {
        if (error) reject(error);
        else resolve(Buffer.from(body));
      });
    });
  }
  return Promise.resolve().then(() => {
    const chunks = [];
    let length = 0;
    const decoder = new ZstdFallbackDecoder((chunk) => {
      length += chunk.length;
      if (length > maxOutput) {
        const error = new Error("decompressed body exceeds limit");
        error.code = "ERR_BUFFER_TOO_LARGE";
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    });
    decoder.push(compressed, true);
    return Buffer.concat(chunks, length);
  });
}

export function createApp(services = createServices()) {
  const { config, metrics, mediaStore, upstreams, configSwitcher, autostart, routeAffinity } = services;
  const app = createMcpExpressApp({ host: config.host, jsonLimit: "25mb" });
  app.disable("x-powered-by");

  // Dashboard /api/* endpoints are same-origin only: a cross-origin browser
  // page must not be able to read status/settings or drive config writes
  // through the loopback listener. curl and Codex send no Origin header, so
  // they are unaffected; the route-level guards add the same rule to /mcp.
  app.use("/api", crossOriginGuard(config));

  const mcpHandler = createMcpNodeHandler({
    upstreams,
    onError: (error) => {
      metrics.recent.unshift({
        id: "mcp",
        kind: "mcp",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      metrics.recent.length = Math.min(metrics.recent.length, metrics.recentLimit);
      metrics.emit("change");
    },
  });

  // Capability-key routes: the base_url written into config.toml carries the key
  // (/c/<key>/v1), so Codex authenticates implicitly while a hostile local web
  // page (which can POST to loopback but cannot read ~/.modeldock) cannot.
  const requireCallerKey = (req, res, next) => {
    if (services.callerKey && callerKeyEqual(req.params.key, services.callerKey)) return next();
    return res.status(401).json({ error: { type: "invalid_caller_key", message: "Unknown caller key; re-enable the Codex switch to refresh the URL." } });
  };
  const guardMcpOrigin = crossOriginGuard(config);
  app.all(`${CALLER_PATH_PREFIX}/:key/mcp`, guardMcpOrigin, requireCallerKey, (req, res) => mcpHandler(req, res, req.body));
  app.all("/mcp", guardMcpOrigin, (_req, res) => res.status(401).json({
    error: { type: "caller_key_required", message: "This MCP endpoint requires the keyed URL; re-enable the Codex switch." },
  }));
  app.post(`${CALLER_PATH_PREFIX}/:key/v1/responses`, requireCallerKey, (req, res) => relayGatewayRequest(req, res, services));
  app.post(`${CALLER_PATH_PREFIX}/:key/v1/responses/compact`, requireCallerKey, (req, res) => relayGatewayRequest(req, res, services));
  app.post(`${CALLER_PATH_PREFIX}/:key/responses/compact`, requireCallerKey, (req, res) => relayGatewayRequest(req, res, services));
  app.get(`${CALLER_PATH_PREFIX}/:key/v1/models`, requireCallerKey, (req, res) => serveModels(req, res, services));
  // The built-in image_gen tool posts to the openai_base_url's images endpoints;
  // with the transparent config those land here and go straight to the native
  // backend on the client's subscription (no Platform API key needed).
  const nativeImageRelay = (req, res) => relayNativeImage(req.body, res, {
    incomingHeaders: req.headers,
    requestUrl: req.originalUrl,
  });
  app.post([...NATIVE_IMAGE_PATHS].map((item) => `${CALLER_PATH_PREFIX}/:key${item}`), requireCallerKey, nativeImageRelay);
  // Bare paths stay for compatibility with configs written before the caller key
  // existed. Enforcement is ON by default: a hostile local web page can POST to
  // loopback without reading ~/.modeldock, so an unkeyed path would let it burn
  // the upstream tokens this process holds. MODELDOCK_REQUIRE_CALLER_KEY=0 (or
  // off/false) re-opens the bare paths for legacy configs.
  const callerKeyEnforced = () => {
    return isCallerKeyEnforced();
  };
  const bareRelay = (req, res) => {
    if (callerKeyEnforced()) {
      return res.status(401).json({ error: { type: "caller_key_required", message: "This gateway requires the keyed base URL; re-enable the Codex switch." } });
    }
    return relayGatewayRequest(req, res, services);
  };
  const bareNativeImageRelay = (req, res) => {
    if (callerKeyEnforced()) {
      return res.status(401).json({ error: { type: "caller_key_required", message: "This gateway requires the keyed base URL; re-enable the Codex switch." } });
    }
    return nativeImageRelay(req, res);
  };
  app.post(["/v1/responses", "/responses"], bareRelay);
  app.post(["/v1/responses/compact", "/responses/compact"], bareRelay);
  app.post([...NATIVE_IMAGE_PATHS], bareNativeImageRelay);
  app.get(["/v1/models", "/models"], (req, res) => serveModels(req, res, services));
  app.get("/healthz", (req, res) => {
    const tokenReady = Boolean(tokenFor(config, services.modelSelection?.mainModel));
    return res.status(tokenReady ? 200 : 503).json({ ok: tokenReady });
  });
  app.get("/api/status", (req, res) => res.json(statusPayload(services)));
  app.get("/api/memory/status", (req, res) => {
    if (!services.memoryStore) return res.json({ enabled: false });
    return res.json(services.memoryStore.status());
  });
  app.get("/api/memory/view", (req, res) => {
    if (!services.memoryStore) return res.json({ enabled: false });
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    return res.json({
      enabled: true,
      status: services.memoryStore.status(),
      content: services.memoryStore.contentView(limit),
      events: services.memoryStore.recentEvents(50),
    });
  });
  app.get("/api/speech", async (req, res) => {
    try {
      const { ttsStatus } = await import("./tts.mjs");
      const { sttStatus } = await import("./stt.mjs");
      const [tts, stt] = await Promise.all([ttsStatus(), sttStatus()]);
      return res.json({ tts, stt });
    } catch (error) {
      return res.status(500).json({ error: { type: "speech_status_error", message: error.message } });
    }
  });
  app.post("/api/speech/install", async (req, res) => {
    try {
      const { ttsInstall } = await import("./tts.mjs");
      const installed = await ttsInstall();
      return res.json({ installed });
    } catch (error) {
      return res.status(500).json({ error: { type: "tts_install_error", message: error.message } });
    }
  });
  app.get("/api/config", async (req, res) => {
    try {
      return res.json({ ...(await configSwitcher.status()), trial: Boolean(config.trialMode) });
    } catch (error) {
      return res.status(500).json({ error: { type: "config_status_error", message: error.message } });
    }
  });

  const mutateConfig = configMutationGuard(config);
  let configMutationQueue = Promise.resolve();
  const configAction = (operation) => async (req, res) => {
    try {
      const run = configMutationQueue.then(() => configSwitcher[operation]());
      configMutationQueue = run.catch(() => {});
      const result = await run;
      recordConfigAction(metrics, `config_${operation}`, { ok: true });
      return res.json(result);
    } catch (error) {
      recordConfigAction(metrics, `config_${operation}`, { ok: false, error: error.message });
      const conflict = error.code === "STATE_INVALID";
      return res.status(conflict ? 409 : 500).json({ error: { type: error.code || "config_switch_error", message: error.message } });
    }
  };
  app.post("/api/config/enable", mutateConfig, configAction("enable"));
  app.post("/api/config/disable", mutateConfig, configAction("disable"));
  app.post("/api/config/restart-ack", mutateConfig, configAction("acknowledgeRestart"));
  // Three-way mode switch (OFF / TRIAL / ON). OFF and ON reuse the existing switch
  // operations; TRIAL additionally locks the modelSelection to the zen-free pair and
  // rewrites the .env so a restart keeps the trial configuration. The catalog file is
  // refreshed immediately so the Codex App picker narrows to the free pair too.
  app.post("/api/config/mode", mutateConfig, async (req, res) => {
    const mode = String(req.body?.mode || "");
    if (mode !== "off" && mode !== "trial" && mode !== "on") {
      return res.status(400).json({ error: { type: "invalid_mode", message: "mode must be 'off', 'trial' or 'on'." } });
    }
    try {
      const run = configMutationQueue.then(async () => {
        let result;
        // Wizard-managed native-GPT merge opt-out (no ChatGPT subscription). It is a
        // persistent property of the account, so it is applied on every enabling mode
        // (trial included): a non-subscriber who later moves trial -> on must not get
        // the native GPT catalog back. "0"/"false"/"off" are accepted for curl users.
        const nativeMergeRaw = req.body?.nativeMerge;
        const nativeMerge = nativeMergeRaw === undefined
          ? undefined
          : !["0", "false", "off"].includes(String(nativeMergeRaw).toLowerCase());
        if (mode === "off") {
          result = await configSwitcher.disable();
          config.trialMode = false;
          writeEnvFile({ MODELDOCK_TRIAL: "0" }, config.envFile);
        } else {
          let onSelection = null;
          let previousSelection = null;
          if (mode === "on") {
            onSelection = onModeSelection(services);
            if (!onSelection) {
              const error = new Error("Configure a provider token before enabling ON mode.");
              error.code = "provider_token_required";
              throw error;
            }
            previousSelection = {
              profile: config.profile,
              profileId: config.profileId,
              mainModel: config.mainModel,
              visionModel: config.visionModel,
              selectedMainModel: services.modelSelection.mainModel,
              selectedVisionModel: services.modelSelection.visionModel,
              switcherModel: services.configSwitcher.model,
            };
            config.profile = onSelection.profile;
            config.profileId = onSelection.providerId;
            config.mainModel = onSelection.mainModel;
            config.visionModel = onSelection.visionModel;
            services.modelSelection.mainModel = onSelection.mainModel;
            services.modelSelection.visionModel = onSelection.visionModel;
            services.configSwitcher.model = onSelection.mainModel;
          }
          try {
            result = await configSwitcher.enable();
          } catch (error) {
            if (previousSelection) {
              config.profile = previousSelection.profile;
              config.profileId = previousSelection.profileId;
              config.mainModel = previousSelection.mainModel;
              config.visionModel = previousSelection.visionModel;
              services.modelSelection.mainModel = previousSelection.selectedMainModel;
              services.modelSelection.visionModel = previousSelection.selectedVisionModel;
              services.configSwitcher.model = previousSelection.switcherModel;
            }
            throw error;
          }
          if (mode === "trial") {
            config.trialMode = true;
            // The catalog is fully owner-qualified, so the selected pair is
            // stored and persisted in its published form too - a bare trial id
            // would make the dashboard selected value disagree with the picker
            // until the next restart.
            const trialMain = publishedSlugFor(config.profileId, TRIAL_MAIN_MODEL);
            const trialVision = publishedSlugFor(config.profileId, TRIAL_VISION_MODEL);
            services.modelSelection.mainModel = trialMain;
            services.modelSelection.visionModel = trialVision;
            services.configSwitcher.model = trialMain;
            const trialEnv = {
              MODELDOCK_TRIAL: "1",
              MODELDOCK_MAIN_MODEL: trialMain,
              MODELDOCK_VISION_MODEL: trialVision,
            };
            if (nativeMerge !== undefined) trialEnv.MODELDOCK_NATIVE_MERGE = nativeMerge ? "1" : "0";
            writeEnvFile(trialEnv, config.envFile);
            if (nativeMerge !== undefined) config.nativeMerge = nativeMerge;
          } else {
            config.trialMode = false;
            const onEnv = {
              MODELDOCK_TRIAL: "0",
              MODELDOCK_PROFILE: onSelection.providerId,
              MODELDOCK_MAIN_MODEL: onSelection.mainModel,
              MODELDOCK_VISION_MODEL: onSelection.visionModel || "none",
            };
            if (nativeMerge !== undefined) onEnv.MODELDOCK_NATIVE_MERGE = nativeMerge ? "1" : "0";
            writeEnvFile(onEnv, config.envFile);
            if (nativeMerge !== undefined) config.nativeMerge = nativeMerge;
          }
          services.writeCatalogFile();
        }
        recordConfigAction(metrics, `config_mode_${mode}`, { ok: true });
        return { ...result, trial: Boolean(config.trialMode) };
      });
      configMutationQueue = run.catch(() => {});
      return res.json(await run);
    } catch (error) {
      recordConfigAction(metrics, `config_mode_${mode}`, { ok: false, error: error.message });
      const conflict = error.code === "STATE_INVALID";
      const badRequest = error.code === "provider_token_required";
      return res.status(conflict ? 409 : badRequest ? 400 : 500).json({ error: { type: error.code || "config_switch_error", message: error.message } });
    }
  });
  // First-run onboarding: what the wizard pre-fills (token presence, autostart)
  // and where it writes its done marker. Mode application reuses /api/config/mode;
  // only the onboarding flag lives here.
  app.get("/api/onboarding", async (req, res) => {
    try {
      const status = await configSwitcher.status();
      const settings = settingsPayload(services);
      return res.json({
        onboarded: Boolean(status.onboarded),
        onboardedAt: status.onboardedAt || null,
        nativeMerge: config.nativeMerge !== false,
        mode: status.enabled ? (config.trialMode ? "trial" : "on") : "off",
        tokenConfigured: {
          "opencode-go": Boolean(config.tokens?.["opencode-go"]),
          "deepseek-official": Boolean(config.tokens?.["deepseek-official"]),
        },
        // Any provider token unlocks the ON mode (the wizard's Apply gate); the
        // trial pair still requires the OpenCode token specifically.
        anyTokenConfigured: anyProviderTokenConfigured(config),
        autostart: settings.autostart,
      });
    } catch (error) {
      return res.status(500).json({ error: { type: "onboarding_status_error", message: error.message } });
    }
  });
  app.post("/api/onboarding/complete", mutateConfig, async (req, res) => {
    try {
      const status = await configSwitcher.markOnboarded();
      recordConfigAction(metrics, "onboarding_complete", { ok: true });
      return res.json({ onboarded: true, ...status });
    } catch (error) {
      recordConfigAction(metrics, "onboarding_complete", { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "onboarding_failed", message: error.message } });
    }
  });
  app.get("/api/models", (req, res) => res.json(modelsPayload(services)));
  app.get("/api/profiles", (req, res) => res.json({ selected: config.profileId, options: profileOptions() }));
  app.post("/api/models", mutateConfig, (req, res) => {
    const current = services.modelSelection;
    // Resolve a bare id to its published form first: the options list is fully
    // owner-qualified, so a legacy/dashboard submission of "kimi-k2.5" must match
    // the "kimi-k2.5@opencode-go" entry instead of 400ing on an exact-id lookup.
    const qualify = (id) => publishedSlugFor(config.profileId, id);
    let nextMain = qualify(req.body?.mainModel === undefined ? current.mainModel : req.body.mainModel);
    let nextVision = qualify(req.body?.visionModel === undefined ? current.visionModel : req.body.visionModel);
    const nextProvider = req.body?.provider;
    // Trial mode pins the free pair and the opencode-go provider; only the mode
    // switch can move models while it is active.
    if (config.trialMode) {
      nextMain = qualify(TRIAL_MAIN_MODEL);
      nextVision = qualify(TRIAL_VISION_MODEL);
    }
    if (!config.trialMode && nextProvider !== undefined && nextProvider !== config.profileId) {
      const known = profileOptions().some((entry) => entry.id === nextProvider);
      if (!known) return res.status(400).json({ error: { type: "invalid_provider", message: `Unknown provider: ${nextProvider}` } });
      config.profile = profileById(nextProvider);
      config.profileId = nextProvider;
      const profileModels = modelCatalogModels(config, config.profileId);
      if (!profileModels.some((entry) => entry.id === nextMain)) nextMain = profileModels[0]?.id || nextMain;
      if (!profileModels.some((entry) => entry.id === nextVision && entry.supportsVision)) {
        nextVision = profileModels.find((entry) => entry.supportsVision)?.id || "";
      }
    }
    const options = modelOptions(config, config.profileId);
    const main = options.find((entry) => entry.id === nextMain);
    const vision = nextVision ? options.find((entry) => entry.id === nextVision) : null;
    if (!main || (nextVision && (!vision || !vision.supportsVision))) return res.status(400).json({ error: { type: "invalid_model_selection", message: "Vision must be None or selected from a vision-capable model." } });
    services.modelSelection.mainModel = nextMain;
    services.modelSelection.visionModel = nextVision;
    config.mainModel = nextMain;
    config.visionModel = nextVision;
    services.configSwitcher.model = nextMain;
    recordConfigAction(metrics, "models_update", { ok: true });
    return res.json(modelsPayload(services));
  });
  app.get("/api/subagent", (req, res) => res.json(subagentPayload(services)));
  app.post("/api/subagent", mutateConfig, async (req, res) => {
    const model = req.body?.model;
    if (typeof model !== "string" || !model) {
      return res.status(400).json({ error: { type: "invalid_subagent_model", message: "A subagent model id is required." } });
    }
    const options = subagentModelOptions(config);
    if (!options.some((entry) => entry.id === model)) {
      return res.status(400).json({ error: { type: "invalid_subagent_model", message: `Unknown subagent model: ${model}` } });
    }
    try {
      writeSubagentAgentFile(config, model);
      await services.configSwitcher.markRestartRequired();
    } catch (error) {
      recordConfigAction(metrics, "subagent_update", { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "subagent_write_failed", message: error.message } });
    }
    recordConfigAction(metrics, "subagent_update", { ok: true });
    return res.json(subagentPayload(services));
  });
  app.post("/api/debug", mutateConfig, (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    services.config.debug = { ...services.config.debug, enabled };
    recordConfigAction(metrics, `debug_${enabled ? "on" : "off"}`, { ok: true });
    return res.json({ enabled });
  });
  app.post("/api/autostart", mutateConfig, async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    try {
      const result = await autostart.setEnabled(enabled);
      recordConfigAction(metrics, `autostart_${enabled ? "on" : "off"}`, { ok: true });
      return res.json(result);
    } catch (error) {
      recordConfigAction(metrics, `autostart_${enabled ? "on" : "off"}`, { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "autostart_failed", message: error.message } });
    }
  });
  app.post("/api/update", mutateConfig, async (req, res) => {
    try {
      const result = await services.updater.apply();
      recordConfigAction(metrics, "update_apply", { ok: true });
      return res.json(result);
    } catch (error) {
      recordConfigAction(metrics, "update_apply", { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "update_failed", message: error.message } });
    }
  });
  app.get("/api/settings", (req, res) => res.json(settingsPayload(services)));
  app.post("/api/settings", mutateConfig, async (req, res) => {
    const body = req.body || {};
    const updates = {};
    const providers = [];
    let failedProvider = null;
    try {
      // Config objects built by tests (and any future non-loadConfig wiring)
      // may lack the tokens map; the settings write must still work.
      config.tokens = config.tokens || {};
      if (body.opencodeGoToken) {
        const token = String(body.opencodeGoToken).trim();
        providers.push("opencode-go");
        if (isPlaceholderToken(token)) {
          const error = new Error("A valid OpenCode Go token is required.");
          error.code = "invalid_opencode_go_token";
          throw error;
        }
        updates.OPENCODE_GO_TOKEN = token;
      }
      if (body.deepseekApiKey) {
        const token = String(body.deepseekApiKey).trim();
        providers.push("deepseek-official");
        const checked = validateProviderToken("deepseek-official", token);
        if (!checked.ok) throw Object.assign(new Error(checked.error), { code: "invalid_deepseek_api_key" });
        if (isPlaceholderToken(token)) {
          const error = new Error("A valid DeepSeek API key is required.");
          error.code = "invalid_deepseek_api_key";
          throw error;
        }
        updates.DEEPSEEK_API_KEY = checked.value;
      }
      if (body.exaApiKey) {
        const checked = validateProviderToken("exa", body.exaApiKey);
        if (!checked.ok) throw Object.assign(new Error(checked.error), { code: "invalid_exa_api_key" });
        // Deferred into the shared updates write: EXA_API_KEY must land in the
        // same atomic writeEnvFile call as the provider tokens, so a rejected
        // provider probe never leaves a partially-updated .env behind.
        updates.EXA_API_KEY = checked.value;
      }
      if (Object.keys(updates).length) {
        for (const [envKey, provider, label] of [
          ["OPENCODE_GO_TOKEN", "opencode-go", "OpenCode Go"],
          ["DEEPSEEK_API_KEY", "deepseek-official", "DeepSeek"],
        ]) {
          if (!updates[envKey]) continue;
          try {
            await probeSettingsToken(config, provider, updates[envKey]);
          } catch (error) {
            const detail = error instanceof CustomEndpointError ? error.message : String(error.message || error);
            const wrapped = new Error(`${label} rejected this token: ${detail}`);
            wrapped.code = `token_rejected_${provider}`;
            failedProvider = provider;
            throw wrapped;
          }
        }
        writeEnvFile(updates, config.envFile);
        config.tokens["opencode-go"] = updates.OPENCODE_GO_TOKEN || config.tokens["opencode-go"];
        if (updates.OPENCODE_GO_TOKEN) {
          // The per-provider map is the single token source; only the audit
          // "where did it come from" hint needs updating in-session.
          config.goTokenSource = "configured";
        }
        config.tokens["deepseek-official"] = updates.DEEPSEEK_API_KEY || config.tokens["deepseek-official"];
        if (updates.EXA_API_KEY) config.exaApiKey = updates.EXA_API_KEY;
      }
      recordSettingsEvent({ providers, ok: true, filePath: config.settingsEventsFile });
      recordConfigAction(metrics, "settings_update", { ok: true });
      return res.json(settingsPayload(services));
    } catch (error) {
      const errorProviders = failedProvider ? [failedProvider] : providers;
      recordSettingsEvent({ providers: errorProviders, ok: false, error: error.code || "settings_failed", filePath: config.settingsEventsFile });
      recordConfigAction(metrics, "settings_update", { ok: false, error: error.message });
      const status = error.code?.startsWith("invalid_") || error.code?.startsWith("token_rejected_") ? 400 : 500;
      return res.status(status).json({ error: { type: error.code || "settings_failed", message: error.message } });
    }
  });

  function customErrorPayload(error) {
    const code = error instanceof CustomEndpointError || error instanceof OllamaError ? error.code : "upstream";
    return { error: { type: code, message: error.message } };
  }

  // Dashboard "Custom model" flow: list the models a user endpoint advertises,
  // then Add runs a Responses probe before persisting the provider.
  app.post("/api/custom/list-models", mutateConfig, async (req, res) => {
    const { baseUrl, apiKey } = req.body || {};
    try {
      const result = await listEndpointModels({ baseUrl, apiKey });
      return res.json(result);
    } catch (error) {
      return res.status(400).json(customErrorPayload(error));
    }
  });

  app.post("/api/custom/add", mutateConfig, async (req, res) => {
    const { baseUrl, apiKey, modelId, asMain, asVision } = req.body || {};
    try {
      const model = String(modelId || "").trim();
      if (!model) throw new CustomEndpointError("model", "A model id is required.");
      if (!String(apiKey || "").trim()) throw new CustomEndpointError("key", "An API key is required.");
      const probe = await probeCustomResponses({ baseUrl, apiKey, modelId: model });
      // Advertised context window (llama.cpp meta.n_ctx) so compaction limits
      // match the real backend instead of the 250K custom fallback.
      const listed = await listEndpointModels({ baseUrl, apiKey });
      const advertisedContext = listed.models.find((m) => m.id === model)?.contextWindow || 0;
      const qualified = `${model}${PROVIDER_SEPARATOR}custom`;
      const updates = {
        MODELDOCK_CUSTOM_BASE_URL: normalizeBaseUrl(baseUrl),
        MODELDOCK_CUSTOM_API_KEY: apiKey,
        MODELDOCK_CUSTOM_MODEL: model,
        MODELDOCK_CUSTOM_CONTEXT_WINDOW: advertisedContext ? String(advertisedContext) : "",
        MODELDOCK_CUSTOM_MAIN: asMain ? "1" : "0",
        MODELDOCK_CUSTOM_VISION: asVision ? "1" : "0",
      };
      // The Main/Vision toggles mark what this endpoint may be USED FOR - they do
      // not hijack the live selection. MODELDOCK_CUSTOM_MAIN/VISION above already
      // record that: CUSTOM_VISION drives supportsVision (so the model shows up in
      // the vision picker) and CUSTOM_MAIN is the boot fallback when no main model
      // is configured. Overwriting MODELDOCK_MAIN_MODEL/VISION_MODEL here made
      // merely adding an endpoint replace whatever the user was already running.
      // Only the un-toggle case still writes: a selection pointing at this model
      // must not dangle once the endpoint is no longer offered for that role.
      if (!asMain && (config.mainModel || "") === qualified) updates.MODELDOCK_MAIN_MODEL = "";
      if (!asVision && (config.visionModel || "") === qualified) updates.MODELDOCK_VISION_MODEL = "";
      writeEnvFile(updates, config.envFile);
      config.customBaseUrl = updates.MODELDOCK_CUSTOM_BASE_URL;
      config.customApiKey = apiKey;
      config.customModel = model;
      config.customContextWindow = advertisedContext;
      config.customMain = Boolean(asMain);
      config.customVision = Boolean(asVision);
      config.tokens.custom = apiKey;
      applyCustomProfile(config);
      // Mirror the un-toggle cleanup above into the live selection so a role this
      // endpoint no longer fills does not keep pointing at it.
      if (!asMain && config.mainModel === qualified) {
        config.mainModel = "";
        services.modelSelection.mainModel = "";
      }
      if (!asVision && config.visionModel === qualified) {
        config.visionModel = "";
        services.modelSelection.visionModel = "";
      }
      // Rewrite the catalog file so the Codex picker sees the model immediately
      // instead of waiting for the next hourly refresh.
      services.writeCatalogFile?.();
      recordConfigAction(metrics, "custom_add", { ok: true, model });
      return res.json({
        ok: true,
        model,
        usage: probe.usage,
        endpoint: probe.endpoint,
        responsesUrl: probe.responsesUrl,
        settings: settingsPayload(services),
      });
    } catch (error) {
      recordConfigAction(metrics, "custom_add", { ok: false, error: error.message });
      return res.status(400).json(customErrorPayload(error));
    }
  });

  // Dashboard "Ollama (local)" flow: one click lists every chat-capable local
  // model (/api/tags), probes the Responses protocol, snapshots the list to disk
  // and publishes the models as one more provider option. Reconnect refreshes;
  // restart restores the snapshot. Connecting never rewrites the main or vision
  // model: Ollama stays a candidate provider and the user picks it explicitly.
  app.post("/api/ollama/connect", mutateConfig, async (req, res) => {
    const { baseUrl } = req.body || {};
    try {
      const result = await listOllamaModels({ baseUrl });
      if (!result.models.length) {
        throw new OllamaError("models", "Ollama returned no chat-capable models. Pull one first (ollama pull <model>).");
      }
      // Prove the Responses dialect before persisting so an old Ollama (< 0.13.3)
      // fails the connect with readable guidance instead of a silent 404 later.
      await probeOllamaResponses({ baseUrl: result.endpoint, modelId: result.models[0].upstreamId });
      const snapshot = { baseUrl: result.endpoint, connectedAt: new Date().toISOString(), models: result.models };
      writeOllamaSnapshot(services.ollamaSnapshotFile, snapshot);
      applyOllamaProfile(config, snapshot);
      config.ollamaBaseUrl = result.endpoint;
      services.writeCatalogFile?.();
      recordConfigAction(metrics, "ollama_connect", { ok: true, models: result.models.length });
      return res.json({
        ok: true,
        connected: true,
        baseUrl: result.endpoint,
        models: result.models,
        responsesUrl: result.responsesUrl,
        settings: settingsPayload(services),
      });
    } catch (error) {
      recordConfigAction(metrics, "ollama_connect", { ok: false, error: error.message });
      return res.status(400).json(customErrorPayload(error));
    }
  });

  app.post("/api/ollama/disconnect", mutateConfig, async (req, res) => {
    try {
      clearOllamaSnapshot(services.ollamaSnapshotFile);
      applyOllamaProfile(config, null);
      config.ollamaBaseUrl = OLLAMA_DEFAULT_BASE;
      // A disconnected provider cannot serve its models: clear main/vision when
      // they pointed at an Ollama model.
      const updates = {};
      if (providerForModel(config, config.mainModel) === "ollama") {
        updates.MODELDOCK_MAIN_MODEL = "";
        config.mainModel = "deepseek-v4-flash@opencode-go";
        services.modelSelection.mainModel = config.mainModel;
        services.configSwitcher.model = config.mainModel;
      }
      if (providerForModel(config, config.visionModel) === "ollama") {
        updates.MODELDOCK_VISION_MODEL = "";
        config.visionModel = "";
        services.modelSelection.visionModel = "";
      }
      if (Object.keys(updates).length) writeEnvFile(updates, config.envFile);
      services.writeCatalogFile?.();
      recordConfigAction(metrics, "ollama_disconnect", { ok: true });
      return res.json({ ok: true, connected: false, settings: settingsPayload(services) });
    } catch (error) {
      recordConfigAction(metrics, "ollama_disconnect", { ok: false, error: error.message });
      return res.status(400).json(customErrorPayload(error));
    }
  });

  const eventClients = new Set();
  const broadcast = () => {
    const data = `data: ${JSON.stringify(statusPayload(services))}\n\n`;
    for (const client of [...eventClients]) {
      try {
        if (client.writableEnded || client.destroyed) {
          eventClients.delete(client);
          continue;
        }
        client.write(data);
      } catch {
        eventClients.delete(client);
      }
    }
  };
  metrics.on("change", broadcast);
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    eventClients.add(res);
    res.write(`data: ${JSON.stringify(statusPayload(services))}\n\n`);
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      eventClients.delete(res);
    });
  });

  serveInlineStatic(app);
  app.use(express.static(publicDir, { extensions: ["html"], maxAge: 0 }));
  app.use("/assets", express.static(assetsDir, { maxAge: "7d" }));
  app.use((req, res) => res.status(404).json({ error: { message: "Not found" } }));

  // Outer wrapper so the zstd decoder runs BEFORE the MCP app's body parser
  // (which is registered inside createMcpExpressApp and cannot be reordered).
  const outer = express();
  outer.disable("x-powered-by");
  outer.use(zstdRequestDecoder(services.callerKey));
  outer.use(app);
  return { app: outer, close: () => mcpHandler.close?.(), services };
}

// New installs, and every version change (reinstall or self-update), default to
// login autostart ON. The marker records both the decision and the version that
// made it: within the same version an explicit off stays off across restarts,
// and re-enabling happens at most once per version, so the dashboard toggle
// keeps working and nothing re-registers repeatedly. Safe to call repeatedly.
export async function initAutostartDefault(autostart, {
  stateDir = path.join(os.homedir(), ".modeldock"),
  markName = "autostart-initialized",
  version = localVersion(),
} = {}) {
  if (!autostart?.supported?.()) return false;
  await autostart.refresh?.().catch(() => {});
  const mark = path.join(stateDir, markName);
  const current = String(version || "").trim();
  let recorded = "legacy";
  try {
    recorded = String(JSON.parse(await readFile(mark, "utf8"))?.version || "");
  } catch {
    // Missing marker: first run. Legacy (timestamp-only) marker: predates
    // version tracking. Both count as "not yet decided for this version".
  }
  if (current === "") {
    // No version to compare against (e.g. a bundle built without the version
    // define and no package.json): keep the historical one-shot behavior.
    try {
      await access(mark);
      return false;
    } catch {
      // First run: fall through and enable once.
    }
  } else if (recorded === current) {
    return false; // Same version: the marker reflects the user's current state.
  }
  try {
    if (!autostart.enabled?.()) {
      const result = await autostart.setEnabled(true);
      if (!result?.enabled) return false;
    }
    await mkdir(stateDir, { recursive: true });
    await writeFile(mark, `${JSON.stringify({ at: new Date().toISOString(), version: current })}\n`, "utf8");
    console.log("[modeldock] autostart initialized (default: on)");
    return true;
  } catch (error) {
    console.warn(`[modeldock] autostart default-on failed: ${error.message}`);
    return false;
  }
}

export async function startServer(config = loadConfig()) {
  const instance = createApp(createServices(config));
  // Tests opt out with autostartDefault: false so they never touch the real
  // registry or the real ~/.modeldock state file.
  if (config.autostartDefault !== false) {
    initAutostartDefault(instance.services.autostart).catch(() => {});
  }
  const server = await new Promise((resolve, reject) => {
    const listener = instance.app.listen(config.port, config.host, () => resolve(listener));
    // Codex desktop first attempts a Responses WebSocket (ws://127.0.0.1:<port>/...
    // /v1/responses) for sampling and remote compaction v2. This gate is HTTP-only:
    // decline every upgrade with 426 so Codex falls back to HTTP immediately instead
    // of treating a 404 as a retryable failure and burning 5 backoff retries per turn
    // (same shape codex-router uses; verified against Codex's responses_retry logs).
    listener.on("upgrade", (_request, socket) => {
      socket.on("error", () => {});
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    listener.once("error", reject);
  });
  return {
    ...instance,
    server,
    url: `http://${urlHost(config.host)}:${config.port}`,
    async stop() {
      await instance.close();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  // One-time: encrypt any plaintext secrets in .env (backs up first, non-destructive).
  const migration = migrateEnvSecrets();
  if (migration.migrated > 0) {
    console.log(`Encrypted ${migration.migrated} secret(s) in ${migration.file} (backup: ${migration.backup})`);
  }
  const instance = await startServer();
  // Record port ownership so restart.ps1 and future instances can tell whose
  // process holds the port (we have shipped stale code from a lookalike
  // instance before). A conflict only warns: the listen already succeeded.
  const ownerConflict = describeOwnerConflict(instance.services.config.port, path.resolve(dirname, ".."));
  if (ownerConflict) console.warn(`WARNING: ${ownerConflict.message}`);
  writeOwnerFile(instance.services.config.port, { root: path.resolve(dirname, "..") });
  console.log(`ModelDock OpenCode Go gate listening at ${instance.url}`);
  console.log(`Dashboard: ${instance.url}/`);
  console.log(`Responses: ${instance.url}/v1/responses`);
  console.log("MCP: caller-key-protected endpoint configured for Codex");
  const missingTokens = Object.entries(instance.services.config.tokens || {})
    .filter(([, token]) => !token)
    .map(([provider]) => provider);
  if (missingTokens.length) console.warn(`Tokens missing for provider(s): ${missingTokens.join(", ")}; the dashboard is available but those upstream calls will return 503.`);

  const shutdown = async () => {
    clearOwnerFile(instance.services.config.port);
    await instance.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

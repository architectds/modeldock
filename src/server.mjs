import path from "node:path";
import os from "node:os";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import zlib from "node:zlib";
import { Decompress as ZstdFallbackDecoder } from "fzstd";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { ownsEnvFile, parseEnvFile, loadConfig, publicConfig, writeEnvFile, envFileFor, migrateEnvSecrets, isPlaceholderToken, envOff } from "./config.mjs";
import { catalogFor } from "./catalog.mjs";
import { nativeModelSlugs, readNativeCatalog, refreshNativeCatalog } from "./native-catalog.mjs";
import { MediaStore } from "./media-store.mjs";
import { Metrics } from "./metrics.mjs";
import { NATIVE_IMAGE_PATHS, relayNativeImage, relayResponses as relayGatewayResponses } from "./gateway.mjs";
import { createUpstreams } from "./upstreams.mjs";
import { createMcpNodeHandler } from "./mcp.mjs";
import { memoryStoreFor } from "./memory.mjs";
import { CodexConfigSwitcher, SUBAGENT_AGENT_FILE } from "./config-switcher.mjs";
import { createAutostart } from "./autostart.mjs";
import { createUpdater, localVersion } from "./update.mjs";
import { createDerivedFallback } from "./derived-fallback.mjs";
import { clearOwnerFile, describeOwnerConflict, writeOwnerFile } from "./instance-owner.mjs";
import { CALLER_PATH_PREFIX, callerBasePath, callerKeyEqual, callerRootPath, loadOrCreateCallerKey } from "./caller-key.mjs";
import { SessionNames } from "./session-names.mjs";
import { validateProviderToken } from "./token-validate.mjs";
import { RouteAffinity } from "./router.mjs";
import { applyXaiProfile, allProfiles, PROVIDER_SEPARATOR, applyCustomProfile, effectiveContextWindow, applyLocalEngineProfile, applyOllamaProfile, bareModelId, profileOptions, profileById, providerForModel, publishedSlugFor, tokenFor } from "./profiles.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";
import { CustomEndpointError, listEndpointModels, normalizeBaseUrl, probeCustomResponses } from "./custom-endpoint.mjs";
import { LEGACY_CUSTOM_ENV_KEYS, migrateLegacyCustomEndpoint, CustomEndpointsError, addCustomEndpoint, customEndpointFor, customEndpointsPath, readCustomEndpoints, removeCustomEndpoint, writeCustomEndpoints } from "./custom-endpoints.mjs";
import { OLLAMA_DEFAULT_BASE, OllamaError, clearOllamaSnapshot, listOllamaModels, normalizeOllamaBase, ollamaSnapshotPath, probeOllamaResponses, readOllamaSnapshot, writeOllamaSnapshot } from "./ollama.mjs";
import { usageEventsPath } from "./usage-events.mjs";
import { applyContextOverrides, contextOverridesPath, readContextOverrides, validateContextWindow, writeContextOverrides } from "./context-overrides.mjs";
import { isModelPublished, modelTogglesPath, readModelToggles, selectedModelSlugs, writeModelToggles } from "./model-toggles.mjs";
import { modelsToPark, shouldTidy, stampFirstSeen } from "./model-tidy.mjs";
import { modelLifecyclePath, readLifecycle, writeLifecycle } from "./model-lifecycle-state.mjs";
import { foldUsageFile, readRollup, rollupTotals, usageRollupPath, writeRollup } from "./usage-rollup.mjs";
import { estimateVramBudget, kvBytesPerToken, maxContextFor, CONTEXT_LADDER, KV_ELEMENT_BYTES, MINIMUM_HEADROOM_BYTES, RECOMMENDED_HEADROOM_BYTES } from "./gguf.mjs";
import { primaryGpu, probeGpus, usableBytesOf } from "./gpu.mjs";
import { applyLaunchOverrides, tokenizeCommandLine } from "./engine-processes.mjs";
import { launchSpecForPort, rememberedLaunch, ENGINE_LABELS as LOCAL_ENGINE_LABELS, CONNECTABLE_ENGINES, readLocalEnginesSnapshot, LocalEngineError, assertLocalBase, clearLocalEngineSnapshot, discoverLocalEngines, localEnginesSnapshotPath, writeLocalEngineSnapshot } from "./local-engines.mjs";
import { XAI_API_BASE, XaiAuthError, accessTokenExpired, clearXaiAuth, listXaiModels, pollDeviceToken, readXaiAuth, refreshAccessToken, startDeviceAuthorization, writeXaiAuth, xaiAuthPath } from "./xai-auth.mjs";
import { recordSettingsEvent } from "./settings-events.mjs";
import { stateDir as resolveStateDir, stateFile } from "./state-dir.mjs";
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
    // originalUrl, not req.path: an app.use("/assets", fn) mount rewrites
    // req.path to the mount-relative form (/icon.png), which made the prefix
    // slice land mid-filename and every inlined asset 404. originalUrl keeps
    // the full path in both mounted and unmounted routes.
    const rel = req.originalUrl.split("?")[0].slice(stripPrefix.length).replace(/^\/+/, "");
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

// Two local engine addresses name the same server. Compared by host and port
// because the stored form carries the /v1 the Responses dialect lives under and
// the discovered form does not, so the strings never match even when the server
// does.
function sameLocalHost(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
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
  for (const id of [config.mainModel, config.visionModel]) {
    if (!id) continue;
    const owner = providerForModel(config, id);
    if (!enabledProviders(config).some((provider) => provider.id === owner)) continue;
    const known = profileById(owner)?.availableModels?.find((model) => model.id === bareModelId(id));
    if (!known || known.status === "unavailable" || known.endpoint === "chat") continue;
    const resolved = publishedSlugFor(owner, known);
    if (all.some((existing) => existing.id === resolved)) continue;
    all.push({ ...withTierLabel(known), id: resolved, provider: owner });
  }
  return appendNativeModels(all, config);
}

// One published model set, shared by every picker: the routed profiles plus
// the native GPT catalog while signed in. Without a sign-in the native backend
// would 401 on every call, so native models stay out (every picker fails
// closed). input_modalities carries vision support, so the vision picker's
// supportsVision filter picks the right native entries.
function appendNativeModels(options, config) {
  if (!hasChatGptLogin(config.codexHome)) return options;
  for (const model of readNativeCatalog(config)?.models || []) {
    if (typeof model?.slug !== "string" || !model.slug) continue;
    if (options.some((entry) => entry.id === model.slug)) continue;
    options.push({
      id: model.slug,
      label: model.display_name || model.slug,
      provider: "openai",
      native: true,
      supportsVision: Array.isArray(model.input_modalities) && model.input_modalities.includes("image"),
      // The native catalog states its own window; dropping it here left these
      // models inheriting our 250,000 fallback while Codex used the real one.
      // Same override the catalog file honours, so the page and the file
      // cannot disagree about a number the page lets you edit.
      contextWindow: Number(config.contextOverrides?.[model.slug])
        || Number(model.context_window) || undefined,
      contextSource: config.contextOverrides?.[model.slug]
        ? "user"
        : (Number(model.context_window) > 0 ? "native" : ""),
    });
  }
  return options;
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
    // A keyless engine has no credential to check, so "connected" is the only
    // test that means anything: it publishes once it has models. Naming Ollama
    // here would have needed a new line per local engine.
    const profile = profileById(entry.id);
    if (!profile?.tokenEnvName) return Boolean(profile?.availableModels?.length);
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

// Vision is cross-provider, but only across providers that can actually serve
// requests once the new main provider is active. The old active profile can
// remain enabled until the switch lands, so filter out providers that would
// lose their "active" pass without a configured token.
function visionOptionsAcrossProviders(config, providerId) {
  return modelOptions(config, providerId).filter((model) =>
    model.supportsVision && (model.provider === providerId || providerTokenConfigured(config, model.provider))
  );
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
  // Vision is deliberately cross-provider, so the pick the user is already on
  // outranks whatever the new main provider happens to catalog: keeping it only
  // when it shared a provider silently swapped a deliberate choice on every
  // main-provider switch. A pick no enabled provider can serve falls back to
  // this provider's own vision model, then to any enabled provider's.
  const servableVision = visionOptionsAcrossProviders(config, providerId);
  const visionOwner = providerForModel(config, modelSelection.visionModel);
  const visionBare = bareModelId(modelSelection.visionModel);
  const vision = (modelSelection.visionModel
    && servableVision.find((entry) => entry.provider === visionOwner && bareModelId(entry.id) === visionBare))
    || servableVision.find((entry) => entry.provider === providerId)
    || servableVision[0]
    || null;
  return {
    providerId,
    profile: profileById(providerId),
    mainModel: publishedSlugFor(providerId, main),
    visionModel: vision?.id || "",
  };
}

function modelsPayload(services) {
  const options = modelOptions(services.config, services.config.profileId);
  const selected = services.modelSelection;
  const visionOptions = options.filter((entry) => entry.supportsVision);
  const visionProviders = providerOptions(services.config).filter((provider) => visionOptions.some((model) => model.provider === provider.id));
  // Native vision models are only published while signed in; without their
  // provider in the list the vision picker can see the models but never pick
  // one. The native provider is not a routed profile, so it is appended here
  // rather than in providerOptions (which would leak it into non-vision lists).
  if (visionOptions.some((model) => model.provider === "openai")) visionProviders.push(NATIVE_PROVIDER);
  return {
    selected,
    options,
    providers: providerOptions(services.config),
    // Derive the provider from the model actually selected, the same way the
    // vision and subagent pickers do. Reporting config.profileId here let the two
    // drift apart: selecting a custom/ollama model as main updates mainModel but
    // never touches profileId, so the dashboard rendered impossible pairs of
    // a provider and a model. profileId remains the fallback for a model the
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
// One spelling, shared with the disable() path that has to remove it.
const SUBAGENT_FILE_NAME = SUBAGENT_AGENT_FILE;
// The built-in native ChatGPT provider, shared by the subagent and vision
// pickers: one spelling, one label, everywhere it is offered.
const NATIVE_PROVIDER = { id: "openai", label: "ChatGPT (native)" };

function subagentModelOptions(config) {
  // The published model set already includes native GPT slugs while signed in
  // (modelOptions -> appendNativeModels); the subagent picker is that same set.
  return modelOptions(config, config.profileId);
}

function subagentProviders(config) {
  const providers = providerOptions(config).map((entry) => ({ id: entry.id, label: entry.label }));
  if (hasChatGptLogin(config.codexHome)) providers.push(NATIVE_PROVIDER);
  return providers;
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
    selectedProvider: selectedEntry?.provider || options[0]?.provider || NATIVE_PROVIDER.id,
  };
}

// The VRAM ledger for one discovered engine: what its current configuration
// costs against the card it is running on. Both the row summary and the drawer
// read this one object, so the two can never disagree about a number.
//
// Absent pieces degrade to null rather than to a guess - no model facts (an
// engine we could not attribute) or no card (a probe that failed) simply means
// no ledger for that row, not a made-up one.
// Settings that are present and doing nothing. Class 4 in 16.6: not a slower
// configuration but a silently wrong one, where the flag is in the command
// line, the behaviour is absent, and the only evidence is one line of engine
// log nobody reads.
//
// Keyed on what actually decides each case rather than on the vendor. Context
// shifting is refused because a hybrid model's recurrent layers hold state
// with no per-token KV to slide - verified on this machine by reproducing the
// warning with -ngl 0, where no GPU is involved at all, so it is the
// architecture and not the backend. Guarding it as an AMD quirk would have
// missed it on NVIDIA and fired wrongly for dense models on AMD.
function engineWarnings(engine) {
  const warnings = [];
  const launch = engine?.launch;
  const facts = engine?.modelFacts;
  if (!launch || !facts) return warnings;
  if (launch.contextShift && facts.hybrid) {
    warnings.push({ code: "context_shift_ineffective" });
  }
  // KV quantization is broken on this AMD stack, and a broken cache is wrong
  // answers rather than slow ones.
  if ((launch.cacheTypeK || launch.cacheTypeV) && engine?.vram?.card?.vendor === "amd") {
    warnings.push({ code: "kv_quant_unsupported" });
  }
  // The weights carry MTP blocks the running backend ignores; the log says so
  // once at load and never again.
  if (facts.blockCount > facts.layers && /vulkan/i.test(String(engine?.binary || ""))) {
    warnings.push({ code: "mtp_ignored" });
  }
  return warnings;
}

function vramLedgerFor(engine, gpus) {
  const facts = engine?.modelFacts;
  const contextTokens = Number(engine?.launch?.ctxSize) || 0;
  if (!facts?.kvBytesPerToken || !contextTokens) return null;
  const card = primaryGpu(gpus, { mainGpu: Number(engine?.launch?.mainGpu) });
  // What an allocator can actually reach, not what the card physically has -
  // budgeting against the raw capacity overstates headroom by most of a
  // gigabyte and recommends a context that gets evicted.
  const cardBytes = usableBytesOf(card);
  const budget = estimateVramBudget({ shape: facts, weightsBytes: facts.fileBytes, contextTokens, cardBytes });
  return {
    ...budget,
    contextTokens,
    card: card ? { name: card.name, vendor: card.vendor, totalBytes: cardBytes, capacityBytes: card.totalBytes } : null,
    // Everything a slider needs to recompute the budget as it moves, so
    // dragging is arithmetic in the page rather than a round trip per pixel.
    perTokenByKv: Object.fromEntries(Object.keys(KV_ELEMENT_BYTES).map((kv) => [kv, kvBytesPerToken(facts, kv)])),
    recommendedHeadroom: RECOMMENDED_HEADROOM_BYTES,
    minimumHeadroom: MINIMUM_HEADROOM_BYTES,
    trainedContext: facts.trainedContext || 0,
    contextLadder: CONTEXT_LADDER.filter((rung) => !facts.trainedContext || rung <= facts.trainedContext),
    // What it should be instead, so a tight configuration comes with an answer
    // rather than only a complaint.
    recommendedContext: cardBytes ? maxContextFor({ shape: facts, weightsBytes: facts.fileBytes, cardBytes }) : 0,
    // How far the slider may be dragged: past the recommendation, but not past
    // the point where the configuration certainly fails.
    maxContext: cardBytes
      ? maxContextFor({ shape: facts, weightsBytes: facts.fileBytes, cardBytes, headroomBytes: MINIMUM_HEADROOM_BYTES })
      : 0,
  };
}

function statusPayload(services) {
  const { config, metrics, mediaStore, routeAffinity, modelSelection, autostart, updater } = services;
  // Real conversations have a Codex rollout file; one-shot background calls
  // (vision probes, native subagent flashes) do not. The dashboard hides the
  // latter by showing only sessions that resolve to a readable name.
  const sessionNames = {};
  if (services.sessionNames) {
    const seen = new Set();
    for (const record of metrics.recent) {
      if (record.sessionId) seen.add(record.sessionId);
    }
    for (const id of seen) {
      const info = services.sessionNames.labelFor(id);
      if (info?.label) sessionNames[id] = info.label;
    }
  }
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
    sessionNames,
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
      asVision: Boolean(config.customVision),
      // The whole list, so the API page renders every endpoint rather than
      // the first one. Keys never leave the machine: only whether one is set.
      endpoints: (config.customEndpoints || []).map((entry) => ({
        modelId: entry.modelId,
        baseUrl: entry.baseUrl,
        contextWindow: entry.contextWindow,
        supportsVision: entry.supportsVision,
      providerId: entry.providerId || "custom",
        apiKeyConfigured: Boolean(entry.apiKey),
      })),
    },
    ollama: {
      baseUrl: config.ollamaBaseUrl || OLLAMA_DEFAULT_BASE,
      connected: ollamaConnected,
      canRestart: Boolean(readOllamaSnapshot(services.ollamaSnapshotFile)?.launch?.binary),
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
    // The signed-in subscription, reported like any other provider so the page
    // does not have to ask a second endpoint what state it is in.
    xai: (() => {
      const auth = readXaiAuth(services.xaiAuthFile || xaiAuthPath());
      return {
        connected: Boolean(auth?.accessToken),
        models: auth?.models || [],
        connectedAt: auth?.connectedAt || "",
        expiresAt: auth?.expiresAt || 0,
      };
    })(),
    local: Object.fromEntries(CONNECTABLE_ENGINES.map((id) => {
      const profile = profileById(id);
      return [id, {
        baseUrl: profile.baseUrl,
        connected: Boolean(profile.availableModels?.length),
        // Drives a control that is hidden when there is nothing to replay.
        canRestart: Boolean(rememberedLaunch(id, services.localEnginesFile || localEnginesSnapshotPath())),
        models: (profile.availableModels || []).map((model) => ({
          id: model.id,
          label: model.label || model.id,
          supportsVision: Boolean(model.supportsVision),
          contextWindow: model.contextWindow || null,
        })),
      }];
    })),
    models: {
      mainModel: modelSelection?.mainModel || config.mainModel,
      visionModel: modelSelection?.visionModel || config.visionModel,
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
  const baseUrl = profile.baseUrlFor(config, profile.availableModels?.[0]?.id || "");
  const model = profile.availableModels?.[0]?.id || config.mainModel;
  return probeCustomResponses({ baseUrl, apiKey: token, modelId: model });
}

function configMutationGuard(config, callerKey) {
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
    // Browsers always send Origin, so a local web page is covered above. A
    // non-browser local caller (curl, scripts) sends no Origin; require the
    // caller capability key when enforcement is on so the dashboard's same-origin
    // path stays open while nothing unauthenticated can drive config writes.
    if (!origin && isCallerKeyEnforced()) {
      const supplied = req.get("x-modeldock-key") || "";
      if (!callerKeyEqual(supplied, callerKey)) {
        return res.status(401).json({ error: { type: "caller_key_required", message: "This config endpoint requires the caller key; pass x-modeldock-key." } });
      }
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

// A route whose only failure mode is "it threw". Eight handlers each wrapped
// their body in the same try/catch that turned any error into a 500 carrying a
// fixed type, which buried the two lines that actually did the work. The handler
// returns its JSON body and this adds the envelope.
function jsonRoute(errorType, handler) {
  return async (req, res) => {
    try {
      return res.json(await handler(req, res));
    } catch (error) {
      return res.status(500).json({ error: { type: errorType, message: error.message } });
    }
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

// The dashboard's view of the same question the relay asks. It had its own
// if-chain and disagreed with the relay about Ollama, so the address shown
// was not the address used.
function upstreamBaseForModel(config, model) {
  return profileById(providerForModel(config, model)).baseUrlFor(config, model);
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
  // Was deepseek-or-OpenCode only, so probing a custom or local vision model
  // sent its image to OpenCode Go.
  const base = profileById(provider).baseUrlFor(config, modelId);
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
  // Opt-in, as the comment above says: a config that simply omits the key (a test
  // fixture, an embedder) must not start probing upstreams. `=== false` only
  // behaved that way because loadConfig always fills a boolean in.
  if (!config.modelProbeEnabled) return;
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
  const derivedFallback = createDerivedFallback();
  const services = {};
  const memoryStore = memoryStoreFor(mutableConfig);
  const upstreams = createUpstreams({
    config: mutableConfig,
    metrics,
    mediaStore,
    memoryStore,
    getVisionModel: () => modelSelection.visionModel,
    // A getter, not the Set: nativeSlugs is built below (the native catalog is
    // read after upstreams exists) and is cleared and refilled in place on every
    // catalog refresh, so upstreams must read it per call, not capture it once.
    getNativeSlugs: () => nativeSlugs,
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
  // Same redirect as the catalog: a test config that isolates one isolates both,
  // and the writer below orders the picker from it.
  const rollupFile = mutableConfig.usageRollupFile || usageRollupPath();
  // Resolved once and published on services, so the boot-time tidy and the
  // endpoint that edits the same file can never disagree about which file it is.
  const togglesFile = mutableConfig.modelTogglesFile || modelTogglesPath();
  const lifecycleFile = mutableConfig.modelLifecycleFile || modelLifecyclePath();
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
    // A view of the live selection, not a snapshot: Codex's own picker changes
    // modelSelection without going through this switcher, and a stored copy then
    // wrote the stale model into config.toml on the next enable.
    model: () => modelSelection.mainModel,
    // Read at enable time, not construction: sign-in state changes what the
    // native catalog holds, and enable() uses this to pick the one model Codex
    // can always start on. Routed slugs never go into config.toml's top-level
    // model - they exist only in the published catalog, so writing one there
    // makes Codex startup depend on ModelDock being healthy.
    nativeModels: () => [...nativeModelSlugs(mutableConfig)],
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
        // Read fresh rather than taken from services: the agent file is edited
        // from the dashboard, and a model the gateway is pointed at is published
        // whatever the toggles say.
        subagentModel: readSubagentModel(mutableConfig),
        // Picker order. Read here rather than held on the config because the
        // file is folded on its own schedule, and a catalog written after a
        // fold should carry the order that fold implies.
        usageByModel: rollupTotals(readRollup(rollupFile)),
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
  // The weekly tidy. At boot rather than on a timer: a gateway that runs for a
  // month should tidy four times, not once, and one that is only started on
  // Mondays should still tidy - which a scheduled day of the week would miss.
  //
  // Every model currently in the published set gets its first-seen stamp on the
  // way past, so a model added today starts its thirty days today rather than
  // inheriting the window's.
  const runModelTidy = (now = Date.now()) => {
    try {
      const lifecycle = readLifecycle(lifecycleFile);
      const models = modelOptions(mutableConfig, mutableConfig.profileId)
        .filter((entry) => !entry.status || entry.status === "available");
      const stamped = stampFirstSeen(lifecycle.firstSeen, models, now);
      const rollup = readRollup(rollupFile);
      const decision = shouldTidy({ lastTidyAt: lifecycle.lastTidyAt, rollup, now });
      if (!decision.run) {
        if (stamped.changed) writeLifecycle(lifecycleFile, { ...lifecycle, firstSeen: stamped.firstSeen });
        return { ...decision, parked: [] };
      }
      const toggles = readModelToggles(togglesFile);
      const parked = modelsToPark({
        models,
        rollup,
        toggles,
        selected: selectedModelSlugs(mutableConfig, readSubagentModel(mutableConfig)),
        firstSeen: stamped.firstSeen,
        now,
      });
      for (const slug of parked) toggles[slug] = false;
      if (parked.length) {
        writeModelToggles(togglesFile, toggles);
        mutableConfig.modelToggles = toggles;
        writeCatalogFile();
      }
      writeLifecycle(lifecycleFile, { lastTidyAt: new Date(now).toISOString(), firstSeen: stamped.firstSeen });
      if (parked.length) {
        console.log(`[gate] model tidy: ${parked.length} unused for 30 days, removed from the Codex picker (${parked.join(", ")})`);
      }
      return { ...decision, parked };
    } catch (error) {
      // Housekeeping must never stop a gateway from starting.
      console.log(`[gate] model tidy skipped: ${error.message}`);
      return { run: false, reason: "error", parked: [] };
    }
  };

  // The periodic pass: refresh the model list, then tidy what it leaves. The
  // tidy has to be on this timer and not only at boot - the gateways that most
  // need it are the ones left running for weeks, and a boot-only tidy never
  // fires on those at all. Running it daily costs nothing, because the weekly
  // guard inside it decides whether this call does any work.
  //
  // After the refresh rather than beside it: a model that arrived in this pass
  // should get its first-seen stamp before anything reasons about its age.
  const runScheduledMaintenance = () => refreshModelCatalog().then(
    () => runModelTidy(),
    () => runModelTidy(),
  );

  // Write once at boot so the file exists even when the refresh is disabled or fails.
  writeCatalogFile();
  runModelTidy();
  refreshModelCatalog();
  const refreshIntervalHours = Number(mutableConfig.modelRefreshHours || 24);
  const modelRefreshTimer = refreshIntervalHours > 0
    ? setInterval(runScheduledMaintenance, refreshIntervalHours * 3_600_000)
    : null;
  if (modelRefreshTimer) modelRefreshTimer.unref();
  // Tests inject a partial config that omits codexHome; fall back to the same
  // default loadConfig would have chosen so the session index is always rooted.
  const codexHome = typeof mutableConfig.codexHome === "string" && mutableConfig.codexHome
    ? mutableConfig.codexHome
    : path.join(os.homedir(), ".codex");
  return Object.assign(services, {
    config: mutableConfig, runtime, metrics, mediaStore, upstreams, configSwitcher,
    autostart, updater, routeAffinity, modelSelection, derivedFallback, callerKey, nativeSlugs,
    // The configured subagent model (modeldock_subagent's `model`). It is the
    // user's explicit choice and can be a native bare slug (model_provider
    // "openai"), which is exactly what the collaboration relay needs.
    subagentModel: readSubagentModel(mutableConfig),
    memoryStore, memoryTimer,
    refreshModelCatalog, writeCatalogFile, runModelTidy, runScheduledMaintenance, modelRefreshTimer, ollamaSnapshotFile,
    usageRollupFile: rollupFile, modelTogglesFile: togglesFile, modelLifecycleFile: lifecycleFile,
    sessionNames: new SessionNames({ sessionsRoot: path.join(codexHome, "sessions") }),
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
  return !envOff("MODELDOCK_REQUIRE_CALLER_KEY");
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
  app.get("/api/speech", jsonRoute("speech_status_error", async () => {
    const { ttsStatus } = await import("./tts.mjs");
    const { sttStatus } = await import("./stt.mjs");
    const [tts, stt] = await Promise.all([ttsStatus(), sttStatus()]);
    return { tts, stt };
  }));
  app.post("/api/speech/install", jsonRoute("tts_install_error", async () => {
    const { ttsInstall } = await import("./tts.mjs");
    return { installed: await ttsInstall() };
  }));
  app.get("/api/config", jsonRoute("config_status_error", async () => ({
    ...(await configSwitcher.status()),
  })));

  const mutateConfig = configMutationGuard(config, services.callerKey);
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
  // Two-way mode switch (OFF / ON). ON enables the managed Codex config with a
  // configured provider; free zen models are ordinary selectable entries and
  // still require the provider to be reachable, so there is no separate trial
  // mode. The catalog file is refreshed immediately so the App picker follows.
  app.post("/api/config/mode", mutateConfig, async (req, res) => {
    const mode = String(req.body?.mode || "");
    if (mode !== "off" && mode !== "on") {
      return res.status(400).json({ error: { type: "invalid_mode", message: "mode must be 'off' or 'on'." } });
    }
    try {
      const run = configMutationQueue.then(async () => {
        let result;
        // Wizard-managed native-GPT merge opt-out (no ChatGPT subscription). It is a
        // persistent property of the account, so it is applied on every enabling mode.
        // "0"/"false"/"off" are accepted for curl users.
        const nativeMergeRaw = req.body?.nativeMerge;
        const nativeMerge = nativeMergeRaw === undefined
          ? undefined
          : !["0", "false", "off"].includes(String(nativeMergeRaw).toLowerCase());
        if (mode === "off") {
          result = await configSwitcher.disable();
        } else {
          const onSelection = onModeSelection(services);
          if (!onSelection) {
            const error = new Error("Configure a provider token before enabling ON mode.");
            error.code = "provider_token_required";
            throw error;
          }
          const previousSelection = {
            profile: config.profile,
            profileId: config.profileId,
            mainModel: config.mainModel,
            visionModel: config.visionModel,
            selectedMainModel: services.modelSelection.mainModel,
            selectedVisionModel: services.modelSelection.visionModel,
          };
          config.profile = onSelection.profile;
          config.profileId = onSelection.providerId;
          config.mainModel = onSelection.mainModel;
          config.visionModel = onSelection.visionModel;
          services.modelSelection.mainModel = onSelection.mainModel;
          services.modelSelection.visionModel = onSelection.visionModel;
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
            }
            throw error;
          }
          const onEnv = {
            MODELDOCK_PROFILE: onSelection.providerId,
            MODELDOCK_VISION_MODEL: onSelection.visionModel || "none",
          };
          if (nativeMerge !== undefined) onEnv.MODELDOCK_NATIVE_MERGE = nativeMerge ? "1" : "0";
          writeEnvFile(onEnv, config.envFile);
          if (nativeMerge !== undefined) config.nativeMerge = nativeMerge;
          services.writeCatalogFile();
        }
        recordConfigAction(metrics, `config_mode_${mode}`, { ok: true });
        return result;
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
  app.get("/api/onboarding", jsonRoute("onboarding_status_error", async () => {
    const status = await configSwitcher.status();
    return {
      onboarded: Boolean(status.onboarded),
      onboardedAt: status.onboardedAt || null,
      nativeMerge: config.nativeMerge !== false,
      mode: status.enabled ? "on" : "off",
      tokenConfigured: {
        "opencode-go": Boolean(config.tokens?.["opencode-go"]),
        "deepseek-official": Boolean(config.tokens?.["deepseek-official"]),
      },
      // Any provider token unlocks the ON mode (the wizard's Apply gate).
      anyTokenConfigured: anyProviderTokenConfigured(config),
      autostart: settingsPayload(services).autostart,
    };
  }));
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
    // A bare id that is already a published entry must stay as-is: native GPT
    // slugs live bare in the merged set (gpt-5.6-luna, provider openai), and
    // qualifying them through the active profile would mislabel them as routed.
    const currentOptions = modelOptions(config, config.profileId);
    const qualify = (id) => (currentOptions.some((entry) => entry.id === id) ? id : publishedSlugFor(config.profileId, id));
    let nextMain = qualify(req.body?.mainModel === undefined ? current.mainModel : req.body.mainModel);
    let nextVision = qualify(req.body?.visionModel === undefined ? current.visionModel : req.body.visionModel);
    const nextProvider = req.body?.provider;
    if (nextProvider !== undefined && nextProvider !== config.profileId) {
      const known = profileOptions().some((entry) => entry.id === nextProvider);
      if (!known) return res.status(400).json({ error: { type: "invalid_provider", message: `Unknown provider: ${nextProvider}` } });
      config.profile = profileById(nextProvider);
      config.profileId = nextProvider;
      const profileModels = modelCatalogModels(config, config.profileId);
      if (!profileModels.some((entry) => entry.id === nextMain)) nextMain = profileModels[0]?.id || nextMain;
    }
    const options = modelOptions(config, config.profileId);
    const main = options.find((entry) => entry.id === nextMain);
    const vision = nextVision ? options.find((entry) => entry.id === nextVision) : null;
    if (!main || (nextVision && (!vision || !vision.supportsVision))) return res.status(400).json({ error: { type: "invalid_model_selection", message: "Vision must be None or selected from a vision-capable model." } });
    services.modelSelection.mainModel = nextMain;
    services.modelSelection.visionModel = nextVision;
    config.visionModel = nextVision;
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

  // The endpoint list. One record per model, because routing resolves an
  // endpoint from the model name a request arrives with - two endpoints
  // offering the same model id would leave the second unreachable, so the
  // second is refused rather than published as a lie.
  const endpointsFile = () => services.customEndpointsFile || customEndpointsPath();

  // Republish from disk after any change, so the catalog, the pickers and the
  // routing tables all move together instead of drifting until a restart.
  const republishEndpoints = () => {
    config.customEndpoints = readCustomEndpoints(endpointsFile());
    // The first entry mirrors into the single-value fields the settings
    // payload and the legacy readers still use, so a change to the list is
    // visible everywhere at once rather than after a restart.
    const first = config.customEndpoints[0] || null;
    config.customBaseUrl = first?.baseUrl || "";
    config.customModel = first?.modelId || "";
    config.customApiKey = first?.apiKey || "";
    config.customContextWindow = first?.contextWindow || 0;
    config.customVision = Boolean(first?.supportsVision);
    config.tokens = { ...(config.tokens || {}) };
    if (first?.apiKey) config.tokens.custom = first.apiKey;
    else delete config.tokens.custom;
    applyCustomProfile(config);
    services.writeCatalogFile?.();
    return config.customEndpoints;
  };

  app.get("/api/custom/endpoints", (req, res) => {
    // Keys never leave the machine: the list reports whether one is set, not
    // what it is.
    const endpoints = readCustomEndpoints(endpointsFile()).map((entry) => ({
      providerId: entry.providerId || "custom",
      modelId: entry.modelId,
      baseUrl: entry.baseUrl,
      label: entry.label,
      contextWindow: entry.contextWindow,
      supportsVision: entry.supportsVision,
      apiKeyConfigured: Boolean(entry.apiKey),
      addedAt: entry.addedAt,
    }));
    return res.json({ endpoints });
  });

  app.post("/api/custom/add", mutateConfig, async (req, res) => {
    const { baseUrl, apiKey, modelId, asVision, label, providerId } = req.body || {};
    try {
      const model = String(modelId || "").trim();
      if (!model) throw new CustomEndpointError("model", "A model id is required.");
      if (!String(apiKey || "").trim()) throw new CustomEndpointError("key", "An API key is required.");
      const probe = await probeCustomResponses({ baseUrl, apiKey, modelId: model });
      // Advertised context window (llama.cpp meta.n_ctx) so compaction limits
      // match the real backend instead of the 250K custom fallback.
      const listed = await listEndpointModels({ baseUrl, apiKey });
      const advertisedContext = listed.models.find((m) => m.id === model)?.contextWindow || 0;
      const next = addCustomEndpoint(readCustomEndpoints(endpointsFile()), {
        providerId,
        modelId: model,
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        label,
        contextWindow: advertisedContext,
        supportsVision: Boolean(asVision),
      });
      writeCustomEndpoints(endpointsFile(), next);
      const endpoints = republishEndpoints();
      // A newly added endpoint publishes a model Codex reads only at startup.
      await services.configSwitcher.markRestartRequired();
      recordConfigAction(metrics, "custom_endpoint_add", { ok: true });
      return res.json({
        ok: true,
        model,
        responsesUrl: probe.responsesUrl,
        endpoints: endpoints.map((entry) => ({ modelId: entry.modelId, baseUrl: entry.baseUrl })),
        settings: settingsPayload(services),
      });
    } catch (error) {
      recordConfigAction(metrics, "custom_endpoint_add", { ok: false, error: error.message });
      if (error instanceof CustomEndpointsError) {
        return res.status(400).json({ error: { type: error.code, message: error.message } });
      }
      return res.status(400).json(customErrorPayload(error));
    }
  });

  // Replace the key on an endpoint that is already configured. A key typed
  // once used to be unreachable: the only way to correct it was to remove the
  // endpoint and add it again, which also threw away its context window and
  // vision flag. The address is not editable here - a different host is a
  // different endpoint - so only the credential moves.
  app.post("/api/custom/key", mutateConfig, async (req, res) => {
    const model = String(req.body?.modelId || "").trim();
    const providerId = String(req.body?.providerId || "").trim();
    const apiKey = String(req.body?.apiKey || "");
    if (!model || !apiKey) {
      return res.status(400).json({ error: { type: "model", message: "A model id and an API key are required." } });
    }
    const before = readCustomEndpoints(endpointsFile());
    let found = false;
    const next = before.map((entry) => {
      if (entry.modelId !== model) return entry;
      if (providerId && (entry.providerId || "custom") !== providerId) return entry;
      found = true;
      return { ...entry, apiKey };
    });
    if (!found) {
      return res.status(404).json({ error: { type: "model", message: `No endpoint serves ${model}.` } });
    }
    writeCustomEndpoints(endpointsFile(), next);
    republishEndpoints();
    recordConfigAction(metrics, "custom_endpoint_key", { ok: true });
    // The key changes what the endpoint can do, not what Codex sees, so no
    // restart is asked for.
    return res.json({ modelId: model, providerId: providerId || "custom" });
  });

  app.post("/api/custom/remove", mutateConfig, async (req, res) => {
    const model = String(req.body?.modelId || "").trim();
    const providerId = String(req.body?.providerId || "").trim();
    if (!model) {
      return res.status(400).json({ error: { type: "model", message: "A model id is required." } });
    }
    const before = readCustomEndpoints(endpointsFile());
    const next = removeCustomEndpoint(before, model, providerId);
    if (next.length === before.length) {
      return res.status(404).json({ error: { type: "model", message: `No endpoint serves ${model}.` } });
    }
    writeCustomEndpoints(endpointsFile(), next);
    republishEndpoints();
    // A selection cannot outlive the endpoint that served it. Vision is a
    // stored preference, so it has to be let go of explicitly; the main model
    // records what Codex routed with and corrects itself on the next request.
    // Published under its own provider, so the selection it may have filled
    // carries that provider and not a hard-coded "custom".
    const gone = before.find((entry) => entry.modelId === model
      && (!providerId || (entry.providerId || "custom") === providerId));
    const qualified = `${model}${PROVIDER_SEPARATOR}${gone?.providerId || "custom"}`;
    if (config.visionModel === qualified) {
      config.visionModel = "";
      services.modelSelection.visionModel = "";
    }
    // The model stays in the picker and no longer resolves; a restart drops it.
    await services.configSwitcher.markRestartRequired();
    recordConfigAction(metrics, "custom_endpoint_remove", { ok: true });
    return res.json({ removed: model, endpoints: next.map((entry) => ({ modelId: entry.modelId, baseUrl: entry.baseUrl })) });
  });

  // Dashboard "Ollama (local)" flow: one click lists every chat-capable local
  // model (/api/tags), probes the Responses protocol, snapshots the list to disk
  // and publishes the models as one more provider option. Reconnect refreshes;
  // restart restores the snapshot. Connecting never rewrites the main or vision
  // model: Ollama stays a candidate provider and the user picks it explicitly.
  // Read-only: report which engines are already listening on this machine so
  // Local Hosts can offer them instead of asking the user to type a port. It
  // persists nothing - connecting still goes through the flow that owns the
  // engine (Ollama has its own; the OpenAI-compatible ones share the custom
  // endpoint slot).
  // The model roster: every published model with the two things a catalog
  // entry cannot tell you - how much it was used, and how it performed. Usage
  // is read from the folded rollup, never from the event log, so the page load
  // costs a small JSON read no matter how much traffic the gateway has served.
  // Correct a context window. Whoever hit the 400 knows more than the catalog
  // does, so the number is editable without waiting for a release. Sending null
  // clears the override and restores whatever the catalog ships.
  //
  // Codex reads model_catalog_json on its own schedule and caches what it read,
  // so rewriting the file is not enough on its own - the change lands on the
  // next Codex restart, which is what restartRequired tells the dashboard to say.
  app.post("/api/models/context", mutateConfig, async (req, res) => {
    const { id, contextWindow } = req.body || {};
    const slug = String(id || "").trim();
    if (!slug) {
      return res.status(400).json({ error: { type: "invalid_model", message: "A model id is required." } });
    }
    const file = services.contextOverridesFile || contextOverridesPath();
    const overrides = readContextOverrides(file);
    if (contextWindow === null) {
      delete overrides[slug];
    } else {
      const check = validateContextWindow(contextWindow);
      if (!check.ok) {
        return res.status(400).json({ error: { type: "invalid_context_window", message: check.message } });
      }
      overrides[slug] = check.value;
    }
    writeContextOverrides(file, overrides);
    // Clearing has to start from the shipped catalog, so rebuild the profiles
    // from their sources before stamping what is left of the overrides on.
    applyCustomProfile(config);
    const localSnapshot = readLocalEnginesSnapshot() || {};
    for (const engineId of CONNECTABLE_ENGINES) applyLocalEngineProfile(engineId, localSnapshot[engineId]);
    // Native models are appended to the published set rather than living in a
    // profile, so the pass below cannot reach them; they read this instead.
    // Without it the edit returned 200 and changed nothing for them.
    config.contextOverrides = overrides;
    applyContextOverrides(allProfiles(), overrides, { publishedSlugFor });
    services.writeCatalogFile?.();
    // The override is on disk and in the profiles by now. If marking the
    // restart fails, the edit still happened - reporting it as rejected would
    // send the user back to change a value that already changed.
    let restartRequired = true;
    try {
      await services.configSwitcher.markRestartRequired();
    } catch (error) {
      restartRequired = false;
      recordConfigAction(metrics, "context_window_update", { ok: false, error: error.message });
    }
    if (restartRequired) recordConfigAction(metrics, "context_window_update", { ok: true });
    return res.json({ id: slug, contextWindow: overrides[slug] ?? null, restartRequired });
  });
  // Switch a published model out of Codex's picker, or back into it.
  //
  // Same shape as the context-window edit next door and for the same reason:
  // the file is the record, the profiles are rebuilt from it, and Codex reads
  // model_catalog_json on its own schedule - so the change lands on the next
  // Codex restart, which is what restartRequired tells the dashboard to say.
  app.post("/api/models/enabled", mutateConfig, async (req, res) => {
    const { id, enabled } = req.body || {};
    const slug = String(id || "").trim();
    if (!slug) {
      return res.status(400).json({ error: { type: "invalid_model", message: "A model id is required." } });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: { type: "invalid_state", message: "enabled must be true or false." } });
    }
    // Refused rather than silently ignored: the catalog would publish this
    // model anyway (a selected model always is), so accepting the write would
    // store a preference that never takes effect and show a switch that lies.
    const selected = selectedModelSlugs(config, readSubagentModel(config));
    if (!enabled && selected.has(slug)) {
      return res.status(409).json({
        error: {
          type: "model_in_use",
          message: "This model is currently selected. Choose a different one first, then switch this off.",
        },
      });
    }
    const file = services.modelTogglesFile || modelTogglesPath();
    const toggles = readModelToggles(file);
    // Recorded either way, never deleted: an entry is how the weekly tidy knows
    // a person has ruled on this model and it should keep its hands off. A
    // delete would leave a rescued model looking untouched, and the tidy would
    // park it again a week later.
    toggles[slug] = enabled;
    writeModelToggles(file, toggles);
    config.modelToggles = toggles;
    config.subagentModel = readSubagentModel(config);
    services.writeCatalogFile?.();
    // The choice is on disk and in the catalog by now. If marking the restart
    // fails, the change still happened - reporting it as rejected would send
    // the user back to flip a switch that already flipped.
    let restartRequired = true;
    try {
      await services.configSwitcher.markRestartRequired();
    } catch (error) {
      restartRequired = false;
      recordConfigAction(metrics, "model_enabled_update", { ok: false, error: error.message });
    }
    if (restartRequired) recordConfigAction(metrics, "model_enabled_update", { ok: true });
    return res.json({ id: slug, enabled, restartRequired });
  });
  app.get("/api/models/roster", (req, res) => {
    const totals = rollupTotals(readRollup(services.usageRollupFile || usageRollupPath()));
    // The roster is the only place a switched-off model can be switched back
    // on, so it lists them all and marks the state - never filters by it.
    const toggles = readModelToggles(services.modelTogglesFile || modelTogglesPath());
    const selected = selectedModelSlugs(config, readSubagentModel(config));
    // The same published set every picker reads. Walking the profiles instead
    // skipped the native GPT models, which are appended to the set rather than
    // living in a profile - so the page was missing the models with the most
    // traffic on a signed-in machine.
    const providerLabels = new Map(providerOptions(config).map((entry) => [entry.id, entry.label]));
    providerLabels.set(NATIVE_PROVIDER.id, NATIVE_PROVIDER.label);
    const models = modelOptions(config, config.profileId)
      .filter((entry) => !entry.status || entry.status === "available")
      .map((entry) => ({
        id: entry.id,
        model: bareModelId(entry.id),
        provider: entry.provider,
        providerLabel: providerLabels.get(entry.provider) || entry.provider,
        label: entry.label || entry.id,
        supportsVision: Boolean(entry.supportsVision),
        visionTier: entry.visionTier || "",
        contextWindow: effectiveContextWindow(entry),
        // vendor: the model maker's published figure. native: the Codex
        // catalog's own. measured: verified against the endpoint. user: set
        // here. Absent means our conservative default, which is a guess.
        contextSource: entry.contextSource || "",
        free: Boolean(entry.free),
        speedTier: entry.speedTier || "",
        quota5h: entry.quota5h || 0,
        usage: totals[entry.id] || null,
        // published: reaches Codex's picker. locked: the gateway is pointed at
        // it, so it is published whatever the file says and the row cannot be
        // switched off from here.
        published: isModelPublished(toggles, entry.id) || selected.has(entry.id),
        locked: selected.has(entry.id),
      }));
    return res.json({ windowDays: 30, models });
  });
  app.get("/api/local/discover", async (req, res) => {
    try {
      const live = await (services.discoverEngines || discoverLocalEngines)({});
      const saved = readLocalEnginesSnapshot(services.localEnginesFile || localEnginesSnapshotPath()) || {};
      // Attached-ness is a property of an address, not of an engine name. Now
      // that discovery reads the process table it can find two llama-servers at
      // once (a tuned 27B on 11435 and a scratch one on 8080 is the ordinary
      // case), and keying this on the engine name alone marked both of them
      // connected while only one was.
      const attached = (engine) => sameLocalHost(saved[engine.engine]?.baseUrl, engine.baseUrl);
      // Probed once per scan, not per engine: two llama-servers on one machine
      // are still one set of cards.
      const gpus = await (services.probeGpus || probeGpus)({});
      const engines = live.map((engine) => ({
        ...engine,
        connected: attached(engine),
        connectedModels: attached(engine) ? saved[engine.engine]?.models?.length || 0 : 0,
        vram: vramLedgerFor(engine, gpus),
      })).map((engine) => ({ ...engine, warnings: engineWarnings(engine) }));
      // An engine that was connected and has since been stopped still belongs on
      // the page. Dropping it would leave a profile published against a server
      // that is gone, with no control anywhere to take it back down.
      for (const [engine, snapshot] of Object.entries(saved)) {
        if (engines.some((found) => found.engine === engine && found.connected)) continue;
        engines.push({
          engine,
          label: LOCAL_ENGINE_LABELS[engine] || engine,
          baseUrl: snapshot.baseUrl || "",
          models: (snapshot.models || []).map((model) => model.id),
          connectable: CONNECTABLE_ENGINES.includes(engine),
          connected: true,
          connectedModels: snapshot.models?.length || 0,
          offline: true,
        });
      }
      return res.json({ engines });
    } catch (error) {
      return res.status(500).json({ error: { type: "discover_failed", message: error.message } });
    }
  });
  // Connect a keyless local engine. assertLocalBase is the whole security
  // story: skipping the API key is only safe because the address cannot leave
  // this machine, so the two are one check rather than two.
  app.post("/api/local/connect", mutateConfig, async (req, res) => {
    const { engine, baseUrl, asVision } = req.body || {};
    try {
      if (!CONNECTABLE_ENGINES.includes(engine)) {
        throw new LocalEngineError("engine", `Unknown local engine: ${engine}`);
      }
      // Scanning and connecting are one action. Discovering the address here
      // rather than trusting the caller to send one is what makes them one:
      // the button in the list and the button in the engine's own section both
      // arrive with no address and both get the port the engine is really on.
      // Without this the fallback was the profile's default port, so an engine
      // started with `--port 11435` was found by the scan and then not
      // connectable, which is the worst of both.
      const discovered = baseUrl
        ? null
        : (await (services.discoverEngines || discoverLocalEngines)({})).find((found) => found.engine === engine);
      if (!baseUrl && !discovered) {
        throw new LocalEngineError(
          "not_found",
          `No ${LOCAL_ENGINE_LABELS[engine] || engine} server is answering on this machine. Start it, then connect.`,
        );
      }
      const base = normalizeBaseUrl(assertLocalBase(baseUrl || discovered.baseUrl));
      const listed = await listEndpointModels({ baseUrl: base, apiKey: "" });
      if (!listed.models.length) {
        throw new LocalEngineError("models", "The engine reported no models. Load one, then reconnect.");
      }
      // Prove the Responses dialect before persisting, so a server that only
      // speaks /v1/chat/completions fails the connect instead of every later turn.
      await probeCustomResponses({ baseUrl: base, apiKey: "", modelId: listed.models[0].id });
      const snapshot = {
        // What started this engine, read from the process behind the port we
        // just connected to. Kept so a stopped engine can be started again as
        // it was, rather than from a command line we would have to invent.
        launch: await launchSpecForPort(new URL(base).port),
        baseUrl: base,
        connectedAt: new Date().toISOString(),
        models: listed.models.map((model) => ({
          id: model.id,
          upstreamId: model.id,
          label: model.id,
          supportsVision: Boolean(asVision),
          contextWindow: model.contextWindow,
        })),
      };
      writeLocalEngineSnapshot(services.localEnginesFile || localEnginesSnapshotPath(), engine, snapshot);
      applyLocalEngineProfile(engine, snapshot);
      services.writeCatalogFile?.();
      // Same for a local engine: the models are new to Codex.
      await services.configSwitcher.markRestartRequired();
      recordConfigAction(metrics, `local_connect_${engine}`, { ok: true });
      return res.json({ engine, baseUrl: base, models: snapshot.models, settings: settingsPayload(services) });
    } catch (error) {
      recordConfigAction(metrics, `local_connect_${engine || "unknown"}`, { ok: false, error: error.message });
      const status = error instanceof LocalEngineError ? 400 : 502;
      return res.status(status).json({ error: { type: error.code || "local_connect_failed", message: error.message } });
    }
  });

  // Start an engine again exactly as it was running when it was connected.
  //
  // The request names an engine and nothing more. The binary and its arguments
  // come from the snapshot this install wrote while that engine was serving, so
  // there is no path from an HTTP body to a process argument, and argv is a list
  // rather than a string so no shell parses a model path.
  //
  // Only offered for an engine we have actually met. Composing a launch for one
  // we have not - guessing a model path, a context size, how many layers belong
  // on the GPU - would be a guess wearing the clothes of a memory.
  app.post("/api/local/restart", mutateConfig, async (req, res) => {
    const { engine } = req.body || {};
    const remembered = engine === "ollama"
      ? readOllamaSnapshot(services.ollamaSnapshotFile)?.launch
      : (CONNECTABLE_ENGINES.includes(engine)
        ? rememberedLaunch(engine, services.localEnginesFile || localEnginesSnapshotPath())
        : null);
    if (!remembered?.binary || !Array.isArray(remembered.args)) {
      return res.status(404).json({
        error: { type: "no_launch", message: `No remembered way to start ${engine || "that engine"}.` },
      });
    }
    // The button hides itself while the engine answers, but that is a rendered
    // snapshot: an engine that came back between the render and the click would
    // get a second copy started on a port the first one holds. The second copy
    // fails to bind, and the only place that failure appears is the log below.
    // Checking here costs one probe and turns a confusing "start" into a plain
    // "it is already running".
    const alreadyUp = (await (services.discoverEngines || discoverLocalEngines)({}))
      .some((found) => found.engine === engine);
    if (alreadyUp) {
      recordConfigAction(metrics, `local_restart_${engine}`, { ok: false, error: "already running" });
      return res.status(409).json({
        error: { type: "already_running", message: `${LOCAL_ENGINE_LABELS[engine] || engine} is already answering.` },
      });
    }
    try {
      // Never discard the output of a background launch (AGENTS.md): an engine
      // that dies on a missing model file, a held port, or a driver fault says
      // so on stderr and nowhere else - and this button is pressed precisely
      // when the engine has already failed once.
      const logDir = path.join(os.tmpdir(), "modeldock");
      mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `engine-${engine}.log`);
      const log = openSync(logFile, "a");
      const child = spawn(remembered.binary, remembered.args, {
        detached: true,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
      // The parent's copy of the descriptor is not needed once the child owns it.
      closeSync(log);
      // Ours to start, not ours to hold: the engine outlives this gateway, and
      // a restart of ModelDock must not take the user's model down with it.
      child.unref();
      recordConfigAction(metrics, `local_restart_${engine}`, { ok: true });
      return res.json({ engine, started: true, binary: remembered.binary, logFile });
    } catch (error) {
      recordConfigAction(metrics, `local_restart_${engine}`, { ok: false, error: error.message });
      return res.status(502).json({ error: { type: "launch_failed", message: error.message } });
    }
  });

// Apply a tuned configuration: stop the engine we discovered, start it again
  // with the chosen settings, and remember them.
  //
  // Stopping someone's model is not a thing to do on a stale reading, so the
  // engine is re-discovered first and the process is only signalled when the
  // port, the pid and the binary all still agree. A pid alone is not identity -
  // the operating system reuses them, and the one we saw a minute ago could be
  // anything by now.
  app.post("/api/local/apply", mutateConfig, async (req, res) => {
    const { engine, contextTokens, sessions, kvType } = req.body || {};
    if (!CONNECTABLE_ENGINES.includes(engine)) {
      return res.status(400).json({ error: { type: "engine", message: `Unknown local engine: ${engine}` } });
    }
    const live = await (services.discoverEngines || discoverLocalEngines)({});
    const running = live.find((found) => found.engine === engine);
    if (!running?.pid || !running.binary || !running.cmdline) {
      return res.status(409).json({
        error: {
          type: "not_attributable",
          message: "That engine is not running, or is not one this machine can attribute to a process.",
        },
      });
    }
    const args = applyLaunchOverrides(tokenizeCommandLine(running.cmdline).slice(1), {
      ctxSize: Number(contextTokens) || undefined,
      parallel: Number(sessions) || undefined,
      cacheTypeK: kvType && kvType !== "f16" ? kvType : undefined,
      cacheTypeV: kvType && kvType !== "f16" ? kvType : undefined,
      kvUnified: true,
    });
    try {
      process.kill(running.pid);
    } catch (error) {
      recordConfigAction(metrics, `local_apply_${engine}`, { ok: false, error: error.message });
      return res.status(502).json({ error: { type: "stop_failed", message: error.message } });
    }
    // The port does not free instantly, and starting a second copy onto a held
    // port is the failure this waits out.
    for (let i = 0; i < 40; i += 1) {
      if (!(await (services.discoverEngines || discoverLocalEngines)({})).some((found) => found.pid === running.pid)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    try {
      const logDir = path.join(os.tmpdir(), "modeldock");
      mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `engine-${engine}.log`);
      const log = openSync(logFile, "a");
      const child = spawn(running.binary, args, { detached: true, stdio: ["ignore", log, log], windowsHide: true });
      closeSync(log);
      child.unref();
      // The chosen spec, so a later restart replays what the user picked rather
      // than what they happened to have typed before.
      const file = services.localEnginesFile || localEnginesSnapshotPath();
      const snapshot = readLocalEnginesSnapshot(file)?.[engine];
      if (snapshot) {
        writeLocalEngineSnapshot(file, engine, {
          ...snapshot,
          launch: { binary: running.binary, args },
        });
      }
      recordConfigAction(metrics, `local_apply_${engine}`, { ok: true });
      return res.json({ engine, started: true, args, logFile });
    } catch (error) {
      recordConfigAction(metrics, `local_apply_${engine}`, { ok: false, error: error.message });
      return res.status(502).json({ error: { type: "launch_failed", message: error.message } });
    }
  });

  app.post("/api/local/disconnect", mutateConfig, async (req, res) => {
    const { engine } = req.body || {};
    if (!CONNECTABLE_ENGINES.includes(engine)) {
      return res.status(400).json({ error: { type: "engine", message: `Unknown local engine: ${engine}` } });
    }
    clearLocalEngineSnapshot(services.localEnginesFile || localEnginesSnapshotPath(), engine);
    applyLocalEngineProfile(engine, null);
    services.writeCatalogFile?.();
    recordConfigAction(metrics, `local_disconnect_${engine}`, { ok: true });
    return res.json({ engine, models: [], settings: settingsPayload(services) });
  });
  // Signing in to xAI. Three routes because a device grant is three moments:
  // ask for a code, wait for a person, then use what they approved.
  //
  // The waiting is the page's job, not the server's: one poll per request keeps
  // a user who closes the tab from leaving a loop running here.
  let pendingXaiDevice = null;

  const publishXai = (auth) => {
    applyXaiProfile(auth?.models || []);
    config.tokens = { ...(config.tokens || {}) };
    if (auth?.accessToken) config.tokens.xai = auth.accessToken;
    else delete config.tokens.xai;
    services.writeCatalogFile?.();
  };

  app.post("/api/xai/start", mutateConfig, async (req, res) => {
    try {
      const device = await startDeviceAuthorization({});
      pendingXaiDevice = device;
      // The code and URL are not secrets - they are what the user has to read
      // off the screen - but the device_code is, so it stays here.
      return res.json({
        userCode: device.userCode,
        verificationUrl: device.verificationUrl,
        expiresAt: device.expiresAt,
        intervalMs: device.intervalMs,
      });
    } catch (error) {
      recordConfigAction(metrics, "xai_start", { ok: false, error: error.message });
      return res.status(502).json({ error: { type: error.code || "device", message: error.message } });
    }
  });

  app.post("/api/xai/poll", mutateConfig, async (req, res) => {
    if (!pendingXaiDevice) {
      return res.status(409).json({ error: { type: "no_pending", message: "No sign-in is in progress." } });
    }
    if (Date.now() > pendingXaiDevice.expiresAt) {
      pendingXaiDevice = null;
      return res.status(408).json({ error: { type: "expired", message: "The sign-in code expired. Start again." } });
    }
    try {
      const result = await pollDeviceToken(pendingXaiDevice.deviceCode, {});
      if (result.status === "pending" || result.status === "slow_down") {
        return res.json({ status: "pending" });
      }
      if (result.status !== "ready") {
        pendingXaiDevice = null;
        return res.status(403).json({
          error: { type: result.status, message: result.message || "xAI declined the sign-in." },
        });
      }
      // Approved. What matters next is whether this subscription can actually
      // reach the models - xAI gates that separately from sign-in, so a token
      // alone is not proof of anything.
      const models = await listXaiModels(result.token.accessToken, {});
      if (!models.length) {
        throw new XaiAuthError("models", "Signed in, but this subscription reaches no models.");
      }
      const auth = { ...result.token, models, connectedAt: new Date().toISOString() };
      writeXaiAuth(services.xaiAuthFile || xaiAuthPath(), auth);
      publishXai(auth);
      pendingXaiDevice = null;
      await services.configSwitcher.markRestartRequired();
      recordConfigAction(metrics, "xai_connect", { ok: true, models: models.length });
      return res.json({ status: "connected", models, settings: settingsPayload(services) });
    } catch (error) {
      pendingXaiDevice = null;
      recordConfigAction(metrics, "xai_connect", { ok: false, error: error.message });
      const status = error instanceof XaiAuthError && error.code === "forbidden" ? 403 : 502;
      return res.status(status).json({ error: { type: error.code || "connect", message: error.message } });
    }
  });

  app.post("/api/xai/disconnect", mutateConfig, async (req, res) => {
    clearXaiAuth(services.xaiAuthFile || xaiAuthPath());
    publishXai(null);
    pendingXaiDevice = null;
    recordConfigAction(metrics, "xai_disconnect", { ok: true });
    return res.json({ status: "disconnected", settings: settingsPayload(services) });
  });

  // An access token lasts hours and the refresh token outlives it, so the
  // session survives restarts without asking the user to sign in again. Checked
  // on a timer rather than per request: the relay's target() is synchronous,
  // and a refresh in that path would be a network call inside a hot loop.
  const refreshXaiToken = async () => {
    const file = services.xaiAuthFile || xaiAuthPath();
    const auth = readXaiAuth(file);
    if (!auth || !accessTokenExpired(auth)) return;
    if (!auth.refreshToken) {
      // Nothing to refresh with: the session is over and saying so beats
      // publishing models that 401 on the next turn.
      clearXaiAuth(file);
      publishXai(null);
      return;
    }
    try {
      const token = await refreshAccessToken(auth.refreshToken, {});
      const next = { ...auth, ...token };
      writeXaiAuth(file, next);
      publishXai(next);
    } catch (error) {
      console.log(`[gate] xAI token refresh failed: ${error.message}`);
      clearXaiAuth(file);
      publishXai(null);
    }
  };

  // Restore the signed-in session at boot, so the pickers are right before the
  // first request rather than after the first refresh tick.
  const restoredXai = readXaiAuth(services.xaiAuthFile || xaiAuthPath());
  if (restoredXai) publishXai(restoredXai);
  // Every ten minutes, and only if there is a session to keep alive - a test
  // gateway with no snapshot never reaches the network from here.
  const xaiTimer = setInterval(() => { refreshXaiToken().catch(() => {}); }, 10 * 60 * 1000);
  xaiTimer.unref?.();
  refreshXaiToken().catch(() => {});

  app.post("/api/ollama/connect", mutateConfig, async (req, res) => {
    const { baseUrl } = req.body || {};
    try {
      // Same rule as the other engines: discover the address instead of
      // falling back to a default port. Ollama's 11434 is stable enough that
      // this rarely changes the outcome, but OLLAMA_HOST can move it, and a
      // moved Ollama was previously found by the scan and then not connectable.
      const discovered = baseUrl
        ? null
        : (await (services.discoverEngines || discoverLocalEngines)({})).find((found) => found.engine === "ollama");
      const result = await listOllamaModels({ baseUrl: baseUrl || discovered?.baseUrl });
      if (!result.models.length) {
        throw new OllamaError("models", "Ollama returned no chat-capable models. Pull one first (ollama pull <model>).");
      }
      // Prove the Responses dialect before persisting so an old Ollama (< 0.13.3)
      // fails the connect with readable guidance instead of a silent 404 later.
      await probeOllamaResponses({ baseUrl: result.endpoint, modelId: result.models[0].upstreamId });
      const snapshot = {
        baseUrl: result.endpoint,
        connectedAt: new Date().toISOString(),
        models: result.models,
        launch: await launchSpecForPort(new URL(result.endpoint).port || 11434),
      };
      writeOllamaSnapshot(services.ollamaSnapshotFile, snapshot);
      applyOllamaProfile(config, snapshot);
      config.ollamaBaseUrl = result.endpoint;
      services.writeCatalogFile?.();
      // Ollama publishes models Codex cannot see until it restarts.
      await services.configSwitcher.markRestartRequired();
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
        config.mainModel = "deepseek-v4-flash@opencode-go";
        services.modelSelection.mainModel = config.mainModel;
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
  stateDir = resolveStateDir(),
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

// Fold the event log into the thirty-day rollup. Both files are read from the
// top each time; a timestamp filter makes that idempotent, and at one fold per
// ten minutes the saved milliseconds would not pay for offset bookkeeping.
function foldUsageOnce(services) {
  try {
    const file = services.usageRollupFile || usageRollupPath();
    const { rollup, folded } = foldUsageFile(readRollup(file), services.usageEventsFile || usageEventsPath());
    if (folded) writeRollup(file, rollup);
    return folded;
  } catch {
    // Reporting must never take the gateway down.
    return 0;
  }
}

const USAGE_FOLD_INTERVAL_MS = 10 * 60 * 1000;
export async function startServer(config = loadConfig()) {
  const instance = createApp(createServices(config));
  // Tests opt out with autostartDefault: false so they never touch the real
  // registry or the real ~/.modeldock state file.
  if (config.autostartDefault !== false) {
    initAutostartDefault(instance.services.autostart).catch(() => {});
  }
  foldUsageOnce(instance.services);
  const usageTimer = setInterval(() => foldUsageOnce(instance.services), USAGE_FOLD_INTERVAL_MS);
  usageTimer.unref?.();
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
      // Codex leaves HTTP keep-alive sockets. server.close() waits for them, so
      // SIGTERM would drop LISTEN while the process stayed alive and launchd
      // KeepAlive would never relaunch. Destroy leftovers first.
      server.closeAllConnections?.();
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
  // One-time: an install configured before the endpoint list keeps its custom
  // endpoint, as an entry in the list rather than as MODELDOCK_CUSTOM_*
  // variables. Those variables used to be read as a fallback, which made them
  // a second source of endpoints - the model appeared in every picker while
  // the page that manages endpoints could not see it, and so could not remove
  // it. Here rather than in loadConfig because this block runs only for the
  // real gateway process.
  // Read from the file, not from process.env: applyEnvFile runs inside
  // loadConfig, which has not happened yet at this point. migrateEnvSecrets
  // above reads the file for the same reason.
  const envPath = envFileFor();
  // Only for the install that owns this .env. A gateway spawned by the install
  // tests resolves the developer real ~/.modeldock/.env and has no business
  // rewriting it - that cleared a live install three times before this check.
  const legacyCustom = ownsEnvFile(envPath)
    ? migrateLegacyCustomEndpoint(existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf8")) : {})
    : null;
  if (legacyCustom) {
    const cleared = Object.fromEntries(LEGACY_CUSTOM_ENV_KEYS.map((key) => [key, ""]));
    for (const key of LEGACY_CUSTOM_ENV_KEYS) delete process.env[key];
    try {
      writeEnvFile(cleared, envFileFor());
      if (legacyCustom.added) {
        console.log(`Moved the custom endpoint ${legacyCustom.modelId} from .env into the endpoint list.`);
      }
    } catch (error) {
      // A read-only .env must not stop the gateway from starting; the list
      // already has the entry. Said out loud because it is not harmless:
      // while the variables sit in the file, removing the endpoint lets the
      // next start bring it back.
      console.warn(`Could not clear MODELDOCK_CUSTOM_* from .env: ${error.message}`);
    }
  }
  let instance;
  try {
    instance = await startServer();
  } catch (error) {
    if (error?.code === "EADDRINUSE") {
      // A second gateway on the same port is almost always a stale instance of
      // this same install (the owner file may even be clobbered by the dead
      // sibling). Point at the restart script instead of dumping a stack trace
      // that reads like a crash.
      const config = loadConfig();
      const restart = process.platform === "win32"
        ? `powershell -ExecutionPolicy Bypass -File "${path.resolve(dirname, "../scripts/restart.ps1")}"`
        : `sh "${path.resolve(dirname, "../scripts/restart.sh")}"`;
      console.error(`ModelDock cannot start: port ${config.port} is already in use by another process.`);
      console.error(`If a ModelDock gateway is already running there, restart it instead of starting a second one:`);
      console.error(`  ${restart}`);
      console.error(`If the port is held by something else, set MODELDOCK_PORT in .env to a free port.`);
      process.exit(1);
    }
    throw error;
  }
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

  const shutdown = async (signal) => {
    console.error(`[modeldock] shutting down on ${signal}`);
    clearOwnerFile(instance.services.config.port);
    const force = setTimeout(() => {
      console.error("[modeldock] shutdown timed out; exiting");
      process.exit(0);
    }, 2000);
    force.unref();
    try {
      await instance.stop();
    } catch (error) {
      console.error(`[modeldock] shutdown error: ${error.message}`);
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

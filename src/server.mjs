import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statfsSync, writeFileSync } from "node:fs";
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
import { CodexAttachmentIndex } from "./codex-attachment-index.mjs";
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
import { runGatewayVerifierCli } from "../scripts/gateway-verifier.mjs";
import { CALLER_PATH_PREFIX, callerBasePath, callerKeyEqual, callerRootPath, loadOrCreateCallerKey } from "./caller-key.mjs";
import { SessionNames } from "./session-names.mjs";
import { validateProviderToken } from "./token-validate.mjs";
import { RouteAffinity } from "./router.mjs";
import { applyXaiProfile, allProfiles, PROVIDER_SEPARATOR, applyCustomProfile, effectiveContextWindow, applyLocalEngineProfile, applyOllamaProfile, bareModelId, profileOptions, profileById, providerForModel, publishedSlugFor, tokenFor } from "./profiles.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";
import { urlHost } from "./loopback.mjs";
import { createServices } from "./services.mjs";
// Re-exported: tests and embedders construct the service bag through
// server.mjs, and that path stays stable across the services split.
export { createServices };
import { anyProviderRouteConfigured, codexModelCatalog, modelCatalogModels, modelOptions, modelProviderOf, providerModels, providerOptions, providerRouteConfigured, publishedModelIds, visionOptionsAcrossProviders } from "./model-options.mjs";
import { NATIVE_PROVIDER, SUBAGENT_DEFAULT_MODEL, readSubagentModel, subagentModelOptions, subagentProviders, writeSubagentAgentFile } from "./subagent-config.mjs";
// Re-exported: tests and the config switcher import the catalog through
// server.mjs, and that path stays stable across the model-options split.
export { codexModelCatalog };
import { CustomEndpointError, listEndpointModels, normalizeBaseUrl, probeCustomResponses } from "./custom-endpoint.mjs";
import { LEGACY_CUSTOM_ENV_KEYS, migrateLegacyCustomEndpoint, CustomEndpointsError, addCustomEndpoint, customEndpointFor, customEndpointsPath, readCustomEndpoints, removeCustomEndpoint, writeCustomEndpoints } from "./custom-endpoints.mjs";
import { OLLAMA_DEFAULT_BASE, OllamaError, clearOllamaSnapshot, listOllamaModels, normalizeOllamaBase, ollamaSnapshotPath, probeOllamaResponses, readOllamaSnapshot, writeOllamaSnapshot } from "./ollama.mjs";
import { usageEventsPath } from "./usage-events.mjs";
import { applyContextOverrides, contextOverridesPath, readContextOverrides, validateContextWindow, writeContextOverrides } from "./context-overrides.mjs";
import { isModelPublished, modelTogglesPath, readModelToggles, selectedModelSlugs, writeModelToggles } from "./model-toggles.mjs";
import { modelsToPark, shouldTidy, stampFirstSeen } from "./model-tidy.mjs";
import { modelLifecyclePath, readLifecycle, writeLifecycle } from "./model-lifecycle-state.mjs";
import { foldUsageFile, readRollup, rollupKey, rollupTotals, usageRollupPath, writeRollup } from "./usage-rollup.mjs";
import { probeGpus } from "./gpu.mjs";
import { launchSpecFrom, managedLlamaLaunchArgs, spawnEngineDetached } from "./engine-processes.mjs";
import { launchSpecForPort, rememberedLaunch, ENGINE_LABELS as LOCAL_ENGINE_LABELS, CONNECTABLE_ENGINES, readLocalEnginesSnapshot, LocalEngineError, assertLocalBase, clearLocalEngineSnapshot, discoverLocalEngines, localEnginesSnapshotPath, writeLocalEngineSnapshot, modelFactsFor } from "./local-engines.mjs";
import { createObservedHost, takeOverHost } from "./local-hosts.mjs";
import { readLocalHostRegistry, removeLocalHost, upsertLocalHost, writeLocalHostRegistry } from "./local-host-registry.mjs";
import { applyLocalHostPlan, reconcileInterruptedLocalHost, verifyLocalHost } from "./local-host-runner.mjs";
import { conservativeNvidiaGpuSample, selectNvidiaManagedProfile } from "./local-host-nvidia.mjs";
import { createLocalHostLifecycleOperations, probeLlamaRequestSlotAffinity } from "./local-host-lifecycle.mjs";
import { createLocalHostCapacityFromLaneProfile } from "./local-host-capacity.mjs";
import { sameKvStorageDirectory } from "./local-host-kv-state.mjs";
import { XAI_API_BASE, XaiAuthError, accessTokenExpired, clearXaiAuth, isDefinitiveAuthRejection, listXaiModels, pollDeviceToken, readXaiAuth, refreshAccessToken, startDeviceAuthorization, writeXaiAuth, xaiAuthPath } from "./xai-auth.mjs";
import { recordSettingsEvent } from "./settings-events.mjs";
import { stateDir as resolveStateDir, stateFile } from "./state-dir.mjs";
import { kvBytesPerToken } from "./gguf.mjs";
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

function managedHostId(engine, baseUrl) {
  const type = String(engine || "").trim();
  try {
    const parsed = new URL(baseUrl);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${type}-${port}`;
  } catch {
    return "";
  }
}

function engineSummaryKey(engine) {
  try {
    return `${engine?.engine || ""}:${new URL(engine?.baseUrl || "").host}`;
  } catch {
    return "";
  }
}

// One shared spelling with the KV store's manifest adoption (see
// sameKvStorageDirectory): the two comparing differently is how a re-spelled
// Windows path once bricked the store while this route said everything matched.
const sameStorageDirectory = sameKvStorageDirectory;

function isAbsoluteStorageDirectory(value) {
  const directory = String(value || "").trim();
  return path.isAbsolute(directory) || /^[a-z]:[\\/]/i.test(directory);
}

function managedHostSummary(record, engine) {
  if (!record || record.adapterId !== "llamacpp-nvidia") return null;
  const storage = record.kvState;
  const launchDirectory = engine?.launch?.slotSavePath || "";
  const profile = record.activeProfile || record.desiredProfile || null;
  const capacity = profile ? createLocalHostCapacityFromLaneProfile(profile, {
    outputReserveTokens: Math.min(16_384, Math.max(1, Math.floor(profile.laneContextTokens / 4))),
  }) : null;
  return {
    id: record.id,
    state: record.state,
    cacheDirectory: storage?.directory || "",
    cacheBudgetBytes: storage?.budgetBytes || 0,
    profile,
    capacity,
    preTakeoverContextTokens: Number(record.capabilities?.contextTokens) || 0,
    // A takeover verifies the observed engine without disturbing it. The
    // explicit restart that adds --slot-save-path is a later, separate action,
    // so the UI must distinguish authority from an active cache launch.
    ssdState: storage && sameStorageDirectory(storage.directory, launchDirectory)
      ? "configured"
      : "restart_required",
    failure: record.failure || "",
  };
}

async function localHostSummaries(engines, registryFile) {
  let registry;
  try {
    registry = await readLocalHostRegistry(registryFile);
  } catch (error) {
    console.log(`[gate] local host registry ignored: ${error.message}`);
    return new Map();
  }
  const summaries = new Map();
  for (const engine of engines) {
    if (engine.engine !== "llamacpp" || !engine.baseUrl) continue;
    const record = Object.values(registry.hosts).find((candidate) => (
      candidate.adapterId === "llamacpp-nvidia" && sameLocalHost(candidate.endpoint, engine.baseUrl)
    ));
    const summary = managedHostSummary(record, engine);
    if (summary) summaries.set(engineSummaryKey(engine), summary);
  }
  return summaries;
}

async function publishManagedLocalEngine(services, record, running) {
  const file = services.localEnginesFile || localEnginesSnapshotPath();
  const snapshot = readLocalEnginesSnapshot(file)?.llamacpp;
  if (!snapshot?.models?.length || !record?.activeSpec) return false;
  const capacity = record.activeProfile ? createLocalHostCapacityFromLaneProfile(record.activeProfile, {
    outputReserveTokens: Math.min(16_384, Math.max(1, Math.floor(record.activeProfile.laneContextTokens / 4))),
  }) : null;
  const contextWindow = Number(capacity?.maxSingleRequestTokens)
    || Number(running?.launch?.ctxSize)
    || Number(record.capabilities?.contextTokens)
    || 0;
  const models = contextWindow
    ? snapshot.models.map((model) => ({ ...model, contextWindow }))
    : snapshot.models;
  const changed = snapshot.models.some((model) => Number(model.contextWindow) !== contextWindow);
  const next = { ...snapshot, launch: record.activeSpec, models };
  writeLocalEngineSnapshot(file, "llamacpp", next);
  applyLocalEngineProfile("llamacpp", next);
  services.writeCatalogFile?.();
  if (changed) await services.configSwitcher.markRestartRequired();
  return changed;
}

// Pick one complete route for ON mode. The current provider wins when it is
// usable; otherwise the first configured provider becomes active. Main and
// vision are selected from that same provider so a DeepSeek-only install does
// not keep advertising an unauthenticated OpenCode vision route.
function onModeSelection(services) {
  const { config, modelSelection } = services;
  const currentProvider = providerForModel(config, modelSelection.mainModel);
  const providerId = providerRouteConfigured(config, currentProvider)
    ? currentProvider
    : profileOptions().map((provider) => provider.id)
      .find((id) => providerRouteConfigured(config, id));
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
function engineWarnings(engine, gpus = []) {
  const warnings = [];
  const launch = engine?.launch;
  const facts = engine?.modelFacts;
  if (!launch || !facts) return warnings;
  const vendors = new Set(gpus.map((gpu) => gpu.vendor).filter(Boolean));
  const vendor = vendors.size === 1 ? [...vendors][0] : "";
  if (launch.contextShift && vendor === "amd") {
    // Refused on this stack, so the flag is not merely idle - a restart takes
    // it off. Reported ahead of the architecture case because it is the one
    // that changes what happens next.
    warnings.push({ code: "context_shift_refused" });
  } else if (launch.contextShift && facts.hybrid) {
    warnings.push({ code: "context_shift_ineffective" });
  }
  // KV quantization is broken on this AMD stack, and a broken cache is wrong
  // answers rather than slow ones.
  if ((launch.cacheTypeK || launch.cacheTypeV) && vendor === "amd") {
    warnings.push({ code: "kv_quant_unsupported" });
  }
  // The weights carry MTP blocks the running backend ignores; the log says so
  // once at load and never again.
  if (facts.blockCount > facts.layers && /vulkan/i.test(String(engine?.binary || ""))) {
    warnings.push({ code: "mtp_ignored" });
  }
  return warnings;
}

// KV slot states are the biggest thing this gateway ever writes, and the
// default directory sits under the user profile - usually the system drive.
// So the budget default is derived from what that volume can actually spare,
// and a manage request is refused when its budget could not fit: the reserve
// stays untouched for the OS (updates, pagefile, hibernation), never handed
// to cache.
const KV_DISK_RESERVE_BYTES = 20 * 1024 ** 3;
const KV_BUDGET_DEFAULT_MAX_GIB = 8;

// Free bytes on the volume that holds (or will hold) the directory. The
// directory itself may not exist yet, so the nearest existing ancestor
// answers for its volume. -1 means "could not measure" - callers must treat
// that as unknown, not as empty.
function kvVolumeFreeBytes(directory) {
  let probe = path.resolve(String(directory || ""));
  for (let depth = 0; depth < 100; depth += 1) {
    if (existsSync(probe)) {
      try {
        const stats = statfsSync(probe);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch {
        return -1;
      }
    }
    const parent = path.dirname(probe);
    if (parent === probe) return -1;
    probe = parent;
  }
  return -1;
}

function kvBudgetDefaultFor(freeBytes) {
  if (!(freeBytes > 0)) return 1;
  const usable = Math.floor((freeBytes - KV_DISK_RESERVE_BYTES) / 1024 ** 3);
  return Math.max(1, Math.min(KV_BUDGET_DEFAULT_MAX_GIB, usable));
}

// Connection snapshots predate GGUF header names, so a previously connected
// llama.cpp server still publishes its disk path after an upgrade until the
// user presses Connect again. Discovery already observes both sides without
// touching the engine: its one advertised endpoint id and the launch GGUF's
// cached header facts. Refresh that one unambiguous case automatically. A
// multi-model endpoint remains untouched because one GGUF cannot name all of
// its models safely.
function refreshedSingleModelSnapshot(snapshot, engine) {
  const saved = snapshot?.models;
  const advertised = Array.isArray(engine?.models) && engine.models.length === 1
    ? String(engine.models[0] || "")
    : "";
  const name = String(engine?.modelFacts?.modelName || "").trim();
  const slug = String(engine?.modelFacts?.modelSlug || "").trim();
  if (!Array.isArray(saved) || saved.length !== 1 || !advertised || !name || !slug) return null;
  const current = saved[0];
  if (current.id === slug && current.label === name && current.upstreamId === advertised) return null;
  return {
    ...snapshot,
    models: [{ ...current, id: slug, label: name, upstreamId: advertised }],
  };
}

function recommendedManagedProfile(engine, gpus) {
  if (engine?.engine !== "llamacpp") return null;
  try {
    const { candidates: _candidates, ...profile } = selectNvidiaManagedProfile({ engine, gpus });
    return profile;
  } catch {
    return null;
  }
}

async function probeManagedNvidiaGpus(services, { sampleCount = 3, sampleDelayMs = 150 } = {}) {
  const probe = services.probeGpus || probeGpus;
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await probe({}));
    if (index + 1 < sampleCount) await new Promise((resolve) => setTimeout(resolve, sampleDelayMs));
  }
  return conservativeNvidiaGpuSample(samples);
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
    "deepseek-official": "DeepSeek",
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
    localHost: services.localHostRuntime?.snapshot?.() || { managed: false, activeCount: 0, pendingCount: 0, hotCount: 0, lanes: [] },
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
    tokenConfigured: anyProviderRouteConfigured(config),
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

// The dashboard's view of the same question the relay asks. It had its own
// if-chain and disagreed with the relay about Ollama, so the address shown
// was not the address used.
function upstreamBaseForModel(config, model) {
  return profileById(providerForModel(config, model)).baseUrlFor(config, model);
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
    // zstdRequestDecoder preserves the original compressed and decoded sizes
    // before Express sees an identity JSON body. The gateway must receive those
    // values instead of inferring a second serialized copy for metrics.
    ingressBytes: req.modeldockIngressBytes,
    requestUrl: req.originalUrl,
    localHostRuntime: services.localHostRuntime,
    signal: controller.signal,
  });
  if (result?.route?.reason === "client_selected" && modelSelection && result.route.model !== modelSelection.mainModel) {
    modelSelection.mainModel = result.route.model;
  }
  return result;
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

function payloadTooLargeDiagnostics({
  encoding,
  reason,
  wireBytes,
  wireLimitBytes = null,
  decodedBytes = null,
  decodedBytesAtLeast = null,
  decodedLimitBytes = null,
}) {
  return {
    encoding,
    reason,
    wireBytes,
    wireLimitBytes,
    decodedBytes,
    decodedBytesAtLeast,
    decodedLimitBytes,
    // A 413 occurs before it is safe to parse the JSON. Never decompress or
    // parse past the guard just to obtain these diagnostics.
    inputItems: null,
    inputImages: null,
    inputImageBytes: null,
  };
}

function recordPayloadTooLarge(metrics, diagnostics) {
  const finish = metrics?.begin?.("responses", {
    operation: "payload_too_large",
    payloadDiagnostics: diagnostics,
  });
  finish?.({
    ok: false,
    httpStatus: 413,
    error: `Request body exceeded ${diagnostics.reason} limit.`,
  });
}

function sendPayloadTooLarge(res, metrics, diagnostics, message) {
  recordPayloadTooLarge(metrics, diagnostics);
  return res.status(413).json({
    error: {
      type: "payload_too_large",
      message,
      diagnostics,
    },
  });
}

function zstdRequestDecoder({ callerKey, metrics }) {
  // Codex sends its own compaction request as one zstd body. A 16 MiB wire cap
  // rejected that very request before it could replace image-heavy history with
  // a compact handoff. Keep a bounded 32 MiB ingress allowance; decompression
  // remains capped at 64 MiB, so this is not an unbounded memory escape hatch.
  const maxInput = 32 * 1024 * 1024;
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
        sendPayloadTooLarge(
          res,
          metrics,
          payloadTooLargeDiagnostics({
            encoding: "zstd",
            reason: "compressed_request",
            wireBytes: received,
            wireLimitBytes: maxInput,
            decodedLimitBytes: maxOutput,
          }),
          `zstd request body exceeds the ${maxInput}-byte limit`,
        );
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
            return sendPayloadTooLarge(
              res,
              metrics,
              payloadTooLargeDiagnostics({
                encoding: "zstd",
                reason: "decompressed_request",
                wireBytes: compressed.length,
                decodedBytes: Number.isFinite(error.decompressedBytes) ? error.decompressedBytes : null,
                decodedBytesAtLeast: Number.isFinite(error.decompressedBytesAtLeast)
                  ? error.decompressedBytesAtLeast
                  : maxOutput + 1,
                decodedLimitBytes: maxOutput,
              }),
              `zstd request decompresses beyond the ${maxOutput}-byte limit`,
            );
          }
          return res.status(400).json({ error: { type: "bad_request", message: `zstd request decode failed: ${error.message}` } });
        }
        try {
          req.headers["content-encoding"] = "identity";
          req.headers["content-length"] = String(body.length);
          // Preserve both measurements before exposing the decoded body to the
          // regular JSON routes. The rewritten headers describe logical JSON;
          // they must not erase the compressed bytes Codex actually sent.
          req.modeldockIngressBytes = { wireBytes: compressed.length, logicalBytes: body.length };
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
        if (error) {
          if (error.code === "ERR_BUFFER_TOO_LARGE") error.decompressedBytesAtLeast = maxOutput + 1;
          reject(error);
        }
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
        error.decompressedBytes = length;
        error.decompressedBytesAtLeast = length;
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
  // One config mutation at a time, across every route that rewrites shared
  // state. The queue never rejects: each queued handler answers its own
  // response, so a failed predecessor must not poison the successors.
  const queueConfigMutation = (work) => {
    const run = configMutationQueue.then(work);
    configMutationQueue = run.catch(() => {});
    return run;
  };
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
            const error = new Error("Connect a provider or configure a provider token before enabling ON mode.");
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
      // This legacy field name is the wizard contract; a connected keyless
      // engine is equally able to unlock ON mode.
      anyTokenConfigured: anyProviderRouteConfigured(config),
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
    if (enabled) {
      // Rescuing a model clears its entry and restarts the thirty-day clock,
      // rather than recording an exemption that outlives the intent. A person
      // switching one back on is saying "I want this one", not "never judge
      // this one again" - and a permanent exemption is how a picker fills up
      // with models somebody enabled once, three years ago, and never opened.
      //
      // The restamp is what makes the delete safe. Without it the model is
      // eligible again on its old firstSeen, and the next tidy parks it a week
      // later - seven days after the person said otherwise rather than the
      // thirty the rule promises. That was the reason the entry used to be
      // kept; restarting the clock answers it without the exemption.
      delete toggles[slug];
      const lifecycleFile = services.modelLifecycleFile || modelLifecyclePath();
      const lifecycle = readLifecycle(lifecycleFile);
      writeLifecycle(lifecycleFile, {
        ...lifecycle,
        firstSeen: { ...lifecycle.firstSeen, [slug]: new Date().toISOString() },
      });
    } else {
      toggles[slug] = false;
    }
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
        // Keyed the way the rollup keyed it when the traffic was recorded. A
        // native entry's id is bare and its usage is filed under
        // "<id>@openai", so reading it by id alone showed the models with the
        // most traffic on a signed-in machine as never used at all - blank
        // requests, blank tps, blank cache, and last in a table that sorts by
        // requests. rollupKey is the same function that wrote the key, so the
        // two cannot drift apart.
        usage: totals[rollupKey({ model: entry.id, provider: entry.provider })] || null,
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
        recommendedProfile: recommendedManagedProfile(engine, gpus),
        // What one full-context session state costs on disk, so the SSD budget
        // field can say "this holds about N sessions" instead of asking the
        // user to intuit GiB. f16 is the state llama.cpp writes by default;
        // a quantized cache only makes the estimate conservative.
        kvFullStateBytes: (() => {
          const perToken = kvBytesPerToken(engine.modelFacts);
          const context = Number(engine.launch?.ctxSize) || Number(engine.modelFacts?.trainedContext) || 0;
          return perToken && context ? perToken * context : 0;
        })(),
      })).map((engine) => ({ ...engine, warnings: engineWarnings(engine, gpus) }));
      const hostSummaries = await localHostSummaries(engines, services.localHostRegistryFile);
      // The window Codex is told about has to follow the per-lane window the
      // engine is actually serving. In managed P2/P3 mode llama.cpp's -c is the
      // total KV pool, while Codex must receive only one equal lane's C.
      // A connected engine publishes its context from meta.n_ctx, read once at
      // connect time. Restart it on a smaller -c - through the drawer, or by
      // hand - and the published figure stays where it was, so Codex keeps
      // packing against the old number and auto-compacts near 80% of it. An
      // engine moved from 80K to 32K is told to fill 64,000 tokens into a window
      // that holds 32,000, and the failure lands mid-conversation.
      //
      // The scan already knows the running ctxSize, so this is the place that
      // can notice. Republishing changes the catalog Codex reads at startup,
      // which is what the restart banner is for.
      for (const engine of engines) {
        const snapshot = saved[engine.engine];
        const running = Number(engine.launch?.ctxSize) || 0;
        const managedContext = Number(hostSummaries.get(engineSummaryKey(engine))?.profile?.laneContextTokens) || 0;
        const declared = managedContext || running;
        if (!engine.connected || !declared || !snapshot?.models?.length) continue;
        if (snapshot.models.every((model) => Number(model.contextWindow) === declared)) continue;
        const models = snapshot.models.map((model) => ({ ...model, contextWindow: declared }));
        writeLocalEngineSnapshot(services.localEnginesFile || localEnginesSnapshotPath(), engine.engine, { ...snapshot, models });
        applyLocalEngineProfile(engine.engine, { ...snapshot, models });
        services.writeCatalogFile?.();
        await services.configSwitcher.markRestartRequired();
        recordConfigAction(metrics, `local_context_republished_${engine.engine}`, { ok: true, contextWindow: declared });
      }
      // Refresh legacy local snapshots from the GGUF header without restarting
      // or modifying the engine. This makes a naming-only ModelDock update
      // visible the next time the dashboard scans, rather than requiring a
      // person to reconnect an already working local server by hand.
      for (const engine of engines) {
        if (!engine.connected) continue;
        const file = services.localEnginesFile || localEnginesSnapshotPath();
        const snapshot = readLocalEnginesSnapshot(file)?.[engine.engine];
        const refreshed = refreshedSingleModelSnapshot(snapshot, engine);
        if (!refreshed) continue;
        writeLocalEngineSnapshot(file, engine.engine, refreshed);
        applyLocalEngineProfile(engine.engine, refreshed);
        services.writeCatalogFile?.();
        await services.configSwitcher.markRestartRequired();
        recordConfigAction(metrics, `local_model_name_refreshed_${engine.engine}`, { ok: true });
      }
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
      const runtimeStatus = await services.localHostRuntime?.status?.() || services.localHostRuntime?.snapshot?.() || null;
      return res.json({
        // The manage form's suggested SSD KV directory and budget.
        // Server-computed so the default directory is one this install already
        // owns (state dir, correct permissions, removed with the install) on
        // every platform, and the default budget follows the volume's real
        // free space minus the system reserve instead of assuming the disk
        // has room.
        ...(() => {
          const kvDirectoryDefault = services.kvDirectoryDefault || stateFile("kv");
          const freeBytes = (services.probeKvFreeBytes || kvVolumeFreeBytes)(kvDirectoryDefault);
          return { kvDirectoryDefault, kvBudgetDefaultGiB: kvBudgetDefaultFor(freeBytes) };
        })(),
        engines: engines.map((engine) => ({
          ...engine,
          management: (() => {
            const management = hostSummaries.get(engineSummaryKey(engine)) || null;
            return management && runtimeStatus?.hostId === management.id
              ? { ...management, runtime: runtimeStatus }
              : management;
          })(),
        })),
      });
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
      const launch = await launchSpecForPort(new URL(base).port);
      const snapshot = {
        // What started this engine, read from the process behind the port we
        // just connected to. Kept so a stopped engine can be started again as
        // it was, rather than from a command line we would have to invent.
        launch,
        baseUrl: base,
        connectedAt: new Date().toISOString(),
        // The endpoint advertises a raw id that is often the model file path
        // (llama.cpp serves "D:\models\Qwen3.8-...gguf"). Publishing that as the
        // picker name leaks a path and makes the catalog unreadable. When a
        // single-model llama.cpp process names a GGUF we read its header and
        // publish the model's own name instead; the endpoint id stays in
        // upstreamId so the wire never sees a name the server does not serve.
        // A multi-model endpoint is deliberately left alone: one launch GGUF
        // cannot name every advertised endpoint model, and assigning it to all
        // of them would manufacture duplicate picker entries. An id we cannot
        // map to one unambiguous file (including vLLM) is published as-is.
        models: listed.models.map((model) => {
          const facts = listed.models.length === 1
            ? (services.modelFactsFor || modelFactsFor)(launch?.model)
            : null;
          const friendly = facts?.modelName || "";
          const slug = facts?.modelSlug || "";
          return {
            id: slug || model.id,
            upstreamId: model.id,
            label: friendly || model.label || model.id,
            supportsVision: Boolean(asVision),
            contextWindow: model.contextWindow,
          };
        }),
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

  // Connecting is observation and routing only. Takeover is the one automatic
  // path that chooses a per-GPU profile, drains work, restarts with fixed equal
  // slots plus SSD state, verifies the real process and rolls back to the exact
  // pre-takeover argv on any failure.
  // Serialized behind the config mutation queue: manage rewrites the registry
  // and restarts a process, and the runtime's beginTransition() answers a
  // concurrent attempt with an error - but a double-click deserves "wait your
  // turn", not a 502.
  app.post("/api/local/manage", mutateConfig, (req, res) => queueConfigMutation(async () => {
    const { engine, cacheDirectory, cacheBudgetGiB } = req.body || {};
    try {
      if (engine !== "llamacpp") throw new LocalEngineError("engine", "Managed host control currently supports NVIDIA llama.cpp only.");
      if (!isAbsoluteStorageDirectory(cacheDirectory)) {
        throw new LocalEngineError("kv_directory", "Choose an absolute SSD cache directory for managed KV state.");
      }
      const budgetGiB = Number(cacheBudgetGiB);
      if (!Number.isSafeInteger(budgetGiB) || budgetGiB < 1 || budgetGiB > 1024) {
        throw new LocalEngineError("kv_budget", "Choose a whole-number SSD KV budget from 1 through 1024 GiB.");
      }
      // The chosen volume must actually hold the budget, with the system
      // reserve untouched. Measured on the nearest existing ancestor, so a
      // not-yet-created folder still answers; files already inside the KV
      // directory count against "free", which makes a re-manage at the same
      // budget slightly conservative - the safe direction.
      const freeBytes = (services.probeKvFreeBytes || kvVolumeFreeBytes)(cacheDirectory);
      if (freeBytes >= 0 && budgetGiB * 1024 ** 3 > freeBytes - KV_DISK_RESERVE_BYTES) {
        const usable = Math.max(0, Math.floor((freeBytes - KV_DISK_RESERVE_BYTES) / 1024 ** 3));
        throw new LocalEngineError(
          "kv_budget_disk",
          `That volume has ${(freeBytes / 1024 ** 3).toFixed(1)} GiB free; keeping ${Math.round(KV_DISK_RESERVE_BYTES / 1024 ** 3)} GiB for the system leaves at most ${usable} GiB for the KV budget.`,
        );
      }
      const snapshot = readLocalEnginesSnapshot(services.localEnginesFile || localEnginesSnapshotPath())?.llamacpp;
      if (!snapshot?.baseUrl) {
        throw new LocalEngineError("not_connected", "Connect this llama.cpp server to the gateway before taking over host control.");
      }
      const live = await (services.discoverEngines || discoverLocalEngines)({});
      const running = live.find((candidate) => candidate.engine === "llamacpp" && sameLocalHost(candidate.baseUrl, snapshot.baseUrl));
      if (!running) throw new LocalEngineError("not_found", "The connected llama.cpp server is not answering. Start it, then take over host control.");
      const launch = launchSpecFrom(running);
      if (!launch) {
        throw new LocalEngineError("not_attributable", "ModelDock cannot read this llama.cpp process command. Start it from an attributable local executable, then try again.");
      }
      if (running.launch?.model && !isAbsoluteStorageDirectory(running.launch.model)) {
        throw new LocalEngineError("relative_model_path", "Host control needs an absolute model path so the exact command can be restarted and recovered safely.");
      }
      const id = managedHostId("llamacpp", snapshot.baseUrl);
      if (!id) throw new LocalEngineError("base", "The connected llama.cpp server has no usable local address.");
      let registry = await readLocalHostRegistry(services.localHostRegistryFile);
      if (registry.hosts[id]) throw new LocalEngineError("already_managed", "This llama.cpp host is already under ModelDock management. Leave management before changing its SSD budget.");
      const gpus = await probeManagedNvidiaGpus(services);
      const selected = (services.selectNvidiaManagedProfile || selectNvidiaManagedProfile)({ engine: running, gpus });
      const { candidates: _candidates, ...profile } = selected;
      await mkdir(String(cacheDirectory).trim(), { recursive: true });
      const desiredSpec = {
        binary: launch.binary,
        args: managedLlamaLaunchArgs(launch.args, {
          profile,
          slotSavePath: String(cacheDirectory).trim(),
        }),
      };
      const observed = createObservedHost({
        id,
        adapterId: "llamacpp-nvidia",
        endpoint: snapshot.baseUrl,
        launch,
        capabilities: {
          model: running.launch?.model || "",
          contextTokens: Number(running.launch?.ctxSize) || 0,
          slots: Number(running.launch?.parallel) || 0,
          gpuCount: profile.gpus.length,
          requestSlotAffinity: false,
        },
      });
      const takenOver = takeOverHost(observed, {
        kvState: {
          directory: String(cacheDirectory).trim(),
          budgetBytes: budgetGiB * 1024 ** 3,
        },
      });
      const releaseTransition = services.localHostRuntime?.beginTransition?.() || (() => {});
      const operations = (services.createLocalHostLifecycleOperations || createLocalHostLifecycleOperations)({
        hostId: id,
        endpoint: snapshot.baseUrl,
        registryFile: services.localHostRegistryFile,
        discover: () => (services.discoverEngines || discoverLocalEngines)({}),
        runtime: services.localHostRuntime,
        logDir: services.engineLogDir || stateFile("engine-logs"),
      });
      try {
        const authorized = await verifyLocalHost(takenOver, operations);
        if (authorized.outcome !== "verified") {
          recordConfigAction(metrics, "local_manage_llamacpp", { ok: false, error: authorized.failure });
          // The standard error envelope rides alongside the outcome fields:
          // the dashboard reads body.error?.message like every other route,
          // and without it a failed takeover displayed as literally
          // "Manage 409" instead of the verification failure text.
          return res.status(409).json({
            error: { type: "takeover_failed", message: authorized.failure },
            outcome: authorized.outcome,
            management: managedHostSummary(authorized.record, running),
            message: authorized.failure,
          });
        }
        let result = await applyLocalHostPlan(authorized.record, { desiredSpec, desiredProfile: profile }, operations);
        if (result.outcome === "applied") {
          const requestSlotAffinity = profile.laneCount === 1 || await (services.probeLlamaRequestSlotAffinity || probeLlamaRequestSlotAffinity)({
            endpoint: snapshot.baseUrl,
            model: profile.modelId,
            slot: profile.laneCount - 1,
          });
          const updated = {
            ...result.record,
            capabilities: { ...result.record.capabilities, requestSlotAffinity },
          };
          const latest = await readLocalHostRegistry(services.localHostRegistryFile);
          await writeLocalHostRegistry(services.localHostRegistryFile, upsertLocalHost(latest, updated));
          result = { ...result, record: updated };
        }
        const current = (await (services.discoverEngines || discoverLocalEngines)({}))
          .find((candidate) => candidate.engine === "llamacpp" && sameLocalHost(candidate.baseUrl, snapshot.baseUrl));
        await publishManagedLocalEngine(services, result.record, current);
        const ok = result.outcome === "applied";
        const restored = result.outcome === "recovered";
        if (ok) {
          await services.localHostRuntime?.refresh?.(result.record);
        } else if (restored) {
          // A failed first takeover has already restored the immutable original
          // command. Revoke the unused authority too, so the user is left in
          // the same connected/observed state without a cleanup step.
          const latest = await readLocalHostRegistry(services.localHostRegistryFile);
          await writeLocalHostRegistry(services.localHostRegistryFile, removeLocalHost(latest, id));
          services.localHostRuntime?.invalidate?.();
        } else {
          // Neither launch verified. Retain the durable authority and recovery
          // facts so a later explicit recovery can identify the process safely.
          await services.localHostRuntime?.refresh?.(null);
        }
        recordConfigAction(metrics, "local_manage_llamacpp", {
          ok,
          outcome: result.outcome,
          lanes: result.record.activeProfile?.laneCount || 0,
          contextWindow: result.record.activeProfile?.laneContextTokens || 0,
        });
        return res.status(ok ? 200 : 502).json({
          outcome: result.outcome,
          management: ok || !restored ? managedHostSummary(result.record, current) : null,
          message: ok
            ? `Host control is active at ${profile.laneCount} lane(s) x ${profile.laneContextTokens} tokens. Session placement and SSD state are automatic.`
            : restored
              ? `The managed profile did not verify. ModelDock restored the exact pre-takeover command line. ${result.failure || ""}`.trim()
              : `Neither the managed profile nor the pre-takeover command verified. Host control remains in degraded recovery state. ${result.recoveryFailure || result.failure || ""}`.trim(),
        });
      } finally {
        releaseTransition();
      }
    } catch (error) {
      recordConfigAction(metrics, "local_manage_llamacpp", { ok: false, error: error.message });
      const status = error instanceof LocalEngineError ? 400 : 502;
      return res.status(status).json({ error: { type: error.code || "local_manage_failed", message: error.message } });
    }
  }));

  // Releasing management returns process ownership as well as metadata: restore
  // the immutable pre-takeover argv first, verify it, then revoke authority.
  // SSD files are retained because deleting a user-selected directory would be
  // a separate destructive action.
  app.post("/api/local/unmanage", mutateConfig, (req, res) => queueConfigMutation(async () => {
    const id = String(req.body?.hostId || "").trim();
    if (!id) return res.status(400).json({ error: { type: "host", message: "A managed local host id is required." } });
    try {
      let registry = await readLocalHostRegistry(services.localHostRegistryFile);
      const record = registry.hosts[id];
      if (!record) return res.status(404).json({ error: { type: "not_managed", message: "That local host is not under ModelDock management." } });
      const releaseTransition = services.localHostRuntime?.beginTransition?.() || (() => {});
      let result;
      try {
        const operations = (services.createLocalHostLifecycleOperations || createLocalHostLifecycleOperations)({
          hostId: id,
          endpoint: record.endpoint,
          registryFile: services.localHostRegistryFile,
          discover: () => (services.discoverEngines || discoverLocalEngines)({}),
          runtime: services.localHostRuntime,
          logDir: services.engineLogDir || stateFile("engine-logs"),
        });
        // activeSpec === null is the failed-first-takeover shape: ModelDock
        // never replaced the original process, so there is nothing to restore
        // via apply/drain - routing it through applyLocalHostPlan put the
        // record into "draining" against a process this gateway never touched
        // (and, before the runner guard, stranded it there). Re-verify the
        // pre-takeover command and release management directly, exactly like
        // the never-changed case below.
        if (record.activeSpec === null || JSON.stringify(record.activeSpec) === JSON.stringify(record.preTakeoverSpec)) {
          const verification = await operations.verify(record.preTakeoverSpec, {
            ...record,
            desiredSpec: record.preTakeoverSpec,
            desiredProfile: null,
          });
          if (!(verification === true || verification?.ok === true)) {
            throw new Error("The pre-takeover llama.cpp command is not serving and cannot be released safely.");
          }
          result = { outcome: "applied", record };
        } else {
          result = await applyLocalHostPlan(record, { desiredSpec: record.preTakeoverSpec, desiredProfile: null }, operations);
        }
        if (result.outcome !== "applied") {
          recordConfigAction(metrics, "local_unmanage", { ok: false, outcome: result.outcome });
          return res.status(502).json({
            error: { type: "restore_failed", message: "The pre-takeover llama.cpp command did not verify, so host control remains active." },
          });
        }
        const current = (await (services.discoverEngines || discoverLocalEngines)({}))
          .find((candidate) => candidate.engine === "llamacpp" && sameLocalHost(candidate.baseUrl, record.endpoint));
        await publishManagedLocalEngine(services, result.record, current);
        registry = await readLocalHostRegistry(services.localHostRegistryFile);
        await writeLocalHostRegistry(services.localHostRegistryFile, removeLocalHost(registry, id));
        services.localHostRuntime?.invalidate?.();
      } finally {
        releaseTransition();
      }
      recordConfigAction(metrics, "local_unmanage", { ok: true });
      return res.json({ released: true, hostId: id, restoredPreTakeover: true });
    } catch (error) {
      recordConfigAction(metrics, "local_unmanage", { ok: false, error: error.message });
      return res.status(502).json({ error: { type: "local_unmanage_failed", message: error.message } });
    }
  }));

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
    let managed = null;
    if (engine === "llamacpp") {
      try {
        const registry = await readLocalHostRegistry(services.localHostRegistryFile);
        managed = Object.values(registry.hosts).find((record) => record.adapterId === "llamacpp-nvidia") || null;
      } catch {
        managed = null;
      }
    }
    const remembered = engine === "ollama"
      ? readOllamaSnapshot(services.ollamaSnapshotFile)?.launch
      : (CONNECTABLE_ENGINES.includes(engine)
        ? managed?.activeSpec || rememberedLaunch(engine, services.localEnginesFile || localEnginesSnapshotPath())
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
    if (managed?.activeSpec) {
      const releaseTransition = services.localHostRuntime?.beginTransition?.() || (() => {});
      try {
        const operations = (services.createLocalHostLifecycleOperations || createLocalHostLifecycleOperations)({
          hostId: managed.id,
          endpoint: managed.endpoint,
          registryFile: services.localHostRegistryFile,
          discover: () => (services.discoverEngines || discoverLocalEngines)({}),
          runtime: services.localHostRuntime,
          logDir: services.engineLogDir || stateFile("engine-logs"),
        });
        const result = await applyLocalHostPlan(managed, {
          desiredSpec: managed.activeSpec,
          desiredProfile: managed.activeProfile,
        }, operations);
        const current = (await (services.discoverEngines || discoverLocalEngines)({}))
          .find((candidate) => candidate.engine === "llamacpp" && sameLocalHost(candidate.baseUrl, managed.endpoint));
        await publishManagedLocalEngine(services, result.record, current);
        await services.localHostRuntime?.refresh?.(result.record);
        const ok = result.outcome === "applied";
        recordConfigAction(metrics, "local_restart_llamacpp", { ok, outcome: result.outcome });
        return res.status(ok ? 200 : 502).json({
          engine,
          started: ok,
          outcome: result.outcome,
          restoredPreTakeover: result.outcome === "recovered",
        });
      } catch (error) {
        recordConfigAction(metrics, "local_restart_llamacpp", { ok: false, error: error.message });
        return res.status(502).json({ error: { type: "launch_failed", message: error.message } });
      } finally {
        releaseTransition();
      }
    }
    try {
      const { logFile } = spawnEngineDetached({
        binary: remembered.binary,
        args: remembered.args,
        engine,
        // Under the state dir, not os.tmpdir(): /tmp is sticky-bit shared on
        // POSIX, so another user can pre-own /tmp/modeldock and point
        // engine-<name>.log at a symlink - an append-as-this-user primitive.
        // ~/.modeldock is already ours alone.
        logDir: services.engineLogDir || stateFile("engine-logs"),
      });
      recordConfigAction(metrics, `local_restart_${engine}`, { ok: true });
      return res.json({ engine, started: true, binary: remembered.binary, logFile });
    } catch (error) {
      recordConfigAction(metrics, `local_restart_${engine}`, { ok: false, error: error.message });
      return res.status(502).json({ error: { type: "launch_failed", message: error.message } });
    }
  });

  app.post("/api/local/apply", mutateConfig, (_req, res) => res.status(410).json({
    error: {
      type: "managed_only",
      message: "Manual local-engine tuning has been replaced by automatic host management. Connect the engine, then enable host control.",
    },
  }));

  app.post("/api/local/disconnect", mutateConfig, async (req, res) => {
    const { engine } = req.body || {};
    if (!CONNECTABLE_ENGINES.includes(engine)) {
      return res.status(400).json({ error: { type: "engine", message: `Unknown local engine: ${engine}` } });
    }
    if (engine === "llamacpp") {
      const registry = await readLocalHostRegistry(services.localHostRegistryFile);
      if (Object.values(registry.hosts).some((record) => record.adapterId === "llamacpp-nvidia")) {
        return res.status(409).json({
          error: {
            type: "host_managed",
            message: "Leave host control before disconnecting the managed llama.cpp route.",
          },
        });
      }
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
      // Only a definitive OAuth rejection (auth.x.ai answering 4xx) ends the
      // session. A network failure or a 5xx keeps the refresh token and the
      // published models; the timer retries in ten minutes, and an expired
      // bearer 401s until then - recoverable, unlike a deleted refresh token.
      if (isDefinitiveAuthRejection(error)) {
        clearXaiAuth(file);
        publishXai(null);
      }
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
  // Coalesced, not per event: one relay emits "change" at least three times
  // (begin, first response, finish), and every broadcast serializes the full
  // status snapshot for each connected dashboard. 100ms folds a request's
  // burst into one frame; the dashboard's own render loop already coalesces
  // at 150ms, so nothing visible slows down.
  let broadcastTimer = null;
  metrics.on("change", () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      broadcast();
    }, 100);
    broadcastTimer.unref?.();
  });
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
  outer.use(zstdRequestDecoder({ callerKey: services.callerKey, metrics: services.metrics }));
  outer.use(app);
  // createMcpExpressApp owns the JSON parser. Its 25 MB rejection is raised
  // after the inner app runs, so record the same anonymous diagnostics here.
  outer.use((error, req, res, next) => {
    if (error?.status !== 413 && error?.statusCode !== 413 && error?.type !== "entity.too.large") return next(error);
    const limit = Number.isFinite(error.limit) ? error.limit : 25 * 1024 * 1024;
    const received = Number.isFinite(error.length) ? error.length : null;
    const diagnostics = payloadTooLargeDiagnostics({
      encoding: String(req.headers["content-encoding"] || "identity").toLowerCase(),
      reason: "json_request",
      wireBytes: received,
      wireLimitBytes: limit,
      decodedBytes: received,
      decodedLimitBytes: limit,
    });
    if (res.headersSent) return next(error);
    return sendPayloadTooLarge(
      res,
      services.metrics,
      diagnostics,
      `JSON request body exceeds the ${limit}-byte limit`,
    );
  });
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

async function reconcileLocalHostsOnBoot(services) {
  let registry;
  try {
    registry = await readLocalHostRegistry(services.localHostRegistryFile);
  } catch (error) {
    console.log(`[gate] local host boot reconciliation skipped: ${error.message}`);
    return;
  }
  for (const record of Object.values(registry.hosts)) {
    if (!["draining", "applying", "verifying", "recovering"].includes(record.state)) continue;
    let releaseTransition;
    try {
      releaseTransition = services.localHostRuntime?.beginTransition?.() || (() => {});
      const operations = (services.createLocalHostLifecycleOperations || createLocalHostLifecycleOperations)({
        hostId: record.id,
        endpoint: record.endpoint,
        registryFile: services.localHostRegistryFile,
        discover: () => (services.discoverEngines || discoverLocalEngines)({}),
        runtime: services.localHostRuntime,
        logDir: services.engineLogDir || stateFile("engine-logs"),
      });
      const result = await reconcileInterruptedLocalHost(record, operations);
      const current = (await (services.discoverEngines || discoverLocalEngines)({}))
        .find((candidate) => candidate.engine === "llamacpp" && sameLocalHost(candidate.baseUrl, record.endpoint));
      await publishManagedLocalEngine(services, result.record, current);
      await services.localHostRuntime?.refresh?.(result.record);
      console.log(`[gate] local host ${record.id} boot reconciliation: ${result.outcome}`);
    } catch (error) {
      console.log(`[gate] local host ${record.id} boot reconciliation failed: ${error.message}`);
    } finally {
      releaseTransition?.();
    }
  }
}

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
  void reconcileLocalHostsOnBoot(instance.services);
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) && process.argv.includes("--verify-gateway")) {
  process.exit(await runGatewayVerifierCli());
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

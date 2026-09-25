import path from "node:path";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import zlib from "node:zlib";
import { Decompress as ZstdFallbackDecoder } from "fzstd";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { ownsEnvFile, parseEnvFile, loadConfig, publicConfig, writeEnvFile, envFileFor, migrateEnvSecrets, isPlaceholderToken, envOff, encodePersistedModelRef } from "./config.mjs";
import { catalogFor } from "./catalog.mjs";
import { nativeModelSlugs, refreshNativeCatalog } from "./native-catalog.mjs";
import { MediaStore } from "./media-store.mjs";
import { CodexAttachmentIndex } from "./codex-attachment-index.mjs";
import { Metrics } from "./metrics.mjs";
import { NATIVE_AUXILIARY_PATHS, relayNativeAuxiliary, relayResponses as relayGatewayResponses } from "./gateway.mjs";
import { createUpstreams } from "./upstreams.mjs";
import { createMcpNodeHandler, recordMcpError } from "./mcp.mjs";
import { memoryStoreFor } from "./memory.mjs";
import { bindMemoryScope, verifiedMemoryScope, withoutMemoryMutations } from "./memory-scope.mjs";
import { CodexConfigSwitcher } from "./config-switcher.mjs";
import { createAutostart } from "./autostart.mjs";
import { createUpdater, localVersion, restartInstalledService } from "./update.mjs";
import { createDerivedFallback } from "./derived-fallback.mjs";
import { clearOwnerFile, describeOwnerConflict, writeOwnerFile } from "./instance-owner.mjs";
import { runGatewayVerifierCli } from "../scripts/gateway-verifier.mjs";
import { CALLER_PATH_PREFIX, callerBasePath, callerKeyEqual, callerRootPath, loadOrCreateCallerKey } from "./caller-key.mjs";
import { SessionNames } from "./session-names.mjs";
import { validateProviderToken } from "./token-validate.mjs";
import { RouteAffinity } from "./router.mjs";
import { applyXaiProfile, allProfiles, credentialProfiles, DEFAULT_PROFILE_ID, applyCustomProfile, effectiveContextWindow, applyLocalEngineProfile, publishedCatalogFingerprint, applyOllamaProfile, bareModelId, LLAMACPP_LOCAL_MODEL_LABEL, LLAMACPP_LOCAL_SLUG, llamaLocalStableEntry, modelAddressFor, modelRefParts, profileOptions, profileById, providerForModel, routedModelRefFor, tokenFor, upstreamTargetFor } from "./profiles.mjs";
import { canonicalLlamaLocalKey, foldLlamaLocalKeys } from "./model-identity.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";
import { sameEndpointHost as sameLocalHost, urlHost } from "./loopback.mjs";
import { createServices } from "./services.mjs";
// Re-exported: tests and embedders construct the service bag through
// server.mjs, and that path stays stable across the services split.
export { createServices };
import { anyProviderRouteConfigured, canonicalModelRefOf, codexModelCatalog, labelForModelId, modelCatalogModels, modelInventory, modelOptions, modelOwnerOf, providerModels, providerOptions, providerRouteConfigured, publishedModelIds, visionOptionsAcrossProviders } from "./model-options.mjs";
import { SUBAGENT_DEFAULT_MODEL, readSubagentModel, subagentModelOptions, subagentProviders, writeSubagentAgentFile } from "./subagent-config.mjs";
import { NATIVE_PROVIDER } from "./native-provider.mjs";
// Re-exported: tests and the config switcher import the catalog through
// server.mjs, and that path stays stable across the model-options split.
export { codexModelCatalog };
import { CustomEndpointError, listEndpointModels, normalizeBaseUrl, probeCustomEndpoint, probeCustomResponses } from "./custom-endpoint.mjs";
import { LEGACY_CUSTOM_ENV_KEYS, migrateLegacyCustomEndpoint, CustomEndpointsError, addCustomEndpoint, customEndpointsPath, readCustomEndpoints, removeCustomEndpoint, writeCustomEndpoints } from "./custom-endpoints.mjs";
import { customEndpointFor } from "./custom-endpoint-routing.mjs";
import { OLLAMA_DEFAULT_BASE, OllamaError, clearOllamaSnapshot, listOllamaModels, normalizeOllamaBase, ollamaSnapshotPath, probeOllamaResponses, readOllamaSnapshot, writeOllamaSnapshot } from "./ollama.mjs";
import { usageEventsPath } from "./usage-events.mjs";
import { attachSseKeepAlive } from "./sse.mjs";
import { applyContextOverrides, contextOverridesPath, readContextOverrides, validateContextWindow, writeContextOverrides } from "./context-overrides.mjs";
import { applyVisionOverrides, readVisionOverrides, visionOverridesPath, writeVisionOverrides } from "./vision-overrides.mjs";
import { isModelPublished, modelTogglesPath, readModelToggles, selectedModelSlugs, writeModelToggles } from "./model-toggles.mjs";
import { modelsToPark, shouldTidy, stampFirstSeen } from "./model-tidy.mjs";
import { modelLifecyclePath, readLifecycle, writeLifecycle } from "./model-lifecycle-state.mjs";
import { canonicalUsageModelId, foldUsageFile, readRollup, rollupKey, rollupTotals, usageRollupPath, usageStats, writeRollup } from "./usage-rollup.mjs";
import { probeGpus } from "./gpu.mjs";
import { launchSpecFrom, spawnEngineDetached } from "./engine-processes.mjs";
import { launchSpecForPort, rememberedLaunch, ENGINE_LABELS as LOCAL_ENGINE_LABELS, CONNECTABLE_ENGINES, readLocalEnginesSnapshot, LocalEngineError, assertLocalBase, clearLocalEngineSnapshot, discoverLocalEngines, localEnginesSnapshotPath, writeLocalEngineSnapshot, modelFactsFor } from "./local-engines.mjs";
import { localEngineDefinitions } from "./local-engine-definitions.mjs";
import { XAI_API_BASE, XaiAuthError, accessTokenExpired, clearXaiAuth, isDefinitiveAuthRejection, listXaiModels, pollDeviceToken, readXaiAuth, refreshAccessToken, startDeviceAuthorization, writeXaiAuth, xaiAuthPath } from "./xai-auth.mjs";
import { recordSettingsEvent } from "./settings-events.mjs";
import { stateDir as resolveStateDir, stateFile } from "./state-dir.mjs";
import staticFiles from "./static-inline.mjs";
import {
  DEFAULT_ZSTD_MEMORY_BUDGET_BYTES,
  WeightedByteBudget,
  ZSTD_COMPRESSED_HARD_LIMIT_BYTES,
  ZSTD_DECODED_HARD_LIMIT_BYTES,
  zstdParseChargeBytes,
  zstdParsedBodyChargeBytes,
  zstdReceiveChargeBytes,
} from "./zstd-ingress-budget.mjs";

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
  ".svg": "image/svg+xml; charset=utf-8",
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

function llamaLaunchArgument(launch, spellings) {
  const args = Array.isArray(launch?.args) ? launch.args : [];
  const index = args.findIndex((value) => spellings.includes(value));
  return index >= 0 ? String(args[index + 1] || "").trim() : "";
}

// One projection owns the catalog-facing model facts learned from a local
// engine. Connect, live refresh, and managed restart may observe those facts at
// different times, but none of them may maintain a private field mapping.
function projectLocalModel(current, {
  modelFacts = null,
  upstreamId = "",
  supportsVision,
  chatTemplateSupportsObjectArguments,
  mediaMarker,
  contextWindow = 0,
} = {}) {
  // Old managed snapshots carried a 70-percent cap. Local compaction now
  // derives from the effective catalog window through the shared rule.
  const { autoCompactTokenLimit: retiredCompactLimit, ...model } = current;
  return {
    ...model,
    ...(modelFacts?.modelSlug ? { id: modelFacts.modelSlug } : {}),
    ...(modelFacts?.modelName ? { label: modelFacts.modelName } : {}),
    ...(upstreamId ? { upstreamId } : {}),
    ...(typeof supportsVision === "boolean" ? { supportsVision } : {}),
    ...(typeof chatTemplateSupportsObjectArguments === "boolean"
      ? { chatTemplateSupportsObjectArguments }
      : {}),
    ...(typeof mediaMarker === "string" ? { mediaMarker } : {}),
    ...(contextWindow > 0 ? { contextWindow } : {}),
  };
}

// Pick one complete route for ON mode. The current provider wins when it is
// usable; otherwise the first configured provider becomes active. Vision is
// an independent saved preference, not a derivative of the main provider.
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
  // Keep the exact identity, including deliberate None. Resolving a native
  // bare slug through the legacy routed-provider helper changed Luna into
  // Luna@opencode-go and then overwrote .env. Availability may change during
  // sign-in/catalog refresh; it is not permission to replace a saved choice.
  let visionModel = modelSelection.visionModel || "";
  if (!config.visionModelConfigured) {
    const available = visionOptionsAcrossProviders(config, providerId);
    visionModel = (available.find((entry) => entry.id === visionModel)
      || available.find((entry) => entry.provider === providerId) || available[0])?.id || "";
  }
  return {
    providerId,
    profile: profileById(providerId),
    mainModel: routedModelRefFor(providerId, main),
    visionModel,
  };
}

function unavailableSavedModel(config, id, { supportsVision = false } = {}) {
  const native = !modelRefParts(id).qualified;
  return {
    id,
    label: `${labelForModelId(bareModelId(id))} (saved - currently unavailable)`,
    provider: native ? NATIVE_PROVIDER.id : modelOwnerOf(config, id),
    native,
    supportsVision,
    status: "unavailable",
  };
}

function canShowUnavailableSavedModel(config, id) {
  return config.visionModelConfigured || modelRefParts(id).qualified || hasChatGptLogin(config.codexHome);
}

function modelsPayload(services) {
  let options = modelOptions(services.config, services.config.profileId);
  const selected = services.modelSelection;
  if (selected.visionModel
      && !options.some((entry) => entry.id === selected.visionModel)
      && canShowUnavailableSavedModel(services.config, selected.visionModel)) {
    options = [unavailableSavedModel(services.config, selected.visionModel, { supportsVision: true }), ...options];
  }
  const selectedVisionEntry = options.find((entry) => entry.id === selected.visionModel);
  const visionOptions = options.filter((entry) => entry.supportsVision);
  const visionProviders = providerOptions(services.config).filter((provider) => visionOptions.some((model) => model.provider === provider.id));
  // Native vision models are only published while signed in; without their
  // provider in the list the vision picker can see the models but never pick
  // one. The native provider is not a routed profile, so it is appended here
  // rather than in providerOptions (which would leak it into non-vision lists).
  if (visionOptions.some((model) => model.provider === NATIVE_PROVIDER.id)) visionProviders.push(NATIVE_PROVIDER);
  return {
    selected,
    options,
    // Monotonic within one gateway process and reset-safe across restarts: an
    // open dashboard only compares it with the last status frame it received.
    // The value changes exclusively when the canonical catalog file changes.
    catalogRevision: services.modelCatalogRevision || 0,
    providers: providerOptions(services.config),
    // Derive the provider from the model actually selected, the same way the
    // vision and subagent pickers do. Reporting config.profileId here let the two
    // drift apart: selecting a custom/ollama model as main updates mainModel but
    // never touches profileId, so the dashboard rendered impossible pairs of
    // a provider and a model. profileId remains the fallback for a model the
    // catalog cannot place.
    selectedProvider: modelOwnerOf(services.config, selected.mainModel) || services.config.profileId || DEFAULT_PROFILE_ID,
    visionProviders,
    selectedVisionProvider: selected.visionModel ? selectedVisionEntry?.provider || services.config.profileId : "",
  };
}

// Reconcile picker state after a provider or endpoint is removed. Every
// disconnect path calls this one projection after updating the provider
// registry; none may keep its own idea of which selected models still exist.
function reconcileModelSelection(services) {
  const { config, modelSelection } = services;
  const options = modelOptions(config, config.profileId);
  const byId = new Map(options.map((entry) => [entry.id, entry]));
  const currentMain = canonicalModelRefOf(config, modelSelection.mainModel);
  const currentVision = canonicalModelRefOf(config, modelSelection.visionModel);
  const fallback = byId.has(currentMain) ? null : onModeSelection(services);
  const mainModel = byId.has(currentMain) ? currentMain : fallback?.mainModel || "";
  const visionModel = currentVision && byId.get(currentVision)?.supportsVision ? currentVision : "";
  const visionChanged = visionModel !== modelSelection.visionModel;

  modelSelection.mainModel = mainModel;
  modelSelection.visionModel = visionModel;
  const configuredMain = canonicalModelRefOf(config, config.mainModel);
  config.mainModel = byId.has(configuredMain) ? configuredMain : mainModel;
  config.visionModel = visionModel;
  if (visionChanged) {
    writeEnvFile({ MODELDOCK_VISION_MODEL: visionModel ? encodePersistedModelRef(visionModel) : "none" }, config.envFile);
    config.visionModelConfigured = true;
  }
  return { mainModel, visionModel, visionChanged };
}

function providerLabelFor(provider) {
  if (provider === NATIVE_PROVIDER.id) return NATIVE_PROVIDER.label;
  return allProfiles().find((entry) => entry.id === provider)?.label || provider;
}

// One route projection feeds readiness, provider label, endpoint and wire in
// the dashboard. Those fields used to be derived independently, which allowed
// a Command Code Chat route to be displayed as OpenCode Responses and a native
// GPT selection to inherit the active external provider's URL.
function modelRouteProjection(config, model) {
  const provider = modelOwnerOf(config, model);
  if (provider === NATIVE_PROVIDER.id) {
    return {
      provider,
      providerLabel: NATIVE_PROVIDER.label,
      upstreamUrl: "",
      wire: "responses",
      ready: hasChatGptLogin(config.codexHome),
    };
  }
  const target = upstreamTargetFor(config, model);
  const profile = profileById(target.provider);
  return {
    provider: target.provider,
    providerLabel: providerLabelFor(target.provider),
    upstreamUrl: target.baseUrl,
    wire: target.transport || "responses",
    ready: Boolean(profile && (profile.keyless || tokenFor(config, model))),
  };
}

// Metering stores the provider-qualified wire id so usage remains unambiguous
// even when two providers serve a similarly named model. The Stats page should
// still use the same friendly label as the Models page. Resolve only ids that
// appear in this bounded snapshot: historical traffic stays visible without
// turning /api/stats into a copy of the full catalog.
function statsModelDirectory(services) {
  const labels = new Map();
  const remember = (id, label) => {
    const key = canonicalUsageModelId(id);
    const value = String(label || "").trim();
    if (!key || !value) return;
    const existing = labels.get(key) || "";
    // Prefer the complete canonical name (for example GPT-5.6-Luna over Luna)
    // when providers give the same model family different display labels.
    if (!existing || value.length > existing.length) labels.set(key, value);
  };
  // Include temporarily disconnected and hidden entries so historical traffic
  // keeps a human name without making those models selectable. Identity and
  // labels come from the same inventory used by every picker.
  for (const entry of modelInventory(services.config)) {
    const id = entry.native ? modelAddressFor(NATIVE_PROVIDER.id, entry.id) : entry.id;
    remember(id, entry.label || entry.id);
  }
  // The stable local entry keeps its "llama.cpp (local)" label even while no
  // engine is connected: folded history still needs the human name, and the
  // inventory above is empty for a provider with nothing published.
  remember(LLAMACPP_LOCAL_SLUG, LLAMACPP_LOCAL_MODEL_LABEL);
  return {
    labelFor: (id) => labels.get(id) || "",
  };
}

function statsModelLabels(directory, stats) {
  const used = new Set(stats?.modelLegend || []);
  for (const period of Object.values(stats?.modelPeriods || {})) {
    for (const model of period?.models || []) used.add(model?.id);
  }
  const out = {};
  for (const id of used) {
    const label = directory.labelFor(id);
    if (id && id !== "__other__" && label) out[id] = label;
  }
  return out;
}

function subagentPayload(services) {
  let options = subagentModelOptions(services.config);
  const saved = readSubagentModel(services.config);
  const selected = saved || SUBAGENT_DEFAULT_MODEL;
  let selectedEntry = options.find((entry) => entry.id === selected);
  if (saved && !selectedEntry && canShowUnavailableSavedModel(services.config, saved)) {
    selectedEntry = unavailableSavedModel(services.config, saved);
    options = [selectedEntry, ...options];
  }
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
  if (!Array.isArray(saved) || saved.length !== 1 || !advertised) return null;
  const current = saved[0];
  const next = projectLocalModel(current, {
    modelFacts: name && slug ? { modelName: name, modelSlug: slug } : null,
    upstreamId: advertised,
    // llama.cpp exposes these on /props. They must overwrite an earlier
    // observation in either direction, especially vision after --mmproj is
    // removed. Other engines do not publish this contract.
    supportsVision: engine?.engine === "llamacpp" ? engine.supportsVision : undefined,
    chatTemplateSupportsObjectArguments: engine?.engine === "llamacpp"
      ? engine.chatTemplateSupportsObjectArguments
      : undefined,
    mediaMarker: engine?.engine === "llamacpp" ? engine.mediaMarker : undefined,
  });
  if (JSON.stringify(current) === JSON.stringify(next)) return null;
  // A swapped file is a real event even when the published identity hides it:
  // the drawer facts reset against the new fingerprint. Silent in the log
  // meant "the engine changed and nothing said why."
  if ((current.upstreamId || "") !== (next.upstreamId || "")) {
    const base = (value) => String(value || "").replace(/\\/g, "/").split("/").pop() || "unknown";
    console.log(`[gate] local engine model changed: ${base(current.upstreamId)} -> ${base(next.upstreamId)}; the published entry stays stable.`);
  }
  return {
    ...snapshot,
    models: [next],
  };
}

async function discoveredLocalEngine(services, engine, baseUrl = "") {
  const found = await (services.discoverEngines || discoverLocalEngines)({});
  return found.find((candidate) => candidate.engine === engine
    && (!baseUrl || sameLocalHost(candidate.baseUrl, baseUrl))) || null;
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
  // Which provider owns the selected main model is a display fact, and the picker
  // already answers it from the published catalog. Deriving it a second way here
  // (providerForModel, which resolves the routing question and always returns an
  // answer) let the route card and the picker disagree about the same model.
  // Routing itself uses the provider registry's canonical target projection.
  const models = modelsPayload(services);
  const mainRoute = modelRouteProjection(config, selected.mainModel);
  const visionRoute = selected.visionModel ? modelRouteProjection(config, selected.visionModel) : null;
  const mainProvider = mainRoute.provider;
  const mainTokenReady = mainRoute.ready;
  // The route card shows the most recent actual request first, falling back to
  // the dashboard selection. Native passthrough (reason "native_passthrough")
  // never rewrites modelSelection, so without this the card would keep showing
  // the last relayed model while native traffic runs.
  const lastRequest = services.latestMainRoute?.();
  const routeModel = lastRequest?.model || selected.mainModel;
  const routeProvider = lastRequest?.provider || mainProvider;
  const routeProviderLabel = providerLabelFor(routeProvider);
  return metrics.snapshot({
    ready: mainTokenReady,
    config: {
      ...publicConfig({ ...config, mainModel: selected.mainModel, visionModel: selected.visionModel }),
      // Selection-aware routing facts for the route card and forwarding map: which
      // provider owns the selected main model, which base URL and wire style it hits.
      mainProvider,
      routeModel,
      routeProvider,
      routeProviderLabel,
      mainProviderLabel: mainRoute.providerLabel,
      mainUpstreamUrl: mainRoute.upstreamUrl,
      mainWire: mainRoute.wire,
      visionUpstreamUrl: visionRoute?.upstreamUrl || "",
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
  const primaryCustomEndpoint = config.customEndpoints?.[0] || null;
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
    providers: credentialProfiles()
      .map((profile) => ({
        id: profile.id,
        label: profile.label,
        settingsField: profile.settingsField,
        tokenConfigured: Boolean(config.tokens?.[profile.id]),
      })),
    custom: {
      baseUrl: primaryCustomEndpoint?.baseUrl || "",
      model: primaryCustomEndpoint?.modelId || "",
      apiKeyConfigured: Boolean(primaryCustomEndpoint?.apiKey),
      asVision: Boolean(primaryCustomEndpoint?.supportsVision),
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

function localDashboardOrigins(config) {
  return new Set([
    `http://${urlHost(config.host)}:${config.port}`,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ]);
}

function configMutationGuard(config, callerKey) {
  const allowedOrigins = localDashboardOrigins(config);
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
  const allowedOrigins = localDashboardOrigins(config);
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
  const abortRelay = () => {
    if (!res.writableFinished) controller.abort();
  };
  // A client can disappear before Node closes the response socket. Watch the
  // incoming request too, but only its explicit abort event: request "close"
  // also happens after a normal fully-read request body.
  req.once("aborted", abortRelay);
  res.once("close", abortRelay);
  try {
    const result = await relayGatewayResponses(req.body, res, {
      config,
      metrics,
      mediaStore,
      routeAffinity,
      knownModels: publishedModelIds(config),
      nativeSlugs: services.nativeSlugs,
      nativeSelectableModels: services.nativeSelectableModels,
      mainModel: modelSelection?.mainModel || config.mainModel,
      visionModel: modelSelection?.visionModel || config.visionModel,
      // The native passthrough leg forwards these to ChatGPT's backend untouched.
      incomingHeaders: req.headers,
      // zstdRequestDecoder preserves the original compressed and decoded sizes
      // before Express sees an identity JSON body. The gateway must receive those
      // values instead of inferring a second serialized copy for metrics.
      ingressBytes: req.modeldockIngressBytes,
      requestUrl: req.originalUrl,
      usageEventsFile: services.usageEventsFile,
      signal: controller.signal,
    });
    services.recordLatestMainRoute?.(result);
    if (result?.route?.reason === "client_selected" && modelSelection && result.route.model !== modelSelection.mainModel) {
      modelSelection.mainModel = result.route.model;
    }
    return result;
  } finally {
    req.removeListener("aborted", abortRelay);
    res.removeListener("close", abortRelay);
  }
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
  return pathname.startsWith("/v1/")
    || pathname === "/v1"
    || pathname === "/responses"
    || pathname === "/responses/compact"
    || [...NATIVE_AUXILIARY_PATHS].includes(pathname);
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

function sendDecodeBudgetExhausted(res, metrics, memoryBudget, requestedBytes) {
  const diagnostics = {
    budgetBytes: memoryBudget.capacityBytes,
    reservedBytes: memoryBudget.usedBytes,
    requestedBytes,
  };
  const finish = metrics?.begin?.("responses", {
    operation: "decode_budget_exhausted",
    payloadDiagnostics: diagnostics,
  });
  finish?.({
    ok: false,
    httpStatus: 503,
    error: "zstd ingress memory budget is busy.",
  });
  res.setHeader("Retry-After", "1");
  return res.status(503).json({
    error: {
      type: "decode_budget_exhausted",
      message: "zstd ingress memory budget is busy; retry shortly.",
      diagnostics,
    },
  });
}

function zstdRequestDecoder({ callerKey, metrics, memoryBudget }) {
  // Both one-request protocol limits are 64 MiB. Aggregate process exposure is
  // bounded separately by memoryBudget, which follows each request from receive
  // through response completion and shrinks after its real size is known.
  const maxInput = ZSTD_COMPRESSED_HARD_LIMIT_BYTES;
  const maxOutput = ZSTD_DECODED_HARD_LIMIT_BYTES;
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
    const declaredWireBytes = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredWireBytes) && declaredWireBytes > maxInput) {
      return sendPayloadTooLarge(
        res,
        metrics,
        payloadTooLargeDiagnostics({
          encoding: "zstd",
          reason: "compressed_request",
          wireBytes: declaredWireBytes,
          wireLimitBytes: maxInput,
          decodedLimitBytes: maxOutput,
        }),
        `zstd request body exceeds the ${maxInput}-byte limit`,
      );
    }
    const initialWireBytes = Number.isSafeInteger(declaredWireBytes) && declaredWireBytes >= 0
      ? declaredWireBytes
      : 0;
    const initialChargeBytes = zstdReceiveChargeBytes(initialWireBytes);
    const reservation = memoryBudget.tryReserve(initialChargeBytes);
    if (!reservation) {
      return sendDecodeBudgetExhausted(res, metrics, memoryBudget, initialChargeBytes);
    }
    let reservationReleased = false;
    const releaseReservation = () => {
      if (reservationReleased) return;
      reservationReleased = true;
      reservation.release();
    };
    res.once("finish", releaseReservation);
    res.once("close", releaseReservation);
    const chunks = [];
    let received = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected || reservationReleased) return;
      received += chunk.length;
      if (received > maxInput) {
        rejected = true;
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
      const receiveChargeBytes = zstdReceiveChargeBytes(received);
      if (!reservation.resize(receiveChargeBytes)) {
        rejected = true;
        sendDecodeBudgetExhausted(res, metrics, memoryBudget, receiveChargeBytes);
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (error) => {
      releaseReservation();
      next(error);
    });
    req.on("end", () => {
      if (rejected || reservationReleased) return;
      const compressed = Buffer.concat(chunks);
      const onDecoded = (error, body) => {
        if (reservationReleased) return;
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
          const parseChargeBytes = zstdParseChargeBytes(compressed.length, body.length);
          if (!reservation.resize(parseChargeBytes)) {
            return sendDecodeBudgetExhausted(res, metrics, memoryBudget, parseChargeBytes);
          }
          req.headers["content-encoding"] = "identity";
          req.headers["content-length"] = String(body.length);
          // Preserve both measurements before exposing the decoded body to the
          // regular JSON routes. The rewritten headers describe logical JSON;
          // they must not erase the compressed bytes Codex actually sent.
          req.modeldockIngressBytes = { wireBytes: compressed.length, logicalBytes: body.length };
          req.body = JSON.parse(body.toString("utf8"));
          const parsedBodyChargeBytes = zstdParsedBodyChargeBytes(body.length);
          if (!reservation.resize(parsedBodyChargeBytes)) {
            return sendDecodeBudgetExhausted(res, metrics, memoryBudget, parsedBodyChargeBytes);
          }
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

  const mcpScope = new AsyncLocalStorage();
  const readOnlyMcpHandler = createMcpNodeHandler({
    upstreams: withoutMemoryMutations(upstreams),
    onError: (error) => recordMcpError(metrics, error),
  });
  const scopedMcpHandler = createMcpNodeHandler({
    upstreams: bindMemoryScope(upstreams, () => mcpScope.getStore()),
    onError: (error) => recordMcpError(metrics, error),
  });

  // Capability-key routes: the base_url written into config.toml carries the key
  // (/c/<key>/v1), so Codex authenticates implicitly while a hostile local web
  // page (which can POST to loopback but cannot read ~/.modeldock) cannot.
  const requireCallerKey = (req, res, next) => {
    if (services.callerKey && callerKeyEqual(req.params.key, services.callerKey)) return next();
    return res.status(401).json({ error: { type: "invalid_caller_key", message: "Unknown caller key; re-enable the Codex switch to refresh the URL." } });
  };
  const guardMcpOrigin = crossOriginGuard(config);
  app.all(`${CALLER_PATH_PREFIX}/:key/mcp`, guardMcpOrigin, requireCallerKey, (req, res) => {
    const scope = verifiedMemoryScope(req.headers, services.callerKey);
    if (!scope) return readOnlyMcpHandler(req, res, req.body);
    return mcpScope.run(scope, () => scopedMcpHandler(req, res, req.body));
  });
  app.all("/mcp", guardMcpOrigin, (_req, res) => res.status(401).json({
    error: { type: "caller_key_required", message: "This MCP endpoint requires the keyed URL; re-enable the Codex switch." },
  }));
  app.post(`${CALLER_PATH_PREFIX}/:key/v1/responses`, requireCallerKey, (req, res) => relayGatewayRequest(req, res, services));
  app.post(`${CALLER_PATH_PREFIX}/:key/v1/responses/compact`, requireCallerKey, (req, res) => relayGatewayRequest(req, res, services));
  app.post(`${CALLER_PATH_PREFIX}/:key/responses/compact`, requireCallerKey, (req, res) => relayGatewayRequest(req, res, services));
  app.get(`${CALLER_PATH_PREFIX}/:key/v1/models`, requireCallerKey, (req, res) => serveModels(req, res, services));
  // Client-owned web search and image generation post auxiliary requests to the
  // configured openai_base_url. Those requests land here and go straight to the
  // native backend on the client's subscription (no Platform API key needed).
  const nativeAuxiliaryRelay = (req, res) => relayNativeAuxiliary(req.body, res, {
    incomingHeaders: req.headers,
    requestUrl: req.originalUrl,
    codexHome: config.codexHome,
    method: req.method,
  });
  app.post([...NATIVE_AUXILIARY_PATHS].map((item) => `${CALLER_PATH_PREFIX}/:key${item}`), requireCallerKey, nativeAuxiliaryRelay);
  // The managed base URL ends in /v1. Exact ModelDock routes above keep their
  // behavior; every other current or future Codex endpoint under that base is
  // an opaque native request. A new client-owned capability therefore does not
  // need a ModelDock path allowlist release.
  app.use(`${CALLER_PATH_PREFIX}/:key/v1`, requireCallerKey, nativeAuxiliaryRelay);
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
  const bareNativeAuxiliaryRelay = (req, res) => {
    if (callerKeyEnforced()) {
      return res.status(401).json({ error: { type: "caller_key_required", message: "This gateway requires the keyed base URL; re-enable the Codex switch." } });
    }
    return nativeAuxiliaryRelay(req, res);
  };
  app.post(["/v1/responses", "/responses"], bareRelay);
  app.post(["/v1/responses/compact", "/responses/compact"], bareRelay);
  app.post([...NATIVE_AUXILIARY_PATHS], bareNativeAuxiliaryRelay);
  app.get(["/v1/models", "/models"], (req, res) => serveModels(req, res, services));
  app.use("/v1", bareNativeAuxiliaryRelay);
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

  const localPostGuard = configMutationGuard(config, services.callerKey);
  let configMutationQueue = Promise.resolve();
  // One request-sized lease around every shared-state mutation. Keeping the
  // queue in middleware means a new mutation route cannot silently bypass it;
  // read-only POSTs use localPostGuard directly and never wait behind a restart.
  const serializeConfigMutation = (_req, res, next) => {
    const previous = configMutationQueue;
    let release;
    const lease = new Promise((resolve) => { release = resolve; });
    configMutationQueue = previous.then(() => lease, () => lease);
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once("finish", finish);
    res.once("close", finish);
    previous.then(next, next);
  };
  const mutateConfig = [localPostGuard, serializeConfigMutation];
  const configAction = (operation) => async (req, res) => {
    try {
      const result = await configSwitcher[operation]();
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
      const result = await (async () => {
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
            MODELDOCK_VISION_MODEL: onSelection.visionModel ? encodePersistedModelRef(onSelection.visionModel) : "none",
          };
          if (nativeMerge !== undefined) onEnv.MODELDOCK_NATIVE_MERGE = nativeMerge ? "1" : "0";
          writeEnvFile(onEnv, config.envFile);
          config.visionModelConfigured = true;
          if (nativeMerge !== undefined) config.nativeMerge = nativeMerge;
          services.writeCatalogFile();
        }
        recordConfigAction(metrics, `config_mode_${mode}`, { ok: true });
        return result;
      })();
      return res.json(result);
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
      tokenConfigured: Object.fromEntries(credentialProfiles().map((profile) => [
        profile.id,
        Boolean(config.tokens?.[profile.id]),
      ])),
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
    // The options list is the ownership contract: routed models include their
    // provider and native Codex models use their exact bare wire slug. Never
    // repair an unknown bare id through the active profile here; that was the
    // ambiguity that turned a saved native Luna choice into OpenCode Go Luna.
    // Persisted selections already carry their provider (or are native bare
    // ids). Preserve them exactly when this request changes only the other
    // selector; re-qualifying through the active profile silently changed
    // native Luna into routed OpenCode Luna on upgrade.
    let nextMain = req.body?.mainModel === undefined ? canonicalModelRefOf(config, current.mainModel) : req.body.mainModel;
    let nextVision = req.body?.visionModel === undefined ? canonicalModelRefOf(config, current.visionModel) : req.body.visionModel;
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
    // Main-model choice belongs to Codex's per-session picker. Vision is the
    // gateway's fallback policy, so a dashboard choice must survive a gateway
    // restart and its normal update restart. "none" is deliberate: an empty
    // .env value would be interpreted as a request for the shipped default.
    try {
      writeEnvFile({ MODELDOCK_VISION_MODEL: nextVision ? encodePersistedModelRef(nextVision) : "none" }, config.envFile);
    } catch (error) {
      recordConfigAction(metrics, "models_update", { ok: false, error: error.message });
      return res.status(500).json({ error: { type: "model_selection_write_failed", message: error.message } });
    }
    services.modelSelection.mainModel = nextMain;
    services.modelSelection.visionModel = nextVision;
    config.visionModel = nextVision;
    config.visionModelConfigured = true;
    recordSettingsEvent({ action: "vision_selection_update", providers: vision ? [vision.provider] : [], filePath: config.settingsEventsFile });
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
      // The running collaboration relay reads the managed role immediately;
      // Codex still needs the advertised restart to reload its agent registry.
      services.writeCatalogFile?.();
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
    try {
      // Config objects built by tests (and any future non-loadConfig wiring)
      // may lack the tokens map; the settings write must still work.
      config.tokens = config.tokens || {};
      for (const profile of credentialProfiles()) {
        if (!body[profile.settingsField]) continue;
        const token = String(body[profile.settingsField]).trim();
        providers.push(profile.id);
        const checked = validateProviderToken(profile.id, token);
        if (!checked.ok || isPlaceholderToken(token)) {
          throw Object.assign(
            new Error(checked.ok ? profile.settingsInvalidMessage : checked.error),
            { code: profile.settingsErrorCode },
          );
        }
        updates[profile.tokenEnvName] = checked.value;
      }
      if (body.exaApiKey) {
        const checked = validateProviderToken("exa", body.exaApiKey);
        if (!checked.ok) throw Object.assign(new Error(checked.error), { code: "invalid_exa_api_key" });
        // Keep the update atomic with the provider credentials: syntactically
        // valid keys are saved together and no hidden model request decides
        // whether one of them is worthy of persistence.
        updates.EXA_API_KEY = checked.value;
      }
      if (Object.keys(updates).length) {
        writeEnvFile(updates, config.envFile);
        for (const profile of credentialProfiles()) {
          if (updates[profile.tokenEnvName]) config.tokens[profile.id] = updates[profile.tokenEnvName];
        }
        if (updates.OPENCODE_GO_TOKEN) {
          // The per-provider map is the single token source; only the audit
          // "where did it come from" hint needs updating in-session.
          config.goTokenSource = "configured";
        }
        if (updates.EXA_API_KEY) config.exaApiKey = updates.EXA_API_KEY;
        // Directory discovery is only GET /models and stays out of the
        // settings critical path. Auth, quota, and model-protocol failures are
        // reported by the user's real selected-model request instead.
        services.refreshModelCatalog?.().catch(() => {});
      }
      recordSettingsEvent({ providers, ok: true, filePath: config.settingsEventsFile });
      recordConfigAction(metrics, "settings_update", { ok: true });
      return res.json(settingsPayload(services));
    } catch (error) {
      recordSettingsEvent({ providers, ok: false, error: error.code || "settings_failed", filePath: config.settingsEventsFile });
      recordConfigAction(metrics, "settings_update", { ok: false, error: error.message });
      const status = error.code?.startsWith("invalid_") ? 400 : 500;
      return res.status(status).json({ error: { type: error.code || "settings_failed", message: error.message } });
    }
  });

  function customErrorPayload(error) {
    const code = error instanceof CustomEndpointError || error instanceof OllamaError ? error.code : "upstream";
    return { error: { type: code, message: error.message } };
  }

  // Dashboard "Custom model" flow: list the models a user endpoint advertises,
  // then Save detects Responses or Chat before persisting the provider.
  app.post("/api/custom/list-models", localPostGuard, async (req, res) => {
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
    // The first key still drives the provider-level readiness bit. Endpoint
    // identity, address, capability, and routing remain owned by the list.
    const first = config.customEndpoints[0] || null;
    config.tokens = { ...(config.tokens || {}) };
    if (first?.apiKey) config.tokens.custom = first.apiKey;
    else delete config.tokens.custom;
    applyCustomProfile(config);
    reconcileModelSelection(services);
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
      transport: entry.transport,
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
      const probe = await probeCustomEndpoint({ baseUrl, apiKey, modelId: model });
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
        transport: probe.transport,
      });
      writeCustomEndpoints(endpointsFile(), next);
      const endpoints = republishEndpoints();
      // A newly added endpoint publishes a model Codex reads only at startup.
      await services.configSwitcher.markRestartRequired();
      recordConfigAction(metrics, "custom_endpoint_add", { ok: true });
      return res.json({
        ok: true,
        model,
        transport: probe.transport,
        probeUrl: probe.probeUrl,
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
    const requested = String(id || "").trim();
    if (!requested) {
      return res.status(400).json({ error: { type: "invalid_model", message: "A model id is required." } });
    }
    // The local endpoint publishes one stable entry whatever file it loads, so an
    // id still carrying the file's own name addresses that entry. Canonicalizing the
    // write key keeps the stored override on the slug the catalog actually publishes:
    // filing it under a name no entry matches answered 200 with the new value while
    // the published window never moved. Only while that entry is published - a
    // multi-model llama.cpp server keeps per-model ids, and each keeps its own edit.
    const canonical = canonicalModelRefOf(config, requested);
    const slug = llamaLocalStableEntry() ? canonicalLlamaLocalKey(canonical) : canonical;
    if (!modelOptions(config).some((entry) => entry.id === slug)) {
      return res.status(400).json({ error: { type: "invalid_model", message: "Choose a model from the published roster." } });
    }
    const file = services.contextOverridesFile || contextOverridesPath();
    // Folded on read as well as on write: a value stored before the stable identity
    // is still the user's measurement, and clearing it has to reach the entry it
    // applies to rather than leave the old key behind to be folded in again.
    const stored = readContextOverrides(file);
    const overrides = llamaLocalStableEntry() ? foldLlamaLocalKeys(stored) : stored;
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
    applyContextOverrides(allProfiles(), overrides, { modelAddressFor });
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
    const requested = String(id || "").trim();
    const slug = canonicalModelRefOf(config, requested);
    if (!requested) {
      return res.status(400).json({ error: { type: "invalid_model", message: "A model id is required." } });
    }
    if (!modelOptions(config).some((entry) => entry.id === slug)) {
      return res.status(400).json({ error: { type: "invalid_model", message: "Choose a model from the published roster." } });
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
  app.post("/api/models/vision", mutateConfig, async (req, res) => {
    const { id, supportsVision } = req.body || {};
    const slug = canonicalModelRefOf(config, String(id || "").trim());
    const model = modelOptions(config).find((entry) => entry.id === slug);
    const visionEditable = Boolean(model && (profileById(model.provider)?.modelDiscovery || model.provider === "llamacpp"));
    if (!visionEditable) {
      return res.status(400).json({ error: { type: "invalid_model", message: "Choose a discovered provider model or the local llama.cpp model." } });
    }
    if (typeof supportsVision !== "boolean") {
      return res.status(400).json({ error: { type: "invalid_state", message: "supportsVision must be true or false." } });
    }
    if (!supportsVision && (services.modelSelection?.visionModel || config.visionModel) === slug) {
      return res.status(409).json({ error: { type: "model_in_use", message: "Choose a different vision model first, then disable vision for this model." } });
    }
    const file = services.visionOverridesFile || visionOverridesPath();
    const overrides = readVisionOverrides(file);
    overrides[slug] = supportsVision;
    writeVisionOverrides(file, overrides);
    config.visionOverrides = overrides;
    applyVisionOverrides(allProfiles(), overrides, { modelAddressFor });
    services.writeCatalogFile?.();
    let restartRequired = true;
    try {
      await services.configSwitcher.markRestartRequired();
    } catch (error) {
      restartRequired = false;
      recordConfigAction(metrics, "vision_capability_update", { ok: false, error: error.message });
    }
    if (restartRequired) recordConfigAction(metrics, "vision_capability_update", { ok: true });
    return res.json({ id: slug, supportsVision, restartRequired });
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
    const models = modelOptions(config, config.profileId)
      .filter((entry) => !entry.status || entry.status === "available")
      .map((entry) => ({
        id: entry.id,
        model: bareModelId(entry.id),
        provider: entry.provider,
        providerLabel: providerLabelFor(entry.provider),
        label: entry.label || entry.id,
        supportsVision: Boolean(entry.supportsVision),
        visionEditable: Boolean(profileById(entry.provider)?.modelDiscovery || entry.provider === "llamacpp"),
        visionLocked: Boolean(entry.supportsVision && (services.modelSelection?.visionModel || config.visionModel) === entry.id),
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
  app.get("/api/stats", (req, res) => {
    const rollup = readRollup(services.usageRollupFile || usageRollupPath());
    const directory = statsModelDirectory(services);
    const stats = usageStats(rollup);
    return res.json({ ...stats, modelLabels: statsModelLabels(directory, stats) });
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
      })).map((engine) => ({ ...engine, warnings: engineWarnings(engine, gpus) }));
      // A gateway update can come up before a managed local engine has started
      // answering again. Keep its durable row in this scan so the drawer can
      // still show the user's selected model and projector instead of
      // replacing them with empty defaults while the host returns.
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
      // The window Codex is told about has to follow the window the engine is
      // actually serving. A connected engine publishes its context from meta.n_ctx, read once at
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
        const declared = Number(engine.launch?.ctxSize) || 0;
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
        const publishedBefore = publishedCatalogFingerprint(engine.engine);
        writeLocalEngineSnapshot(file, engine.engine, refreshed);
        applyLocalEngineProfile(engine.engine, refreshed);
        const publishedAfter = publishedCatalogFingerprint(engine.engine);
        if (publishedAfter === publishedBefore) continue;
        services.writeCatalogFile?.();
        await services.configSwitcher.markRestartRequired();
        recordConfigAction(metrics, `local_model_name_refreshed_${engine.engine}`, { ok: true });
      }
      return res.json({
        engineDefinitions: localEngineDefinitions(),
        engines: engines.map((engine) => ({
          ...engine,
          observation: attached(engine) ? saved[engine.engine]?.observation || null : null,
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
      const launch = launchSpecFrom(discovered) || await launchSpecForPort(new URL(base).port);
      const supportsVision = engine === "llamacpp"
        ? Boolean(discovered?.supportsVision ?? asVision)
        : Boolean(asVision);
      const observation = {
        modelPath: discovered?.launch?.model || llamaLaunchArgument(launch, ["-m", "--model"]),
        visionProjectorPath: discovered?.launch?.visionProjectorPath || llamaLaunchArgument(launch, ["--mmproj"]),
        supportsVision,
        ...(engine === "llamacpp" && typeof discovered?.chatTemplateSupportsObjectArguments === "boolean"
          ? { chatTemplateSupportsObjectArguments: discovered.chatTemplateSupportsObjectArguments }
          : {}),
        ...(engine === "llamacpp" && typeof discovered?.mediaMarker === "string"
          ? { mediaMarker: discovered.mediaMarker }
          : {}),
        observedAt: new Date().toISOString(),
      };
      const snapshot = {
        // What started this engine, read from the process behind the port we
        // just connected to. Kept so a stopped engine can be started again as
        // it was, rather than from a command line we would have to invent.
        launch,
        baseUrl: base,
        connectedAt: new Date().toISOString(),
        // A Connect observation is useful input when the person next opens
        // managed setup, but is deliberately separate from the catalog's live
        // capability declaration. A subsequent /props scan can therefore turn
        // off image routing without erasing the last chosen model/projector.
        observation,
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
            ? (services.modelFactsFor || modelFactsFor)(observation.modelPath)
            : null;
          const friendly = facts?.modelName || "";
          const slug = facts?.modelSlug || "";
          return projectLocalModel({
            id: model.id,
            label: model.label || model.id,
          }, {
            modelFacts: friendly && slug ? { modelName: friendly, modelSlug: slug } : null,
            upstreamId: model.id,
            supportsVision,
            chatTemplateSupportsObjectArguments: engine === "llamacpp"
              ? discovered?.chatTemplateSupportsObjectArguments
              : undefined,
            mediaMarker: engine === "llamacpp" ? discovered?.mediaMarker : undefined,
            contextWindow: model.contextWindow,
          });
        }),
      };
      const publishedBefore = publishedCatalogFingerprint(engine);
      writeLocalEngineSnapshot(services.localEnginesFile || localEnginesSnapshotPath(), engine, snapshot);
      applyLocalEngineProfile(engine, snapshot);
      services.writeCatalogFile?.();
      // Same rule as the managed publish: connect only means a new world to
      // Codex when the published catalog projection actually moved. Re-
      // connecting llama.cpp after swapping the GGUF updates the wire id and
      // nothing the picker was told, and that swap is precisely the flow the
      // stable identity exists to keep restart-free.
      if (publishedCatalogFingerprint(engine) !== publishedBefore) await services.configSwitcher.markRestartRequired();
      recordConfigAction(metrics, `local_connect_${engine}`, { ok: true });
      return res.json({
        engine,
        baseUrl: base,
        // Report what Codex will be told, not the snapshot's internal row: the
        // two are the same object for every engine except a single-model
        // llama.cpp, whose published id is deliberately stable.
        models: profileById(engine)?.availableModels || snapshot.models,
        observation,
        settings: settingsPayload(services),
      });
    } catch (error) {
      recordConfigAction(metrics, `local_connect_${engine || "unknown"}`, { ok: false, error: error.message });
      const status = error instanceof LocalEngineError ? 400 : 502;
      return res.status(status).json({ error: { type: error.code || "local_connect_failed", message: error.message } });
    }
  });

  // Restart the gateway service itself, immediately.
  //
  // Two refusals make this route what it is, and both are the point:
  //   - It is guarded by `localPostGuard` alone, NOT `serializeConfigMutation`.
  //     The mutation queue is exactly what a wedged local host blocks, and it
  //     takes everything behind it down with it. The one action that clears the
  //     wedge must not have to queue behind it.
  //   - It never calls `prepareGatewayRestart()`. Checkpointing is a courtesy the
  //     wedge can veto, and a restart that can be held hostage is not a recovery.
  //
  // The response goes out before the supervisor is spawned so the caller learns
  // it was accepted; the process then stops underneath it.
  app.post("/api/local/service/restart", localPostGuard, async (_req, res) => {
    const scheduled = await (services.restartService || restartInstalledService)();
    recordConfigAction(metrics, "local_service_restart", { ok: Boolean(scheduled) });
    if (!scheduled) {
      return res.status(500).json({
        error: { type: "service_restart_failed", message: "ModelDock could not start the service restart." },
      });
    }
    return res.json({ scheduled: true });
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
    const alreadyUp = Boolean(await discoveredLocalEngine(services, engine));
    if (alreadyUp) {
      recordConfigAction(metrics, `local_restart_${engine}`, { ok: false, error: "already running" });
      return res.status(409).json({
        error: { type: "already_running", message: `${LOCAL_ENGINE_LABELS[engine] || engine} is already answering.` },
      });
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

  // Disconnect is the last resort, so it may not depend on anything the host it
  // is leaving can still hold: no queue behind a wedged mutation, no engine
  // round-trip, and no prerequisite that management be released first.
  //
  // It used to answer 409 while a llama.cpp host was managed ("Leave host control
  // before disconnecting"), but releasing management restores the pre-takeover
  // command and *verifies* it, which cannot succeed against a server that is dead
  // - and a record already stuck in "draining" can never be verified again. Two
  // refusals referencing each other formed a lock with no exit: the host could not
  // be used, could not be unmanaged, and could not be disconnected.
  //
  // Management is therefore *released* here rather than demanded as a precondition.
  // Authority is never orphaned - the records go away with the route - but nothing
  // is verified, drained or restarted on the way out, because the whole point is
  // that the process being walked away from may be beyond answering.
  app.post("/api/local/disconnect", localPostGuard, async (req, res) => {
    const { engine } = req.body || {};
    if (!CONNECTABLE_ENGINES.includes(engine)) {
      return res.status(400).json({ error: { type: "engine", message: `Unknown local engine: ${engine}` } });
    }
    clearLocalEngineSnapshot(services.localEnginesFile || localEnginesSnapshotPath(), engine);
    applyLocalEngineProfile(engine, null);
    reconcileModelSelection(services);
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
    reconcileModelSelection(services);
    services.writeCatalogFile?.();
    // The cached subscription list makes the picker correct immediately. A
    // background directory read then picks up later xAI additions without ever
    // sending a capability-test prompt to the provider.
    if (auth?.accessToken) services.refreshModelCatalog?.().catch(() => {});
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
      reconcileModelSelection(services);
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
    // One keepalive implementation for every SSE peer in this process. The relay
    // needs it because a cold prefill is silent, the dashboard needs it because a
    // quiet proxy idle-drops a stream with no events; both are the same job, and
    // the helper's frames carry the identical comment payload.
    const detachKeepAlive = attachSseKeepAlive(res, 20_000);
    req.on("close", () => {
      detachKeepAlive();
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
  const zstdMemoryBudget = services.zstdMemoryBudget || new WeightedByteBudget(
    services.config?.zstdMemoryBudgetBytes || DEFAULT_ZSTD_MEMORY_BUDGET_BYTES,
  );
  outer.use(zstdRequestDecoder({
    callerKey: services.callerKey,
    metrics: services.metrics,
    memoryBudget: zstdMemoryBudget,
  }));
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
  return {
    app: outer,
    close: async () => {
      await Promise.all([
        readOnlyMcpHandler.close?.(),
        scopedMcpHandler.close?.(),
      ]);
    },
    services,
  };
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
    const { rollup, folded, changed } = foldUsageFile(readRollup(file), services.usageEventsFile || usageEventsPath());
    if (changed) writeRollup(file, rollup);
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

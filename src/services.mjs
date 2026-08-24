// Service construction: everything a running gateway is made of, wired once.
//
// createServices used to sit in server.mjs between the route handlers, which
// mixed "what the gateway is" (stores, timers, catalog upkeep, the config
// switcher) with "how it answers HTTP". The routes receive this bag; this
// module owns building it. Moved as-is from server.mjs.
import path from "node:path";
import os from "node:os";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { nativeModelSlugs, refreshNativeCatalog } from "./native-catalog.mjs";
import { MediaStore } from "./media-store.mjs";
import { CodexAttachmentIndex } from "./codex-attachment-index.mjs";
import { Metrics } from "./metrics.mjs";
import { createUpstreams } from "./upstreams.mjs";
import { memoryStoreFor } from "./memory.mjs";
import { CodexConfigSwitcher } from "./config-switcher.mjs";
import { createAutostart } from "./autostart.mjs";
import { createUpdater } from "./update.mjs";
import { createDerivedFallback } from "./derived-fallback.mjs";
import { callerBasePath, callerRootPath, loadOrCreateCallerKey } from "./caller-key.mjs";
import { SessionNames } from "./session-names.mjs";
import { RouteAffinity } from "./router.mjs";
import { applyOllamaProfile } from "./profiles.mjs";
import { ollamaSnapshotPath, readOllamaSnapshot } from "./ollama.mjs";
import { modelTogglesPath, readModelToggles, selectedModelSlugs, writeModelToggles } from "./model-toggles.mjs";
import { modelsToPark, shouldTidy, stampFirstSeen } from "./model-tidy.mjs";
import { modelLifecyclePath, readLifecycle, writeLifecycle } from "./model-lifecycle-state.mjs";
import { readRollup, rollupTotals, usageRollupPath } from "./usage-rollup.mjs";
import { stateFile } from "./state-dir.mjs";
import { urlHost } from "./loopback.mjs";
import { codexModelCatalog, labelForModelId, modelEndpoint, modelOptions } from "./model-options.mjs";
import { readSubagentModel } from "./subagent-config.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export async function refreshProfileModels(profile, config) {
  if (!profile || profile.id !== "opencode-go") return;
  const opencodeToken = config.tokens?.["opencode-go"];
  if (!opencodeToken) return;
  if (!config.goBaseUrl.includes("opencode.ai")) return;
  // Model catalog refresh, opt-in via MODELDOCK_MODEL_PROBE_ENABLED=1. The shipped
  // curated catalog (profiles.mjs) is the primary model source and ships with the
  // release; users do not need to re-probe. This only does a light GET /models merge
  // so newly added upstream ids appear alongside the curated ones. (The old
  // dev-only vision probing/evaluation chain that used to sit above this
  // function was never wired in and has been deleted; git history has it.)
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
  const codexHome = typeof mutableConfig.codexHome === "string" && mutableConfig.codexHome
    ? mutableConfig.codexHome
    : path.join(os.homedir(), ".codex");
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
  const attachmentIndex = new CodexAttachmentIndex({ codexHome });
  const mediaStore = new MediaStore({
    ttlMs: mutableConfig.mediaTtlMs,
    maxBytes: mutableConfig.mediaMaxBytes,
    maxEntries: mutableConfig.mediaMaxEntries,
    maxStoredBytes: mutableConfig.mediaMaxStoredBytes,
    stateDir: mutableConfig.mediaDir,
    externalRoots: attachmentIndex.roots,
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
  // A managed local host is a separate authority record from a connected local
  // endpoint. Keep its small metadata alongside the other state files; its
  // potentially large KV states live only in the directory the user selects
  // during takeover.
  const localHostRegistryFile = mutableConfig.localHostRegistryFile || stateFile("local-hosts.json");
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
      const firstSeen = { ...stamped.firstSeen };
      const toggles = readModelToggles(togglesFile);
      // Before the sparse false-only format, re-enabling a model wrote
      // `{ slug: true }`. Those legacy entries cannot be distinguished from a
      // hand edit, but keeping them forever would contradict the new rescue
      // contract. Convert them once into a fresh first-seen timestamp: the
      // model stays visible now, survives the next weekly tidy, and is judged
      // normally again after a full thirty days.
      const legacyRescued = Object.keys(toggles).filter((slug) => toggles[slug] === true);
      if (legacyRescued.length) {
        const refreshedAt = new Date(now).toISOString();
        for (const slug of legacyRescued) {
          delete toggles[slug];
          if (firstSeen[slug]) firstSeen[slug] = refreshedAt;
        }
        writeModelToggles(togglesFile, toggles);
        mutableConfig.modelToggles = toggles;
      }
      const rollup = readRollup(rollupFile);
      const decision = shouldTidy({ lastTidyAt: lifecycle.lastTidyAt, rollup, now });
      if (!decision.run) {
        if (stamped.changed || legacyRescued.length) writeLifecycle(lifecycleFile, { ...lifecycle, firstSeen });
        return { ...decision, parked: [] };
      }
      const parked = modelsToPark({
        models,
        rollup,
        toggles,
        selected: selectedModelSlugs(mutableConfig, readSubagentModel(mutableConfig)),
        firstSeen,
        now,
      });
      for (const slug of parked) toggles[slug] = false;
      if (parked.length) {
        writeModelToggles(togglesFile, toggles);
        mutableConfig.modelToggles = toggles;
        writeCatalogFile();
      }
      writeLifecycle(lifecycleFile, { lastTidyAt: new Date(now).toISOString(), firstSeen });
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
  return Object.assign(services, {
    config: mutableConfig, runtime, metrics, mediaStore, upstreams, configSwitcher,
    autostart, updater, routeAffinity, modelSelection, derivedFallback, callerKey, nativeSlugs,
    // The configured subagent model (modeldock_subagent's `model`). It is the
    // user's explicit choice and can be a native bare slug (model_provider
    // "openai"), which is exactly what the collaboration relay needs.
    subagentModel: readSubagentModel(mutableConfig),
    memoryStore, memoryTimer,
    refreshModelCatalog, writeCatalogFile, runModelTidy, runScheduledMaintenance, modelRefreshTimer, ollamaSnapshotFile,
    usageRollupFile: rollupFile, modelTogglesFile: togglesFile, modelLifecycleFile: lifecycleFile, localHostRegistryFile,
    sessionNames: new SessionNames({ sessionsRoot: path.join(codexHome, "sessions") }),
    attachmentIndex,
  });
}


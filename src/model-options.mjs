// The published model universe, answered in one place.
//
// Every picker, the catalog file, the status payload, and the relay's
// known-model set derive "which models exist and who owns them" from these
// helpers. They used to live in server.mjs among the route handlers; they are
// one subject - the enabled providers, the models they publish, and the
// native GPT catalog merge - so they moved here as-is. server.mjs owns HTTP;
// this module owns the model set.
import { bareModelId, profileById, profileOptions, providerForModel, publishedSlugFor } from "./profiles.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";
import { readNativeCatalog } from "./native-catalog.mjs";
import { catalogFor } from "./catalog.mjs";

export const VISION_TIER_LABELS = { strong: "High", medium: "Mid", basic: "Low", poor: "Weak" };
export const SPEED_SCORES = { fast: 1.0, medium: 0.6, slow: 0.2 };
export const QUOTA_SCORES = [
  { min: 10000, score: 1.0 },
  { min: 2000, score: 0.8 },
  { min: 500, score: 0.5 },
  { min: 0, score: 0.15 },
];

export function quotaScore(quota5h) {
  if (typeof quota5h !== "number") return 0;
  return QUOTA_SCORES.find((band) => quota5h >= band.min)?.score || 0.15;
}

export function balanceScoreFor(model) {
  const capability = model.visionScore != null && model.visionMaxScore ? model.visionScore / model.visionMaxScore : 0;
  const speed = SPEED_SCORES[model.speedTier] ?? 0;
  const cheap = quotaScore(model.quota5h);
  const freeBoost = model.free ? 0.05 : 0;
  return Number(((capability + speed + cheap) / 3 + freeBoost).toFixed(3));
}

export function withTierLabel(model) {
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
export function legacyBareIds(config) {
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
export function publishedModelIds(config) {
  const ids = new Set();
  for (const model of codexModelCatalog(config).models || []) {
    if (model?.slug) ids.add(model.slug);
  }
  for (const id of legacyBareIds(config)) ids.add(id);
  return ids;
}

export function modelOptions(config, profileId) {
  const all = [];
  for (const entry of enabledProviders(config)) {
    const profile = profileById(entry.id);
    for (const model of profile?.availableModels || []) {
      if (model.status === "unavailable") continue;
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
    if (!known || known.status === "unavailable") continue;
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
export function appendNativeModels(options, config) {
  if (!hasChatGptLogin(config.codexHome)) return options;
  for (const model of readNativeCatalog(config)?.models || []) {
    if (typeof model?.slug !== "string" || !model.slug) continue;
    // The same test the Codex catalog applies, in the same spelling: a model
    // Codex marks "hide" is one it does not offer, and offering it here only
    // in our own pickers puts a choice in front of people that their own App
    // will not show them. gpt-5.4, gpt-5.4-mini and codex-auto-review are
    // hidden today; the review model in particular is internal machinery that
    // happens to read images, not a vision model anyone was given.
    if (model.visibility !== "list") continue;
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

export function modelCatalogModels(config, profileId) {
  const active = profileId || config.profileId;
  return modelOptions(config, active).filter((entry) => entry.provider === active);
}

export function providerOptions(config) {
  return enabledProviders(config);
}

// Only providers with a configured token (or the active profile, which may resolve
// its token from the Codex config backup) are shown in the picker and published in
// the catalog. A provider with no key cannot serve requests, so it stays hidden.
export function enabledProviders(config) {
  const all = profileOptions();
  const active = config.profileId || "opencode-go";
  return all.filter((entry) => {
    if (entry.id === active) return true;
    // A keyless engine has no credential to check, so "connected" is the only
    // test that means anything: it publishes once it has models. The routing
    // property is deliberate: xAI also has no environment variable, but its
    // OAuth access token is still required on every request.
    const profile = profileById(entry.id);
    if (profile?.keyless) return Boolean(profile.availableModels?.length);
    const token = config.tokens?.[entry.id];
    return Boolean(token);
  });
}

export function providerModels(providerId) {
  return (profileById(providerId)?.availableModels || [])
    .filter((model) => model.status !== "unavailable");
}

export function providerRouteConfigured(config, providerId) {
  const profile = profileById(providerId);
  return Boolean(providerModels(providerId).length && (profile.keyless || config.tokens?.[providerId]));
}

export function anyProviderRouteConfigured(config) {
  return profileOptions().some((provider) => providerRouteConfigured(config, provider.id));
}

// Vision is cross-provider, but only across providers that can actually serve
// requests once the new main provider is active. The old active profile can
// remain enabled until the switch lands, so filter out providers that would
// lose their "active" pass without a configured token.
export function visionOptionsAcrossProviders(config, providerId) {
  return modelOptions(config, providerId).filter((model) =>
    model.supportsVision && (model.provider === providerId || providerRouteConfigured(config, model.provider))
  );
}


// The provider that owns a published model id, or "" when the catalog cannot
// place it. Returning a placeholder here instead made every `modelProviderOf(...)
// || config.profileId` fallback dead code, since the placeholder is truthy.
export function modelProviderOf(options, modelId) {
  return options.find((entry) => entry.id === modelId)?.provider || "";
}


export function codexModelCatalog(config) {
  return catalogFor(config);
}


export function labelForModelId(id) {
  return id
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// Endpoint capability from live probing (2026-08-04): most models accept BOTH responses and
// chat/completions; minimax-m2.5/m3 and qwen* only accept chat (responses returns 401);
// grok-4.5 only accepts responses (chat returns 500). Prefer responses (native Codex dialect).
export function modelEndpoint(modelId) {
  if (/^(minimax-m2\.5|minimax-m3|qwen)/.test(modelId)) return "chat";
  return "responses";
}


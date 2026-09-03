// The published model universe, answered in one place.
//
// Every picker, the catalog file, the status payload, and the relay's
// known-model set derive "which models exist and who owns them" from these
// helpers. They used to live in server.mjs among the route handlers; they are
// one subject - the enabled providers, the models they publish, and the
// native GPT catalog merge - so they moved here as-is. server.mjs owns HTTP;
// this module owns the model set.
import {
  bareModelId,
  DEFAULT_PROFILE_ID,
  enabledProviderOptions,
  profileById,
  profileOptions,
  modelRefParts,
  providerForModel,
  providerRouteConfigured,
  publishedSlugFor,
  routedModelInventory,
} from "./profiles.mjs";
import { hasChatGptLogin } from "./codex-auth.mjs";
import { readNativeCatalog } from "./native-catalog.mjs";
import { catalogFor } from "./catalog.mjs";
import { NATIVE_PROVIDER_ID } from "./native-provider.mjs";

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
  const defaultProfile = profileById(DEFAULT_PROFILE_ID);
  for (const model of defaultProfile?.availableModels || []) {
    if (model?.id && !model.ownerQualified && model.status !== "unavailable") ids.add(model.id);
  }
  return ids;
}

// The slugs this gate can serve: every provider's published catalog plus the
// legacy bare ids above. Used to decide whether a client-chosen model is one this
// gate can route. An unknown bare id may be native GPT traffic; an explicit
// unknown @provider address is a configuration error. The legacy bare ids keep
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
  return modelInventory(config)
    .filter((entry) => entry.serviceable && entry.selectable)
    .map(({ serviceable, selectable, ...entry }) => entry);
}

// One directory owns identity, labels and capabilities. Consumers may project
// different wire shapes, but they do not rediscover which models exist.
export function modelInventory(config) {
  const serviceableProviders = new Set(enabledProviderOptions(config).map((entry) => entry.id));
  const inventory = [];
  const seen = new Set();
  for (const item of routedModelInventory()) {
      const { id, provider, model } = item;
      if (seen.has(id)) continue;
      seen.add(id);
      inventory.push({
        ...withTierLabel(model),
        id,
        provider,
        serviceable: serviceableProviders.has(provider),
        selectable: model.status !== "unavailable",
      });
  }
  const nativeServiceable = config.nativeMerge !== false && hasChatGptLogin(config.codexHome);
  for (const model of readNativeCatalog(config)?.models || []) {
    if (typeof model?.slug !== "string" || !model.slug || seen.has(model.slug)) continue;
    seen.add(model.slug);
    inventory.push({
      id: model.slug,
      label: model.display_name || model.slug,
      provider: NATIVE_PROVIDER_ID,
      native: true,
      supportsVision: Array.isArray(model.input_modalities) && model.input_modalities.includes("image"),
      contextWindow: Number(config.contextOverrides?.[model.slug])
        || Number(model.context_window) || undefined,
      contextSource: config.contextOverrides?.[model.slug]
        ? "user"
        : (Number(model.context_window) > 0 ? "native" : ""),
      serviceable: nativeServiceable,
      selectable: model.visibility === "list",
    });
  }
  return inventory;
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
  return enabledProviderOptions(config);
}

export function providerModels(providerId) {
  return (profileById(providerId)?.availableModels || [])
    .filter((model) => model.status !== "unavailable");
}

export { providerRouteConfigured };

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


// Resolve ownership from the same inventory used by the picker and catalog.
// In particular, a native GPT id is a bare id and must not be reinterpreted
// through whichever routed profile happens to be active.
export function modelOwnerOf(config, modelId) {
  const id = String(modelId || "").trim();
  if (!id) return "";
  const exact = modelInventory(config).find((entry) => entry.id === id);
  if (exact?.provider) return exact.provider;
  const parts = modelRefParts(id);
  return parts.qualified ? parts.provider : providerForModel(config, id);
}

// Convert a legacy bare routed selection only when the shared inventory proves
// that the default routed provider owns it. Native bare ids remain untouched;
// this is the narrow persistence repair needed when an older config updates
// only its other selector.
export function canonicalModelRefOf(config, modelId) {
  const id = String(modelId || "").trim();
  if (!id || modelRefParts(id).qualified) return id;
  const inventory = modelInventory(config);
  if (inventory.some((entry) => entry.id === id && entry.native)) return id;
  return inventory.find((entry) => !entry.native && entry.provider === DEFAULT_PROFILE_ID && bareModelId(entry.id) === id)?.id || id;
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


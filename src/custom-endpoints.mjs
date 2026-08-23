// Remote endpoints the user has added, as a list.
//
// There used to be one slot: MODELDOCK_CUSTOM_BASE_URL and friends in .env.
// Adding a second endpoint silently replaced the first, which is a real thing
// to want - a self-hosted vLLM alongside a third-party OpenAI-compatible API is
// an ordinary setup, not an exotic one.
//
// The list lives in its own file rather than numbered .env keys because .env is
// a flat key=value store: deleting the third of five entries there means
// rewriting four keys and hoping nothing reads a half-updated file. Keys are
// encrypted with the same DPAPI helper that protects the provider tokens, so
// moving out of .env does not move out of encryption.
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stateFile } from "./state-dir.mjs";
import { encryptSecret, decryptSecret } from "./secrets.mjs";
import { protectPrivateFile } from "./caller-key.mjs";

export class CustomEndpointsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CustomEndpointsError";
    this.code = code;
  }
}

// Tests redirect this the way they redirect the metering file. loadConfig()
// reads the list itself, so a test that only isolates the services object
// still writes the real one - which is how a fake vendor endpoint ended up in
// a live ~/.modeldock during this feature.
export function customEndpointsPath() {
  return process.env.MODELDOCK_CUSTOM_ENDPOINTS_FILE || stateFile("custom-endpoints.json");
}

function normalizeBase(raw) {
  return String(raw || "").trim().replace(/\/+$/, "");
}

// One record per published model. The model id is the key because that is what
// routing has to resolve: a request arrives naming a model, and the endpoint
// that serves it has to be found from the name alone.
// Provider ids this gateway defines itself. A user-named provider may not
// take one of these: the suffix is a routing address, and two different
// things answering to one address is the failure this whole change removes.
export const RESERVED_PROVIDER_IDS = ["opencode-go", "deepseek-official", "ollama", "llamacpp", "vllm", "openai"];

// Lowercase, no separator, no spaces: the id becomes the @suffix of every
// model this endpoint publishes, and that suffix is parsed by splitting on
// the separator.
export function normalizeProviderId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function validateProviderId(value) {
  const id = normalizeProviderId(value);
  // Absent is allowed and means "custom": every endpoint added before this
  // existed is in that group, and moving them would change the slug Codex has
  // in its picker.
  if (!id) return "custom";
  if (RESERVED_PROVIDER_IDS.includes(id)) {
    throw new CustomEndpointsError("provider", `${id} is a built-in provider name. Choose another.`);
  }
  return id;
}

function cleanEntry(entry) {
  const modelId = String(entry?.modelId || "").trim();
  const baseUrl = normalizeBase(entry?.baseUrl);
  if (!modelId || !baseUrl) return null;
  return {
    providerId: validateProviderId(entry?.providerId),
    modelId,
    baseUrl,
    apiKey: decryptSecret(entry.apiKey || ""),
    label: String(entry.label || "").trim() || baseUrl,
    contextWindow: Number(entry.contextWindow) > 0 ? Number(entry.contextWindow) : 0,
    supportsVision: Boolean(entry.supportsVision),
    addedAt: entry.addedAt || "",
  };
}

export function readCustomEndpoints(file = customEndpointsPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed?.endpoints;
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    const clean = [];
    for (const entry of list) {
      const item = cleanEntry(entry);
      // The key is the address, not the model id: two providers may each serve
      // a model of the same name and both are reachable, because the published
      // slug carries the provider. Keying on the id alone silently dropped the
      // second one.
      if (!item) continue;
      const key = `${item.providerId}@${item.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(item);
    }
    return clean;
  } catch {
    return [];
  }
}

export function writeCustomEndpoints(file, endpoints) {
  mkdirSync(path.dirname(file), { recursive: true });
  if (!endpoints.length) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
    return file;
  }
  const payload = endpoints.map((entry) => ({
    providerId: entry.providerId || "custom",
    modelId: entry.modelId,
    baseUrl: normalizeBase(entry.baseUrl),
    apiKey: entry.apiKey ? encryptSecret(entry.apiKey) : "",
    label: entry.label || "",
    contextWindow: entry.contextWindow || 0,
    supportsVision: Boolean(entry.supportsVision),
    addedAt: entry.addedAt || new Date().toISOString(),
  }));
  const tmp = `${file}.${process.pid}.tmp`;
  // mode on the temp file: rename preserves it, and on macOS/Linux the API
  // keys in this file are plaintext (DPAPI is Windows-only), so the file mode
  // is their only at-rest protection.
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  // POSIX only: the keys are plaintext there and the mode is their whole
  // protection. On Windows they are DPAPI-sealed already, and an icacls spawn
  // per save would be cost without coverage.
  if (process.platform !== "win32") {
    try {
      protectPrivateFile(file);
    } catch {
      // Hardening must never block saving the endpoint list.
    }
  }
  return file;
}

// Routing asks this, and only this: which endpoint serves this model?
// The endpoint serving a model, by the address the model carries.
//
// The suffix is the provider, and looking it up by bare model id alone made
// two providers serving the same id indistinguishable: qwen@together resolved
// to whichever host happened to be first in the list. The suffix is the whole
// reason providers are named.
//
// A bare id still matches on model alone, because a caller that has not been
// through routing yet - a probe, a legacy config value - has no suffix to give.
export function customEndpointFor(endpoints, model) {
  if (!model) return null;
  const slug = String(model);
  const separator = slug.lastIndexOf("@");
  const bare = separator > 0 ? slug.slice(0, separator) : slug;
  const provider = separator > 0 ? slug.slice(separator + 1) : "";
  const list = endpoints || [];
  if (provider) {
    const owned = list.find((entry) =>
      entry.modelId === bare && (entry.providerId || "custom") === provider);
    if (owned) return owned;
    // A suffix naming a provider that serves no such model resolves to nothing
    // rather than to somebody else s endpoint.
    if (list.some((entry) => (entry.providerId || "custom") === provider)) return null;
  }
  return list.find((entry) => entry.modelId === bare) || null;
}

export function addCustomEndpoint(endpoints, entry) {
  const item = cleanEntry({ ...entry, apiKey: "" });
  if (!item) throw new CustomEndpointsError("model", "An endpoint needs a base URL and a model id.");
  // A clash is per provider, not global: naming providers is exactly what
  // makes the same model id on two hosts addressable, and refusing it would
  // undo the reason for naming them.
  const clash = endpoints.find((existing) =>
    existing.modelId === item.modelId && (existing.providerId || "custom") === item.providerId);
  if (clash) {
    throw new CustomEndpointsError(
      "duplicate",
      `${item.modelId} is already served by ${clash.baseUrl} under ${item.providerId}. Remove that endpoint first, or give this one a different provider name.`,
    );
  }
  return [...endpoints, { ...item, apiKey: String(entry.apiKey || ""), addedAt: new Date().toISOString() }];
}

export function removeCustomEndpoint(endpoints, modelId, providerId = "") {
  const id = String(modelId || "").trim();
  const provider = normalizeProviderId(providerId);
  // Without a provider this removes every endpoint serving that model id,
  // which is what a caller written before providers existed means by it.
  return (endpoints || []).filter((entry) =>
    entry.modelId !== id || (provider && (entry.providerId || "custom") !== provider));
}


// The MODELDOCK_CUSTOM_* variables are how a single custom endpoint was
// configured before this list existed. They were kept as a read-time
// fallback, which quietly made them a second source of endpoints: the model
// they described appeared in every picker while the page that manages
// endpoints - which reads only this file - showed nothing, so there was no
// way to remove it. One store, one answer; the variables are an input to it
// on first boot and stop existing afterwards.
//
// Returns the entry it added, or null. The caller clears the variables: this
// module owns the endpoint list, not the .env file.
export const LEGACY_CUSTOM_ENV_KEYS = [
  "MODELDOCK_CUSTOM_BASE_URL",
  "MODELDOCK_CUSTOM_API_KEY",
  "MODELDOCK_CUSTOM_MODEL",
  "MODELDOCK_CUSTOM_VISION",
  "MODELDOCK_CUSTOM_CONTEXT_WINDOW",
  // Retired with the "as main" flag; cleared so the block leaves nothing behind.
  "MODELDOCK_CUSTOM_MAIN",
];

export function migrateLegacyCustomEndpoint(env = process.env, file = customEndpointsPath()) {
  const modelId = String(env.MODELDOCK_CUSTOM_MODEL || "").trim();
  const baseUrl = String(env.MODELDOCK_CUSTOM_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!modelId || !baseUrl) return null;

  const existing = readCustomEndpoints(file);
  // A list that already serves this model is the newer truth; the variables
  // are leftovers and only need clearing.
  if (existing.some((entry) => entry.modelId === modelId)) return { modelId, added: false };

  const entry = {
    modelId,
    baseUrl,
    apiKey: String(env.MODELDOCK_CUSTOM_API_KEY || ""),
    contextWindow: Number(env.MODELDOCK_CUSTOM_CONTEXT_WINDOW) || 0,
    supportsVision: ["1", "true", "on", "yes"].includes(
      String(env.MODELDOCK_CUSTOM_VISION || "").trim().toLowerCase(),
    ),
    addedAt: new Date().toISOString(),
  };
  writeCustomEndpoints(file, [...existing, entry]);
  return { modelId, added: true };
}
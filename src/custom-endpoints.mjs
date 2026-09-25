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
import { readFileSync, rmSync } from "node:fs";
import { atomicWriteJsonSync } from "./atomic-file.mjs";
import { stateFile } from "./state-dir.mjs";
import { encryptSecret, decryptSecret } from "./secrets.mjs";
import { protectPrivateFile } from "./caller-key.mjs";
export { customEndpointFor } from "./custom-endpoint-routing.mjs";

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

function cleanEntry(entry) {
  const modelId = String(entry?.modelId || "").trim();
  const baseUrl = normalizeBase(entry?.baseUrl);
  if (!modelId || !baseUrl) return null;
  return {
    modelId,
    baseUrl,
    apiKey: decryptSecret(entry.apiKey || ""),
    label: String(entry.label || "").trim() || baseUrl,
    contextWindow: Number(entry.contextWindow) > 0 ? Number(entry.contextWindow) : 0,
    supportsVision: Boolean(entry.supportsVision),
    transport: entry.transport === "chat" ? "chat" : "responses",
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
      if (!item) continue;
      if (seen.has(item.modelId)) continue;
      seen.add(item.modelId);
      clean.push(item);
    }
    return clean;
  } catch {
    return [];
  }
}

export function writeCustomEndpoints(file, endpoints) {
  if (!endpoints.length) {
    try { rmSync(file, { force: true }); } catch { /* best effort */ }
    return file;
  }
  const payload = endpoints.map((entry) => ({
    modelId: entry.modelId,
    baseUrl: normalizeBase(entry.baseUrl),
    apiKey: entry.apiKey ? encryptSecret(entry.apiKey) : "",
    label: entry.label || "",
    contextWindow: entry.contextWindow || 0,
    supportsVision: Boolean(entry.supportsVision),
    transport: entry.transport === "chat" ? "chat" : "responses",
    addedAt: entry.addedAt || new Date().toISOString(),
  }));
  // mode on the temp file: rename preserves it, and on macOS/Linux the API
  // keys in this file are plaintext (DPAPI is Windows-only), so the file mode
  // is their only at-rest protection.
  atomicWriteJsonSync(file, payload, { mode: 0o600 });
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

export function addCustomEndpoint(endpoints, entry) {
  const item = cleanEntry({ ...entry, apiKey: "" });
  if (!item) throw new CustomEndpointsError("model", "An endpoint needs a base URL and a model id.");
  const clash = endpoints.find((existing) => existing.modelId === item.modelId);
  if (clash) {
    throw new CustomEndpointsError(
      "duplicate",
      `${item.modelId} is already served by ${clash.baseUrl}. Remove that endpoint first.`,
    );
  }
  return [...endpoints, { ...item, apiKey: String(entry.apiKey || ""), addedAt: new Date().toISOString() }];
}

export function removeCustomEndpoint(endpoints, modelId) {
  const id = String(modelId || "").trim();
  return (endpoints || []).filter((entry) => entry.modelId !== id);
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

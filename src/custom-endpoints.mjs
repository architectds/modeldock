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
      // A duplicate model id cannot be routed: the second one would be
      // unreachable, so it is dropped on read rather than published as a lie.
      if (!item || seen.has(item.modelId)) continue;
      seen.add(item.modelId);
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
    modelId: entry.modelId,
    baseUrl: normalizeBase(entry.baseUrl),
    apiKey: entry.apiKey ? encryptSecret(entry.apiKey) : "",
    label: entry.label || "",
    contextWindow: entry.contextWindow || 0,
    supportsVision: Boolean(entry.supportsVision),
    addedAt: entry.addedAt || new Date().toISOString(),
  }));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, file);
  return file;
}

// Routing asks this, and only this: which endpoint serves this model?
export function customEndpointFor(endpoints, model) {
  if (!model) return null;
  const bare = String(model).split("@")[0];
  return (endpoints || []).find((entry) => entry.modelId === bare) || null;
}

export function addCustomEndpoint(endpoints, entry) {
  const item = cleanEntry({ ...entry, apiKey: "" });
  if (!item) throw new CustomEndpointsError("model", "An endpoint needs a base URL and a model id.");
  if (endpoints.some((existing) => existing.modelId === item.modelId)) {
    const owner = endpoints.find((existing) => existing.modelId === item.modelId);
    throw new CustomEndpointsError(
      "duplicate",
      `${item.modelId} is already served by ${owner.baseUrl}. Remove that endpoint first, or add this model under a different id.`,
    );
  }
  return [...endpoints, { ...item, apiKey: String(entry.apiKey || ""), addedAt: new Date().toISOString() }];
}

export function removeCustomEndpoint(endpoints, modelId) {
  const id = String(modelId || "").trim();
  return (endpoints || []).filter((entry) => entry.modelId !== id);
}

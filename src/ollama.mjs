// Ollama one-click connection for the dashboard "Ollama (local)" section.
//
// Unlike the custom endpoint flow, Ollama needs no API key and no /v1 base URL
// completion: the model list lives at the root (/api/tags) while the Responses
// probe lives under /v1/responses. Model tags may contain a colon (qwen3.8:27b)
// which the published slug cannot carry, so each entry keeps both the published
// id (colon -> dash) and the original upstream id for the wire.
import path from "node:path";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { stateFile } from "./state-dir.mjs";
import { isLoopbackHost } from "./loopback.mjs";

export const OLLAMA_DEFAULT_BASE = "http://127.0.0.1:11434";

export class OllamaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
  }
}

// Strip a trailing /v1 (users paste the OpenAI-compatible tree) and trailing
// slashes so both http://127.0.0.1:11434 and .../v1 resolve to the root where
// /api/tags lives.
export function normalizeOllamaBase(raw) {
  let value = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return OLLAMA_DEFAULT_BASE;
  if (/\/v1$/i.test(value)) value = value.slice(0, -3).replace(/\/+$/, "");
  return value || OLLAMA_DEFAULT_BASE;
}

// Only https and loopback http are acceptable: Ollama is a local service, and a
// remote plaintext endpoint would send every prompt over the LAN unencrypted.
export function validateOllamaBase(raw) {
  const trimmed = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new OllamaError("connect", "Ollama base URL must be an http(s) URL.");
  }
  const value = normalizeOllamaBase(raw);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new OllamaError("connect", "Ollama base URL must be an http(s) URL.");
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new OllamaError("connect", "Only loopback http (or https) Ollama endpoints are allowed.");
  }
  return value;
}

export function publishedOllamaId(upstreamId) {
  return String(upstreamId || "").replace(/:/g, "-");
}

function connectError(url, error) {
  const reason = error?.message || error?.code || "network error";
  return new OllamaError("connect", `Cannot connect to Ollama at ${url} (${reason}).`);
}

// GET {base}/api/tags: the only source that carries vision capabilities and the
// native context window. The OpenAI-compatible /v1/models list exposes ids only.
// Embedding-only models (no "completion" capability) cannot serve Responses
// turns, so they stay out of the connected set.
export async function listOllamaModels({ baseUrl = OLLAMA_DEFAULT_BASE } = {}) {
  const endpoint = validateOllamaBase(baseUrl);
  const url = `${endpoint}/api/tags`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw connectError(url, error);
  }
  if (!response.ok) {
    throw new OllamaError("connect", `Ollama model list failed with HTTP ${response.status} at ${url}. Is Ollama running?`);
  }
  const body = await response.json().catch(() => ({}));
  const models = Array.isArray(body?.models)
    ? body.models
        .map((entry) => {
          const upstreamId = String(entry?.name || "").trim();
          if (!upstreamId) return null;
          const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : null;
          if (capabilities && !capabilities.includes("completion")) return null;
          return {
            id: publishedOllamaId(upstreamId),
            upstreamId,
            label: upstreamId,
            supportsVision: capabilities ? capabilities.includes("vision") : false,
            contextWindow: Number(entry?.details?.context_length) || undefined,
            status: "available",
          };
        })
        .filter(Boolean)
    : [];
  return { models, endpoint, modelsUrl: url, responsesUrl: `${endpoint}/v1/responses` };
}

// POST {base}/v1/responses with a tiny turn to prove the local Ollama speaks the
// Responses dialect (Ollama >= 0.13.3). Classified failures: 404 means the
// protocol is unsupported (too old); anything else non-2xx is upstream.
export async function probeOllamaResponses({ baseUrl = OLLAMA_DEFAULT_BASE, modelId }) {
  const model = String(modelId || "").trim();
  if (!model) throw new OllamaError("model", "An Ollama model id is required.");
  const endpoint = validateOllamaBase(baseUrl);
  const url = `${endpoint}/v1/responses`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly OLLAMA_OK." }] }],
        max_output_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw connectError(url, error);
  }
  if (response.status === 404) {
    throw new OllamaError("protocol", "This Ollama version does not support the Responses protocol. Upgrade to Ollama 0.13.3 or newer.");
  }
  if (!response.ok) {
    throw new OllamaError("upstream", `Ollama Responses probe failed with HTTP ${response.status}.`);
  }
  return { ok: true, model, endpoint, responsesUrl: url };
}

// The connection snapshot: where the model list lives between reconnects so a
// restart never has to re-contact Ollama. Same MODELDOCK_STATE_DIR redirect as
// the catalog file so throwaway installs (mock-install tests) stay isolated.
export function ollamaSnapshotPath() {
  return stateFile("ollama-models.json");
}

export function readOllamaSnapshot(file = ollamaSnapshotPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.models) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeOllamaSnapshot(file, snapshot) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
  renameSync(tmp, file);
  return file;
}

export function clearOllamaSnapshot(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    // Best effort: a stale snapshot is only re-read when it parses.
  }
}

// Discovery for inference engines already running on this machine.
//
// Local Hosts answers a question the custom-endpoint page cannot: "what is
// already up?" A short list of well-known loopback ports answers it in well
// under a second. This is deliberately not a port scan - scanning is slower,
// reads as hostile on a user's own machine, and finds nothing the list does
// not already cover.
//
// Identification comes from the response, not the port: llama-server and vLLM
// both speak the OpenAI dialect and either can be moved to the other's port,
// so a port alone would mislabel them.
import { isLoopbackHost } from "./loopback.mjs";

export class LocalEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalEngineError";
    this.code = code;
  }
}

// Ollama is listed first because it is the only one with a dedicated connect
// path; the rest share the keyless OpenAI-compatible route.
export const LOCAL_CANDIDATES = [
  { port: 11434, hint: "ollama" },
  { port: 8080, hint: "llama.cpp" },
  { port: 8000, hint: "vllm" },
];

export const ENGINE_LABELS = {
  ollama: "Ollama",
  "llama.cpp": "llama.cpp",
  vllm: "vLLM",
  openai: "OpenAI-compatible",
};

// Pure: given what each probe returned, name the engine. Order matters - the
// /props hit is what separates llama.cpp from every other OpenAI-compatible
// server, so it is checked before the generic /v1/models shape.
export function engineFromProbes({ tags, props, models } = {}) {
  if (tags && Array.isArray(tags.models)) return "ollama";
  if (props && typeof props === "object" && !Array.isArray(props)) return "llama.cpp";
  if (models && Array.isArray(models.data)) return "openai";
  return "";
}

// Only loopback: the keyless path exists because a local engine has no key to
// give, so it must never be able to reach a remote host. These two facts are
// one decision, not two.
export function assertLocalBase(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalEngineError("base", "Local engine URL must be an http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new LocalEngineError("base", "Local engine URL must be an http(s) URL.");
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new LocalEngineError("base", "Local engines must be on this machine (loopback address).");
  }
  return value;
}

async function probeJson(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Nothing listening, wrong shape, or too slow: all mean "not here".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// One candidate, three probes in parallel. A miss is silent by design: most
// ports are empty on most machines, and reporting that is noise.
export async function probeLocalEngine(port, { fetchImpl = fetch, timeoutMs = 800 } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const [tags, props, models] = await Promise.all([
    probeJson(fetchImpl, `${base}/api/tags`, timeoutMs),
    probeJson(fetchImpl, `${base}/props`, timeoutMs),
    probeJson(fetchImpl, `${base}/v1/models`, timeoutMs),
  ]);
  const engine = engineFromProbes({ tags, props, models });
  if (!engine) return null;
  const modelIds = engine === "ollama"
    ? (tags.models || []).map((m) => m?.name).filter(Boolean)
    : (models?.data || []).map((m) => m?.id).filter(Boolean);
  return { engine, label: ENGINE_LABELS[engine] || engine, baseUrl: base, port, models: modelIds };
}

export async function discoverLocalEngines({ fetchImpl = fetch, timeoutMs = 800, candidates = LOCAL_CANDIDATES } = {}) {
  const found = await Promise.all(
    candidates.map((candidate) => probeLocalEngine(candidate.port, { fetchImpl, timeoutMs })),
  );
  return found.filter(Boolean);
}

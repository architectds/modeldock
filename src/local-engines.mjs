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
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isLoopbackHost } from "./loopback.mjs";
import { stateFile } from "./state-dir.mjs";

export class LocalEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalEngineError";
    this.code = code;
  }
}

// Ollama is listed first because it is the only one with a dedicated connect
// path; the rest share the keyless OpenAI-compatible route.
const LOCAL_CANDIDATES = [
  { port: 11434, hint: "ollama" },
  { port: 8080, hint: "llama.cpp" },
  { port: 8000, hint: "vllm" },
];

const ENGINE_LABELS = {
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

// One file keyed by engine rather than a file per engine: a fourth engine then
// costs a key, not a new path to remember, back up, and clean up. Ollama keeps
// its own snapshot - it predates this and renaming it would strand anyone
// mid-upgrade for no gain.
export function localEnginesSnapshotPath() {
  return stateFile("local-engines.json");
}

export function readLocalEnginesSnapshot(file = localEnginesSnapshotPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLocalEngineSnapshot(file, engine, snapshot) {
  const all = readLocalEnginesSnapshot(file) || {};
  all[engine] = snapshot;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
  renameSync(tmp, file);
  return file;
}

export function clearLocalEngineSnapshot(file, engine) {
  const all = readLocalEnginesSnapshot(file);
  if (!all || !(engine in all)) return file;
  delete all[engine];
  try {
    if (Object.keys(all).length === 0) {
      rmSync(file, { force: true });
      return file;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    renameSync(tmp, file);
  } catch {
    // Best effort: a stale entry is only honoured while it still parses.
  }
  return file;
}

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
import { readFileSync, rmSync } from "node:fs";
import { atomicWriteJsonSync } from "./atomic-file.mjs";
import { isLoopbackHost } from "./loopback.mjs";
import { stateFile } from "./state-dir.mjs";
import { launchSpecFrom, listEngineListeners, parseLlamaArgs } from "./engine-processes.mjs";
import { modelFactsAreStale, readModelFacts } from "./gguf.mjs";
import { LOCAL_ENGINE_DEFINITIONS, localEngineDefinitions } from "./local-engine-definitions.mjs";

export class LocalEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalEngineError";
    this.code = code;
  }
}

// Ollama is listed first because it is the only one with a dedicated connect
// path; the rest share the keyless OpenAI-compatible route.
const LOCAL_CANDIDATES = localEngineDefinitions()
  .filter((entry) => entry.defaultPort > 0 && entry.id !== "openai")
  .map((entry) => ({ port: entry.defaultPort, hint: entry.label }));

// The engines this gateway can attach a profile to. Ollama is absent because
// it connects through its own older route and snapshot. Kept in one place so
// the discovery, the route, and the page cannot drift into disagreeing about
// which engines are offerable - which is exactly how this feature shipped
// unreachable the first time.
export const CONNECTABLE_ENGINES = localEngineDefinitions()
  .filter((entry) => entry.connectable)
  .map((entry) => entry.id);

export const ENGINE_LABELS = Object.fromEntries(
  Object.values(LOCAL_ENGINE_DEFINITIONS).map((entry) => [entry.id, entry.label]),
);

// Pure: given what each probe returned, name the engine. The names are the
// ids used everywhere else - the provider suffix, the snapshot key, the
// connect route - because a second vocabulary here is a bug waiting to be
// written, and once was: discovery said "llama.cpp" while the route only
// accepted "llamacpp", so nothing could ever be connected.
//
// Order is by how specific the evidence is. /props is llama.cpp's own and no
// one else serves it. /version is vLLM's; without it vLLM is just another
// OpenAI-compatible server, which is what it used to be reported as.
export function engineFromProbes({ tags, props, version, models } = {}) {
  if (tags && Array.isArray(tags.models)) return "ollama";
  if (props && typeof props === "object" && !Array.isArray(props)) return "llamacpp";
  if (version && typeof version.version === "string" && models && Array.isArray(models.data)) {
    return "vllm";
  }
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
  const [tags, props, version, models] = await Promise.all([
    probeJson(fetchImpl, `${base}/api/tags`, timeoutMs),
    probeJson(fetchImpl, `${base}/props`, timeoutMs),
    probeJson(fetchImpl, `${base}/version`, timeoutMs),
    probeJson(fetchImpl, `${base}/v1/models`, timeoutMs),
  ]);
  const engine = engineFromProbes({ tags, props, version, models });
  if (!engine) return null;
  const modelIds = engine === "ollama"
    ? (tags.models || []).map((m) => m?.name).filter(Boolean)
    : (models?.data || []).map((m) => m?.id).filter(Boolean);
  return {
    engine,
    label: ENGINE_LABELS[engine] || engine,
    baseUrl: base,
    port,
    models: modelIds,
    // llama.cpp publishes modalities on /props. This is a live capability
    // fact, not a remembered dashboard preference: an engine restarted without
    // --mmproj must immediately stop being offered to Codex as an image model.
    ...(engine === "llamacpp" ? {
      supportsVision: Boolean(props?.modalities?.vision),
      chatTemplateSupportsObjectArguments: Boolean(props?.chat_template_caps?.supports_object_arguments),
      mediaMarker: typeof props?.media_marker === "string" ? props.media_marker : "",
    } : {}),
    // A bare OpenAI-compatible server is discovered but not connectable here:
    // it has no profile to attach to, and the API page already takes an
    // arbitrary endpoint with a key.
    connectable: CONNECTABLE_ENGINES.includes(engine),
  };
}

// Two sources of candidate ports, in this order:
//
// 1. The process table (engine-processes.mjs). This is the one that finds an
//    engine the user moved - `llama-server --port 11435` is invisible to any
//    fixed list, and moving it is the ordinary case on a machine running two
//    of anything. It also carries the binary and command line, so a hit here
//    is already an adoption spec rather than just an address.
// 2. The fixed list below, which still earns its place: it costs three probes,
//    and it catches an engine whose owning process we cannot attribute -
//    inside WSL or a container the port is published here while the process
//    is not, and reading another user's process needs elevation we do not ask
//    for.
//
// `listeners` is injected by tests so a unit test never shells out to the
// operating system. Passing an empty array reduces this to the old behaviour.
export async function discoverLocalEngines({
  fetchImpl = fetch,
  timeoutMs = 800,
  candidates = LOCAL_CANDIDATES,
  listeners = null,
  factsOptions = undefined,
} = {}) {
  const observed = listeners || await listEngineListeners();
  // Process-derived ports first so their metadata wins; the fixed list only
  // contributes ports nothing was attributed to.
  const byPort = new Map();
  for (const listener of observed) {
    if (Number.isInteger(listener?.port)) byPort.set(listener.port, listener);
  }
  for (const candidate of candidates) {
    if (!byPort.has(candidate.port)) byPort.set(candidate.port, { port: candidate.port });
  }
  const found = await Promise.all(
    [...byPort.keys()].map((port) => probeLocalEngine(port, { fetchImpl, timeoutMs })),
  );
  return found.filter(Boolean).map((engine) => describeFromProcess(engine, byPort.get(engine.port), factsOptions));
}

// Attach what the operating system already told us about the process behind a
// confirmed engine. Nothing here is invented: a port we could not attribute
// simply keeps the fields it had.
function describeFromProcess(engine, listener, factsOptions) {
  if (!listener?.pid || !listener.binary) return engine;
  const described = {
    ...engine,
    pid: listener.pid,
    binary: listener.binary,
    cmdline: listener.cmdline || "",
  };
  // Only llama.cpp's command line is parsed today. vLLM runs under a bare
  // `python` whose arguments follow no shared convention, and guessing at them
  // would produce a spec that looks authoritative and is not.
  if (engine.engine === "llamacpp" && described.cmdline) {
    described.launch = parseLlamaArgs(described.cmdline);
    // The scan is where the model file is read; everything downstream reads the
    // cache instead of the file.
    const facts = modelFactsFor(described.launch.model, factsOptions);
    if (facts) described.modelFacts = facts;
  }
  return described;
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
  atomicWriteJsonSync(file, all);
  return file;
}

// What a model file costs, remembered so the ledger does not re-read a 12 GiB
// file on every scan. Keyed by the model PATH rather than by the engine: the
// facts belong to the file, and two engines can serve the same one.
//
// The scan is the single reading point. By the time a row turns blue the
// numbers are already in hand, so opening the drawer reads nothing - and the
// ledger still answers after the engine stops, which is exactly when a user
// asks what to change.
export function modelFactsCachePath() {
  return stateFile("model-facts.json");
}

export function readModelFactsCache(file = modelFactsCachePath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeModelFactsCache(file, all) {
  try {
    atomicWriteJsonSync(file, all);
  } catch {
    // A cache that cannot be written is a slow scan, not a broken one.
  }
}

// Cached facts for one model file, reading it only when the cache is absent or
// the file changed underneath. Returns null for anything unreadable: a missing
// model must cost the row its ledger, never the whole scan.
export function modelFactsFor(modelPath, { file = modelFactsCachePath(), read = readModelFacts } = {}) {
  if (!modelPath) return null;
  const all = readModelFactsCache(file);
  const cached = all[modelPath];
  if (cached && !modelFactsAreStale(cached, modelPath)) return cached;
  try {
    const facts = read(modelPath);
    all[modelPath] = facts;
    writeModelFactsCache(file, all);
    return facts;
  } catch {
    return cached || null;
  }
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
    atomicWriteJsonSync(file, all);
  } catch {
    // Best effort: a stale entry is only honoured while it still parses.
  }
  return file;
}


// The remembered launch for an engine, or null. Reading it through one
// function keeps the shape of the snapshot an implementation detail of this
// module rather than something the restart route has to know.
export function rememberedLaunch(engine, file = localEnginesSnapshotPath()) {
  const spec = readLocalEnginesSnapshot(file)?.[engine]?.launch;
  if (!spec?.binary || !Array.isArray(spec.args)) return null;
  return { binary: spec.binary, args: spec.args };
}

// Attach the launch of whatever process is serving this port, when we could
// attribute one. A port we could not attribute simply carries no launch, and
// the Restart control stays hidden rather than offering a guess.
export async function launchSpecForPort(port, { listeners = null } = {}) {
  const observed = listeners || await listEngineListeners();
  const match = observed.find((listener) => Number(listener?.port) === Number(port));
  return launchSpecFrom(match);
}

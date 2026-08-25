// Real process operations for the pure local-host lifecycle runner.
// Every stop is re-attributed to the configured endpoint and an authorized argv
// before a signal is sent; every start is accepted only after the same argv is
// serving and llama.cpp reports the selected equal-slot shape.

import path from "node:path";
import { stat } from "node:fs/promises";
import { launchSpecFrom, spawnEngineDetached, waitForEngineStop } from "./engine-processes.mjs";
import { readLocalHostRegistry, upsertLocalHost, writeLocalHostRegistry } from "./local-host-registry.mjs";

function sameEndpoint(left, right) {
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

function canonicalBinary(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function sameLaunchSpec(left, right) {
  return Boolean(
    left?.binary
      && right?.binary
      && canonicalBinary(left.binary) === canonicalBinary(right.binary)
      && Array.isArray(left.args)
      && Array.isArray(right.args)
      && JSON.stringify(left.args) === JSON.stringify(right.args),
  );
}

async function probeProps(endpoint, fetchImpl, timeoutMs = 2000) {
  const url = new URL(endpoint);
  url.pathname = "/props";
  url.search = "";
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return null;
  return response.json();
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeSlots(endpoint, fetchImpl, timeoutMs = 2000) {
  const url = new URL(endpoint);
  url.pathname = "/slots";
  url.search = "";
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return null;
  const slots = await response.json();
  return Array.isArray(slots) ? slots : null;
}

async function verifiedFileIdentity(file) {
  try {
    const value = await stat(file);
    return { bytes: value.size, mtimeMs: Math.round(value.mtimeMs) };
  } catch {
    return { bytes: 0, mtimeMs: 0 };
  }
}

function shortScalar(value) {
  if (!["string", "number", "boolean"].includes(typeof value)) return "";
  return String(value).slice(0, 200);
}

export async function probeLlamaRequestSlotAffinity({ endpoint, model, slot, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(slot) || slot < 0) return false;
  try {
    const url = new URL(endpoint);
    url.pathname = "/v1/responses";
    url.search = "";
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: String(model || "local-model"),
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply OK." }] }],
        max_output_tokens: 1,
        stream: false,
        id_slot: slot,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return false;
    await response.arrayBuffer();
    const slotsUrl = new URL(endpoint);
    slotsUrl.pathname = "/slots";
    slotsUrl.search = "";
    const slotsResponse = await fetchImpl(slotsUrl, { signal: AbortSignal.timeout(5000) });
    if (!slotsResponse.ok) return false;
    const slots = await slotsResponse.json();
    const selected = Array.isArray(slots) ? slots.find((entry) => Number(entry?.id) === slot) : null;
    return Boolean(selected && Number(selected.n_prompt_tokens) > 0);
  } catch {
    return false;
  }
}

async function waitForIdleSlots(endpoint, fetchImpl, timeoutMs) {
  const url = new URL(endpoint);
  url.pathname = "/slots";
  url.search = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const slots = await response.json();
        if (Array.isArray(slots) && slots.every((slot) => !slot?.is_processing)) return true;
      }
    } catch {
      // A transient status miss is not permission to stop an active process.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

export function createLocalHostLifecycleOperations({
  hostId,
  endpoint,
  registryFile,
  discover,
  runtime,
  logDir,
  fetchImpl = fetch,
  spawn = spawnEngineDetached,
  stopProcess = (pid) => process.kill(pid, "SIGTERM"),
  waitForStop = waitForEngineStop,
  verifyTimeoutMs = 180_000,
  stopTimeoutMs = 30_000,
} = {}) {
  if (!hostId || !endpoint || !registryFile || typeof discover !== "function") {
    throw new TypeError("Managed local host lifecycle identity and operations are required.");
  }
  let startedPid = 0;
  let startedSpec = null;

  const persist = async (record) => {
    const registry = await readLocalHostRegistry(registryFile);
    await writeLocalHostRegistry(registryFile, upsertLocalHost(registry, record));
  };

  const findCurrent = async () => (await discover()).find((candidate) => sameEndpoint(candidate.baseUrl, endpoint)) || null;

  return {
    persist,
    async drain() {
      if (runtime) {
        const idle = await runtime.drain({ timeoutMs: 120_000 });
        if (!idle) throw new Error("Timed out waiting for admitted local model requests to finish.");
      }
      if (!await findCurrent()) return;
      if (!await waitForIdleSlots(endpoint, fetchImpl, 120_000)) {
        throw new Error("Timed out waiting for llama.cpp slots to become idle.");
      }
      if (runtime?.checkpointHotStates) {
        const checkpoint = await runtime.checkpointHotStates();
        if (checkpoint?.failed) {
          throw new Error("Could not checkpoint active local conversations; managed restart was not performed.");
        }
      }
    },
    async stop(record) {
      const current = await findCurrent();
      if (!current) return;
      const currentSpec = launchSpecFrom(current);
      const authorized = [record.activeSpec, record.desiredSpec, record.preTakeoverSpec, record.recoverySpec, startedSpec]
        .some((spec) => sameLaunchSpec(currentSpec, spec));
      if (!authorized && current.pid !== startedPid) {
        throw new Error("The listener changed ownership or argv during managed restart; it was not stopped.");
      }
      stopProcess(current.pid);
      const stopped = await waitForStop({ pid: current.pid, discover, timeoutMs: stopTimeoutMs });
      if (!stopped) throw new Error("The managed llama.cpp process did not stop before the restart deadline.");
      if (current.pid === startedPid) startedPid = 0;
    },
    async start(spec) {
      const launched = spawn({ binary: spec.binary, args: spec.args, engine: "llamacpp", logDir });
      startedPid = Number(launched?.pid) || 0;
      startedSpec = spec;
    },
    async verify(spec, record) {
      const deadline = Date.now() + verifyTimeoutMs;
      let lastFailure = "llama.cpp did not appear on its managed endpoint.";
      while (Date.now() < deadline) {
        const current = await findCurrent();
        if (startedPid && !processAlive(startedPid)) {
          throw new Error("The newly launched llama.cpp process exited before it served the managed endpoint.");
        }
        const currentSpec = launchSpecFrom(current);
        if (current && sameLaunchSpec(currentSpec, spec)) {
          const props = await probeProps(endpoint, fetchImpl);
          if (!props) {
            lastFailure = "The managed llama.cpp status endpoint is still loading the model.";
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          try {
            const profile = record.desiredProfile;
            if (profile) {
              if (Number(props.total_slots) !== Number(profile.laneCount)) {
                throw new Error(`llama.cpp reported ${props.total_slots} slots instead of ${profile.laneCount}.`);
              }
              const slots = await probeSlots(endpoint, fetchImpl);
              if (!slots || slots.length !== Number(profile.laneCount)) {
                throw new Error("llama.cpp did not expose the expected managed slot list.");
              }
              const unexpected = slots.find((slot) => Number(slot?.n_ctx) !== Number(profile.laneContextTokens));
              if (unexpected) {
                throw new Error(`llama.cpp slot ${Number(unexpected.id)} reported ${Number(unexpected.n_ctx)} tokens instead of ${profile.laneContextTokens}.`);
              }
            }
            if (record.capabilities?.visionProjectorPath && !props?.modalities?.vision) {
              throw new Error("llama.cpp loaded without the requested local vision projector.");
            }
            const binary = await verifiedFileIdentity(current.binary);
            return {
              ok: true,
              pid: current.pid,
              props,
              capabilities: {
                verifiedBinaryBytes: binary.bytes,
                verifiedBinaryMtimeMs: binary.mtimeMs,
                verifiedModelBytes: Number(current.modelFacts?.fileBytes) || 0,
                verifiedModelMtimeMs: Number(current.modelFacts?.mtimeMs) || 0,
                verifiedBuild: shortScalar(props.build_info || props.build || props.version),
              },
            };
          } catch (error) {
            // Once /props is ready, an argv/slot/capability mismatch cannot
            // become correct by polling. Fail now so the runner can recover.
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(lastFailure);
    },
  };
}

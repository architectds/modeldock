// Calibration records real measurements without embedding prompts, outputs, or
// device-specific launch guesses. An adapter supplies candidates only after
// that hardware line has been validated on an actual host.

import { createLocalHostCapacityContract } from "./local-host-capacity.mjs";
import { LOCAL_HOST_ADAPTERS, normalizeLaunchSpec } from "./local-hosts.mjs";

const METRIC_KEYS = new Set(["firstTokenMs", "prefillTokensPerSecond", "decodeTokensPerSecond", "headroomBytes"]);

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function copy(value) {
  return structuredClone(value);
}

function normalizeMetrics(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new TypeError("Calibration metrics must be an object.");
  const normalized = {};
  for (const [key, metric] of Object.entries(value)) {
    if (!METRIC_KEYS.has(key)) throw new TypeError(`Unsupported calibration metric: ${key}.`);
    if (typeof metric !== "number" || !Number.isFinite(metric) || metric < 0) {
      throw new TypeError(`Calibration metric ${key} must be a non-negative number.`);
    }
    normalized[key] = metric;
  }
  return normalized;
}

function normalizeCandidate(value, adapterId) {
  const candidate = {
    id: text(value?.id, "A calibration candidate id"),
    modelId: text(value?.modelId, "A calibration candidate model id"),
    launchSpec: normalizeLaunchSpec(value?.launchSpec),
  };
  if (value?.adapterId && text(value.adapterId, "A calibration candidate adapter id") !== adapterId) {
    throw new TypeError("A calibration candidate must match the plan adapter.");
  }
  return candidate;
}

export function createLocalHostCalibrationPlan({ hostId, adapterId, candidates = [] } = {}) {
  const normalizedAdapterId = text(adapterId, "A local host adapter id");
  if (!LOCAL_HOST_ADAPTERS[normalizedAdapterId]) throw new TypeError(`Unsupported local host adapter: ${normalizedAdapterId}.`);
  if (!Array.isArray(candidates)) throw new TypeError("Calibration candidates must be an array.");
  const normalizedCandidates = candidates.map((candidate) => normalizeCandidate(candidate, normalizedAdapterId));
  const ids = new Set(normalizedCandidates.map(({ id }) => id));
  if (ids.size !== normalizedCandidates.length) throw new TypeError("Calibration candidate ids must be unique.");
  return Object.freeze({
    version: 1,
    hostId: text(hostId, "A local host id"),
    adapterId: normalizedAdapterId,
    candidates: normalizedCandidates,
    results: [],
  });
}

export function recordLocalHostCalibrationResult(plan, { candidateId, success, metrics = {}, capacity } = {}) {
  const candidate = plan?.candidates?.find((entry) => entry.id === text(candidateId, "A calibration candidate id"));
  if (!candidate) throw new TypeError(`Unknown calibration candidate: ${candidateId || "(empty)"}.`);
  if (typeof success !== "boolean") throw new TypeError("Calibration success must be a boolean.");
  const normalizedMetrics = normalizeMetrics(metrics);
  let normalizedCapacity = null;
  if (success) {
    normalizedCapacity = createLocalHostCapacityContract(capacity);
    if (normalizedCapacity.adapterId !== plan.adapterId || normalizedCapacity.modelId !== candidate.modelId || normalizedCapacity.profileId !== candidate.id) {
      throw new TypeError("Successful calibration capacity must describe its plan adapter, model, and candidate id.");
    }
  } else if (capacity !== undefined) {
    throw new TypeError("A failed calibration cannot publish a capacity contract.");
  }
  const result = { candidateId: candidate.id, success, metrics: normalizedMetrics, capacity: normalizedCapacity };
  const results = [...(plan?.results || []).filter((entry) => entry.candidateId !== candidate.id), result];
  return Object.freeze({ ...copy(plan), results });
}

// Selection has no hidden benchmark heuristic. A later policy layer must make
// its scoring rule explicit and can receive only verified result records.
export function selectVerifiedCalibrationProfile(plan, compare) {
  if (typeof compare !== "function") throw new TypeError("Selecting a calibration profile requires an explicit comparator.");
  const verified = (plan?.results || []).filter((result) => result.success && result.capacity);
  if (!verified.length) return null;
  return copy(verified.reduce((best, current) => (compare(current, best) > 0 ? current : best)));
}

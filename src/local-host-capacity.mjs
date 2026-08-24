// A capacity contract is a measured promise to the client, not a translation
// of llama.cpp flags. The scheduler decides who may consume it; the catalog
// sees only the window that one admitted request can reliably use.

import { LOCAL_HOST_ADAPTERS } from "./local-hosts.mjs";

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function ratio(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new TypeError(`${label} must be greater than zero and less than one.`);
  }
  return value;
}

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

export function createLocalHostCapacityContract({
  adapterId,
  modelId,
  profileId,
  maxSingleRequestTokens,
  outputReserveTokens,
  maxActiveRequests,
  autoCompactRatio = 0.8,
} = {}) {
  const normalizedAdapterId = text(adapterId, "A local host adapter id");
  if (!LOCAL_HOST_ADAPTERS[normalizedAdapterId]) throw new TypeError(`Unsupported local host adapter: ${normalizedAdapterId}.`);
  const maximum = positiveInteger(maxSingleRequestTokens, "maxSingleRequestTokens");
  const reserve = positiveInteger(outputReserveTokens, "outputReserveTokens");
  if (reserve >= maximum) throw new TypeError("outputReserveTokens must leave room for input.");
  const compactRatio = ratio(autoCompactRatio, "autoCompactRatio");
  return Object.freeze({
    version: 1,
    adapterId: normalizedAdapterId,
    modelId: text(modelId, "A local model id"),
    profileId: text(profileId, "A selected profile id"),
    maxSingleRequestTokens: maximum,
    outputReserveTokens: reserve,
    maxActiveRequests: positiveInteger(maxActiveRequests, "maxActiveRequests"),
    autoCompactRatio: compactRatio,
  });
}

// The profile calculator owns the static per-GPU arithmetic. This adapter is
// deliberately narrow: the catalog and scheduler receive only the one honest
// per-lane window and its fixed lane count, never total context or VRAM facts.
export function createLocalHostCapacityFromLaneProfile(profile, {
  outputReserveTokens,
  autoCompactRatio = 0.8,
} = {}) {
  if (!profile || typeof profile !== "object") throw new TypeError("A selected local host lane profile is required.");
  return createLocalHostCapacityContract({
    adapterId: profile.adapterId,
    modelId: profile.modelId,
    profileId: profile.profileId,
    maxSingleRequestTokens: profile.laneContextTokens,
    outputReserveTokens,
    maxActiveRequests: profile.laneCount,
    autoCompactRatio,
  });
}

export function catalogContextFromCapacity(contract) {
  const normalized = createLocalHostCapacityContract(contract);
  const inputBudget = normalized.maxSingleRequestTokens - normalized.outputReserveTokens;
  const autoCompactTokenLimit = Math.floor(inputBudget * normalized.autoCompactRatio);
  return Object.freeze({
    context_window: normalized.maxSingleRequestTokens,
    max_context_window: normalized.maxSingleRequestTokens,
    auto_compact_token_limit: autoCompactTokenLimit,
  });
}

export function admissionBudgetFromCapacity(contract) {
  const normalized = createLocalHostCapacityContract(contract);
  return Object.freeze({
    maxInputTokens: normalized.maxSingleRequestTokens - normalized.outputReserveTokens,
    outputReserveTokens: normalized.outputReserveTokens,
    maxActiveRequests: normalized.maxActiveRequests,
  });
}

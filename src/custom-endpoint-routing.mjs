import { modelRefParts } from "./model-ref.mjs";

// Resolve the endpoint serving a model by the provider-qualified address the
// model carries. This pure lookup lives below both the endpoint store and the
// provider registry so those two owners can depend on it without a cycle.
export function customEndpointFor(endpoints, model) {
  if (!model) return null;
  const ref = modelRefParts(model);
  const bare = ref.model;
  const provider = ref.provider;
  const list = endpoints || [];
  if (provider) {
    const owned = list.find((entry) =>
      entry.modelId === bare && (entry.providerId || "custom") === provider);
    if (owned) return owned;
    // An explicit provider is an address, not a hint. Once the caller writes
    // `model@provider`, never fall back to an endpoint serving the same bare
    // model under another provider (or to the legacy custom group when the
    // provider is unknown).
    return null;
  }
  return list.find((entry) => entry.modelId === bare) || null;
}

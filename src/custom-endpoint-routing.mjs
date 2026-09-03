// Resolve the endpoint serving a model by the provider-qualified address the
// model carries. This pure lookup lives below both the endpoint store and the
// provider registry so those two owners can depend on it without a cycle.
export function customEndpointFor(endpoints, model) {
  if (!model) return null;
  const slug = String(model);
  const separator = slug.lastIndexOf("@");
  const bare = separator > 0 ? slug.slice(0, separator) : slug;
  const provider = separator > 0 ? slug.slice(separator + 1) : "";
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

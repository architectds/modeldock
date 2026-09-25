import { modelRefParts } from "./model-ref.mjs";

// Every user endpoint belongs to the one custom provider. The model id is its
// address inside that provider, so one lookup serves catalog and routing.
export function customEndpointFor(endpoints, model) {
  if (!model) return null;
  const bare = modelRefParts(model).model;
  return (endpoints || []).find((entry) => entry.modelId === bare) || null;
}

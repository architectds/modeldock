import { modelRefParts } from "./model-ref.mjs";

// The caller passes one provider's subset of the endpoint list. The model id
// is an address within that owner, so Local and Custom may use the same name.
export function customEndpointFor(endpoints, model) {
  if (!model) return null;
  const bare = modelRefParts(model).model;
  return (endpoints || []).find((entry) => entry.modelId === bare) || null;
}

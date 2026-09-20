import { modelAddressFor, modelRefParts } from "./model-ref.mjs";

// One model identity is shared by usage aggregation and equivalent API
// pricing. Providers and vendor namespaces describe where a model was served,
// not which model did the work.
export function canonicalModelId(model) {
  const raw = String(model || "").trim();
  if (!raw) return raw;
  const ref = modelRefParts(raw);
  const withoutProvider = ref.qualified ? ref.model : raw;
  const vendorSeparator = withoutProvider.lastIndexOf("/");
  const bare = vendorSeparator >= 0 ? withoutProvider.slice(vendorSeparator + 1) : withoutProvider;
  return bare
    .toLowerCase()
    .replace(/[_\s:]+/g, "-")
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || raw;
}

// The stable llama.cpp entry. A local machine has one llama.cpp endpoint and
// its published identity survives whatever GGUF is loaded underneath it, so
// every name that endpoint has ever been published under ("Qwen3.8-27B", a
// codename read from a file header, a shard path) is an alias of this one
// slug. Routing aliases a stale request onto it, stats fold history onto it,
// and a replayed boot selection resolves through it - all three must agree on
// the exact string, so the rule lives beside the other shared identity.
export const LLAMACPP_LOCAL_MODEL_ID = "Local";
export const LLAMACPP_LOCAL_SLUG = modelAddressFor("llamacpp", LLAMACPP_LOCAL_MODEL_ID);
// "Is this name addressed to the local llama.cpp endpoint?" - the one place that
// spelling is tested. Routing, the stored vision reference, and the entry resolver
// each gate the alias on a different authority (the published catalog, the profile,
// the loaded snapshot), but they must agree on what counts as a llama.cpp name or
// they will disagree about which requests are aliases.
export function isLlamaLocalName(value) {
  return modelRefParts(value).provider === "llamacpp";
}
export function canonicalLlamaLocalKey(key) {
  const raw = String(key || "");
  return isLlamaLocalName(raw) ? LLAMACPP_LOCAL_SLUG : raw;
}

// Fold a map keyed by published slug onto the stable local entry.
//
// A stored key is the slug the catalog published when it was written, so a
// window measured before the stable identity is filed under the file's own name
// and stops matching the entry that is published now. Callers gate this on
// llamaLocalStableEntry(): with several local models there is no stable entry,
// each one keeps its own id, and its keys are not aliases of each other. The
// canonical key wins, so a fold can never overwrite a newer value with an older
// name for the same entry.
export function foldLlamaLocalKeys(map) {
  if (!map || typeof map !== "object") return map;
  const keys = Object.keys(map);
  if (!keys.some((key) => isLlamaLocalName(key) && key !== LLAMACPP_LOCAL_SLUG)) return map;
  const folded = {};
  for (const [key, value] of Object.entries(map)) {
    if (!isLlamaLocalName(key) || key === LLAMACPP_LOCAL_SLUG) {
      folded[key] = value;
      continue;
    }
    if (!(LLAMACPP_LOCAL_SLUG in folded)) folded[LLAMACPP_LOCAL_SLUG] = value;
  }
  return folded;
}

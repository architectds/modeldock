import { modelRefParts } from "./model-ref.mjs";

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

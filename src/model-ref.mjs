import { Buffer } from "node:buffer";

// Internal model ownership and the Codex-facing wire identity are two distinct
// contracts. ModelDock keeps the readable `model@provider` address internally;
// Codex receives a reversible slug made only from characters its metrics layer
// accepts. Existing tasks may still send the old address, so the parser accepts
// both spellings while every new catalog writes only the safe one.
export const LEGACY_PROVIDER_SEPARATOR = "@";
export const CODEX_ROUTED_SLUG_PREFIX = "mdr.";
export const CODEX_METRIC_TAG_VALUE = /^[A-Za-z0-9._/-]+$/;

const modelId = (model) => typeof model === "string" ? model : model?.id;
const encode = (value) => Buffer.from(String(value), "utf8").toString("base64url");

function decode(value) {
  try {
    const decoded = Buffer.from(String(value), "base64url").toString("utf8");
    return encode(decoded) === value ? decoded : "";
  } catch {
    return "";
  }
}

export function modelAddressFor(provider, model) {
  const id = modelId(model);
  if (!id) return id || model;
  return provider ? `${id}${LEGACY_PROVIDER_SEPARATOR}${provider}` : id;
}

export function codexSlugFor(provider, model) {
  const id = modelId(model);
  if (!id) return id || model;
  if (!provider) return id;
  const slug = `${CODEX_ROUTED_SLUG_PREFIX}${encode(provider)}.${encode(id)}`;
  if (!isCodexTelemetrySafeSlug(slug)) {
    throw new Error("Could not encode a Codex telemetry-safe model slug.");
  }
  return slug;
}

export function modelRefParts(model) {
  const raw = String(model || "");
  if (raw.startsWith(CODEX_ROUTED_SLUG_PREFIX)) {
    const encoded = raw.slice(CODEX_ROUTED_SLUG_PREFIX.length).split(".");
    if (encoded.length === 2) {
      const provider = decode(encoded[0]);
      const id = decode(encoded[1]);
      if (provider && id) return { raw, model: id, provider, qualified: true, format: "codex" };
    }
    // The prefix is an explicit routed address. A corrupted encoding must fail
    // closed at the routed boundary, never become an unknown bare id that the
    // native ChatGPT passthrough might accept.
    return { raw, model: raw, provider: "", qualified: true, format: "invalid-codex" };
  }
  const at = raw.lastIndexOf(LEGACY_PROVIDER_SEPARATOR);
  if (at > 0 && at < raw.length - 1) {
    return { raw, model: raw.slice(0, at), provider: raw.slice(at + 1), qualified: true, format: "legacy" };
  }
  if (raw.includes(LEGACY_PROVIDER_SEPARATOR)) {
    return { raw, model: raw, provider: "", qualified: true, format: "invalid-legacy" };
  }
  return { raw, model: raw, provider: "", qualified: false, format: "bare" };
}

export function internalModelRef(model) {
  const parts = modelRefParts(model);
  return parts.qualified ? modelAddressFor(parts.provider, parts.model) : parts.raw;
}

export function codexModelRef(model) {
  const parts = modelRefParts(model);
  return parts.qualified ? codexSlugFor(parts.provider, parts.model) : parts.raw;
}

export function isCodexTelemetrySafeSlug(model) {
  const value = String(model || "");
  return Boolean(value) && CODEX_METRIC_TAG_VALUE.test(value);
}

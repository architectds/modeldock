import { profileById } from "./profiles.mjs";
// Provider token validation at the write boundary (settings API). Providers
// reject malformed keys at request time with confusing errors, so the shape is
// checked before anything reaches the .env - DeepSeek setup-script semantics
// (:324-354): the key must carry its documented prefix and must not contain
// quotes. A failed validation aborts the write; the .env is left untouched.
export function validateProviderToken(provider, value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return { ok: false, error: "The token is empty." };
  }
  if (/[\s"']/.test(raw)) {
    return { ok: false, error: "The token must not contain quotes or spaces." };
  }
  // Asked of the provider rather than listed here: a new keyed endpoint
  // brings its own key format, and this file should not have to learn it.
  const profile = profileById(provider);
  if (profile?.tokenPattern && !profile.tokenPattern.test(raw)) {
    return { ok: false, error: profile.tokenHint || `A ${profile.label} key does not look right.` };
  }
  // Exa is a search provider, not a model provider: it has no profile, so its
  // shape stays here.
  if (provider === "exa" && !/^exa_[A-Za-z0-9_-]+$/.test(raw)) {
    return { ok: false, error: "An Exa API key must look like exa_<token>." };
  }
  return { ok: true, value: raw };
}

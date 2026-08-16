// One reader for the Codex sign-in file (~/.codex/auth.json).
//
// Two callers needed it and each parsed the file its own way: config.mjs asked
// "is there a session at all" (access_token, refresh_token, or the legacy
// OPENAI_API_KEY), while upstreams.mjs reached in for tokens.access_token and
// tokens.account_id to call the native image endpoint. Same file, same
// Codex-internal shape, two independent copies of the knowledge - so a change to
// auth.json's layout would silently break native image generation while the
// sign-in check kept reporting a healthy session, and the published catalog kept
// advertising native GPT models.
//
// Every field is normalised to a string so callers never have to re-check types,
// and an unreadable or malformed file reads as "no sign-in" rather than throwing:
// a missing credential is an ordinary state here, not an error.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const EMPTY = Object.freeze({ present: false, accessToken: "", refreshToken: "", accountId: "", apiKey: "" });

export function codexAuthPath(codexHome) {
  return codexHome ? path.join(codexHome, "auth.json") : "";
}

export function readCodexAuth(codexHome) {
  const file = codexAuthPath(codexHome);
  // No codexHome is the same answer as no file. The previous inline readers got
  // here by letting path.join throw into a catch; say it directly instead.
  if (!file) return { ...EMPTY, file: "" };
  try {
    if (!existsSync(file)) return { ...EMPTY, file };
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const tokens = parsed?.tokens || {};
    return {
      file,
      present: true,
      accessToken: String(tokens.access_token || ""),
      refreshToken: String(tokens.refresh_token || ""),
      accountId: String(tokens.account_id || ""),
      apiKey: String(parsed?.OPENAI_API_KEY || ""),
    };
  } catch {
    return { ...EMPTY, file };
  }
}

// A refresh token counts as a sign-in: Codex refreshes it silently, so a session
// carrying only a refresh token is still usable.
export function hasChatGptLogin(codexHome) {
  const auth = readCodexAuth(codexHome);
  return Boolean(auth.accessToken || auth.refreshToken || auth.apiKey);
}

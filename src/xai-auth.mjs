// Signing in to xAI with a Grok subscription, instead of paying per token.
//
// xAI publishes an OIDC device-code grant at auth.x.ai. The whole parameter set
// below is what its own discovery document declares - device_authorization_endpoint,
// token_endpoint, the device_code grant, and every scope named here - so nothing
// is inferred from a client's traffic:
//
//   https://auth.x.ai/.well-known/openid-configuration
//
// The client id is xAI's public Grok-CLI client, the same one their partner
// integrations use. A device grant has no client secret by design: the user's
// browser approval is the credential, which is why this works from a gateway
// that never sees a password.
//
// Device code rather than a redirect: ModelDock is a loopback service with no
// public callback URL, and the user may be on a machine without a browser at
// all. They open a short URL anywhere, type a nine-character code, and this
// polls until they approve.
import path from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { stateFile } from "./state-dir.mjs";
import { encryptSecret, decryptSecret } from "./secrets.mjs";
import { protectPrivateFile } from "./caller-key.mjs";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_DEVICE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_API_BASE = "https://api.x.ai/v1";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

// Refreshed this long before it actually expires, so a tool call that starts
// just under the wire does not have to recover from a mid-flight 401. The skew
// must exceed the server's 10-minute refresh timer: at 5 minutes a token could
// pass its effective expiry between ticks, and the relay's synchronous target()
// would hand out an expired bearer until the next tick.
export const REFRESH_SKEW_MS = 15 * 60 * 1000;

export class XaiAuthError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "XaiAuthError";
    this.code = code;
  }
}

const form = (fields) => new URLSearchParams(fields).toString();

async function postForm(fetchImpl, url, fields, timeoutMs) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form(fields),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* reported below with the status */ }
  return { ok: response.ok, status: response.status, body, text };
}

// Step one: ask for a code the user can approve elsewhere.
export async function startDeviceAuthorization({ fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const result = await postForm(fetchImpl, XAI_DEVICE_URL, {
    client_id: XAI_CLIENT_ID,
    scope: XAI_SCOPE,
  }, timeoutMs);
  if (!result.ok || !result.body.device_code) {
    throw new XaiAuthError("device", `xAI refused the sign-in request (HTTP ${result.status}).`);
  }
  return {
    deviceCode: result.body.device_code,
    userCode: result.body.user_code || "",
    // verification_uri_complete already carries the code, so a user who can
    // click the link never has to type it.
    verificationUrl: result.body.verification_uri_complete || result.body.verification_uri || "",
    intervalMs: Math.max(Number(result.body.interval || 5) * 1000, 1000),
    expiresAt: Date.now() + Number(result.body.expires_in || 300) * 1000,
  };
}

// Step two, called repeatedly while the user is deciding. "Pending" is the
// normal answer and is not an error: the flow is a person walking to a browser.
export async function pollDeviceToken(deviceCode, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const result = await postForm(fetchImpl, XAI_TOKEN_URL, {
    client_id: XAI_CLIENT_ID,
    device_code: deviceCode,
    grant_type: DEVICE_CODE_GRANT,
  }, timeoutMs);
  if (result.ok && result.body.access_token) return { status: "ready", token: tokenFrom(result.body) };
  const error = String(result.body.error || "");
  if (error === "authorization_pending") return { status: "pending" };
  // The server asking us to back off is also not a failure.
  if (error === "slow_down") return { status: "slow_down" };
  if (error === "expired_token") return { status: "expired" };
  return {
    status: "denied",
    message: result.body.error_description || error || `HTTP ${result.status}`,
  };
}

export async function refreshAccessToken(refreshToken, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const result = await postForm(fetchImpl, XAI_TOKEN_URL, {
    client_id: XAI_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, timeoutMs);
  if (!result.ok || !result.body.access_token) {
    const error = new XaiAuthError("refresh", result.body.error_description || result.body.error || `HTTP ${result.status}`);
    // The caller must tell a dead session from a bad night: status and the
    // OAuth error code are what isDefinitiveAuthRejection reads.
    error.status = result.status;
    error.oauthError = String(result.body.error || "");
    throw error;
  }
  return tokenFrom(result.body, refreshToken);
}

// Whether a refresh failure means the session itself is over. Only auth.x.ai
// saying "this grant is no good" (a 4xx) qualifies: a fetch-level throw is the
// laptop waking up offline, and a 5xx is their outage - deleting the refresh
// token on either signed the user out of Grok for good over a transient
// failure, which is exactly the wrong trade for the longest-lived secret in
// this file.
export function isDefinitiveAuthRejection(error) {
  if (!(error instanceof XaiAuthError)) return false;
  const status = Number(error.status || 0);
  return status >= 400 && status < 500;
}

function tokenFrom(body, previousRefresh = "") {
  return {
    accessToken: String(body.access_token || ""),
    // A rotated refresh token replaces the old one; a response without one
    // means the old one is still valid, and dropping it would strand the
    // session at the next expiry.
    refreshToken: String(body.refresh_token || previousRefresh || ""),
    expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
    scope: String(body.scope || ""),
  };
}

// The models this subscription can actually reach. Asked at connect time and
// stored, so a restart republishes without contacting xAI.
export async function listXaiModels(accessToken, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const response = await fetchImpl(`${XAI_API_BASE}/models`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 401 || response.status === 403) {
    throw new XaiAuthError("forbidden", "This Grok subscription cannot reach the model API.");
  }
  if (!response.ok) throw new XaiAuthError("models", `Model list failed with HTTP ${response.status}.`);
  const body = await response.json().catch(() => ({}));
  return (body.data || [])
    .map((entry) => String(entry?.id || "").trim())
    .filter(Boolean);
}

export function xaiAuthPath() {
  return stateFile("xai-auth.json");
}

// Both tokens are secrets: the refresh token is the long-lived one and is worth
// more than the access token it mints.
export function readXaiAuth(file = xaiAuthPath()) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const accessToken = decryptSecret(parsed.accessToken || "");
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: decryptSecret(parsed.refreshToken || ""),
      expiresAt: Number(parsed.expiresAt) || 0,
      scope: String(parsed.scope || ""),
      models: Array.isArray(parsed.models) ? parsed.models.filter((m) => typeof m === "string") : [],
      connectedAt: String(parsed.connectedAt || ""),
    };
  } catch {
    return null;
  }
}

export function writeXaiAuth(file, auth) {
  mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    accessToken: encryptSecret(auth.accessToken || ""),
    refreshToken: encryptSecret(auth.refreshToken || ""),
    expiresAt: Number(auth.expiresAt) || 0,
    scope: String(auth.scope || ""),
    models: Array.isArray(auth.models) ? auth.models : [],
    connectedAt: auth.connectedAt || new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  // mode on the temp file, not just a chmod after: rename preserves the temp
  // file's permissions, so the refresh token is never world-readable even for
  // the instant between rename and hardening. DPAPI covers the content only on
  // Windows; on macOS/Linux the file mode is the whole protection.
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  // POSIX only: on Windows the tokens are DPAPI-sealed and %USERPROFILE% ACLs
  // already exclude other users, while protectPrivateFile there costs an
  // icacls spawn on a write that runs from the ten-minute refresh timer.
  if (process.platform !== "win32") {
    try {
      protectPrivateFile(file);
    } catch {
      // Hardening must never take the sign-in down.
    }
  }
  return file;
}

export function clearXaiAuth(file = xaiAuthPath()) {
  try { rmSync(file, { force: true }); } catch { /* best effort */ }
  return file;
}

export function accessTokenExpired(auth, now = Date.now()) {
  if (!auth?.accessToken) return true;
  return now >= Number(auth.expiresAt || 0) - REFRESH_SKEW_MS;
}

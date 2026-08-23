// A device grant is three moments - ask, wait, use - and the waiting is the
// part that goes wrong. "Pending" is the normal answer and must not read as a
// failure; "slow_down" is the server asking for patience, not a refusal; and a
// refresh response without a new refresh token means the old one still stands,
// which is the difference between a session that survives the night and one
// that strands the user at the next expiry.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import {
  XAI_CLIENT_ID,
  XAI_SCOPE,
  XaiAuthError,
  accessTokenExpired,
  isDefinitiveAuthRejection,
  listXaiModels,
  pollDeviceToken,
  readXaiAuth,
  refreshAccessToken,
  startDeviceAuthorization,
  writeXaiAuth,
} from "../src/xai-auth.mjs";
import { dpapiSupported } from "../src/secrets.mjs";

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

test("the sign-in request carries the client and scopes xAI publishes", async () => {
  let sent = null;
  const fetchImpl = async (url, init) => {
    sent = { url, body: new URLSearchParams(init.body) };
    return reply(200, {
      device_code: "dev-123",
      user_code: "ABCD-EFGH",
      verification_uri: "https://accounts.x.ai/oauth2/device",
      verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
      interval: 5,
      expires_in: 1800,
    });
  };

  const device = await startDeviceAuthorization({ fetchImpl });
  assert.equal(sent.url, "https://auth.x.ai/oauth2/device/code");
  assert.equal(sent.body.get("client_id"), XAI_CLIENT_ID);
  assert.equal(sent.body.get("scope"), XAI_SCOPE);

  // The complete URL already carries the code, so a user who can click never
  // has to type it.
  assert.equal(device.verificationUrl, "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH");
  assert.equal(device.userCode, "ABCD-EFGH");
  assert.equal(device.intervalMs, 5000);
  assert.ok(device.expiresAt > Date.now());
});

test("waiting for a person is not an error", async () => {
  const answers = [
    [400, { error: "authorization_pending" }, "pending"],
    [400, { error: "slow_down" }, "slow_down"],
    [400, { error: "expired_token" }, "expired"],
    [400, { error: "access_denied", error_description: "User denied" }, "denied"],
  ];
  for (const [status, body, expected] of answers) {
    const result = await pollDeviceToken("dev-123", { fetchImpl: async () => reply(status, body) });
    assert.equal(result.status, expected, `${body.error} reads as ${expected}`);
  }

  const ready = await pollDeviceToken("dev-123", {
    fetchImpl: async () => reply(200, {
      access_token: "at", refresh_token: "rt", expires_in: 21600, scope: XAI_SCOPE,
    }),
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.token.accessToken, "at");
  assert.equal(ready.token.refreshToken, "rt");
  assert.ok(ready.token.expiresAt > Date.now() + 21_000_000);
});

test("a refresh without a new refresh token keeps the one that still works", async () => {
  const rotated = await refreshAccessToken("old-rt", {
    fetchImpl: async () => reply(200, { access_token: "at2", refresh_token: "new-rt", expires_in: 3600 }),
  });
  assert.equal(rotated.refreshToken, "new-rt", "a rotated token replaces the old one");

  const unchanged = await refreshAccessToken("old-rt", {
    fetchImpl: async () => reply(200, { access_token: "at3", expires_in: 3600 }),
  });
  assert.equal(
    unchanged.refreshToken,
    "old-rt",
    "no new token means the old one stands; dropping it would strand the session at the next expiry",
  );

  await assert.rejects(
    () => refreshAccessToken("dead-rt", { fetchImpl: async () => reply(400, { error: "invalid_grant" }) }),
    (error) => error instanceof XaiAuthError && error.code === "refresh",
  );
});

// Signing in and reaching the models are gated separately by xAI: a token is
// not proof that this subscription can infer.
test("a subscription that cannot reach the models says so", async () => {
  await assert.rejects(
    () => listXaiModels("at", { fetchImpl: async () => ({ status: 403, ok: false, json: async () => ({}) }) }),
    (error) => error.code === "forbidden",
  );
  const models = await listXaiModels("at", {
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ data: [{ id: "grok-4.6" }, { id: "grok-4.5" }, { id: "" }] }) }),
  });
  assert.deepEqual(models, ["grok-4.6", "grok-4.5"]);
});

test("both tokens are stored encrypted, and the refresh token is the one worth protecting", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-xai-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "xai-auth.json");

  writeXaiAuth(file, {
    accessToken: "access-plaintext",
    refreshToken: "refresh-plaintext",
    expiresAt: Date.now() + 3600_000,
    scope: XAI_SCOPE,
    models: ["grok-4.6"],
  });

  // DPAPI is Windows-only. Where it exists both tokens must be sealed; where it
  // does not they are stored as given, the same bargain every other secret in
  // this install makes - and asserting the Windows behaviour everywhere is how
  // this test passed locally and failed on Linux CI.
  const raw = readFileSync(file, "utf8");
  if (dpapiSupported()) {
    assert.equal(raw.includes("access-plaintext"), false, "the access token is not on disk in the clear");
    assert.equal(raw.includes("refresh-plaintext"), false, "nor the refresh token, which outlives it");
    assert.match(raw, /"refreshToken": "dpapi:/);
  } else {
    assert.ok(raw.includes("refresh-plaintext"), "without DPAPI it is stored as given");
  }

  const back = readXaiAuth(file);
  assert.equal(back.accessToken, "access-plaintext");
  assert.equal(back.refreshToken, "refresh-plaintext");
  assert.deepEqual(back.models, ["grok-4.6"]);

  // A file with no usable token is no session, not a half-connected one.
  writeXaiAuth(file, { accessToken: "", refreshToken: "", expiresAt: 0, models: [] });
  assert.equal(readXaiAuth(file), null);
});

test("the auth file is readable by the current user only (POSIX)", (t) => {
  // On macOS/Linux there is no DPAPI, so the refresh token sits in this file in
  // the clear and the file mode is its whole at-rest protection. Windows
  // expresses the same restriction through ACLs, which stat cannot see.
  if (process.platform === "win32") return t.skip("POSIX file modes do not apply on Windows");
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-xai-mode-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "xai-auth.json");
  writeXaiAuth(file, { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000, models: [] });
  assert.equal(statSync(file).mode & 0o777, 0o600, "group/other must have no access to the refresh token");
});

test("only a 4xx from the token endpoint counts as a dead session", async () => {
  // The refresh caller deletes the refresh token on a definitive rejection and
  // must NOT on anything transient: a laptop waking up offline at the refresh
  // tick used to sign the user out of Grok permanently.
  const failWith = async (status, body) => {
    try {
      await refreshAccessToken("rt", { fetchImpl: async () => ({ ok: false, status, text: async () => JSON.stringify(body) }) });
      assert.fail("the refresh should have thrown");
    } catch (error) {
      return error;
    }
  };
  const revoked = await failWith(400, { error: "invalid_grant" });
  assert.equal(isDefinitiveAuthRejection(revoked), true, "invalid_grant is the session ending");
  assert.equal(revoked.oauthError, "invalid_grant");
  const outage = await failWith(503, { error: "temporarily_unavailable" });
  assert.equal(isDefinitiveAuthRejection(outage), false, "their outage is not our sign-out");
  const offline = new TypeError("fetch failed");
  assert.equal(isDefinitiveAuthRejection(offline), false, "a network throw is not a rejection at all");
});

test("a token is refreshed before it expires, not after", () => {
  const now = Date.now();
  assert.equal(accessTokenExpired({ accessToken: "at", expiresAt: now + 3600_000 }, now), false);
  // Inside the skew: still valid, but a tool call starting now could outlive it,
  // so it is treated as expired and refreshed early.
  assert.equal(accessTokenExpired({ accessToken: "at", expiresAt: now + 60_000 }, now), true);
  assert.equal(accessTokenExpired({ accessToken: "at", expiresAt: now - 1 }, now), true);
  assert.equal(accessTokenExpired(null, now), true);
});

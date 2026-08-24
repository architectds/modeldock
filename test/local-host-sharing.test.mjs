import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeLocalHostAction,
  createLocalHostSharingPolicy,
  disabledLocalHostSharing,
} from "../src/local-host-sharing.mjs";

test("sharing is disabled by default and keeps no transport configuration", () => {
  assert.deepEqual(disabledLocalHostSharing(), { version: 1, enabled: false, tls: null, principals: [], localPriority: true });
  assert.deepEqual(authorizeLocalHostAction(disabledLocalHostSharing(), { source: "remote", principalId: "phone", action: "infer" }), {
    allowed: false, reason: "sharing_disabled",
  });
});

test("enabled sharing needs TLS references and explicit authenticated principals", () => {
  assert.throws(() => createLocalHostSharingPolicy({ enabled: true }), /requires TLS/);
  assert.throws(() => createLocalHostSharingPolicy({ enabled: true, tls: { certificateRef: "cert", privateKeyRef: "key" } }), /at least one/);
  assert.throws(() => createLocalHostSharingPolicy({
    enabled: true,
    tls: { certificateRef: "cert", privateKeyRef: "key" },
    principals: [{ id: "phone-a", weight: 0 }],
  }), /positive integer/);
  const policy = createLocalHostSharingPolicy({
    enabled: true,
    tls: { certificateRef: "keychain:modeldock-cert", privateKeyRef: "keychain:modeldock-key" },
    principals: [{ id: "phone-a", weight: 2 }],
  });
  assert.equal(policy.tls.privateKeyRef, "keychain:modeldock-key");
  assert.equal(policy.principals[0].weight, 2);
});

test("remote sharing can infer and cancel its own work but never manage or recycle the host", () => {
  const policy = createLocalHostSharingPolicy({
    enabled: true,
    tls: { certificateRef: "keychain:modeldock-cert", privateKeyRef: "keychain:modeldock-key" },
    principals: [{ id: "phone-a" }],
  });
  assert.equal(authorizeLocalHostAction(policy, { source: "remote", principalId: "phone-a", action: "infer" }).allowed, true);
  assert.deepEqual(authorizeLocalHostAction(policy, { source: "remote", principalId: "phone-a", action: "recycle" }), {
    allowed: false, reason: "remote_management_forbidden",
  });
  assert.equal(authorizeLocalHostAction(policy, { source: "local", action: "recycle" }).allowed, true);
  assert.deepEqual(authorizeLocalHostAction(policy, { source: "remote", principalId: "unknown", action: "infer" }), {
    allowed: false, reason: "unauthenticated_principal",
  });
});

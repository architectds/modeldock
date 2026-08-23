// Local-network sharing begins as a policy and authorization contract. This
// module does not create a listener, publish discovery data, or retain TLS
// material. A future transport receives only reference names after this policy
// has been explicitly enabled.

const REMOTE_ACTIONS = new Set(["infer", "cancel_own", "read_status"]);
const LOCAL_ACTIONS = new Set([...REMOTE_ACTIONS, "manage", "recycle", "configure"]);

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function normalizePrincipals(value) {
  if (!Array.isArray(value)) throw new TypeError("Sharing principals must be an array.");
  const principals = value.map((principal) => ({
    id: text(principal?.id, "A sharing principal id"),
    weight: principal?.weight === undefined ? 1 : positiveInteger(principal.weight, "A sharing principal weight"),
  }));
  if (new Set(principals.map(({ id }) => id)).size !== principals.length) throw new TypeError("Sharing principal ids must be unique.");
  return principals;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

export function disabledLocalHostSharing() {
  return Object.freeze({ version: 1, enabled: false, tls: null, principals: [], localPriority: true });
}

export function createLocalHostSharingPolicy({ enabled = false, tls, principals = [], localPriority = true } = {}) {
  if (!enabled) return disabledLocalHostSharing();
  if (!tls || typeof tls !== "object") throw new TypeError("Enabled local host sharing requires TLS reference fields.");
  const normalizedTls = {
    certificateRef: text(tls.certificateRef, "A TLS certificate reference"),
    privateKeyRef: text(tls.privateKeyRef, "A TLS private-key reference"),
  };
  const normalizedPrincipals = normalizePrincipals(principals);
  if (!normalizedPrincipals.length) throw new TypeError("Enabled local host sharing requires at least one authenticated principal.");
  if (typeof localPriority !== "boolean") throw new TypeError("localPriority must be a boolean.");
  return Object.freeze({ version: 1, enabled: true, tls: normalizedTls, principals: normalizedPrincipals, localPriority });
}

export function authorizeLocalHostAction(policy, { source, principalId, action } = {}) {
  const normalizedPolicy = createLocalHostSharingPolicy(policy);
  const normalizedSource = text(source, "A request source");
  const normalizedAction = text(action, "A local host action");
  if (normalizedSource === "local") {
    return Object.freeze({ allowed: LOCAL_ACTIONS.has(normalizedAction), reason: LOCAL_ACTIONS.has(normalizedAction) ? "local" : "unknown_action" });
  }
  if (normalizedSource !== "remote") return Object.freeze({ allowed: false, reason: "unknown_source" });
  if (!normalizedPolicy.enabled) return Object.freeze({ allowed: false, reason: "sharing_disabled" });
  const principal = normalizedPolicy.principals.find(({ id }) => id === text(principalId, "A sharing principal id"));
  if (!principal) return Object.freeze({ allowed: false, reason: "unauthenticated_principal" });
  return Object.freeze({ allowed: REMOTE_ACTIONS.has(normalizedAction), reason: REMOTE_ACTIONS.has(normalizedAction) ? "remote" : "remote_management_forbidden" });
}

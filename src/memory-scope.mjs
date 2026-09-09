import { createHmac, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export const MEMORY_SCOPE_HEADER = "x-modeldock-memory-scope";
export const MEMORY_SCOPE_PROOF_HEADER = "x-modeldock-memory-scope-proof";

function stripWindowsNamespace(value) {
  return String(value || "").replace(/^\\\\\?\\/, "");
}

export function canonicalMemoryScope(value = process.cwd()) {
  const resolved = path.resolve(String(value || process.cwd()));
  try {
    return stripWindowsNamespace(realpathSync.native(resolved));
  } catch {
    // A trusted MODELDOCK_MEMORY_SCOPE may name a bucket whose directory does
    // not exist because memory is stored in ModelDock's vault, not at the scope.
    return stripWindowsNamespace(resolved);
  }
}

function comparableScope(value) {
  const canonical = canonicalMemoryScope(value).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? canonical.replaceAll("/", "\\").toLowerCase()
    : canonical;
}

export function sameMemoryScope(left, right) {
  return comparableScope(left) === comparableScope(right);
}

function scopeProof(encodedScope, callerKey) {
  return createHmac("sha256", callerKey)
    .update(`modeldock-memory-scope:v1:${encodedScope}`)
    .digest("hex");
}

export function callerKeyFromGatewayUrl(baseUrl) {
  const match = /\/c\/([^/]+)(?:\/|$)/.exec(new URL(baseUrl).pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

export function memoryScopeHeaders(scope, callerKey) {
  const canonical = canonicalMemoryScope(scope);
  const encoded = Buffer.from(canonical, "utf8").toString("base64url");
  return {
    [MEMORY_SCOPE_HEADER]: encoded,
    [MEMORY_SCOPE_PROOF_HEADER]: scopeProof(encoded, callerKey),
  };
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

export function verifiedMemoryScope(headers, callerKey) {
  const encoded = headerValue(headers, MEMORY_SCOPE_HEADER);
  const suppliedProof = headerValue(headers, MEMORY_SCOPE_PROOF_HEADER);
  if (!encoded || !suppliedProof || !callerKey || encoded.length > 8_192) return "";
  const expectedProof = scopeProof(encoded, callerKey);
  const supplied = Buffer.from(suppliedProof, "utf8");
  const expected = Buffer.from(expectedProof, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return "";
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (!decoded || !path.isAbsolute(decoded)) return "";
    return canonicalMemoryScope(decoded);
  } catch {
    return "";
  }
}

function currentScope(scope) {
  const value = typeof scope === "function" ? scope() : scope;
  if (!value) throw new Error("Memory mutation requires a trusted session scope.");
  return canonicalMemoryScope(value);
}

function mutationArgs(args, scope) {
  const fixed = currentScope(scope);
  if (args?.scope_dir && !sameMemoryScope(args.scope_dir, fixed)) {
    throw new Error("Memory mutation cannot target a scope outside the current project.");
  }
  return { ...(args || {}), scope_dir: fixed };
}

export function bindMemoryScope(upstreams, scope, { strictRecall = false } = {}) {
  const bound = { ...upstreams };
  if (typeof upstreams.recallMemory === "function") {
    bound.recallMemory = (args = {}) => {
      const fixed = currentScope(scope);
      if (strictRecall && args.scope_dir && !sameMemoryScope(args.scope_dir, fixed)) {
        throw new Error("Strict memory recall cannot target a scope outside the configured project.");
      }
      return upstreams.recallMemory(strictRecall
        ? { ...args, scope_dir: fixed, scope_only: true }
        : (args.scope_dir ? args : { ...args, scope_dir: fixed }));
    };
  }
  if (typeof upstreams.storeMemory === "function") {
    bound.storeMemory = (args) => upstreams.storeMemory(mutationArgs(args, scope));
  }
  if (typeof upstreams.learnMemory === "function") {
    bound.learnMemory = (args) => upstreams.learnMemory(mutationArgs(args, scope));
  }
  return bound;
}

export function withoutMemoryMutations(upstreams) {
  const readOnly = { ...upstreams };
  delete readOnly.storeMemory;
  delete readOnly.learnMemory;
  return readOnly;
}

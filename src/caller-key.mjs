import { randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFile } from "./state-dir.mjs";

// Loopback binding does not stop a malicious web page in a local browser from
// POSTing to http://127.0.0.1:<port>/v1/responses (fetch with mode:"no-cors"
// fires even though the response is unreadable), which burns the upstream
// tokens this process holds. Putting a capability key in the base URL closes
// that: Codex reads base_url from config.toml, so the key rides along with zero
// protocol changes, while a hostile page cannot learn it.

export const CALLER_PATH_PREFIX = "/c";
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

// The key file follows MODELDOCK_STATE_DIR when set (mock installs and tests
// redirect it to a throwaway root) and defaults to ~/.modeldock/caller-key,
// which is where every real install already looks.
function keyFilePath() {
  return stateFile("caller-key");
}

// The persisted key is a bearer capability: restrict the file to the current
// user (POSIX 0600; Windows: remove inherited ACLs, grant the user Full
// Control). Same intent as codex-router's file-security.mjs. Failure is never
// fatal - the key still works for this process lifetime.
let windowsSid;
function currentWindowsSid() {
  if (windowsSid) return windowsSid;
  const script = "[Console]::Out.Write([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)";
  windowsSid = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (!windowsSid) throw new Error("Could not resolve the current Windows user SID.");
  return windowsSid;
}

function protectPrivateFile(target) {
  chmodSync(target, 0o600);
  if (process.platform !== "win32") return target;
  const sid = currentWindowsSid();
  execFileSync(
    "icacls.exe",
    [target, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
    { stdio: "ignore" },
  );
  return target;
}

export function validCallerKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

export function callerKeyEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Load the persisted key, minting one on first use. The key is generated
// locally and is not a provider credential; losing it just means re-enabling
// the Codex switch to write the new URL.
export function loadOrCreateCallerKey(filePath = keyFilePath()) {
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (validCallerKey(existing)) {
      try {
        protectPrivateFile(filePath);
      } catch {
        // Hardening must never take the gateway down.
      }
      return existing;
    }
  } catch {
    // Missing or unreadable: mint below.
  }
  const key = randomBytes(32).toString("base64url");
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${key}\n`, "utf8");
    try {
      renameSync(tmp, filePath);
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* keep the original error */ }
      throw error;
    }
    try {
      protectPrivateFile(filePath);
    } catch {
      // Hardening must never take the gateway down.
    }
  } catch {
    // Unwritable state dir: the key still works for this process lifetime.
  }
  return key;
}

export function callerBasePath(key) {
  return `${callerRootPath(key)}/v1`;
}

export function callerRootPath(key) {
  return `${CALLER_PATH_PREFIX}/${key}`;
}

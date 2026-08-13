// Secret-at-rest handling for the user .env file.
//
// Token values (OPENCODE_GO_TOKEN, DEEPSEEK_API_KEY, EXA_API_KEY, MODELDOCK_CUSTOM_API_KEY) are stored on disk
// as `dpapi:<base64>` using the Windows current-user Data Protection API, so a copied
// .env is not readable on another machine or by another user. On non-Windows platforms
// (CI, dev on macOS/Linux) values stay plaintext so nothing breaks; a `dpapi:` value on
// a non-Windows host reads back as empty rather than crashing, and the dashboard then
// prompts for a re-entry.
//
// Reading is backward compatible: a plaintext value is returned unchanged, so an old
// unencrypted .env keeps working with no migration and no way to "lose" the token.

import { execFileSync } from "node:child_process";
import process from "node:process";

export const SECRET_KEYS = new Set([
  "OPENCODE_GO_TOKEN",
  "DEEPSEEK_API_KEY",
  "EXA_API_KEY",
  "MODELDOCK_CUSTOM_API_KEY",
]);
export const PREFIX = "dpapi:";

export function isSecretKey(key) {
  return SECRET_KEYS.has(key);
}

export function dpapiSupported() {
  return process.platform === "win32";
}

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd())",
  "$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($e))",
].join("; ");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd())",
  "$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($d))",
].join("; ");

function runDpapi(script, payload) {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      input: `${payload}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  ).trim();
}

// Encrypt a plaintext secret. Already-encrypted values pass through unchanged; on
// non-Windows the value is returned as-is. Never throws: a DPAPI failure falls back to
// plaintext with a loud log so the token is never silently lost.
export function encryptSecret(plain) {
  if (!plain) return plain;
  if (String(plain).startsWith(PREFIX)) return String(plain);
  if (!dpapiSupported()) return String(plain);
  try {
    const b64 = runDpapi(PROTECT_SCRIPT, Buffer.from(String(plain), "utf8").toString("base64"));
    return `${PREFIX}${b64}`;
  } catch (error) {
    console.error(`[modeldock] DPAPI protect failed (${error.message}); storing plaintext`);
    return String(plain);
  }
}

// Decrypt a stored secret. Plaintext values pass through unchanged (backward compat).
// Never throws: an unreadable `dpapi:` value returns "" with a loud log so startup and
// the dashboard stay alive.
export function decryptSecret(stored) {
  if (!stored) return "";
  if (!String(stored).startsWith(PREFIX)) return String(stored);
  if (!dpapiSupported()) return "";
  try {
    const b64 = runDpapi(UNPROTECT_SCRIPT, String(stored).slice(PREFIX.length));
    return Buffer.from(b64, "base64").toString("utf8");
  } catch (error) {
    console.error(`[modeldock] DPAPI unprotect failed (${error.message}); token treated as unset`);
    return "";
  }
}

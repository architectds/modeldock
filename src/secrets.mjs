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
  "COMMANDCODE_API_KEY",
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

// One stdin line per value, one stdout line per value, '!' for a value that
// failed. Batching matters: each powershell.exe launch costs about a second,
// so protecting or unprotecting a list value-by-value turns a multi-endpoint
// custom-endpoints.json into a minutes-long synchronous stall at startup and
// on every settings read.
const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "foreach($line in ([Console]::In.ReadToEnd() -split [string][char]10)){ $line=$line.Trim(); if($line.Length -eq 0){continue}; try{ $b=[Convert]::FromBase64String($line); $e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.WriteLine([Convert]::ToBase64String($e)) } catch { [Console]::Out.WriteLine('!') } }",
].join("; ");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "foreach($line in ([Console]::In.ReadToEnd() -split [string][char]10)){ $line=$line.Trim(); if($line.Length -eq 0){continue}; try{ $b=[Convert]::FromBase64String($line); $d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.WriteLine([Convert]::ToBase64String($d)) } catch { [Console]::Out.WriteLine('!') } }",
].join("; ");

// One PowerShell launch per BATCH of values. Takes base64 lines in, returns
// one result line per input line ('!' marks a value DPAPI rejected).
function runDpapi(script, payloadLines) {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      input: `${payloadLines.join("\n")}\n`,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000 + 100 * payloadLines.length,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== payloadLines.length) {
    throw new Error(`DPAPI batch returned ${lines.length} results for ${payloadLines.length} values`);
  }
  return lines;
}

// A process-local cache in both directions. The same ciphertexts come back on
// every readCustomEndpoints call (routes re-read the file), so without this
// each settings read would re-pay one DPAPI round per stored key. Reusing a
// ciphertext for an unchanged plaintext is fine: DPAPI is at-rest protection,
// not a nonce-per-write scheme.
const cipherToPlain = new Map();
const plainToCipher = new Map();

function remember(plain, stored) {
  cipherToPlain.set(stored, plain);
  plainToCipher.set(plain, stored);
}

// Encrypt plaintext secrets, one PowerShell launch for all uncached values.
// Already-encrypted values pass through unchanged; on non-Windows values stay
// as-is. Never throws: a DPAPI failure falls back to plaintext with a loud log
// so a token is never silently lost.
export function encryptSecrets(plains) {
  const result = new Map();
  const todo = [];
  for (const value of plains) {
    const plain = String(value || "");
    if (!plain || plain.startsWith(PREFIX) || !dpapiSupported()) { result.set(value, plain || value); continue; }
    const cached = plainToCipher.get(plain);
    if (cached) { result.set(value, cached); continue; }
    if (!todo.includes(plain)) todo.push(plain);
  }
  if (todo.length) {
    try {
      const lines = runDpapi(PROTECT_SCRIPT, todo.map((plain) => Buffer.from(plain, "utf8").toString("base64")));
      todo.forEach((plain, index) => {
        if (lines[index] === "!") {
          console.error("[modeldock] DPAPI protect failed; storing plaintext");
          result.set(plain, plain);
          return;
        }
        const stored = `${PREFIX}${lines[index]}`;
        remember(plain, stored);
        result.set(plain, stored);
      });
    } catch (error) {
      console.error(`[modeldock] DPAPI protect failed (${error.message}); storing plaintext`);
      for (const plain of todo) result.set(plain, plain);
    }
  }
  return result;
}

export function encryptSecret(plain) {
  if (!plain) return plain;
  return encryptSecrets([plain]).get(plain);
}

// Decrypt stored secrets, one PowerShell launch for all uncached values.
// Plaintext values pass through unchanged (backward compat). Never throws: an
// unreadable `dpapi:` value maps to "" with a loud log so startup and the
// dashboard stay alive.
export function decryptSecrets(storeds) {
  const result = new Map();
  const todo = [];
  for (const value of storeds) {
    const stored = String(value || "");
    if (!stored) { result.set(value, ""); continue; }
    if (!stored.startsWith(PREFIX)) { result.set(value, stored); continue; }
    if (!dpapiSupported()) { result.set(value, ""); continue; }
    const cached = cipherToPlain.get(stored);
    if (cached !== undefined) { result.set(value, cached); continue; }
    if (!todo.includes(stored)) todo.push(stored);
  }
  if (todo.length) {
    try {
      const lines = runDpapi(UNPROTECT_SCRIPT, todo.map((stored) => stored.slice(PREFIX.length)));
      todo.forEach((stored, index) => {
        if (lines[index] === "!") {
          console.error("[modeldock] DPAPI unprotect failed; token treated as unset");
          cipherToPlain.set(stored, "");
          result.set(stored, "");
          return;
        }
        const plain = Buffer.from(lines[index], "base64").toString("utf8");
        remember(plain, stored);
        result.set(stored, plain);
      });
    } catch (error) {
      console.error(`[modeldock] DPAPI unprotect failed (${error.message}); tokens treated as unset`);
      for (const stored of todo) result.set(stored, "");
    }
  }
  return result;
}

export function decryptSecret(stored) {
  if (!stored) return "";
  return decryptSecrets([stored]).get(stored);
}

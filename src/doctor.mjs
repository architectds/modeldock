// Doctor: a 10-point diagnostic for a ModelDock installation, in the spirit of
// codex-router's doctor.mjs but scoped to what ModelDock can actually answer.
// Never prints credential material: token presence is a yes/no, .env values are
// only classified as encrypted vs plaintext. Every path is injectable so the
// test suite can run the checks against a scratch install.
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { envFileFor, parseEnvFile, tokenFromCodexToml, hasChatGptLogin } from "./config.mjs";
import { SECRET_KEYS, PREFIX as SECRET_PREFIX } from "./secrets.mjs";
import { stateDir as resolveStateDir } from "./state-dir.mjs";

export const DOCTOR_CHECKS = 10;

export async function checkDoctor({
  port = Number(process.env.MODELDOCK_PORT || 4097),
  stateDir = resolveStateDir(),
  codexHome = path.resolve(process.env.MODELDOCK_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
  envFile = process.env.MODELDOCK_ENV_FILE || envFileFor(),
  rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), ".."),
  fetchImpl = globalThis.fetch,
} = {}) {
  const checks = [];
  const add = (status, name, detail, fix = "") => checks.push({ status, name, detail, fix });

  // 1. Node.js
  const [major, minor] = process.versions.node.split(".").map(Number);
  add(
    major > 24 || (major === 24 && minor >= 0) ? "ok" : "fail",
    "Node.js",
    `${process.version}; Node 24+ required`,
    "Install Node.js 24 LTS or newer, then restart the gateway.",
  );

  // 2. Service health on the configured port.
  const probe = async () => {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3_000) });
      if (res.status !== 200) return { status: "fail", detail: `port ${port} answers ${res.status}, expected 200` };
      const body = await res.json().catch(() => ({}));
      return body.ok
        ? { status: "ok", detail: `http://127.0.0.1:${port}/healthz answers ok` }
        : { status: "warn", detail: `gateway is up but reports no provider token (/healthz ok=false)` };
    } catch (error) {
      return { status: "fail", detail: `nothing answers on 127.0.0.1:${port} (${error?.cause?.code || error?.message || error})` };
    }
  };
  const health = await probe();
  add(
    health.status,
    "Gateway health",
    health.detail,
    health.status === "fail"
      ? "Start the gateway (scripts/start-hidden.sh / start-hidden.ps1, or the dashboard); check MODELDOCK_PORT matches."
      : "",
  );

  // 3. ChatGPT sign-in (native GPT models depend on it).
  const signedIn = hasChatGptLogin(codexHome);
  add(
    signedIn ? "ok" : "warn",
    "ChatGPT sign-in",
    signedIn ? "~/.codex/auth.json carries a session" : "no ~/.codex/auth.json; native GPT models are unpublished",
    "Sign in to Codex/ChatGPT if you want native GPT models in the picker; logged-out installs work with routed providers.",
  );

  // 4. OpenCode Go token.
  const codexConfig = path.join(codexHome, "config.toml");
  const goToken = process.env.OPENCODE_GO_TOKEN || (existsSync(codexConfig) ? tokenFromCodexToml(readFileSync(codexConfig, "utf8")) : "");
  add(
    goToken ? "ok" : "warn",
    "OpenCode Go token",
    goToken ? "configured (env or codex config backup)" : "not configured",
    "Add OPENCODE_GO_TOKEN to the .env (Settings) or start Codex once so the config backup carries the token.",
  );

  // 5. .env secret hygiene (never print values, only encryption state).
  if (existsSync(envFile)) {
    const entries = parseEnvFile(readFileSync(envFile, "utf8"));
    const plainSecrets = Object.entries(entries).filter(
      ([key, value]) => SECRET_KEYS.has(key) && value && !String(value).startsWith(SECRET_PREFIX),
    );
    add(
      plainSecrets.length === 0 ? "ok" : "warn",
      ".env secret storage",
      plainSecrets.length === 0
        ? "all secret keys are stored encrypted"
        : `${plainSecrets.map(([key]) => key).join(", ")} stored in plaintext`,
      process.platform === "win32"
        ? "Run once with the settings API (it migrates plaintext secrets to DPAPI); on non-Windows plaintext is expected."
        : "Plaintext is expected on non-Windows; keep the .env out of backups and sync tools.",
    );
  } else {
    add("warn", ".env secret storage", "no .env file found", "The dashboard writes .env on first Settings save; this is expected before first run.");
  }

  // 6. State dir ownership (exists and writable).
  const stateDirWritable = (() => {
    if (!existsSync(stateDir)) return { ok: false, detail: `state dir missing: ${stateDir}` };
    try {
      const probe = mkdtempSync(path.join(stateDir, ".doctor-write-"));
      rmSync(probe, { recursive: true, force: true });
      return { ok: true, detail: stateDir };
    } catch {
      return { ok: false, detail: `state dir exists but is not writable: ${stateDir}` };
    }
  })();
  add(
    stateDirWritable.ok ? "ok" : "fail",
    "State dir",
    stateDirWritable.detail,
    stateDirWritable.ok ? "" : "Create ~/.modeldock with the current user; the gateway cannot persist keys/state without it.",
  );

  // 7. Caller-key file: present and (on POSIX) 0600.
  const callerKeyFile = path.join(stateDir, "caller-key");
  if (existsSync(callerKeyFile)) {
    const mode = statSync(callerKeyFile).mode & 0o777;
    const protectedMode = process.platform === "win32" || mode === 0o600;
    add(
      protectedMode ? "ok" : "warn",
      "Caller key file",
      protectedMode
        ? `present${process.platform === "win32" ? " (Windows ACL)" : ` (mode ${mode.toString(8)})`}`
        : `present but world-readable (mode ${mode.toString(8)})`,
      protectedMode ? "" : "Restrict it: chmod 600 (a second gateway start hardens it automatically).",
    );
  } else {
    add("warn", "Caller key file", "not minted yet", "The gateway mints the key on first start; expected before the first run.");
  }

  // 8. Codex config route consistency: openai_base_url must point at this gateway.
  const managedUrl = (() => {
    if (!existsSync(codexConfig)) return "";
    const match = readFileSync(codexConfig, "utf8").match(/^\s*openai_base_url\s*=\s*(.+?)\s*(?:#.*)?$/m);
    if (!match) return "";
    const raw = match[1].trim();
    return raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw;
  })();
  const routedToSelf = managedUrl.startsWith(`http://127.0.0.1:${port}`) || managedUrl.startsWith(`http://localhost:${port}`);
  const keyed = routedToSelf && /\/c\/[^/]+\/v1$/.test(managedUrl);
  add(
    managedUrl === ""
      ? "warn"
      : keyed
        ? "ok"
        : routedToSelf
          ? "warn"
          : "warn",
    "Codex route",
    managedUrl === ""
      ? "no openai_base_url found in config.toml (Codex not pointed at ModelDock)"
      : keyed
        ? `config.toml routes to this gateway: ${managedUrl}`
        : `config.toml routes to ${managedUrl || "(elsewhere)"}, not this gateway's keyed URL`,
    "Enable the Codex switch from the dashboard so config.toml is rewritten to the keyed /c/<key>/v1 URL.",
  );

  // 9. Install integrity: the bundle or the source entry exists.
  const bundle = path.join(rootDir, "dist", "modeldock.mjs");
  const sourceEntry = path.join(rootDir, "src", "server.mjs");
  add(
    existsSync(bundle) || existsSync(sourceEntry) ? "ok" : "fail",
    "Installation",
    existsSync(bundle) ? "release bundle present (dist/modeldock.mjs)" : existsSync(sourceEntry) ? "source checkout (src/server.mjs)" : "neither bundle nor source entry found",
    "Re-run the installer, or npm run build in a checkout, so dist/modeldock.mjs exists.",
  );

  // 10. Log & diagnostics files.
  const log = path.join(rootDir, "modeldock.log");
  const compactFailures = path.join(stateDir, "compact-failures.jsonl");
  const logNote = (() => {
    if (!existsSync(log)) return "no log file yet";
    const size = statSync(log).size;
    return `${(size / 1024 / 1024).toFixed(1)} MB${size > 32 * 1024 * 1024 ? " (over the 32 MB rotation cap)" : ""}`;
  })();
  const failureNote = existsSync(compactFailures) ? "compact-failures.jsonl has history; review it" : "no recorded compact failures";
  const logWarned = existsSync(log) && statSync(log).size > 32 * 1024 * 1024;
  const failuresWarned = existsSync(compactFailures);
  add(
    logWarned || failuresWarned ? "warn" : "ok",
    "Log & diagnostics",
    `${logNote}; ${failureNote}`,
    logWarned ? "Restart the gateway: start-hidden rotates modeldock.log once it exceeds 32 MB." : failuresWarned ? "Inspect ~/.modeldock/compact-failures.jsonl for repeated compaction upstream errors." : "",
  );

  return checks;
}

export function doctorExitCode(checks) {
  return checks.some((check) => check.status === "fail") ? 1 : 0;
}

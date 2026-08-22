// Shared lifecycle verifier. It is deliberately independent of modeldock.mjs:
// an installer or updater can verify an older released bundle before this
// version of the bundle itself has been published.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizedPath(value, platform = process.platform) {
  let resolved = path.resolve(value);
  // Windows can expose the same installed directory once through its long
  // name and once through an 8.3 name (for example, a launcher inherited from
  // SYSTEM). The owner record and the installer then name one directory but
  // string comparison sees two. Canonicalize an existing root before checking
  // ownership; a missing value still falls back to the diagnostic resolve.
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    // Let the normal owner-root diagnostic describe a nonexistent path.
  }
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function ownerPath(port, stateDir) {
  return path.join(stateDir || path.join(os.homedir(), ".modeldock"), `owner-${port}.json`);
}

function readOwner(port, stateDir) {
  try {
    const file = ownerPath(port, stateDir);
    if (!existsSync(file)) return null;
    const owner = JSON.parse(readFileSync(file, "utf8"));
    return owner && typeof owner === "object" ? owner : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function inspectGateway({
  root,
  port,
  stateDir,
  startedAfterMs = 0,
  previousPid = 0,
  fetchImpl = fetch,
  platform = process.platform,
} = {}) {
  const expectedRoot = normalizedPath(root || ".", platform);
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) return { ok: false, reason: "invalid_port" };
  const owner = readOwner(numericPort, stateDir);
  if (!owner) return { ok: false, reason: "owner_missing" };
  if (normalizedPath(owner.root || ".", platform) !== expectedRoot) return { ok: false, reason: "owner_root" };
  if (Number(owner.port) !== numericPort) return { ok: false, reason: "owner_port" };
  if (!Number.isInteger(Number(owner.pid)) || !processAlive(Number(owner.pid))) return { ok: false, reason: "owner_dead" };
  if (Number(previousPid) > 0 && Number(owner.pid) === Number(previousPid)) return { ok: false, reason: "old_owner" };
  if (Number(startedAfterMs) > 0) {
    const startedAt = Date.parse(owner.startedAt || "");
    if (!Number.isFinite(startedAt) || startedAt < Number(startedAfterMs)) return { ok: false, reason: "owner_stale" };
  }
  try {
    const response = await fetchImpl(`http://127.0.0.1:${numericPort}/api/status`, {
      signal: AbortSignal.timeout(2_000), headers: { accept: "application/json" },
    });
    if (!response.ok) return { ok: false, reason: `status_${response.status}` };
    const status = await response.json();
    if (!status || typeof status !== "object" || !status.config || !status.runtime) return { ok: false, reason: "status_shape" };
    return { ok: true, owner };
  } catch {
    return { ok: false, reason: "status_unreachable" };
  }
}

export async function waitForGateway({ timeoutMs = 15_000, intervalMs = 250, ...options } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, reason: "not_started" };
  while (Date.now() <= deadline) {
    last = await inspectGateway(options);
    if (last.ok) return last;
    await sleep(intervalMs);
  }
  return last;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] || "" : "";
}

export function verifierArgs(args = process.argv.slice(2)) {
  return {
    root: valueAfter(args, "--root"),
    port: Number(valueAfter(args, "--port")),
    stateDir: valueAfter(args, "--state-dir"),
    timeoutMs: Number(valueAfter(args, "--timeout-ms")) || 15_000,
    startedAfterMs: Number(valueAfter(args, "--started-after-ms")) || 0,
    previousPid: Number(valueAfter(args, "--previous-pid")) || 0,
  };
}

export async function runGatewayVerifierCli(args = process.argv.slice(2), output = console) {
  const options = verifierArgs(args);
  if (!options.root || !options.port) {
    output.error("usage: --verify-gateway --root <install-root> --port <port> [--state-dir <dir>]");
    return 64;
  }
  const result = await waitForGateway(options);
  if (!result.ok) {
    output.error(`Gateway did not verify: ${result.reason}`);
    return 1;
  }
  output.log(`Gateway verified: PID ${result.owner.pid}, port ${options.port}`);
  return 0;
}

// Do not derive direct execution from import.meta.url: Node can expose a
// launched installer helper through a platform-normalized path that differs
// textually from the module URL (notably on macOS). This flag is exclusive to
// the lifecycle CLI; imports from the gateway have no such argument.
if (process.argv.includes("--verify-gateway")) {
  process.exit(await runGatewayVerifierCli());
}

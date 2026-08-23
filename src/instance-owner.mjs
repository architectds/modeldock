import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateFile } from "./state-dir.mjs";

// One port is owned by exactly one gateway process from one checkout. We have
// been bitten twice by lookalike instances: a second server on a neighbouring
// port serving stale code, and restart scripts killing whatever held the port
// without knowing whose process it was. The owner file makes both visible:
// startup records {pid, root, startedAt} per port, and restart.ps1 refuses to
// kill a process whose recorded root is a different checkout unless forced.

// Where owner records live. MODELDOCK_STATE_DIR redirects them so a spawned
// gateway (the mock-install test runs the real installer, which starts a real
// gateway on a random port) keeps its bookkeeping inside its own throwaway
// root instead of littering the user's ~/.modeldock with one file per run.
// An explicit `home` still wins, so the unit tests below stay hermetic even
// when the variable is set in the surrounding environment.
export function ownerFilePath(port, home) {
  return stateFile(`owner-${port}.json`, { home });
}

export function writeOwnerFile(port, { root = process.cwd(), pid = process.pid, home } = {}) {
  const filePath = ownerFilePath(port, home);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ pid, root: path.resolve(root), port, startedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
    return filePath;
  } catch {
    // Ownership telemetry must never stop the gateway from starting.
    return undefined;
  }
}

export function readOwnerFile(port, { home } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(ownerFilePath(port, home), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function clearOwnerFile(port, { pid = process.pid, home } = {}) {
  // Only the recorded owner removes its own file, so a crashed instance's stale
  // record survives for diagnosis instead of being clobbered by a bystander.
  const current = readOwnerFile(port, { home });
  if (current && current.pid !== pid) return false;
  try {
    unlinkSync(ownerFilePath(port, home));
    return true;
  } catch {
    return false;
  }
}

export function describeOwnerConflict(port, root, { home } = {}) {
  const recorded = readOwnerFile(port, { home });
  if (!recorded?.root) return undefined;
  const same = path.resolve(recorded.root) === path.resolve(root);
  if (same) return undefined;
  let alive = false;
  try {
    process.kill(recorded.pid, 0);
    alive = true;
  } catch (error) {
    // ESRCH: the recorded process is gone; a stale file is not a conflict.
    // EPERM: it exists but is not ours to signal (an elevated owner) - that
    // is still alive, and treating it as stale reported no conflict for
    // exactly the process most likely to really hold the port.
    alive = error?.code === "EPERM";
  }
  if (!alive) return undefined;
  return {
    port,
    recordedRoot: recorded.root,
    currentRoot: path.resolve(root),
    pid: recorded.pid,
    message: `Port ${port} is owned by a gateway from ${recorded.root} (pid ${recorded.pid}); this checkout is ${path.resolve(root)}.`,
  };
}

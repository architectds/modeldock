// Startup update check + one-click apply.
//
// Source of truth is the newest GitHub Release of MODELDOCK_UPDATE_REPO (default
// architectds/modeldock). The check runs once at startup (fire-and-forget); the
// dashboard shows a small Update button when a newer version exists. Applying:
//   - git checkout (a .git directory next to src/): `git pull --ff-only`
//   - installed bundle: download and atomically deploy the complete platform
//     layout from the newest release
// Old Node 22 bridges first migrate their runtime, then the dashboard resumes
// the same latest-release deployment without another user action.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_REPO = "architectds/modeldock";
const ASSET_NAME = "modeldock.mjs";
const SUMS_NAME = "SHA256SUMS";
const CHECK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
// The 0.3.x bridge can run on old managed Node 22 installations long enough to
// install Node 24. The 0.4 line removes that bridge and must never be deployed
// onto the old runtime.
const NODE_24_REQUIRED_FROM = "0.4.0";
// Rollback snapshots kept per install: one is the recovery material for the
// current update, the second covers the previous update's recover menu while a
// user works through it. Older full-layout copies would otherwise pile up.
const MAX_ROLLBACK_SNAPSHOTS = 2;

// Files an installed layout needs beyond the bundle itself. The release carries
// every one of them as an asset (see release.yml), and an update deploys the
// full set for the current platform so an install never mixes a new bundle
// with old launcher/restart/recover scripts. Each entry is {asset, dest,
// platforms}; dest is relative to the package root.
const DEPLOY_TARGETS = {
  "modeldock.mjs": { dest: ["dist", "modeldock.mjs"] },
  "mcp-standalone.mjs": { dest: ["dist", "mcp-standalone.mjs"] },
  "start-hidden.ps1": { dest: ["scripts", "start-hidden.ps1"], platforms: ["win32"] },
  "restart.ps1": { dest: ["scripts", "restart.ps1"], platforms: ["win32"] },
  "recover.ps1": { dest: ["scripts", "recover.ps1"], platforms: ["win32"] },
  "start-hidden.sh": { dest: ["scripts", "start-hidden.sh"], platforms: ["linux", "darwin"] },
  "restart.sh": { dest: ["scripts", "restart.sh"], platforms: ["linux", "darwin"] },
  "recover.sh": { dest: ["scripts", "recover.sh"], platforms: ["linux", "darwin"] },
};

function deployTargetsFor(platform) {
  return Object.entries(DEPLOY_TARGETS)
    .filter(([, target]) => !target.platforms || target.platforms.includes(platform))
    .map(([asset, target]) => ({ asset, ...target }));
}

// In the release bundle esbuild's `define` replaces this expression with the version
// string literal; in a git checkout it is undefined and package.json is used.
const BUILD_VERSION = process.env.MODELDOCK_BUILD_VERSION;

export function localVersion(rootDir = root) {
  if (BUILD_VERSION) return BUILD_VERSION;
  try {
    return JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Numeric dotted compare; non-numeric suffixes (e.g. -beta.1) are ignored per part.
// Returns >0 when a is newer than b.
export function compareVersions(a, b) {
  const parse = (v) => String(v || "").replace(/^v/, "").split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

export function parseLatestRelease(release, current) {
  const tag = String(release?.tag_name || "").replace(/^v/, "");
  if (!tag) return { available: false };
  const assets = release?.assets || [];
  const asset = assets.find((a) => a?.name === ASSET_NAME);
  const sums = assets.find((a) => a?.name === SUMS_NAME);
  const assetMap = {};
  for (const item of assets) assetMap[item?.name] = item?.browser_download_url || "";
  return {
    available: compareVersions(tag, current) > 0,
    latestVersion: tag,
    assetUrl: asset?.browser_download_url || "",
    sumsUrl: sums?.browser_download_url || "",
    notesUrl: release?.html_url || "",
    assets: assetMap,
  };
}

// Parse a sha256sum-style file ("<hex>  <filename>" per line) into {filename: hex}.
export function parseSumsFile(text) {
  const sums = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (match) sums[match[2].trim()] = match[1].toLowerCase();
  }
  return sums;
}

function updateRepo() {
  return process.env.MODELDOCK_UPDATE_REPO || DEFAULT_REPO;
}

// Optional token for the GitHub API check. Anonymous requests share the caller's
// public IP rate budget (60/hour), which shared/NAT egress can exhaust; a token
// (MODELDOCK_GITHUB_TOKEN or GITHUB_TOKEN) raises that and keeps the Update
// button reliable. Without a token the check still runs anonymously.
function updateToken() {
  return process.env.MODELDOCK_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
}

function isGitCheckout(rootDir) {
  return existsSync(path.join(rootDir, ".git"));
}

function gitPull(rootDir) {
  return new Promise((resolve, reject) => {
    // Explicit remote/branch so the update never depends on the checkout's
    // configured upstream (a detached or custom branch would otherwise fail
    // with "no tracking information").
    execFile("git", ["pull", "--ff-only", "origin", "main"], { cwd: rootDir, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message));
      else resolve(stdout);
    });
  });
}

async function fetchAsset(url, maxBytes, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    headers: { "user-agent": "modeldock-updater" },
  });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`Asset too large (${declared} bytes, limit ${maxBytes})`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new Error(`Asset too large (${body.length} bytes, limit ${maxBytes})`);
  return body;
}

async function fetchVerified(assetUrl, expected, { minBytes = 0, fetchImpl = fetch } = {}) {
  const body = await fetchAsset(assetUrl, MAX_BUNDLE_BYTES, fetchImpl);
  if (body.length < minBytes) throw new Error(`Downloaded asset suspiciously small (${body.length} bytes)`);
  const actual = createHash("sha256").update(body).digest("hex");
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${assetUrl} (expected ${expected.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`);
  }
  return body;
}

async function fetchSums(sumsUrl, fetchImpl = fetch) {
  if (!sumsUrl) throw new Error("Release has no SHA256SUMS asset; refusing unverified update");
  return parseSumsFile((await fetchAsset(sumsUrl, 64 * 1024, fetchImpl)).toString("utf8"));
}

function removeFileIfPresent(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function stagedPath(target) {
  return `${target}.${process.pid}.update-stage`;
}

function backupPath(target) {
  return `${target}.${process.pid}.update-backup`;
}

function writeStagedFile(body, target) {
  const tmp = stagedPath(target);
  // Keep POSIX launchers executable after an update. The installer chmods these
  // files, but replacing a file with a newly-created temp file would otherwise
  // silently drop that mode bit.
  const mode = target.endsWith(".sh") ? 0o755 : 0o644;
  removeFileIfPresent(tmp);
  writeFileSync(tmp, body, { mode });
  return tmp;
}

// Replace the platform layout as one recoverable set. The complete rollback
// snapshot and its durable marker are committed before the first destination
// changes, so both thrown errors and process/machine crashes are recoverable.
export function deployFilesAtomically(items, rootDir, { afterReplace } = {}) {
  const prepared = [];
  let applied = 0;
  let rollbackDir = "";
  let rollbackStageDir = "";
  let rollbackRoot = "";
  let marker = "";
  let markerStage = "";
  let markerCommitted = false;
  let previousMarker;
  try {
    for (const item of items) {
      if (existsSync(item.dest) && !statSync(item.dest).isFile()) {
        throw new Error(`Update destination is not a file: ${item.dest}`);
      }
      const stage = writeStagedFile(item.body, item.dest);
      const backup = backupPath(item.dest);
      const existed = existsSync(item.dest);
      const preparedItem = { ...item, stage, backup, existed };
      prepared.push(preparedItem);
      removeFileIfPresent(backup);
      if (existed) copyFileSync(item.dest, backup);
    }

    // Preserve the entire previous platform layout, not just the bundle. A new
    // bundle can depend on its matching bridge and lifecycle scripts, so runtime
    // recovery must restore the same version set as one transaction. This is
    // deliberately durable before any destination rename: if the updater dies
    // mid-deployment, recover.* can still identify and restore the old layout.
    rollbackRoot = path.join(rootDir, ".modeldock-rollback");
    const rollbackName = `${Date.now()}-${process.pid}`;
    rollbackDir = path.join(rollbackRoot, rollbackName);
    rollbackStageDir = `${rollbackDir}.tmp`;
    marker = path.join(rollbackRoot, "current");
    markerStage = `${marker}.${process.pid}.tmp`;
    previousMarker = existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
    mkdirSync(rollbackStageDir, { recursive: true });
    const files = [];
    for (const item of prepared) {
      const relative = path.relative(rootDir, item.dest).replaceAll(path.sep, "/");
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
        throw new Error(`Update destination escaped the install root: ${item.dest}`);
      }
      files.push({ path: relative, existed: item.existed });
      if (item.existed) {
        const rollbackFile = path.join(rollbackStageDir, ...relative.split("/"));
        mkdirSync(path.dirname(rollbackFile), { recursive: true });
        copyFileSync(item.backup, rollbackFile);
      }
    }
    writeFileSync(path.join(rollbackStageDir, "manifest.json"), `${JSON.stringify({ files }, null, 2)}\n`, "utf8");
    renameSync(rollbackStageDir, rollbackDir);
    writeFileSync(markerStage, `${rollbackName}\n`, "utf8");
    renameSync(markerStage, marker);
    markerCommitted = true;

    for (const item of prepared) {
      renameSync(item.stage, item.dest);
      applied += 1;
      afterReplace?.(applied, item);
    }

    // Prune old snapshots now that the new marker is committed: the marker
    // always points at the newest snapshot, so older ones are unreachable
    // recovery material and safe to drop. Best-effort - a cleanup failure must
    // not turn a committed deployment into an error.
    try {
      const snapshots = readdirSync(rollbackRoot)
        .filter((name) => /^\d+-\d+$/.test(name))
        .sort();
      for (const old of snapshots.slice(0, Math.max(0, snapshots.length - MAX_ROLLBACK_SNAPSHOTS))) {
        rmSync(path.join(rollbackRoot, old), { recursive: true, force: true });
      }
    } catch { /* stale snapshots are harmless */ }

    // The deployment is committed once every destination and the complete
    // rollback snapshot are in place. Backup cleanup is best-effort from here:
    // treating a cleanup error
    // as a deployment failure could start a rollback after earlier backups
    // have already been deleted.
    for (const item of prepared) {
      try { removeFileIfPresent(item.backup); } catch { /* stale backup is safe */ }
    }
  } catch (error) {
    const rollbackErrors = [];
    for (let index = applied - 1; index >= 0; index -= 1) {
      const item = prepared[index];
      try {
        if (item.existed) copyFileSync(item.backup, item.dest);
        else removeFileIfPresent(item.dest);
      } catch (rollbackError) {
        rollbackErrors.push(`${item.dest}: ${rollbackError.message}`);
      }
    }
    for (const item of prepared) {
      try { removeFileIfPresent(item.stage); } catch { /* report the primary failure */ }
    }
    try { if (markerStage) removeFileIfPresent(markerStage); } catch { /* report the primary failure */ }
    // If an in-process rollback itself failed, keep the new marker, complete
    // snapshot, and adjacent backups intact. The recovery script can then
    // finish restoring the old layout instead of losing the only good copies.
    if (rollbackErrors.length) {
      throw new Error(`${error.message}; rollback failed: ${rollbackErrors.join("; ")}`);
    }
    for (const item of prepared) {
      try { removeFileIfPresent(item.backup); } catch { /* restored layout is already safe */ }
    }
    if (markerCommitted) {
      try {
        if (previousMarker === undefined) {
          removeFileIfPresent(marker);
        } else {
          writeFileSync(markerStage, previousMarker, "utf8");
          renameSync(markerStage, marker);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${marker}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`${error.message}; rollback metadata restore failed: ${rollbackErrors.join("; ")}`);
    }
    if (rollbackDir) {
      try { rmSync(rollbackDir, { recursive: true, force: true }); } catch { /* unreferenced partial snapshot */ }
    }
    if (rollbackStageDir) {
      try { rmSync(rollbackStageDir, { recursive: true, force: true }); } catch { /* unreferenced partial snapshot */ }
    }
    throw error;
  }
}

// Relaunch through the platform restart script, which is the supervisor for an
// upgrade: it stops the old listener, starts the new gateway, and prints
// every step. The updater is the gateway itself, so the
// script is spawned unref'd with -Force (deliberate takeover of our own port;
// the owner guard's CIM command-line probe can come back empty for elevated
// processes). No process.exit() here: the restart script stops the old
// process, and if spawning it fails the current gateway keeps serving instead
// of leaving the port dead.
//
// stdio is fully detached ("ignore") on every platform. The restart script
// writes the new gateway's logs to modeldock.log itself, so nothing here needs
// a file descriptor. Earlier builds handed an update-log fd to the child as
// stdout/stderr, then closed it on "spawn": restart.ps1 kills the very process
// holding that fd, the handle vanished mid-start, and the whole restart died
// silently - an empty update.log, no spawn error, the old gateway still
// serving. Giving the child no fd at all is what the manual "run restart.ps1"
// path already does, and that path works.
// Exported for the spawn-shape test: the Windows restart has to outlive the
// gateway it stops, and that is a property of these spawn arguments alone.
export function scheduleRestart(rootDir, {
  spawnImpl = spawn,
  platform = process.platform,
} = {}) {
  const env = {
    ...process.env,
    MODELDOCK_NODE_PATH: process.execPath,
  };
  try {
    const [command, args] = platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", "/b", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDir, "scripts", "restart.ps1"), "-Force"]]
      : ["sh", [path.join(rootDir, "scripts", "restart.sh"), "-Force"]];
    // The restart script's first act is to stop this gateway - its own parent -
    // so it only runs to completion if it outlives us. Measured on Windows 11: a
    // plain spawnImpl child does NOT. With the parent alive the script finishes;
    // with the parent exiting right after the spawn the same child is torn down
    // mid-script and never reaches its Start-Process. unref() does not change
    // that, and it is exactly the reported failure - the dashboard says
    // "restarting...", the old listener dies, and nothing starts in its place.
    //
    // `detached: true` is not the fix either: measured on the same machine, a
    // detached powershell.exe gets a pid and then never executes the script at
    // all. Going through cmd's `start` re-parents the script away from this
    // process and it survives - verified with the parent exiting 400ms after the
    // spawn, and with a rootDir containing a space. The empty "" is start's
    // window-title argument, which it would otherwise take from the command.
    const child = spawnImpl(command, args, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
      ...(platform === "win32" ? { windowsHide: true } : { detached: true }),
    });
    if (typeof child?.on === "function") {
      child.on("error", () => { /* the old gateway keeps serving */ });
      child.unref?.();
    }
  } catch (error) {
    // The old gateway keeps serving; the Update button stays actionable.
  }
}

// A bridge runtime cannot execute a Node-24-only bundle, but it can hand the
// runtime migration to the installer from that same verified release. The old
// bridge restarts on Node 24, then the dashboard resumes the normal atomic
// updater directly against latest without another user action.
function scheduleInstallerMigration({ body, installerName, rootDir, repo }) {
  const extension = installerName.endsWith(".ps1") ? "ps1" : "sh";
  const installerPath = path.join(os.tmpdir(), `modeldock-update-${process.pid}-${Date.now()}.${extension}`);
  writeFileSync(installerPath, body, { mode: extension === "sh" ? 0o700 : 0o600 });
  // modeldock.log is held by the gateway on Windows; use the same dedicated
  // updater log as the ordinary restart path so migration can always spawn.
  const logPath = path.join(rootDir, "modeldock-update.log");
  const logFd = openSync(logPath, "a");
  const env = {
    ...process.env,
    MODELDOCK_ROOT: rootDir,
    MODELDOCK_REPO: repo,
    MODELDOCK_INSTALLER_TEMP: installerPath,
    MODELDOCK_NODE_PATH: "",
    MODELDOCK_RUNTIME_ONLY: "1",
    MODELDOCK_SKIP_OPEN: "1",
  };
  const command = extension === "ps1" ? "powershell.exe" : "sh";
  const args = extension === "ps1"
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", installerPath]
    : [installerPath];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        detached: true,
        env,
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      });
    } catch (error) {
      closeSync(logFd);
      removeFileIfPresent(installerPath);
      reject(error);
      return;
    }
    closeSync(logFd);
    child.once("error", (error) => {
      removeFileIfPresent(installerPath);
      reject(error);
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function createUpdater({
  fetchImpl = fetch,
  restartImpl,
  migrateImpl,
  autoCheckMs = 0,
  rootDir = root,
  platform = process.platform,
  nodeMajor = Number(process.versions.node.split(".", 1)[0]),
} = {}) {
  const restart = restartImpl || (() => scheduleRestart(rootDir));
  const migrate = migrateImpl || scheduleInstallerMigration;
  const state = {
    currentVersion: localVersion(rootDir),
    latestVersion: "",
    available: false,
    updating: false,
    checkedAt: 0,
    notesUrl: "",
    error: "",
  };
  let assetUrl = "";
  let sumsUrl = "";
  let releaseAssets = {};

  async function check() {
    try {
      const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "modeldock-updater",
      };
      const token = updateToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await fetchImpl(`https://api.github.com/repos/${updateRepo()}/releases/latest`, {
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        headers,
      });
      if (!response.ok) throw new Error(`Release check: HTTP ${response.status}`);
      const parsed = parseLatestRelease(await response.json(), state.currentVersion);
      state.available = parsed.available;
      state.latestVersion = parsed.latestVersion || "";
      state.notesUrl = parsed.notesUrl || "";
      state.error = "";
      assetUrl = parsed.assetUrl || "";
      sumsUrl = parsed.sumsUrl || "";
      releaseAssets = parsed.assets || {};
    } catch (error) {
      state.available = false;
      state.latestVersion = "";
      state.notesUrl = "";
      state.error = error.message;
      assetUrl = "";
      sumsUrl = "";
      releaseAssets = {};
    }
    state.checkedAt = Date.now();
    return state;
  }

  async function apply() {
    if (state.updating) throw new Error("Update already in progress");
    state.updating = true;
    try {
      if (!state.available) await check();
      if (!state.available) throw new Error("No update available");
      let mode;
      if (isGitCheckout(rootDir)) {
        mode = "git";
        await gitPull(rootDir);
      } else {
        mode = "bundle";
        // Always re-check at click time: the button may have been rendered from a
        // startup check while newer releases were published in the meantime, and
        // apply() must deploy the newest release, not a cached one.
        await check();
        if (!state.available) throw new Error("No update available");
        if (nodeMajor < 24 && compareVersions(state.latestVersion, NODE_24_REQUIRED_FROM) >= 0) {
          const installerName = platform === "win32" ? "install.ps1" : "install.sh";
          const bridgeUrl = releaseAssets["mcp-standalone.mjs"];
          if (!releaseAssets[installerName]) throw new Error(`Release is missing ${installerName}`);
          if (!assetUrl) throw new Error("Release has no modeldock.mjs asset");
          if (!bridgeUrl) throw new Error("Release has no mcp-standalone.mjs asset");
          const sums = await fetchSums(sumsUrl, fetchImpl);
          for (const target of deployTargetsFor(platform)) {
            if (!releaseAssets[target.asset]) throw new Error(`Release is missing ${target.asset}`);
            if (!sums[target.asset]) throw new Error(`SHA256SUMS has no entry for ${target.asset}`);
          }
          // Use this bridge release's installer for runtime migration, not the
          // future latest installer. That keeps the migration protocol pinned
          // and lets later releases delete it without stranding old bridges.
          const currentReleaseBase = `https://github.com/${updateRepo()}/releases/download/v${state.currentVersion}`;
          const currentSums = await fetchSums(`${currentReleaseBase}/${SUMS_NAME}`, fetchImpl);
          const expected = currentSums[installerName];
          if (!expected) throw new Error(`Current release SHA256SUMS has no entry for ${installerName}`);
          const body = await fetchVerified(`${currentReleaseBase}/${installerName}`, expected, { fetchImpl });
          await migrate({
            body,
            installerName,
            rootDir,
            repo: updateRepo(),
          });
          // The detached installer may fail before it restarts this process.
          // Release the in-memory lock so the still-running bridge can retry;
          // the dashboard itself remains disabled while it monitors migration.
          state.updating = false;
          return { ok: true, mode: "installer", latestVersion: state.latestVersion, restarting: true };
        }
        if (!assetUrl) throw new Error("Release has no modeldock.mjs asset");
        const sums = await fetchSums(sumsUrl, fetchImpl);
        // Download and verify the whole set first; only then touch the installed
        // files, so a failed download never leaves a half-updated layout.
        const staged = [];
        for (const target of deployTargetsFor(platform)) {
          const url = releaseAssets[target.asset];
          if (!url) throw new Error(`Release is missing ${target.asset}`);
          const expected = sums[target.asset];
          if (!expected) throw new Error(`SHA256SUMS has no entry for ${target.asset}`);
          const body = await fetchVerified(url, expected, {
            minBytes: target.asset === ASSET_NAME ? 100_000 : 0,
            fetchImpl,
          });
          staged.push({ body, dest: path.join(rootDir, ...target.dest) });
        }
        deployFilesAtomically(staged, rootDir);
      }
      restart();
      return { ok: true, mode, latestVersion: state.latestVersion, restarting: true };
    } catch (error) {
      state.updating = false;
      throw error;
    }
  }

  const api = { state: () => ({ ...state }), check, apply };
  if (autoCheckMs > 0) {
    // Keep the Update button current without a restart. unref() so the timer
    // never keeps the process alive on its own.
    const timer = setInterval(() => {
      check().catch(() => {});
    }, autoCheckMs);
    timer.unref?.();
  }
  return api;
}

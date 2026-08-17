#!/bin/sh
# ModelDock installer (macOS / Linux).
#
# User-side bootstrap: runs BEFORE Node is guaranteed to exist, so it must stay a
# plain shell script (an .mjs installer would need Node already - chicken and egg).
#
#   curl -fsSL https://raw.githubusercontent.com/architectds/modeldock/main/scripts/install.sh | sh
#
# What it does:
#   1. Use Node >= 24 (a bundled copy under ~/.modeldock/node wins, then PATH). If
#      none is found, download the latest Node 24 LTS tarball from nodejs.org, verify
#      its SHA256 and unpack it under ~/.modeldock/node so the install is self-contained.
#   2. Lay out the install dir at ~/.modeldock: dist/modeldock.mjs (downloaded from the
#      newest GitHub Release) + scripts/start-hidden.sh (background launcher used by the
#      dashboard's start-at-login toggle and the one-click updater).
#   3. Start ModelDock in the background (skipped if one is already running) and print
#      the dashboard URL.
# Tokens are NOT asked for here - the dashboard opens its Settings dialog on first run.
#
# Overrides (optional; used by the mock-install test and mirror deployments):
#   MODELDOCK_ROOT          install directory             (default: ~/.modeldock)
#   MODELDOCK_REPO          GitHub repo                   (default: architectds/modeldock)
#   MODELDOCK_RELEASE_URL   direct asset URL (overrides MODELDOCK_REPO)
#   MODELDOCK_SKILL_BASE_URL  base URL for the content-to-video skill files
#                             (default: raw.githubusercontent.com/<repo>/main/skills/content-to-video)
#   MODELDOCK_CODEX_HOME    Codex home dir (default: ~/.codex; skills land in
#                             <codexHome>/skills/content-to-video)
#   MODELDOCK_PORT          dashboard port                (default: 4097)
#   MODELDOCK_NODE_PATH     absolute path to a node executable to prefer
#   MODELDOCK_FORCE_NODE_DOWNLOAD  set to "1" to always (re)install the bundled node
#   MODELDOCK_NODE_VERSION  pin a Node version, e.g. "24.5.0" (default: latest 24 LTS)
#   MODELDOCK_NODE_BASE_URL mirror of https://nodejs.org/dist (tests/mirrors)
#   MODELDOCK_SKIP_START    set to "1" to lay out files without starting the gateway
#   MODELDOCK_SKIP_OPEN     set to "1" to not open a browser

set -eu

REPO="${MODELDOCK_REPO:-architectds/modeldock}"
PORT="${MODELDOCK_PORT:-4097}"
ROOT="${MODELDOCK_ROOT:-$HOME/.modeldock}"
RELEASE_URL="${MODELDOCK_RELEASE_URL:-https://github.com/$REPO/releases/latest/download/modeldock.mjs}"
SKIP_OPEN="${MODELDOCK_SKIP_OPEN:-0}"
SKIP_START="${MODELDOCK_SKIP_START:-0}"

echo "ModelDock installer"

# 1. Node >= 24. Prefer an explicit path, then a bundled Node (installed here on a
#    previous run, or by the download step below), then a PATH node. When nothing
#    suitable exists, download the latest Node 24 LTS tarball, verify its SHA256 and
#    unpack it under "$ROOT/node" - the launcher and restart script resolve the same
#    bundled-first way, so the installed layout stays self-contained.
NODE_BIN=""
NODE_SYSTEM_VERSION=""
MANAGED_NODE_UPGRADE=0
NODE_MIGRATION_NEEDED=0
if [ -n "${MODELDOCK_NODE_PATH:-}" ] && [ -x "$MODELDOCK_NODE_PATH" ]; then
  NODE_MAJOR="$($MODELDOCK_NODE_PATH --version 2>/dev/null | sed -n 's/^v\([0-9]*\).*/\1/p' || true)"
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 24 ]; then
    NODE_BIN="$MODELDOCK_NODE_PATH"
  else
    case "$MODELDOCK_NODE_PATH" in
      "$ROOT"/node/*) MANAGED_NODE_UPGRADE=1 ;;
      *) echo "ERROR: MODELDOCK_NODE_PATH must point to Node.js 24 or newer: $MODELDOCK_NODE_PATH" >&2; exit 1 ;;
    esac
  fi
fi
for d in "$ROOT"/node/v*; do
  [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
  NODE_DIR_MAJOR="$(basename "$d" | sed -n 's/^v\([0-9]*\).*/\1/p')"
  if [ -n "$NODE_DIR_MAJOR" ] && [ "$NODE_DIR_MAJOR" -lt 24 ]; then
    # The login launcher is bundled-first. Ensure it cannot fall back to an old
    # managed Node after this installer stops exporting an external one.
    NODE_MIGRATION_NEEDED=1
    MANAGED_NODE_UPGRADE=1
    NODE_BIN=""
  fi
done
if [ "$MANAGED_NODE_UPGRADE" -eq 1 ]; then NODE_MIGRATION_NEEDED=1; fi
if [ -z "$NODE_BIN" ] && { [ -z "${MODELDOCK_NODE_PATH:-}" ] || [ "$MANAGED_NODE_UPGRADE" -eq 1 ]; }; then
  BEST_NODE_BIN=""
  BEST_NODE_VERSION=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] || continue
    [ -x "$d/bin/node" ] || continue
    NODE_DIR_VERSION="$(basename "$d" | sed 's/^v//')"
    NODE_DIR_MAJOR="$(printf '%s' "$NODE_DIR_VERSION" | cut -d. -f1)"
    if [ "$NODE_DIR_MAJOR" -lt 24 ]; then
      NODE_MIGRATION_NEEDED=1
      MANAGED_NODE_UPGRADE=1
      continue
    fi
    if [ -z "$BEST_NODE_VERSION" ] || [ "$(printf '%s\n%s\n' "$NODE_DIR_VERSION" "$BEST_NODE_VERSION" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$NODE_DIR_VERSION" ]; then
      BEST_NODE_BIN="$d/bin/node"
      BEST_NODE_VERSION="$NODE_DIR_VERSION"
    fi
  done
  if [ -n "$BEST_NODE_BIN" ]; then NODE_BIN="$BEST_NODE_BIN"; MANAGED_NODE_UPGRADE=0; fi
fi
if [ -z "$NODE_BIN" ] && [ "$MANAGED_NODE_UPGRADE" -eq 0 ] && command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node --version | sed -n 's/^v\([0-9]*\).*/\1/p')"
  if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 24 ]; then
    NODE_SYSTEM_VERSION="$(node --version)"
    NODE_BIN="$(command -v node)"
  fi
fi
if [ "${MODELDOCK_FORCE_NODE_DOWNLOAD:-0}" = "1" ]; then
  NODE_BIN=""
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BASE="${MODELDOCK_NODE_BASE_URL:-https://nodejs.org/dist}"
  NODE_VER="${MODELDOCK_NODE_VERSION:-}"
  if [ -z "$NODE_VER" ]; then
    echo "  resolving latest Node 24 LTS..."
    NODE_VER="$(curl -fsSL --max-time 30 "$NODE_BASE/index.json" 2>/dev/null | tr '{' '\n' | grep '"version":"v24\.' | grep '"lts":"' | sed -n 's/.*"version":"\(v24\.[0-9]*\.[0-9]*\)".*/\1/p' | head -n 1 || true)"
  fi
  case "$NODE_VER" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    ?*) NODE_VER="v$NODE_VER" ;;
  esac
  case "$NODE_VER" in
    v[0-9]*.[0-9]*.[0-9]*) ;;
    *) echo "ERROR: invalid Node version: ${NODE_VER:-<empty>} (set MODELDOCK_NODE_VERSION to pin one)" >&2; exit 1 ;;
  esac
  case "$(uname -s)" in
    Darwin) NODE_OS="darwin" ;;
    *) NODE_OS="linux" ;;
  esac
  case "$(uname -m)" in
    aarch64|arm64) NODE_ARCH="arm64" ;;
    *) NODE_ARCH="x64" ;;
  esac
  TARBALL="node-$NODE_VER-$NODE_OS-$NODE_ARCH.tar.gz"
  STAGE="$ROOT/node/.tmp-$NODE_VER"
  TARGET="$ROOT/node/$NODE_VER"
  # Preserve the exit status: a plain cleanup trap would make a failing
  # `exit 1` return 0 under dash (the trap's own status becomes the shell's).
  trap 'rc=$?; [ -n "${STAGE:-}" ] && rm -rf "$STAGE"; exit $rc' EXIT
  mkdir -p "$STAGE"
  echo "  downloading $TARBALL..."
  curl -fL --progress-bar "$NODE_BASE/$NODE_VER/$TARBALL" -o "$STAGE/$TARBALL"
  EXPECTED="$(curl -fsSL --max-time 30 "$NODE_BASE/$NODE_VER/SHASUMS256.txt" | grep " $TARBALL$" | awk '{print $1}')"
  if [ -z "$EXPECTED" ]; then
    echo "ERROR: SHA256 for $TARBALL not found in SHASUMS256.txt" >&2
    exit 1
  fi
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL="$(shasum -a 256 "$STAGE/$TARBALL" | awk '{print $1}')"
  else
    ACTUAL="$(sha256sum "$STAGE/$TARBALL" | awk '{print $1}')"
  fi
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    echo "ERROR: SHA256 mismatch for $TARBALL" >&2
    exit 1
  fi
  echo "  extracting..."
  tar -xzf "$STAGE/$TARBALL" -C "$STAGE"
  rm -rf "$TARGET"
  mv "$STAGE/node-$NODE_VER-$NODE_OS-$NODE_ARCH" "$TARGET"
  rm -rf "$STAGE"
  NODE_BIN="$TARGET/bin/node"
  NODE_DOWNLOADED=1
  NODE_MIGRATION_NEEDED=1
  if [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: extracted archive is missing bin/node" >&2
    exit 1
  fi
  echo "  bundled node $NODE_VER installed at $TARGET"
fi
export MODELDOCK_NODE_PATH="$NODE_BIN"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo ""
  echo "Node.js 24 or newer is required but could not be installed automatically."
  echo "Install the LTS version from https://nodejs.org (or: brew install node),"
  echo "reopen your terminal, then run this installer again."
  exit 1
fi
if [ -n "$NODE_SYSTEM_VERSION" ]; then
  echo "  node $NODE_SYSTEM_VERSION - OK"
else
  echo "  node $NODE_BIN - OK"
fi

# The dashboard updater uses this mode to migrate the managed runtime without
# touching the installed bundle. After the old bridge restarts on Node 24, the
# updater performs its normal verified atomic deployment directly to latest.
if [ "${MODELDOCK_RUNTIME_ONLY:-0}" = "1" ]; then
  if [ "$SKIP_START" = "1" ]; then
    echo "  Node runtime migration complete; gateway restart skipped."
    [ -n "${MODELDOCK_INSTALLER_TEMP:-}" ] && rm -f "$MODELDOCK_INSTALLER_TEMP"
    exit 0
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    RUNTIME_PLIST_DIR="${MODELDOCK_AUTOSTART_PLIST_DIR:-$HOME/Library/LaunchAgents}"
    RUNTIME_PLIST_FILE="$RUNTIME_PLIST_DIR/com.modeldock.gateway.plist"
    if [ -f "$RUNTIME_PLIST_FILE" ]; then
      RUNTIME_SERVER="$ROOT/dist/modeldock.mjs"
      runtime_xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
      RUNTIME_NODE_DIR="$(dirname "$NODE_BIN")"
      RUNTIME_PLIST_PATH="$(runtime_xml_escape "$RUNTIME_NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"
      RUNTIME_PLIST_NODE="$(runtime_xml_escape "$NODE_BIN")"
      RUNTIME_PLIST_SERVER="$(runtime_xml_escape "$RUNTIME_SERVER")"
      RUNTIME_PLIST_ROOT="$(runtime_xml_escape "$ROOT")"
      cat > "$RUNTIME_PLIST_FILE" <<RUNTIME_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.modeldock.gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$RUNTIME_PLIST_PATH</string>
    <key>MODELDOCK_NODE_PATH</key><string>$RUNTIME_PLIST_NODE</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$RUNTIME_PLIST_NODE</string>
    <string>$RUNTIME_PLIST_SERVER</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$RUNTIME_PLIST_ROOT</string>
  <key>StandardOutPath</key><string>$RUNTIME_PLIST_ROOT/modeldock.log</string>
  <key>StandardErrorPath</key><string>$RUNTIME_PLIST_ROOT/modeldock.log</string>
</dict>
</plist>
RUNTIME_PLIST
      launchctl unload "$RUNTIME_PLIST_FILE" >/dev/null 2>&1 || true
      if launchctl load -w "$RUNTIME_PLIST_FILE"; then
        echo "  ModelDock restarted on the migrated Node runtime."
        [ -n "${MODELDOCK_INSTALLER_TEMP:-}" ] && rm -f "$MODELDOCK_INSTALLER_TEMP"
        exit 0
      fi
      echo "  WARNING: launchd reload failed; falling back to restart.sh" >&2
    fi
  fi
  RUNTIME_RELAUNCHER="$ROOT/scripts/restart.sh"
  [ -f "$RUNTIME_RELAUNCHER" ] || { echo "ERROR: restart.sh is missing from $ROOT" >&2; exit 1; }
  echo "  restarting ModelDock on the migrated Node runtime..."
  RUNTIME_EXIT=0
  sh "$RUNTIME_RELAUNCHER" --force || RUNTIME_EXIT=$?
  [ -n "${MODELDOCK_INSTALLER_TEMP:-}" ] && rm -f "$MODELDOCK_INSTALLER_TEMP"
  exit "$RUNTIME_EXIT"
fi

# 2. Install layout
mkdir -p "$ROOT/dist" "$ROOT/scripts"

BUNDLE="$ROOT/dist/modeldock.mjs"
echo "  downloading latest release bundle..."
curl -fL --progress-bar "$RELEASE_URL" -o "$BUNDLE"
echo "  saved $BUNDLE"
BRIDGE_URL="${MODELDOCK_BRIDGE_URL:-https://github.com/$REPO/releases/latest/download/mcp-standalone.mjs}"
BRIDGE="$ROOT/dist/mcp-standalone.mjs"
echo "  downloading MCP stdio bridge..."
curl -fL --progress-bar "$BRIDGE_URL" -o "$BRIDGE"
echo "  saved $BRIDGE"

# Integrity: releases publish a SHA256SUMS covering every asset. Verify the two
# files just downloaded against it and refuse to leave a corrupt install behind.
# MODELDOCK_SUMS_URL redirects the lookup (mock-install tests).
SUMS_URL="${MODELDOCK_SUMS_URL:-https://github.com/$REPO/releases/latest/download/SHA256SUMS}"
if command -v sha256sum >/dev/null 2>&1; then
  HASH_CMD="sha256sum"
else
  HASH_CMD="shasum -a 256"
fi
verify_download() {
  file="$1"
  name="$2"
  sums="$(curl -fsSL --max-time 60 "$SUMS_URL" 2>/dev/null || true)"
  line="$(printf '%s\n' "$sums" | grep -E "^[0-9a-f]{64}[[:space:]]+\*?${name}[[:space:]]*$" | head -n 1 || true)"
  if [ -z "$line" ]; then
    echo "ERROR: SHA256SUMS has no entry for $name; refusing to keep an unverified download" >&2
    rm -f "$file"
    exit 1
  fi
  expected="$(printf '%s' "$line" | awk '{print tolower($1)}')"
  actual="$($HASH_CMD "$file" 2>/dev/null | awk '{print tolower($1)}')"
  if [ "$actual" != "$expected" ]; then
    echo "ERROR: checksum mismatch for $name (expected $expected, got $actual)" >&2
    rm -f "$file"
    exit 1
  fi
}
verify_download "$BUNDLE" "modeldock.mjs"
verify_download "$BRIDGE" "mcp-standalone.mjs"
echo "  release assets verified against SHA256SUMS"

# Background launcher (same content as the repo's scripts/start-hidden.sh). Written by
# the installer so a single-file download still gets autostart + self-update restarts.
LAUNCHER="$ROOT/scripts/start-hidden.sh"
cat > "$LAUNCHER" <<'EOF'
#!/bin/sh
# Start the ModelDock gateway in the background with no attached terminal and the
# package root as the working directory. Used by the dashboard and for manual
# background starts on macOS/Linux.
set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ -f "$ROOT/dist/modeldock.mjs" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
else
  SERVER="$ROOT/src/server.mjs"
fi
PORT="${MODELDOCK_PORT:-4097}"
if [ -f "$ROOT/.env" ]; then
  ENV_PORT="$(sed -n 's/^MODELDOCK_PORT=//p' "$ROOT/.env" | tail -n 1 | tr -d '\r' || true)"
  [ -n "$ENV_PORT" ] && PORT="$ENV_PORT"
fi
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz"; then
  exit 0
fi
NODE_BIN="${MODELDOCK_NODE_PATH:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  # Bundled Node installed by install.sh (or a previous run) wins over PATH so the
  # installed layout stays self-contained; pick the highest version if several exist.
  BEST_BIN=""
  BEST_V=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    v="$(basename "$d" | sed 's/^v//')"
    if [ -z "$BEST_V" ] || [ "$(printf '%s\n%s\n' "$v" "$BEST_V" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$v" ]; then
      BEST_BIN="$d/bin/node"
      BEST_V="$v"
    fi
  done
  if [ -n "$BEST_BIN" ]; then
    NODE_BIN="$BEST_BIN"
  else
    # `set -e` turns a failed command substitution into an immediate exit, so
    # the friendly error below would never run; keep the substitution false-safe.
    NODE_BIN="$(command -v node || true)"
  fi
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found; install Node 24+ or re-run the ModelDock installer" >&2
  exit 1
fi
# A source checkout must never serve a stale bundle - and never silently serve the
# src/ entry users do not have. Rebuild dist when source is newer than the bundle, so
# the gateway runs the same artifact users install. Installed layouts have no src/ at
# all (the self-updater owns dist there), and an applied update makes dist newer than
# src, so this is a no-op for real installs and never clobbers an update. A failed
# rebuild is loud but not fatal: the gateway still starts on the best bundle available.
if [ -f "$ROOT/src/server.mjs" ] && [ -f "$ROOT/scripts/build-if-stale.mjs" ]; then
  if ! "$NODE_BIN" "$ROOT/scripts/build-if-stale.mjs"; then
    echo "WARNING: source is newer than dist/modeldock.mjs but the rebuild failed; starting anyway (run npm run build to refresh the bundle before trusting local results)." >&2
  fi
fi
# Re-pick after the potential rebuild so a freshly built bundle wins over src.
if [ -f "$ROOT/dist/modeldock.mjs" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
fi
cd "$ROOT"
# Log instead of discarding: a background start that dies (bad node, port in use,
# missing file) is otherwise completely silent for the user.
LOG="$ROOT/modeldock.log"
# Rotate at startup, one previous generation (like codex-router's log-rotation):
# the log is append-only for the life of the process, so a cap on growth can only
# be applied between runs. 32 MB keeps roughly a month of daily use.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 33554432 ]; then
  mv -f "$LOG" "$LOG.1"
fi
# Detach into a fresh session, not just a nohup background job: the Codex/agent
# exec environment reaps the whole session when the launching command returns,
# and nohup only ignores SIGHUP - the gateway would die a few seconds later
# with a clean startup block and no error. setsid escapes the session; plain
# terminals keep working through the nohup fallback.
if command -v setsid >/dev/null 2>&1; then
  setsid "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 < /dev/null &
else
  nohup "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 &
fi
EOF
chmod +x "$LAUNCHER"

# Restart script (same content as the repo's scripts/restart.ps1). Written by the
# installer so the model-facing "Restarting the gateway" instruction baked into the
# catalog resolves to a real file in the installed layout.
RESTART="$ROOT/scripts/restart.ps1"
cat > "$RESTART" <<'EOF'
# restart.ps1 - restart the ModelDock gateway service.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   powershell -ExecutionPolicy Bypass -File <modeldock>\scripts\restart.ps1
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>\.env (default 4097).
#   2. Stops the process listening on that port (if any).
#   3. Rebuilds the bundle when a source checkout has drifted ahead of it.
#   4. Starts a fresh detached gateway from the built bundle (dist/modeldock.mjs).
#   5. Prints where the gateway started and exits; runtime logs go to modeldock.log.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"

# Status lines go to both stdout and stderr. Callers (CI, the model shell, the
# dashboard) sometimes capture only one stream; a hidden launcher must never
# fail silently.
function Write-Status($message) {
  Write-Output $message
  [Console]::Error.WriteLine($message)
}

# Seed from the environment before consulting .env, matching restart.sh. This script
# used to ignore $env:MODELDOCK_PORT entirely, so a gateway told to use another port
# by environment restarted against 4097 instead: it stopped whatever unrelated process
# held the default port, then health-checked a port its own gateway was not on.
# scheduleRestart passes the running gateway's environment through for exactly this.
$port = 4097
$envPort = 0
if ($env:MODELDOCK_PORT -and [int]::TryParse($env:MODELDOCK_PORT, [ref]$envPort) -and $envPort -gt 0) {
  $port = $envPort
}
if (Test-Path $envFile) {
  $line = Select-String -Path $envFile -Pattern '^MODELDOCK_PORT=' | Select-Object -First 1
  if ($line) {
    $parsed = 0
    if ([int]::TryParse(($line.Line -replace '^MODELDOCK_PORT=', ''), [ref]$parsed) -and $parsed -gt 0) {
      $port = $parsed
    }
  }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $oldPid = $listener.OwningProcess
  # Ownership guard: the gateway records {pid, root} per port in
  # ~/.modeldock/owner-<port>.json. If the recorded owner is a *different*
  # checkout, killing it would swap live traffic onto this checkout's code -
  # exactly the lookalike-instance mixup we have hit before. Refuse unless -Force.
  # Must match ownerFilePath() in src/instance-owner.mjs, including the
  # MODELDOCK_STATE_DIR redirect, or the guard reads a file the gateway never wrote.
  $stateDir = if ($env:MODELDOCK_STATE_DIR) { $env:MODELDOCK_STATE_DIR } else { Join-Path $env:USERPROFILE ".modeldock" }
  $ownerFile = Join-Path $stateDir "owner-$port.json"
  $forceTakeover = $args -contains "-Force"
  if (-not $forceTakeover) {
    $owned = $false
    try {
      if (-not (Test-Path -LiteralPath $ownerFile)) { throw "owner record is missing" }
      $owner = Get-Content $ownerFile -Raw | ConvertFrom-Json
      $ownerRoot = [System.IO.Path]::GetFullPath([string]$owner.root)
      $thisRoot = [System.IO.Path]::GetFullPath($root)
      if ([int]$owner.pid -ne [int]$oldPid -or [int]$owner.port -ne $port -or $ownerRoot -ne $thisRoot) {
        throw "owner record does not match this listener and install root"
      }
      $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $oldPid" -ErrorAction Stop
      $commandLine = [string]$processInfo.CommandLine
      $sourceEntry = [System.IO.Path]::GetFullPath((Join-Path $root "src\server.mjs"))
      $bundleEntry = [System.IO.Path]::GetFullPath((Join-Path $root "dist\modeldock.mjs"))
      $owned = $commandLine.IndexOf($sourceEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $commandLine.IndexOf($bundleEntry, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
      if (-not $owned) { throw "listener command does not run this ModelDock install" }
    } catch {
      Write-Status "ERROR: refusing to stop PID $oldPid on port $port because ownership could not be verified: $($_.Exception.Message)"
      Write-Status "Re-run with -Force to take the port over deliberately."
      exit 2
    }
  }
  $currentListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($currentListener -and $currentListener.OwningProcess -ne $oldPid -and (-not $forceTakeover)) {
    Write-Status "ERROR: the listener on port $port changed during ownership verification; refusing to stop it."
    exit 2
  }
  Write-Status "restart.ps1: stopping gateway (PID $oldPid, port $port)"
  if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $oldPid -Force
  } else {
    # The gateway (e.g. the updater process) may have exited between the port
    # probe and here; that is not a failure, just start fresh below.
    Write-Status "restart.ps1: PID $oldPid already exited; continuing"
  }
  for ($i = 0; $i -lt 20; $i += 1) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { break }
  }
} else {
  Write-Status "restart.ps1: no gateway on port $port; starting fresh"
}

$log = Join-Path $root "modeldock.log"

# Rotate at startup, one previous generation (same policy as start-hidden.ps1):
# the log is append-only for the life of the process, so a cap on growth can
# only be applied between runs. 32 MB keeps roughly a month of daily use.
if ((Test-Path -LiteralPath $log) -and ((Get-Item -LiteralPath $log).Length -gt 32MB)) {
  try {
    Move-Item -LiteralPath $log -Destination "$log.1" -Force
  } catch {
    # Rotation is best-effort: a raced lock must not turn a restart into a
    # failure. Stop-Process already waited for the old listener to exit, so the
    # append-only redirect below uses a fresh handle.
    Write-Status "WARNING: could not rotate modeldock.log: $($_.Exception.Message)"
  }
}

# Prefer an explicit path, then a bundled Node under <root>\node (the installer
# downloads Node 24 LTS there when none is on PATH), then PATH.
$nodeExe = $null
if ($env:MODELDOCK_NODE_PATH -and (Test-Path -LiteralPath $env:MODELDOCK_NODE_PATH)) { $nodeExe = $env:MODELDOCK_NODE_PATH }
if (-not $nodeExe) {
  $bestDir = @(Get-ChildItem -LiteralPath (Join-Path $root "node") -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^v\d+\.\d+\.\d+$" } |
      Sort-Object @{ Expression = {
              if ($_.Name -match "^v(\d+)\.(\d+)\.(\d+)$") { [long]$Matches[1] * 1000000 + [long]$Matches[2] * 1000 + [long]$Matches[3] } else { -1 }
          }; Descending = $true } |
      Select-Object -First 1)
  if ($bestDir -and (Test-Path -LiteralPath (Join-Path $bestDir.FullName "node.exe"))) {
    $nodeExe = Join-Path $bestDir.FullName "node.exe"
  }
}
if (-not $nodeExe) { $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $nodeExe) {
  Write-Status "ERROR: node.exe not found; install Node 24+ or re-run the ModelDock installer"
  exit 1
}

# A source checkout must never serve a stale bundle - and never silently serve
# the src/ entry users do not have. Rebuild dist when source is newer than the
# bundle, so the gateway runs the same artifact users install. Installed layouts
# have no src/ at all (the self-updater owns dist there), and an applied update
# makes dist newer than src, so this is a no-op for real installs and never
# clobbers an update. A failed rebuild is loud but not fatal: the gateway still
# starts on the best bundle available and the log records exactly what ran.
$buildIfStale = Join-Path $root "scripts\build-if-stale.mjs"
if ((Test-Path -LiteralPath (Join-Path $root "src\server.mjs")) -and (Test-Path -LiteralPath $buildIfStale)) {
  & $nodeExe $buildIfStale
  if ($LASTEXITCODE -ne 0) {
    Write-Status "WARNING: source is newer than dist/modeldock.mjs but the rebuild failed; starting anyway (run npm run build to refresh the bundle before trusting local results)."
  }
}

# Prefer the built bundle, falling back to the source entry in a git checkout.
# This must match start-hidden.ps1 exactly: the two used to disagree (this script
# preferred src while the launcher preferred dist), so a checkout served one
# version on restart and another at login. dist wins because the self-updater
# writes dist/modeldock.mjs and never touches src - preferring src would leave an
# applied update permanently unused, and the Update button permanently lit.
$server = Join-Path $root "dist\modeldock.mjs"
if (-not (Test-Path -LiteralPath $server)) { $server = Join-Path $root "src\server.mjs" }

try {
  # Quote both paths: an installed layout under a home dir with a space
  # (e.g. "C:\Users\Chen Bao\.modeldock") would otherwise be split by node's
  # CRT into two argv entries and fail with "Cannot find module". cmd.exe does
  # the >> redirection so stdout and stderr share the same log file as the
  # start-hidden launcher (and the "check modeldock.log" guidance).
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "`"`"$nodeExe`" `"$server`" >> `"$log`" 2>&1`"" -WorkingDirectory $root -WindowStyle Hidden
} catch {
  Write-Status "ERROR: failed to start gateway: $($_.Exception.Message)"
  exit 1
}
Write-Status "restart.ps1: started gateway from $root using $server (logs: $log)"
exit 0
EOF

# POSIX restart script (same content as the repo's scripts/restart.sh). Written by
# the installer so macOS/Linux installs can restart without requiring PowerShell.
RESTART_SH="$ROOT/scripts/restart.sh"
cat > "$RESTART_SH" <<'EOF'
#!/bin/sh
# restart.sh - restart the ModelDock gateway service on macOS/Linux.
#
# The model (Codex/DeepSeek/Luna) can restart the gateway itself by running:
#   sh <modeldock>/scripts/restart.sh
#
# What it does:
#   1. Reads MODELDOCK_PORT from <modeldock>/.env (default 4097).
#   2. On macOS, asks launchd to restart the managed service when it is loaded.
#   3. Otherwise stops the process listening on that port, after an owner check.
#   4. Starts a fresh detached node gateway.

set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    -f|--force|-Force) FORCE=1 ;;
  esac
done

status() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >&2
}

PORT="${MODELDOCK_PORT:-4097}"
if [ -f "$ENV_FILE" ]; then
  ENV_PORT="$(sed -n 's/^MODELDOCK_PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r' || true)"
  case "$ENV_PORT" in
    ''|*[!0-9]*) ;;
    *) [ "$ENV_PORT" -gt 0 ] && PORT="$ENV_PORT" ;;
  esac
fi

find_listener_pid() {
  pid=""
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
    if [ -n "$pid" ]; then printf '%s\n' "$pid"; return; fi
  fi
  if command -v ss >/dev/null 2>&1; then
    # Minimal Linux images (Debian/Ubuntu containers) ship neither lsof nor
    # psmisc, but do ship ss. Without this branch the old PID is never found and
    # the new gateway dies with EADDRINUSE while the stale one keeps answering.
    pid="$(ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n 1 | cut -d= -f2 || true)"
    if [ -n "$pid" ]; then printf '%s\n' "$pid"; return; fi
  fi
  if command -v fuser >/dev/null 2>&1; then
    pid="$(fuser "$PORT/tcp" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | head -n 1 || true)"
    if [ -n "$pid" ]; then printf '%s\n' "$pid"; return; fi
  fi
  true
}

resolve_node() {
  if [ -n "${MODELDOCK_NODE_PATH:-}" ] && [ -x "$MODELDOCK_NODE_PATH" ]; then
    printf '%s\n' "$MODELDOCK_NODE_PATH"
    return
  fi

  best_bin=""
  best_v=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    v="$(basename "$d" | sed 's/^v//')"
    if [ -z "$best_v" ] || [ "$(printf '%s\n%s\n' "$v" "$best_v" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$v" ]; then
      best_bin="$d/bin/node"
      best_v="$v"
    fi
  done
  if [ -n "$best_bin" ]; then
    printf '%s\n' "$best_bin"
    return
  fi

  command -v node || true
}

NODE_BIN="$(resolve_node)"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  status "ERROR: node not found; install Node 24+ or re-run the ModelDock installer"
  exit 1
fi

# A source checkout must never serve a stale bundle - and never silently serve the
# src/ entry users do not have. Rebuild dist when source is newer than the bundle, so
# the gateway runs the same artifact users install. Installed layouts have no src/ at
# all (the self-updater owns dist there), and an applied update makes dist newer than
# src, so this is a no-op for real installs and never clobbers an update. A failed
# rebuild is loud but not fatal: the gateway still starts on the best bundle available.
if [ -f "$ROOT/src/server.mjs" ] && [ -f "$ROOT/scripts/build-if-stale.mjs" ]; then
  if ! "$NODE_BIN" "$ROOT/scripts/build-if-stale.mjs"; then
    status "WARNING: source is newer than dist/modeldock.mjs but the rebuild failed; starting anyway (run npm run build to refresh the bundle before trusting local results)."
  fi
fi

# Prefer the built bundle, falling back to the source entry in a git checkout.
# Must match start-hidden.sh: the two used to disagree, so a checkout served one
# version on restart and another at login. dist wins because the self-updater
# writes dist/modeldock.mjs and never touches src.
SERVER="$ROOT/dist/modeldock.mjs"
if [ ! -f "$SERVER" ]; then
  SERVER="$ROOT/src/server.mjs"
fi
if [ ! -f "$SERVER" ]; then
  status "ERROR: gateway entry not found under $ROOT/src or $ROOT/dist"
  exit 1
fi

OLD_PID="$(find_listener_pid)"
if curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null \
    && [ -z "$OLD_PID" ]; then
  status "ERROR: port $PORT is active but its listener PID could not be identified; refusing a fake restart"
  exit 3
fi

check_owner() {
  [ -n "$OLD_PID" ] || return 0
  [ "$FORCE" -eq 0 ] || return 0
  state_dir="${MODELDOCK_STATE_DIR:-$HOME/.modeldock}"
  owner_file="$state_dir/owner-$PORT.json"
  "$NODE_BIN" --input-type=module - "$owner_file" "$OLD_PID" "$ROOT" "$PORT" <<'NODE'
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [ownerFile, oldPid, root, port] = process.argv.slice(2);
const candidates = [path.join(root, "src", "server.mjs"), path.join(root, "dist", "modeldock.mjs")];

// The command line is the ground truth: a listener that provably runs this
// install's gateway is ours no matter what the owner record says. The record
// can go stale - a crash or a manual start never updates it, and a second
// instance that died with EADDRINUSE can even clobber it with its own pid -
// and blocking the restart on that stale file leaves the old process serving
// forever (the "restart does nothing" failure). Only refuse when the listener
// cannot be identified as ours AND the record names a different live owner.
let listenerIsOurs = false;
try {
  if (process.platform === "linux") {
    const argv = fs.readFileSync(`/proc/${oldPid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    listenerIsOurs = argv.some((arg) => candidates.includes(path.resolve(arg)));
  } else {
    try {
      const command = execFileSync("ps", ["-p", oldPid, "-o", "command="], { encoding: "utf8" });
      listenerIsOurs = candidates.some((candidate) => command.includes(candidate));
    } catch {
      // ps failed (pid vanished mid-check); treat as unknown and consult the record.
    }
  }
} catch {
  // /proc vanished: the listener died between discovery and the check.
  process.exit(0);
}
if (listenerIsOurs) process.exit(0);

// Not provably ours. A record naming a LIVE pid that is not the listener is a
// genuine conflict with another ModelDock instance - refuse. A missing or stale
// record (recorded pid dead) identifies nothing, so the listener still cannot be
// trusted; refuse rather than risk killing a foreign process.
let owner;
try {
  owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
} catch {
  // No record at all.
}
if (owner) {
  let alive = false;
  try {
    process.kill(Number(owner.pid), 0);
    alive = true;
  } catch {
    // ESRCH: the recorded process is gone; the record is stale.
  }
  if (alive && Number(owner.pid) !== Number(oldPid)) {
    console.error(`ERROR: refusing to stop PID ${oldPid} on port ${port} because port ${port} is recorded as owned by live PID ${owner.pid} (root: ${owner.root}).`);
    console.error("Re-run with --force to take the port over deliberately.");
    process.exit(2);
  }
}
console.error(`ERROR: refusing to stop PID ${oldPid} on port ${port} because ownership could not be verified: the listener is not a ModelDock gateway from this install and the owner record is missing or stale.`);
console.error("Re-run with --force to take the port over deliberately.");
process.exit(2);
NODE
}

try_launchd_restart() {
  [ "$(uname -s 2>/dev/null || true)" = "Darwin" ] || return 1
  command -v launchctl >/dev/null 2>&1 || return 1
  label="gui/$(id -u)/com.modeldock.gateway"
  launchctl print "$label" >/dev/null 2>&1 || return 1
  status "restart.sh: restarting launchd service com.modeldock.gateway"
  launchctl kickstart -k "$label" >/dev/null 2>&1
}

check_owner

if try_launchd_restart; then
  status "restart.sh: launchd service com.modeldock.gateway restarted"
  exit 0
fi

if [ -n "$OLD_PID" ]; then
  current_pid="$(find_listener_pid)"
  if [ "$FORCE" -eq 0 ] && [ -n "$current_pid" ] && [ "$current_pid" != "$OLD_PID" ]; then
    status "ERROR: the listener on port $PORT changed during ownership verification; refusing to stop it"
    exit 2
  fi
  status "restart.sh: stopping gateway (PID $OLD_PID, port $PORT)"
  kill "$OLD_PID" 2>/dev/null || true
  i=0
  while [ "$i" -lt 20 ]; do
    current_pid="$(find_listener_pid)"
    alive=""
    if kill -0 "$OLD_PID" 2>/dev/null; then alive=1; fi
    if [ -z "$alive" ] && { [ -z "$current_pid" ] || [ "$current_pid" != "$OLD_PID" ]; }; then
      break
    fi
    sleep 0.25
    i=$((i + 1))
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    status "restart.sh: gateway did not stop after SIGTERM; forcing PID $OLD_PID"
    kill -9 "$OLD_PID" 2>/dev/null || true
    sleep 0.5
  fi
else
  status "restart.sh: no gateway on port $PORT; starting fresh"
fi

cd "$ROOT"
LOG="$ROOT/modeldock.log"
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 33554432 ]; then
  mv -f "$LOG" "$LOG.1"
fi

# Detach the gateway into its own session. nohup alone is not enough when the
# launcher runs inside the Codex/agent exec environment: that environment tears
# down the whole session (process group) when the command returns, and nohup
# only ignores SIGHUP - the child stays in the dying session and is reaped a
# few seconds later, which reads as "the gateway died right after the agent
# restarted it" with a clean startup block and no error in the log. setsid
# moves the child into a fresh session the reaper cannot reach; a normal
# terminal keeps working through the nohup fallback.
if command -v setsid >/dev/null 2>&1; then
  setsid "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 < /dev/null &
else
  nohup "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 &
fi
status "restart.sh: started gateway from $ROOT using $SERVER (logs: $LOG)"
exit 0
EOF
chmod +x "$RESTART_SH"

# Manual recovery menu: restart the gateway or restore the native Codex route.
RECOVER="$ROOT/scripts/recover.sh"
cat > "$RECOVER" <<'EOF'
#!/bin/sh
# ModelDock manual recovery menu.
# Choose gateway restart, restore the last native Codex configuration, or repair
# the start-at-login entry.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
STATE_DIR="${MODELDOCK_STATE_DIR:-$ROOT}"
PORT="${MODELDOCK_PORT:-4097}"
if [ -f "$ROOT/.env" ]; then
  ENV_PORT="$(sed -n 's/^MODELDOCK_PORT=//p' "$ROOT/.env" | tail -n 1 | tr -d '\r' || true)"
  case "$ENV_PORT" in
    ''|*[!0-9]*) ;;
    *) [ "$ENV_PORT" -gt 0 ] && PORT="$ENV_PORT" ;;
  esac
fi

# Resolve a Node binary the same bundled-first way as restart.sh. A self-contained
# install (node auto-downloaded into "$ROOT/node" because the machine had none)
# has no node on PATH, so a bare "node" here would fail the config restore exactly
# when the gateway is down and recovery matters most.
resolve_node() {
  if [ -n "${MODELDOCK_NODE_PATH:-}" ] && [ -x "$MODELDOCK_NODE_PATH" ]; then
    printf '%s\n' "$MODELDOCK_NODE_PATH"; return
  fi
  best_bin=""; best_v=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    v="$(basename "$d" | sed 's/^v//')"
    if [ -z "$best_v" ] || [ "$(printf '%s\n%s\n' "$v" "$best_v" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$v" ]; then
      best_bin="$d/bin/node"; best_v="$v"
    fi
  done
  if [ -n "$best_bin" ]; then printf '%s\n' "$best_bin"; return; fi
  command -v node || true
}

restore_previous_update() {
  marker="$ROOT/.modeldock-rollback/current"
  [ -f "$marker" ] || return 1
  node_bin="$(resolve_node)"
  [ -n "$node_bin" ] && [ -x "$node_bin" ] || return 1
  "$node_bin" --input-type=module - "$ROOT" "$marker" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [rootArg, marker] = process.argv.slice(2);
const root = path.resolve(rootArg);
const rollbackRoot = path.join(root, ".modeldock-rollback");
const name = fs.readFileSync(marker, "utf8").trim();
if (!name || path.basename(name) !== name) throw new Error("invalid update rollback marker");
const rollbackDir = path.join(rollbackRoot, name);
const manifest = JSON.parse(fs.readFileSync(path.join(rollbackDir, "manifest.json"), "utf8"));
const prepared = [];
let applied = 0;
const remove = (file) => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; } };
try {
  for (const entry of manifest.files || []) {
    const target = path.resolve(root, entry.path);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`rollback path escaped install root: ${entry.path}`);
    const stage = `${target}.rollback-stage-${process.pid}`;
    const current = `${target}.rollback-current-${process.pid}`;
    remove(stage);
    remove(current);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const currentExisted = fs.existsSync(target);
    if (currentExisted) fs.copyFileSync(target, current);
    if (entry.existed) {
      const source = path.resolve(rollbackDir, entry.path);
      if (!source.startsWith(`${rollbackDir}${path.sep}`) || !fs.statSync(source).isFile()) throw new Error(`rollback file is missing: ${entry.path}`);
      fs.copyFileSync(source, stage);
    }
    prepared.push({ target, stage, current, currentExisted, restore: Boolean(entry.existed) });
  }
  for (const item of prepared) {
    if (item.restore) fs.renameSync(item.stage, item.target);
    else remove(item.target);
    applied += 1;
  }
} catch (error) {
  for (let index = applied - 1; index >= 0; index -= 1) {
    const item = prepared[index];
    if (item.currentExisted) fs.copyFileSync(item.current, item.target);
    else remove(item.target);
  }
  throw error;
} finally {
  for (const item of prepared) {
    try { remove(item.stage); } catch {}
    try { remove(item.current); } catch {}
  }
}
NODE
}

restart_gateway() {
  restart="$ROOT/scripts/restart.sh"
  if [ ! -x "$restart" ]; then
    echo "restart.sh is missing from $ROOT" >&2
    exit 1
  fi
  if "$restart"; then return; else restart_status=$?; fi
  # Codes 2 and 3 are ownership/PID-safety refusals, not a bad release. Never
  # replace files while a listener we cannot safely stop may still be running.
  if [ "$restart_status" -eq 2 ] || [ "$restart_status" -eq 3 ]; then exit "$restart_status"; fi
  echo "New installed version did not become healthy; restoring the complete previous version set." >&2
  if restore_previous_update && "$ROOT/scripts/restart.sh"; then
    echo "Rolled back the complete installed version; gateway is healthy."
    return
  fi
  echo "Gateway did not become healthy. Check $ROOT/modeldock.log" >&2
  exit 1
}

restore_native() {
  if curl -fsS --max-time 3 -X POST "http://127.0.0.1:$PORT/api/config/disable" >/dev/null 2>&1; then
    echo "Codex native route restored through the running gateway."
    return
  fi
  echo "Gateway is unavailable; restoring from the local backup."
  CODEX_HOME_VALUE="${MODELDOCK_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
  STATE="$CODEX_HOME_VALUE/modeldock/config-switch-state.json"
  CONFIG="$CODEX_HOME_VALUE/config.toml"
  if [ ! -f "$STATE" ]; then
    echo "ModelDock switch state was not found: $STATE" >&2
    exit 1
  fi
  NODE_BIN="$(resolve_node)"
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "node not found; cannot restore the Codex config. Install Node 24+ or re-run the installer." >&2
    exit 1
  fi
  "$NODE_BIN" --input-type=module - "$STATE" "$CONFIG" <<'NODE'
import { copyFile, readFile, rm, writeFile, rename } from "node:fs/promises";
import path from "node:path";
const [statePath, configPath] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, "utf8"));
if (!state.enabled) {
  console.log("Codex is already on the native route.");
  process.exit(0);
}
if (!state.backupPath) throw new Error("ModelDock backup path is missing.");
const backup = path.resolve(state.backupPath);
try { await readFile(backup); } catch { throw new Error(`ModelDock backup is missing: ${backup}`); }
try {
  await readFile(configPath);
  await copyFile(configPath, `${configPath}.native-recovery-${Date.now()}.bak`);
  if (state.originalExisted) await copyFile(backup, configPath);
  else await rm(configPath, { force: true });
} catch (error) {
  if (error.code === "ENOENT" && state.originalExisted) await copyFile(backup, configPath);
  else if (error.code !== "ENOENT") throw error;
}
state.enabled = false;
state.restartRequired = true;
state.lastBackupPath = backup;
state.changedAt = new Date().toISOString();
const temporary = `${statePath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, statePath);
console.log(`Codex native route restored from ${backup}`);
console.log("Fully quit and restart Codex.");
NODE
}

repair_autostart() {
  if [ "$(uname -s)" != "Darwin" ] && [ "${MODELDOCK_FAKE_DARWIN:-}" != "1" ]; then
    echo "Start-at-login repair is macOS-only; on Windows use the installer's recover menu." >&2
    return
  fi
  if [ ! -e "$STATE_DIR/autostart-initialized" ]; then
    echo "No start-at-login decision was recorded; enable it from the dashboard Settings instead." >&2
    return
  fi
  NODE_BIN=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    NODE_BIN="$d/bin/node"
    break
  done
  [ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "node not found; cannot regenerate the launch agent." >&2
    exit 1
  fi
  if [ -f "$ROOT/dist/modeldock.mjs" ]; then
    SERVER="$ROOT/dist/modeldock.mjs"
  else
    SERVER="$ROOT/src/server.mjs"
  fi
  PLIST_DIR="${MODELDOCK_AUTOSTART_PLIST_DIR:-$HOME/Library/LaunchAgents}"
  PLIST="$PLIST_DIR/com.modeldock.gateway.plist"
  mkdir -p "$PLIST_DIR"
  # plist is XML: a user path containing & < > would otherwise break launchd.
  xml_escape() {
    printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
  }
  NODE_DIR="$(dirname "$NODE_BIN")"
  PLIST_PATH="$(xml_escape "$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"
  PLIST_NODE="$(xml_escape "$NODE_BIN")"
  PLIST_SERVER="$(xml_escape "$SERVER")"
  PLIST_ROOT="$(xml_escape "$ROOT")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.modeldock.gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PLIST_PATH</string>
    <key>MODELDOCK_NODE_PATH</key><string>$PLIST_NODE</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$PLIST_NODE</string>
    <string>$PLIST_SERVER</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$PLIST_ROOT</string>
  <key>StandardOutPath</key><string>$PLIST_ROOT/modeldock.log</string>
  <key>StandardErrorPath</key><string>$PLIST_ROOT/modeldock.log</string>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  if launchctl load -w "$PLIST"; then
    echo "Start-at-login re-enabled."
  else
    echo "launchctl load failed; check $ROOT/modeldock.log and the plist." >&2
    exit 1
  fi
}

echo ""
echo "ModelDock manual recovery"
echo "1. Restart ModelDock gateway"
echo "2. Restore Codex native route"
echo "3. Repair start-at-login"
echo "Q. Quit"
printf "Choose 1, 2, 3, or Q: "
read -r choice
case "$choice" in
  1) restart_gateway ;;
  2) restore_native ;;
  3) repair_autostart ;;
  q|Q|"") exit 0 ;;
  *) echo "Unknown choice: $choice" >&2; exit 1 ;;
esac
EOF
chmod +x "$RECOVER"

# Shell fallback for the ModelDock MCP tools (same content as the repo's
# scripts/mcp-call.sh + scripts/mcp-call.mjs). The base instructions tell the
# model to call the tools through the shell when the session MCP connection is
# stale; on Linux the private Node runtime is not on PATH, so both the runtime
# resolver and the client must ship with the install.
MCP_CALL_SH="$ROOT/scripts/mcp-call.sh"
cat > "$MCP_CALL_SH" <<'EOF'
#!/bin/sh
# mcp-call.sh - run a ModelDock MCP tool from the shell.
#
# Same purpose as `node scripts/mcp-call.mjs`, but resolves the bundled Node
# runtime first, so it works on Linux/macOS installs where `node` is not on PATH
# (the installer downloads a private Node into <root>/node). Usage:
#
#   sh scripts/mcp-call.sh list_mcp_tools
#   sh scripts/mcp-call.sh search "query"
#   sh scripts/mcp-call.sh vision <path> "question"
#   sh scripts/mcp-call.sh image "prompt"
#   sh scripts/mcp-call.sh recall "query" [scope_dir]
#   sh scripts/mcp-call.sh store "content" [scope_dir] [kind]
#
# The tool list is identical to scripts/mcp-call.mjs; this wrapper only locates
# the runtime and forwards the arguments.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

if [ -n "${MODELDOCK_NODE_PATH:-}" ] && [ -x "$MODELDOCK_NODE_PATH" ]; then
  NODE_BIN="$MODELDOCK_NODE_PATH"
else
  NODE_BIN=""
  for d in "$ROOT"/node/v*; do
    [ -d "$d" ] && [ -x "$d/bin/node" ] || continue
    NODE_BIN="$d/bin/node"
    break
  done
  [ -n "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node not found; install Node 24+ or re-run the ModelDock installer" >&2
  exit 1
fi

CALLER="$ROOT/scripts/mcp-call.mjs"
if [ ! -f "$CALLER" ]; then
  echo "ERROR: $CALLER is missing; this install predates the shell fallback - update ModelDock or run from a source checkout" >&2
  exit 1
fi

exec "$NODE_BIN" "$CALLER" "$@"
EOF
chmod +x "$MCP_CALL_SH"

MCP_CALL_MJS="$ROOT/scripts/mcp-call.mjs"
cat > "$MCP_CALL_MJS" <<'EOF'
// Direct caller for the ModelDock MCP tools.
//
// Use this when the Codex session's MCP connection is unavailable (for example
// after a gateway restart, which the Codex client never re-establishes). It
// bypasses the Codex MCP client and talks straight to the gateway's keyed MCP
// endpoint, so the tools work in any session without exposing a bare route.
//
//   node scripts/mcp-call.mjs tools
//   node scripts/mcp-call.mjs list_mcp_tools
//   node scripts/mcp-call.mjs search <query> [numResults]
//   node scripts/mcp-call.mjs vision <path> <question> [mode]
//   node scripts/mcp-call.mjs image <prompt> [size] [model]
//   node scripts/mcp-call.mjs speak <text>
//   node scripts/mcp-call.mjs hear <file>
//   node scripts/mcp-call.mjs recall <query> [scope_dir] [limit]
//   node scripts/mcp-call.mjs store <content> [scope_dir] [kind]
//
// This file is self-contained ON PURPOSE: it is shipped to installed layouts
// (via install.sh) that have no src/ directory at all, so it must not import
// ../src/mcp-client.mjs or ../src/caller-key.mjs. The ~60 lines below are the
// minimal faithful copy of those two modules (keyed base URL + stateless MCP
// client); keep them in lockstep when either changes.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// State-dir resolution, mirroring src/state-dir.mjs: MODELDOCK_STATE_DIR
// redirects the whole directory (tests, throwaway installs), otherwise
// ~/.modeldock. The gateway and this CLI both resolve the caller key there, so
// they always agree on the keyed base URL.
function stateFile(name) {
  const dir = process.env.MODELDOCK_STATE_DIR
    ? path.resolve(process.env.MODELDOCK_STATE_DIR)
    : path.join(os.homedir(), ".modeldock");
  return path.join(dir, name);
}

// Caller-key resolution, mirroring src/caller-key.mjs. Read the persisted key
// and mint one on first use (the gateway does the same, so whichever runs
// first creates it; both write the same file).
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

function loadOrCreateCallerKey() {
  const filePath = stateFile("caller-key");
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (KEY_PATTERN.test(existing)) return existing;
  } catch {
    // Missing or unreadable: mint below.
  }
  const key = randomBytes(32).toString("base64url");
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${key}\n`, "utf8");
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Hardening must never block the fallback.
    }
  } catch {
    // Unwritable state dir: the key still works for this process lifetime.
  }
  return key;
}

// Keyed gateway base URL, mirroring src/mcp-client.mjs.
function gatewayBaseUrl() {
  if (process.env.MODELDOCK_GATEWAY_URL) return process.env.MODELDOCK_GATEWAY_URL;
  return `http://127.0.0.1:4097/c/${loadOrCreateCallerKey()}`;
}

async function requestMcp(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  let message = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      message = JSON.parse(line.slice(5).trim());
      break;
    } catch {
      // Try the next data line.
    }
  }
  if (!message) {
    throw new Error(`MCP ${method} failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (message.error) {
    throw new Error(message.error.message || JSON.stringify(message.error));
  }
  return message.result;
}

async function listMcpTools(baseUrl = gatewayBaseUrl()) {
  const result = await requestMcp(baseUrl, "tools/list", {});
  return result.tools || [];
}

// Returns the tool result text; when that text is itself JSON the parsed value
// is returned so callers can work with the object directly.
async function callMcpTool(name, args, baseUrl = gatewayBaseUrl()) {
  const result = await requestMcp(baseUrl, "tools/call", { name, arguments: args });
  const text = (result.content || []).find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === "tools") {
  const tools = await listMcpTools();
  console.log(JSON.stringify(tools.map((tool) => tool.name), null, 2));
} else if (command === "list_mcp_tools") {
  // Discovery command: print every tool with its arguments and a ready-to-run
  // example, fetched live from the gateway so the prompt never hardcodes a
  // schema that can drift.
  const tools = await listMcpTools();
  const lines = [];
  for (const tool of tools) {
    const schema = tool.inputSchema || {};
    const required = new Set(schema.required || []);
    const args = Object.entries(schema.properties || {})
      .map(([name, prop]) => `${name}${required.has(name) ? "" : "?"}: ${prop.type || "any"}${prop.description ? ` (${prop.description})` : ""}`)
      .join(", ");
    lines.push(
      `${tool.name}\n  args: ${args || "none"}\n  desc: ${tool.description || ""}\n  example: node scripts/mcp-call.mjs ${exampleFor(tool.name)}`,
    );
  }
  console.log(lines.join("\n"));
} else if (command === "search") {
  const args = { query: rest[0] };
  if (rest[1]) args.numResults = Number(rest[1]);
  console.log(JSON.stringify(await callMcpTool("web_search_exa", args), null, 2));
} else if (command === "recall") {
  const args = { query: rest[0] };
  args.scope_dir = process.env.MODELDOCK_MEMORY_SCOPE || rest[1] || process.cwd();
  if (process.env.MODELDOCK_MEMORY_SCOPE) args.scope_only = true;
  if (rest[2]) args.limit = Number(rest[2]);
  console.log(await callMcpTool("recall_memory", args));
} else if (command === "store") {
  const args = { content: rest[0] };
  args.scope_dir = process.env.MODELDOCK_MEMORY_SCOPE || rest[1] || process.cwd();
  if (rest[2]) args.kind = rest[2];
  console.log(JSON.stringify(await callMcpTool("store_memory", args), null, 2));
} else if (command === "vision") {
  const args = { path: rest[0], question: rest[1] };
  if (rest[2]) args.mode = rest[2];
  console.log(JSON.stringify(await callMcpTool("vision_inspect", args), null, 2));
} else if (command === "image") {
  // image_gen is a first-class tool but was missing here, so a stale MCP
  // connection took it away entirely while the instructions still called it
  // mandatory for frontend work.
  const args = { prompt: rest[0] };
  if (rest[1]) args.size = rest[1];
  if (rest[2]) args.model = rest[2];
  console.log(await callMcpTool("image_gen", args));
} else if (command === "speak") {
  console.log(await callMcpTool("speak", { text: rest[0] }));
} else if (command === "hear") {
  console.log(await callMcpTool("hear", { file: rest[0] }));
} else {
  console.error("usage: node scripts/mcp-call.mjs <tools|list_mcp_tools|search|vision|image|speak|hear|recall|store> ...");
  process.exitCode = 2;
}

function exampleFor(toolName) {
  const examples = {
    web_search_exa: 'search "query"',
    vision_inspect: 'vision <path> "question"',
    image_gen: 'image "prompt" [size]',
    speak: 'speak "text"',
    hear: "hear <file>",
    recall_memory: 'recall "query" [scope_dir]',
    store_memory: 'store "content" [scope_dir] [kind]',
  };
  return examples[toolName] || `${toolName} <args>`;
}
EOF

# 2.5. Install the content-to-video skill into the Codex skills directory.
# The skill is small (18 text files, ~0.1 MB) and ships as source in the repo,
# so the installer mirrors the same files from GitHub raw instead of bundling
# an archive. The skill is additive: a download failure warns and continues,
# it never fails the install.
CODEX_HOME_VALUE="${MODELDOCK_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
SKILL_BASE="${MODELDOCK_SKILL_BASE_URL:-https://raw.githubusercontent.com/$REPO/main/skills/content-to-video}"
SKILL_DEST="$CODEX_HOME_VALUE/skills/content-to-video"
mkdir -p "$SKILL_DEST"
SKILL_FILES="
SKILL.md
agents/openai.yaml
references/beat-sync.md
references/classification.md
references/hyperframes.md
references/methodology.md
references/pipeline.md
references/pipelines.md
references/quality.md
references/sound-design.md
references/sprites.md
references/tech-stack.md
scripts/build_film.py
scripts/classify.mjs
scripts/preview-scenes.mjs
scripts/qa-frames.mjs
scripts/render-clip.mjs
scripts/static-server-range.mjs
"
for rel in $SKILL_FILES; do
  mkdir -p "$SKILL_DEST/$(dirname "$rel")"
  if ! curl -fsSL --max-time 20 "$SKILL_BASE/$rel" -o "$SKILL_DEST/$rel"; then
    rm -f "$SKILL_DEST/$rel"
    echo "  WARNING: could not download skill file $rel" >&2
  fi
done
echo "  content-to-video skill installed to $SKILL_DEST"

# 3. Enable login autostart on every install (macOS). The gateway also has a
#    first-run default-on safeguard, but doing it here makes the install result
#    deterministic even when the first background start is delayed or fails.
#    The marker only records that the decision was made (the dashboard toggle
#    remains the runtime switch); a reinstall deliberately re-enables start at
#    login instead of preserving a previous off. SKIP_START=1 opts out. Tests
#    redirect the plist directory and state dir through
#    MODELDOCK_AUTOSTART_PLIST_DIR and MODELDOCK_STATE_DIR so mock installs
#    never touch the real LaunchAgents.
STATE_DIR="${MODELDOCK_STATE_DIR:-$ROOT}"
AUTOSTART_MARK="$STATE_DIR/autostart-initialized"
if [ "$SKIP_START" != "1" ] && [ "$(uname -s)" = "Darwin" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
  PLIST_DIR="${MODELDOCK_AUTOSTART_PLIST_DIR:-$HOME/Library/LaunchAgents}"
  PLIST="$PLIST_DIR/com.modeldock.gateway.plist"
  mkdir -p "$PLIST_DIR"
  # plist is XML: a user path containing & < > would otherwise break launchd.
  xml_escape() {
    printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
  }
  NODE_DIR="$(dirname "$NODE_BIN")"
  PLIST_PATH="$(xml_escape "$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")"
  PLIST_NODE="$(xml_escape "$NODE_BIN")"
  PLIST_SERVER="$(xml_escape "$SERVER")"
  PLIST_ROOT="$(xml_escape "$ROOT")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.modeldock.gateway</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$PLIST_PATH</string>
    <key>MODELDOCK_NODE_PATH</key><string>$PLIST_NODE</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$PLIST_NODE</string>
    <string>$PLIST_SERVER</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$PLIST_ROOT</string>
  <key>StandardOutPath</key><string>$PLIST_ROOT/modeldock.log</string>
  <key>StandardErrorPath</key><string>$PLIST_ROOT/modeldock.log</string>
</dict>
</plist>
EOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  if launchctl load -w "$PLIST"; then
    mkdir -p "$STATE_DIR"
    printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$AUTOSTART_MARK"
    echo "  start at login enabled"
  else
    echo "ERROR: could not enable start at login (launchctl load failed)." >&2
    echo "       The gateway still works; run the recovery script and choose" >&2
    echo "       'Repair start-at-login' to fix it later." >&2
  fi
fi

# 4. Start (unless already running) and point at the dashboard.
#    MODELDOCK_SKIP_START=1 skips the launch (used by the install mock test, which
#    feeds the installer a fake node that may not be executable).
if [ "$SKIP_START" = "1" ]; then
  echo "  MODELDOCK_SKIP_START=1 - not starting the gateway."
elif curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" && { [ "${NODE_DOWNLOADED:-0}" = "1" ] || [ "$NODE_MIGRATION_NEEDED" = "1" ]; }; then
  echo "  restarting ModelDock on the new Node runtime..."
  sh "$RESTART_SH" --force
elif curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz"; then
  echo "  ModelDock is already running on port $PORT - keeping it."
else
  echo "  starting ModelDock in the background..."
  "$LAUNCHER"
  sleep 3
fi

echo ""
echo "Done. Dashboard: http://127.0.0.1:$PORT"
echo "First run: paste your API token into the Settings dialog that opens automatically."
echo "Start at login is enabled by default; you can turn it off in Settings."
if [ "$SKIP_OPEN" != "1" ]; then
  command -v open >/dev/null 2>&1 && open "http://127.0.0.1:$PORT/?settings=1" || true
fi

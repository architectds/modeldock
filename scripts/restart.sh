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
STATE_DIR="${MODELDOCK_STATE_DIR:-$HOME/.modeldock}"

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

# A successful process launch is not a successful restart: the child can bind
# briefly and then die, or an old listener can survive the handoff. Invoke the
# verifier embedded in the same bundle that was just launched so Windows,
# POSIX, installer recovery, and release verification share one definition of
# ready: a fresh owner from this install plus a working local status API.
verify_gateway() {
  if [ -n "$OLD_PID" ]; then
    if ! "$NODE_BIN" "$SERVER" --verify-gateway \
      --root "$ROOT" --port "$PORT" --state-dir "$STATE_DIR" \
      --started-after-ms "$STARTED_AFTER_MS" --timeout-ms 15000 \
      --previous-pid "$OLD_PID"; then
      status "ERROR: Gateway did not verify after restart. The replacement may have exited; check $ROOT/modeldock.log."
      return 1
    fi
  elif ! "$NODE_BIN" "$SERVER" --verify-gateway \
    --root "$ROOT" --port "$PORT" --state-dir "$STATE_DIR" \
    --started-after-ms "$STARTED_AFTER_MS" --timeout-ms 15000; then
    status "ERROR: Gateway did not verify after restart. The replacement may have exited; check $ROOT/modeldock.log."
    return 1
  fi
}

check_owner

STARTED_AFTER_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
if try_launchd_restart; then
  status "restart.sh: launchd service com.modeldock.gateway restarted; verifying readiness"
  verify_gateway
  status "restart.sh: verified launchd gateway from $ROOT"
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
  STARTED_AFTER_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
  setsid "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 < /dev/null &
else
  STARTED_AFTER_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
  nohup "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 &
fi
status "restart.sh: started gateway from $ROOT using $SERVER; verifying readiness (logs: $LOG)"
verify_gateway
status "restart.sh: verified gateway from $ROOT (logs: $LOG)"
exit 0

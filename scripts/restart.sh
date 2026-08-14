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
#   4. Starts a fresh detached node gateway and waits for /healthz.

set -eu

# A self-update launches this script before its HTTP handler returns. Give that
# loopback response a bounded window to flush before stopping the old gateway.
case "${MODELDOCK_RESTART_DELAY_SECONDS:-}" in
  1|2|3|4|5|6|7|8|9|10) sleep "$MODELDOCK_RESTART_DELAY_SECONDS" ;;
esac

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

SERVER="$ROOT/src/server.mjs"
if [ ! -f "$SERVER" ]; then
  SERVER="$ROOT/dist/modeldock.mjs"
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
try {
  const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
  const ownerRoot = path.resolve(String(owner?.root || ""));
  const thisRoot = path.resolve(root);
  if (Number(owner?.pid) !== Number(oldPid) || Number(owner?.port) !== Number(port) || ownerRoot !== thisRoot) {
    throw new Error("owner record does not match this listener and install root");
  }
  const candidates = [path.join(thisRoot, "src", "server.mjs"), path.join(thisRoot, "dist", "modeldock.mjs")];
  let commandMatches = false;
  if (process.platform === "linux") {
    const argv = fs.readFileSync(`/proc/${oldPid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    commandMatches = argv.some((arg) => candidates.includes(path.resolve(arg)));
  } else {
    const command = execFileSync("ps", ["-p", oldPid, "-o", "command="], { encoding: "utf8" });
    commandMatches = candidates.some((candidate) => command.includes(candidate));
  }
  if (!commandMatches) throw new Error("listener command does not run this ModelDock install");
} catch (error) {
  console.error(`ERROR: refusing to stop PID ${oldPid} on port ${port} because ownership could not be verified: ${error.message}`);
  console.error("Re-run with --force to take the port over deliberately.");
  process.exit(2);
}
NODE
}

wait_for_health() {
  old_pid="${1:-}"
  i=0
  while [ "$i" -lt 40 ]; do
    # No -f: a 503 (gateway up but no token yet) still proves the process is
    # listening. -f would treat that as a failure and loop until the timeout,
    # reporting a healthy fresh install as "did not start".
    if curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
      new_pid="$(find_listener_pid)"
      if [ -z "$old_pid" ] || [ -z "$new_pid" ] || [ "$new_pid" != "$old_pid" ]; then
        status "restart.sh: gateway healthy at http://127.0.0.1:$PORT"
        return 0
      fi
    fi
    sleep 0.25
    i=$((i + 1))
  done
  return 1
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
  if wait_for_health "$OLD_PID"; then
    exit 0
  fi
  status "WARNING: launchd restart did not become healthy; falling back to manual restart"
  OLD_PID="$(find_listener_pid)"
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

nohup "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 &
NEW_PID=$!
status "restart.sh: started gateway from $ROOT (logs: $LOG)"

if wait_for_health "$OLD_PID"; then
  exit 0
fi

status "ERROR: gateway did not become healthy within 10s"
kill "$NEW_PID" 2>/dev/null || true
wait "$NEW_PID" 2>/dev/null || true
if [ -f "$LOG" ]; then
  tail -n 10 "$LOG" >&2 || true
fi
exit 1

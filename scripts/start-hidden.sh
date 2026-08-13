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
nohup "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 &

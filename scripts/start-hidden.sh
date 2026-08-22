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
STATE_DIR="${MODELDOCK_STATE_DIR:-$HOME/.modeldock}"
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
# A correctly running gateway without a provider deliberately reports 503 from
# /healthz, so use the shared status/owner verifier rather than treating that
# normal setup state as down. It also prevents a second hidden launch from
# masking a foreign listener as our gateway.
if "$NODE_BIN" "$SERVER" --verify-gateway --root "$ROOT" --port "$PORT" --state-dir "$STATE_DIR" --timeout-ms 500 >/dev/null 2>&1; then
  exit 0
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
  STARTED_AFTER_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
  setsid "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 < /dev/null &
else
  STARTED_AFTER_MS="$("$NODE_BIN" -e 'process.stdout.write(String(Date.now()))')"
  nohup "$NODE_BIN" "$SERVER" >>"$LOG" 2>&1 &
fi
if ! "$NODE_BIN" "$SERVER" --verify-gateway \
  --root "$ROOT" --port "$PORT" --state-dir "$STATE_DIR" \
  --started-after-ms "$STARTED_AFTER_MS" --timeout-ms 15000; then
  echo "ERROR: Gateway did not verify after hidden start. Check $LOG." >&2
  exit 1
fi

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

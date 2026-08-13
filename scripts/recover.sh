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

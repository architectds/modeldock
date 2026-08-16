import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function embeddedRecover(installText) {
  const marker = 'cat > "$RECOVER" <<\'EOF\'';
  const start = installText.indexOf(marker);
  assert.ok(start >= 0, "install.sh should embed a recover.sh");
  const bodyStart = installText.indexOf("\n", start) + 1;
  const bodyEnd = installText.indexOf("\nEOF", start);
  return installText.slice(bodyStart, bodyEnd);
}

test("recover.sh ships a start-at-login repair in both copies", () => {
  const repo = readFileSync(new URL("../scripts/recover.sh", import.meta.url), "utf8");
  const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
  const copies = [repo, embeddedRecover(install)];
  for (const text of copies) {
    assert.match(text, /repair_autostart\(\)/, "recover should carry the autostart repair");
    assert.match(text, /3\. Repair start-at-login/, "menu should expose the repair option");
    assert.match(text, /PLISTEOF/, "the regenerated plist should use a nested heredoc marker");
    assert.match(text, /MODELDOCK_FAKE_DARWIN/, "the test hook should stay for cross-platform coverage");
  }
});

test("recovery restores a complete version snapshot through the canonical restart", () => {
  const posix = readFileSync(new URL("../scripts/recover.sh", import.meta.url), "utf8");
  const windows = readFileSync(new URL("../scripts/recover.ps1", import.meta.url), "utf8");
  assert.match(posix, /\.modeldock-rollback\/current/);
  assert.match(posix, /manifest\.json/);
  assert.match(posix, /scripts\/restart\.sh/);
  assert.doesNotMatch(posix, /modeldock\.mjs\.prev/);
  assert.match(windows, /\.modeldock-rollback/);
  assert.match(windows, /manifest\.json/);
  assert.match(windows, /restored the complete previous version set/);
  assert.doesNotMatch(windows, /modeldock\.mjs\.prev/);
});

test("restart.sh cascades listener discovery and refuses an unidentified healthy port", () => {
  const restart = readFileSync(new URL("../scripts/restart.sh", import.meta.url), "utf8");
  assert.match(restart, /if command -v lsof[\s\S]*if command -v ss[\s\S]*if command -v fuser/);
  assert.doesNotMatch(restart, /elif command -v ss/);
  assert.match(restart, /refusing a fake restart/);
  assert.match(restart, /started gateway from \$ROOT using \$SERVER/);
  assert.doesNotMatch(restart, /did not become healthy/, "restart.sh no longer polls healthz after launch");
});

test("install.sh warns loudly when the login agent cannot be loaded", () => {
  const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
  assert.match(install, /ERROR: could not enable start at login/, "load failure must not be silent");
  assert.match(install, /Repair start-at-login/, "the error should point at the recovery repair");
});

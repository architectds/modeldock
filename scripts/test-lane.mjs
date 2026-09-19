// Test lanes: one rule table, four selectors, so "what gates a release" has a single
// owner instead of a hand-maintained file list per workflow (which drifts the moment
// someone adds or renames a test file).
//
//   node scripts/test-lane.mjs --all        everything (what `npm test` runs)
//   node scripts/test-lane.mjs --ci         everything the release gate blocks on
//   node scripts/test-lane.mjs --browser    the browser render leg only (advisory)
//   node scripts/test-lane.mjs --fast       the no-elevated-rights lane (local iteration)
//   node scripts/test-lane.mjs --preflight  the shared setup steps, then stop
//
// The preflight is the same four steps every lane needs, so `npm test` (through its
// `pretest` hook) and each narrower lane cannot drift into checking different things:
// sandbox cleanup, installer-copy drift, internal-doc drift, then the bundle build.
//
// The exclusions describe what a test *needs*, not how valuable it is:
//
//   BROWSER  drives a real Chrome over CDP. Slow, and a runner can fail it with no
//            product defect (v0.3.85: Chrome alive, no page target for 30s, release
//            blocked). Out of the blocking step until it clears a release cleanly.
//   LIVE     spawns the installed `codex` CLI. It self-skips where Codex is absent, so
//            CI has never run it, and an agent sandbox fails it on out-of-root reads.
//            This is the only real-client proof in the repo, which is exactly why a
//            sandbox artifact must not be reported through it as a product failure.
//   HOST     writes HKCU, drives restart.ps1 / recover.sh, or reaches GitHub. Needs a
//            real machine, or one of the dedicated install jobs.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(repoRoot, "test");

const BROWSER = ["dashboard-tabs.test.mjs"];
const LIVE = [
  "codex-chat-reasoning-client.test.mjs",
  "codex-native-search-client.test.mjs",
  "codex-preview-client.test.mjs",
  "codex-subagent-client.test.mjs",
  "codex-vision-client.test.mjs",
];
const HOST = [
  "autostart-lifecycle.test.mjs",
  "install-macos-sim.test.mjs",
  "install-mock.test.mjs",
  "recover-autostart.test.mjs",
  "restart-ps1.test.mjs",
  "restart-sh.test.mjs",
  "verify-release-install.test.mjs",
];

const PREFLIGHT = [
  ["scripts/cleanup-sandbox.mjs"],
  ["scripts/sync-installer-helpers.mjs", "--check"],
  ["scripts/check-internal-docs.mjs"],
  ["scripts/build-if-stale.mjs"],
];

function runNode(args, label) {
  const step = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  if (step.status !== 0) {
    console.error(`test-lane: ${label} failed (exit ${step.status ?? "signal"})`);
    process.exit(step.status ?? 1);
  }
}

const selector = process.argv[2] || "--all";
if (!["--all", "--ci", "--browser", "--fast", "--preflight"].includes(selector)) {
  console.error(`unknown lane ${selector} (expected --all, --ci, --browser, --fast or --preflight)`);
  process.exit(2);
}

if (selector === "--preflight") {
  for (const [script, ...rest] of PREFLIGHT) {
    runNode([path.join(repoRoot, script), ...rest], `preflight ${script}`);
  }
  process.exit(0);
}

// A renamed or deleted file leaves its rule inert, and for BROWSER that would quietly
// remove the render check from CI altogether: the name would match nothing, the
// advisory step would pass, and nobody would notice the leg had vanished.
const missing = [...BROWSER, ...LIVE, ...HOST].filter((name) => !existsSync(path.join(testDir, name)));
if (missing.length) {
  console.error(`test-lane: rule table names files that no longer exist: ${missing.join(", ")} - delete the entry`);
  process.exit(1);
}

const present = readdirSync(testDir).filter((name) => name.endsWith(".test.mjs")).sort();
const files = present.filter((name) => {
  if (selector === "--browser") return BROWSER.includes(name);
  if (selector === "--ci") return !BROWSER.includes(name);
  if (selector === "--fast") return !BROWSER.includes(name) && !LIVE.includes(name) && !HOST.includes(name);
  return true;
});

// A lane must never run against a stale bundle, so it takes the identical preflight.
for (const [script, ...rest] of PREFLIGHT) {
  runNode([path.join(repoRoot, script), ...rest], `pretest ${script}`);
}

console.log(`# test-lane ${selector}: ${files.length}/${present.length} file(s)`);
const run = spawnSync(process.execPath, [
  // Must be a file:// URL: `--import` with a bare Windows absolute path throws
  // ERR_UNSUPPORTED_ESM_URL_SCHEME, and it throws per file, which reads as every test
  // in the lane failing at once.
  "--import", pathToFileURL(path.join(testDir, "preload-env.mjs")).href,
  "--test", "--test-concurrency=1", "--test-reporter=tap",
  ...files.map((name) => path.join("test", name)),
], { cwd: repoRoot, stdio: "inherit" });
process.exit(run.status ?? 1);

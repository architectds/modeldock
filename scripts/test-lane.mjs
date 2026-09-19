// Test lanes: one rule table, four selectors, so "what gates a release" has a single
// owner instead of a hand-maintained file list per workflow (which drifts the moment
// someone adds or renames a test file).
//
//   node scripts/test-lane.mjs --all        everything, the way `npm test` runs it
//   node scripts/test-lane.mjs --fast       no elevated rights: the release gate
//   node scripts/test-lane.mjs --host       the rights/OS lane (launchers, installers)
//   node scripts/test-lane.mjs --live       the real installed-Codex lane
//   node scripts/test-lane.mjs --browser    the Chrome render leg
//   node scripts/test-lane.mjs --preflight  the shared setup steps, then stop
//   node scripts/test-lane.mjs --list LANE  print a lane's files and stop
//
// `--fast` is what a release blocks on, and it is deliberately the same command a
// developer or an agent runs before pushing: one gate, run it locally, get the same
// answer. The other lanes are not less important, they are *conditional* - they need a
// real machine, an installed Codex, or a browser - so they are separate steps that can
// each say why they failed instead of coloring the gate.
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
  // After the build, because it measures the artifact the lanes are about to run.
  // The package is the one product surface that only ever grows by accident.
  ["scripts/check-bundle-budget.mjs"],
];

function runNode(args, label) {
  const step = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: "inherit" });
  if (step.status !== 0) {
    console.error(`test-lane: ${label} failed (exit ${step.status ?? "signal"})`);
    process.exit(step.status ?? 1);
  }
}

const LANES = ["--all", "--fast", "--host", "--live", "--browser", "--preflight", "--list"];
const selector = process.argv[2] || "--all";
if (!LANES.includes(selector)) {
  console.error(`unknown lane ${selector} (expected one of: ${LANES.join(", ")})`);
  process.exit(2);
}
// `--list LANE` reports what a lane would run without running it, so the tables can be
// inspected from a workflow or a review without paying for the suite. The extra argument
// is only a lane name for --list: every other selector takes none, and validating them as
// if it did made `--preflight` reject itself, which broke `npm test` through its own
// pretest hook. Only --list's argument is checked, and --list itself is not a runnable lane.
let lane = selector;
if (selector === "--list") {
  lane = process.argv[3] || "--all";
  if (!LANES.includes(lane) || lane === "--list" || lane === "--preflight") {
    console.error(`test-lane --list: unknown lane ${lane}`);
    process.exit(2);
  }
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
// The three conditional lanes plus --fast must be a partition: a file in two tables would
// run twice in one CI job, and --fast (defined as the complement) would still hide it.
const lanes = [...BROWSER, ...LIVE, ...HOST];
const doubled = lanes.filter((name, index) => lanes.indexOf(name) !== index);
if (doubled.length) {
  console.error(`test-lane: files sit in two lanes at once: ${[...new Set(doubled)].join(", ")}`);
  process.exit(1);
}

const present = readdirSync(testDir).filter((name) => name.endsWith(".test.mjs")).sort();
const files = present.filter((name) => {
  switch (lane) {
    case "--browser": return BROWSER.includes(name);
    case "--host": return HOST.includes(name);
    case "--live": return LIVE.includes(name);
    // --fast is everything that needs nothing but the checkout and a loopback port, so it
    // is the complement of the three conditional lanes rather than its own list.
    case "--fast": return !BROWSER.includes(name) && !LIVE.includes(name) && !HOST.includes(name);
    default: return true;
  }
});

if (selector === "--list") {
  for (const name of files) console.log(path.join("test", name));
  process.exit(0);
}

// Every lane takes the identical preflight, and must never run against a stale bundle.
for (const [script, ...rest] of PREFLIGHT) {
  runNode([path.join(repoRoot, script), ...rest], `pretest ${script}`);
}

console.log(`# test-lane ${lane}: ${files.length}/${present.length} file(s)`);
const run = spawnSync(process.execPath, [
  // Must be a file:// URL: `--import` with a bare Windows absolute path throws
  // ERR_UNSUPPORTED_ESM_URL_SCHEME, and it throws per file, which reads as every test
  // in the lane failing at once.
  "--import", pathToFileURL(path.join(testDir, "preload-env.mjs")).href,
  "--test", "--test-concurrency=1", "--test-reporter=tap",
  ...files.map((name) => path.join("test", name)),
], { cwd: repoRoot, stdio: "inherit" });
process.exit(run.status ?? 1);

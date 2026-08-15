import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = readFileSync(path.join(repoRoot, "scripts", "build-if-stale.mjs"), "utf8");

const MINUTE_MS = 60_000;
const OLD_MS = Date.now() - MINUTE_MS;
const NOW_MS = Date.now();

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-build-if-stale-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  mkdirSync(path.join(root, "src"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "build-if-stale.mjs"), helper, "utf8");
  return root;
}

// A fake build: writes a marker when invoked (and can fail on demand). The real
// build-if-stale spawns `node scripts/build.mjs` with cwd = the temp root, so a
// fake build.mjs next to it proves whether a rebuild was triggered.
function writeFakeBuild(root, { fail = false } = {}) {
  writeFileSync(
    path.join(root, "scripts", "build.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(new URL("../built.txt", import.meta.url), "built\\n");
process.exit(${fail ? 7 : 0});
`,
    "utf8",
  );
}

function runHelper(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts", "build-if-stale.mjs")], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

test("build-if-stale is a no-op in an installed layout (no src/)", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-build-if-stale-"));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "scripts", "build-if-stale.mjs"), helper, "utf8");
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "process.exit(0);\n", "utf8");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { code, err } = await runHelper(root);
  assert.equal(code, 0, err);
  assert.doesNotMatch(err, /rebuild/i, "no source checkout must never try to build");
});

test("build-if-stale skips the rebuild when the bundle is newer than the source", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFakeBuild(root);
  writeFileSync(path.join(root, "src", "server.mjs"), "export const x = 1;\n", "utf8");
  utimesSync(path.join(root, "src", "server.mjs"), OLD_MS / 1000, OLD_MS / 1000);
  utimesSync(path.join(root, "scripts", "build-if-stale.mjs"), OLD_MS / 1000, OLD_MS / 1000);
  utimesSync(path.join(root, "scripts", "build.mjs"), OLD_MS / 1000, OLD_MS / 1000);
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "process.exit(0);\n", "utf8");
  utimesSync(path.join(root, "dist", "modeldock.mjs"), NOW_MS / 1000, NOW_MS / 1000);

  const { code, err } = await runHelper(root);
  assert.equal(code, 0, err);
  assert.equal(existsSync(path.join(root, "built.txt")), false, "a fresh bundle must not be rebuilt");
  // A self-updated bundle (dist newer than src) is authoritative - never clobbered.
  assert.equal(readFileSync(path.join(root, "dist", "modeldock.mjs"), "utf8"), "process.exit(0);\n");
});

test("build-if-stale rebuilds when the source checkout is newer than the bundle", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFakeBuild(root);
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "process.exit(0);\n", "utf8");
  utimesSync(path.join(root, "dist", "modeldock.mjs"), OLD_MS / 1000, OLD_MS / 1000);
  writeFileSync(path.join(root, "src", "server.mjs"), "export const x = 1;\n", "utf8");
  utimesSync(path.join(root, "src", "server.mjs"), NOW_MS / 1000, NOW_MS / 1000);

  const { code, err } = await runHelper(root);
  assert.equal(code, 0, err);
  assert.equal(existsSync(path.join(root, "built.txt")), true, "a stale bundle must be rebuilt before launch");
  assert.match(err, /rebuild/i);
});

test("build-if-stale exits non-zero and does not launch when the rebuild fails", async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFakeBuild(root, { fail: true });
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "process.exit(0);\n", "utf8");
  utimesSync(path.join(root, "dist", "modeldock.mjs"), OLD_MS / 1000, OLD_MS / 1000);
  writeFileSync(path.join(root, "src", "server.mjs"), "export const x = 1;\n", "utf8");
  utimesSync(path.join(root, "src", "server.mjs"), NOW_MS / 1000, NOW_MS / 1000);

  const { code, err } = await runHelper(root);
  assert.notEqual(code, 0);
  assert.match(err, /failed/i);
});

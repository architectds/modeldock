// Build the release bundle (dist/modeldock.mjs) only when a source checkout
// has drifted ahead of it, so a launched gateway is always the artifact users
// install - never the src/ entry a user does not have.
//
// Why "if stale" and not "always build":
// - Installed layouts have no src/ at all: dist/ is authoritative there and
//   the self-updater maintains it, so nothing must ever be built.
// - A self-updated bundle (dist newer than src) is never rebuilt: once an
//   update is applied, src is not the source of truth for that layout.
// - In a git checkout, editing src makes it newer than the bundle, so the next
//   launch rebuilds and the local gateway again matches the release artifact.
//
// Usage: node scripts/build-if-stale.mjs
// Exit 0 when the bundle is fresh (or there is nothing to build); non-zero when
// a build was needed and failed, so callers can surface the divergence loudly
// instead of silently serving a stale bundle or an unshipped src entry.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist", "modeldock.mjs");
const sourceEntry = path.join(root, "src", "server.mjs");

// The bundle is produced by scripts/build.mjs and inlines public/ and assets/,
// so all of these are its inputs. package.json pins the esbuild version.
const INPUT_ROOTS = ["src", "public", "assets", "scripts"];
const EXTRA_INPUTS = ["package.json"];

function newestMtime(...paths) {
  let newest = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      }
    }
  };
  for (const candidate of paths) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isDirectory()) {
      walk(candidate);
    } else {
      const mtime = statSync(candidate).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  }
  return newest;
}

// Installed layout: the updater owns dist/ and there is no source to build.
if (!existsSync(sourceEntry)) {
  process.exit(0);
}

const sourceNewest = newestMtime(...INPUT_ROOTS, ...EXTRA_INPUTS);
const bundleMtime = existsSync(bundle) ? statSync(bundle).mtimeMs : 0;
if (sourceNewest <= bundleMtime) {
  process.exit(0);
}

console.error(
  "build-if-stale: src/ is newer than dist/modeldock.mjs; rebuilding so the gateway serves the release artifact.",
);
const result = spawnSync(process.execPath, [path.join(root, "scripts", "build.mjs")], {
  cwd: root,
  stdio: "inherit",
  encoding: "utf8",
});
if (result.status !== 0) {
  console.error(
    `build-if-stale: rebuild failed (exit ${result.status ?? "unknown"}); the gateway would serve a stale bundle.`,
  );
  process.exit(result.status ?? 1);
}
process.exit(0);

// Delete stale ModelDock sandbox entries. "Stale" means older than
// MODELDOCK_SANDBOX_MAX_AGE_DAYS (default 1). Cleans the configured sandbox
// root plus any modeldock-* leftovers in the OS temp dir. The gateway log dir
// (os.tmpdir()/modeldock) is never touched; in-use files are skipped, not fatal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const maxAgeDays = Number(process.env.MODELDOCK_SANDBOX_MAX_AGE_DAYS) || 1;
const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
const now = Date.now();

function cleanRoot(root, { prefix = "modeldock-", exclude = new Set(["modeldock"]) } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { removed: 0, skipped: 0 };
  }
  let removed = 0;
  let skipped = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || exclude.has(name)) continue;
    const full = path.join(root, name);
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { removed, skipped };
}

const roots = [];
if (process.env.MODELDOCK_SANDBOX_DIR) roots.push(process.env.MODELDOCK_SANDBOX_DIR);
roots.push(os.tmpdir());

let totalRemoved = 0;
let totalSkipped = 0;
for (const root of roots) {
  const { removed, skipped } = cleanRoot(root);
  totalRemoved += removed;
  totalSkipped += skipped;
  console.log(`cleanup-sandbox root=${root} removed=${removed} skipped=${skipped} maxAgeDays=${maxAgeDays}`);
}
console.log(`cleanup-sandbox total removed=${totalRemoved} skipped=${totalSkipped}`);

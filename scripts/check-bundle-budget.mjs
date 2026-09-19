// Size ratchet: dist/modeldock.mjs is the file every user downloads and the gateway
// keeps resident, so a jump in it is a product change, not a build detail. It grew to
// 2.9 MB quietly: 760 KB of it was two inlined images nothing requested (build.mjs now
// refuses those), and most of the rest is three dependency subtrees.
//
// Lower the ceiling when you shrink something; raise it only with a reason you can say
// out loud. Attribution: `node scripts/bundle-report.mjs` prints the per-input breakdown.
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BUDGETS = [
  // Today's bundle is 2,272,785. The headroom is deliberate: enough that a normal
  // dependency refresh does not trip it, small enough that re-inlining something the
  // size of dashboard.png (400 KB) still fails the gate rather than scrolling past.
  { file: "dist/modeldock.mjs", maxBytes: 2_400_000 },
  // The stdio bridge runs once per Codex session, so its cost is memory per agent, not
  // per user. Same rule, roomier number: it shares profiles.mjs and the MCP SDK with
  // the gateway and has no dashboard to inline.
  { file: "dist/mcp-standalone.mjs", maxBytes: 900_000 },
];

let failed = false;
for (const { file, maxBytes } of BUDGETS) {
  const full = path.join(root, file);
  let size;
  try {
    size = statSync(full).size;
  } catch {
    console.error(`bundle-budget: ${file} is missing (run npm run build)`);
    failed = true;
    continue;
  }
  const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
  if (size > maxBytes) {
    console.error(`bundle-budget: ${file} is ${mb(size)}, ceiling ${mb(maxBytes)}.`);
    console.error("  Name the new bytes before raising the ceiling: node scripts/bundle-report.mjs");
    failed = true;
    continue;
  }
  console.log(`bundle-budget: ${file} ${mb(size)} / ${mb(maxBytes)}`);
}
process.exit(failed ? 1 : 0);

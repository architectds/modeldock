// Guard: internal-only docs must never be tracked by git.
//
// architecture.md (and any future internal doc) carries private strategy and
// business-model decisions. .gitignore lists them, but an ignore entry is
// silently lost if someone force-adds the file or restructures the ignore
// rules. This script fails the build when any of them shows up in `git ls-files`.
// Wired into `pretest` so a local test run and CI both catch it.

import { execFileSync } from "node:child_process";

const INTERNAL_DOCS = ["AGENTS.md", "architecture.md"];

try {
  const out = execFileSync("git", ["ls-files", "--", ...INTERNAL_DOCS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tracked = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (tracked.length) {
    console.error(
      `FAIL: internal-only docs are tracked by git: ${tracked.join(", ")}`,
    );
    console.error(
      "Remove them from the index and keep them ignored: git rm --cached <file>",
    );
    process.exit(1);
  }
  console.log(`ok: internal docs not tracked (${INTERNAL_DOCS.join(", ")})`);
} catch (error) {
  console.error("FAIL: could not verify internal-doc tracking state:", error.message);
  process.exit(1);
}

// Keep the single-file installers' embedded helper scripts byte-equivalent to
// the standalone release assets. Run without arguments to update the installers,
// or with --check in CI to fail when a helper changed without being re-embedded.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function normalized(source, newline) {
  return String(source).replace(/\r\n/g, "\n").replace(/\n$/, "").replace(/\n/g, newline);
}

function lineEndAt(source, index) {
  const end = source.indexOf("\n", index);
  if (end < 0) throw new Error("unterminated installer marker");
  return end + 1;
}

function replacePowerShellBlock(installer, variable, helper) {
  const assignment = installer.indexOf(`$${variable} =`);
  if (assignment < 0) throw new Error(`install.ps1 is missing $${variable}`);
  const opener = installer.indexOf("@'", assignment);
  const contentStart = lineEndAt(installer, opener);
  const newline = installer.slice(contentStart - 2, contentStart) === "\r\n" ? "\r\n" : "\n";
  const closer = `${newline}'@ | Out-File -FilePath $${variable}`;
  const contentEnd = installer.indexOf(closer, contentStart);
  if (contentEnd < 0) throw new Error(`install.ps1 cannot find the $${variable} heredoc end`);
  return `${installer.slice(0, contentStart)}${normalized(helper, newline)}${installer.slice(contentEnd)}`;
}

function replaceShellBlock(installer, variable, helper) {
  const assignment = installer.indexOf(`${variable}=`);
  if (assignment < 0) throw new Error(`install.sh is missing ${variable}`);
  const opener = installer.indexOf("<<'EOF'", assignment);
  const contentStart = lineEndAt(installer, opener);
  const newline = installer.slice(contentStart - 2, contentStart) === "\r\n" ? "\r\n" : "\n";
  const contentEnd = installer.indexOf(`${newline}EOF`, contentStart);
  if (contentEnd < 0) throw new Error(`install.sh cannot find the ${variable} heredoc end`);
  return `${installer.slice(0, contentStart)}${normalized(helper, newline)}${installer.slice(contentEnd)}`;
}

function helper(name) {
  return readFileSync(path.join(repoRoot, "scripts", name), "utf8");
}

const files = [
  {
    name: "install.ps1",
    sync(source) {
      let result = source;
      for (const [variable, name] of [["launcher", "start-hidden.ps1"], ["restart", "restart.ps1"], ["recover", "recover.ps1"]]) {
        result = replacePowerShellBlock(result, variable, helper(name));
      }
      return result;
    },
  },
  {
    name: "install.sh",
    sync(source) {
      let result = source;
      for (const [variable, name] of [
        ["LAUNCHER", "start-hidden.sh"],
        ["RESTART", "restart.ps1"],
        ["RESTART_SH", "restart.sh"],
        ["RECOVER", "recover.sh"],
        ["MCP_CALL_SH", "mcp-call.sh"],
        ["MCP_CALL_MJS", "mcp-call.mjs"],
      ]) {
        result = replaceShellBlock(result, variable, helper(name));
      }
      return result;
    },
  },
];

const check = process.argv.includes("--check");
const drift = [];
for (const file of files) {
  const target = path.join(repoRoot, "scripts", file.name);
  const current = readFileSync(target, "utf8");
  const next = file.sync(current);
  if (next === current) continue;
  drift.push(file.name);
  if (!check) writeFileSync(target, next, "utf8");
}

if (drift.length) {
  if (check) {
    console.error(`installer helper drift: ${drift.join(", ")}; run node scripts/sync-installer-helpers.mjs`);
    process.exitCode = 1;
  } else {
    console.log(`synchronized installer helpers: ${drift.join(", ")}`);
  }
} else {
  console.log("installer helper copies are synchronized");
}

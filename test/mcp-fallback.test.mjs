// The documented answer to a stale MCP connection is "run the CLI instead", so
// every tool the gateway registers has to be reachable that way. learn was not,
// and nothing would have said so: the gap is between two files that no test
// compared.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

// The CLI names a command per tool; this is the only place the two vocabularies
// meet, so it is written down rather than inferred.
const COMMAND_FOR_TOOL = {
  web_search_exa: "search",
  vision_inspect: "vision",
  image_gen: "image",
  speak: "speak",
  hear: "hear",
  recall_memory: "recall",
  store_memory: "store",
  learn: "learn",
};

function registeredTools() {
  return [...read("src/mcp.mjs").matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
}

function cliCommands() {
  const usage = read("scripts/mcp-call.mjs").match(/usage: node scripts\/mcp-call\.mjs <([^>]+)>/);
  assert.ok(usage, "mcp-call.mjs no longer prints a usage line to read commands from");
  return new Set(usage[1].split("|"));
}

test("every registered MCP tool can be reached from the shell", () => {
  const commands = cliCommands();
  const unreachable = registeredTools().filter((tool) => {
    const command = COMMAND_FOR_TOOL[tool];
    return !command || !commands.has(command);
  });
  assert.deepEqual(
    unreachable,
    [],
    "these tools have no CLI fallback - a stale MCP connection makes them unusable, "
    + "which is exactly what the fallback exists to prevent",
  );
});

test("the CLI does not offer commands for tools that no longer exist", () => {
  const tools = new Set(registeredTools());
  const reserved = new Set(["tools", "list_mcp_tools"]);
  const orphans = [...cliCommands()].filter((command) => {
    if (reserved.has(command)) return false;
    return !Object.entries(COMMAND_FOR_TOOL).some(([tool, c]) => c === command && tools.has(tool));
  });
  assert.deepEqual(orphans, [], "the CLI advertises commands the gateway cannot serve");
});

test("the base instructions point at commands the CLI actually has", () => {
  // The instructions are what the model reads when a tool call fails. Naming a
  // command that does not exist turns one broken tool into two.
  const instructions = read("src/catalog.mjs");
  const commands = cliCommands();
  const named = [...instructions.matchAll(/`([a-z_]+)[ `<]/g)]
    .map((m) => m[1])
    .filter((name) => commands.has(name) || Object.values(COMMAND_FOR_TOOL).includes(name));
  assert.ok(named.length > 0, "the instructions no longer name any CLI command");
  const missing = [...new Set(named)].filter((name) => !commands.has(name));
  assert.deepEqual(missing, [], "the instructions name commands mcp-call.mjs does not support");
});

test("the installer ships the same CLI the repo tests", () => {
  // install.sh embeds a copy; a fix that lands in one and not the other reaches
  // nobody who installed rather than cloned.
  const cli = read("scripts/mcp-call.mjs");
  const embedded = read("scripts/install.sh");
  for (const command of cliCommands()) {
    if (command === "tools") continue;
    assert.ok(
      embedded.includes(`command === "${command}"`) || embedded.includes(command),
      `install.sh is missing the ${command} command`,
    );
  }
  assert.ok(cli.includes('command === "learn"'), "learn is the command this test was written for");
});

// Off has to give Codex back a machine it can start on.
//
// Restoring config.toml was treated as the whole of "Off", so the audit that
// checked config.toml called it clean - and it is, byte for byte. The failure
// was next to it: the dashboard writes <codexHome>/agents/modeldock-subagent.toml,
// Codex reads that directory at startup, and nothing ever removed the file. It
// pins model_provider = "openai" to a ModelDock-published slug, so once the
// managed openai_base_url is gone that provider resolves to the real OpenAI
// backend, where the slug does not exist, and Codex fails to start. Switching
// ModelDock off left the app broken.
//
// The check that finds this is not a code review, it is a diff: enable, disable,
// and list every file that appeared and stayed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexConfigSwitcher, SUBAGENT_AGENT_FILE, buildManagedCodexConfig } from "../src/config-switcher.mjs";

const ORIGINAL = `model = "gpt-5.6-sol"
approval_policy = "on-request"

[projects.'d:\\work']
trust_level = "trusted"

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
`;

function sandbox(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-off-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(path.join(home, "config.toml"), ORIGINAL, "utf8");
  return home;
}

function files(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, base, out);
    else out.push(path.relative(base, full).replaceAll("\\", "/"));
  }
  return out.sort();
}

function switcher(home, publishedModels = null) {
  return new CodexConfigSwitcher({
    codexHome: home,
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    model: "deepseek-v4-flash@opencode-go",
    publishedModels,
    catalogFile: path.join(home, "catalog.json"),
    mcpUrl: "http://127.0.0.1:4097/c/KEY/mcp",
  });
}

// The dashboard, not the switcher, writes this file - reproduce it exactly so the
// test covers the state a real user is in when they switch off.
function writeSubagentFile(home, model = "gpt-5.6-luna") {
  mkdirSync(path.join(home, "agents"), { recursive: true });
  writeFileSync(
    path.join(home, "agents", SUBAGENT_AGENT_FILE),
    `# Managed by ModelDock.\nname = "modeldock_subagent"\nmodel_provider = "openai"\nmodel = "${model}"\n`,
    "utf8",
  );
}

test("Off leaves behind nothing Codex reads at startup", async (t) => {
  const home = sandbox(t);
  const before = files(home);
  const s = switcher(home);

  await s.enable();
  writeSubagentFile(home);
  const added = files(home).filter((f) => !before.includes(f));
  assert.ok(added.includes(`agents/${SUBAGENT_AGENT_FILE}`), "the fixture reproduces the agent file enable leaves in place");

  await s.disable();
  const left = files(home).filter((f) => !before.includes(f));

  assert.ok(
    !left.includes(`agents/${SUBAGENT_AGENT_FILE}`),
    `the subagent agent file survived Off, which is what breaks Codex startup: ${left.join(", ")}`,
  );
  // Recovery material is meant to survive; anything Codex itself loads is not.
  for (const file of left) {
    assert.ok(
      file.startsWith("modeldock/") || file.startsWith("config.toml.modeldock-backup-"),
      `Off left ${file}, which is neither the backup nor switcher state`,
    );
  }
});

test("Off restores config.toml byte for byte", async (t) => {
  const home = sandbox(t);
  const s = switcher(home);
  await s.enable();
  await s.disable();
  assert.equal(readFileSync(path.join(home, "config.toml"), "utf8"), ORIGINAL);
});

test("Off is safe to run twice and without an agent file", async (t) => {
  const home = sandbox(t);
  const s = switcher(home);
  await s.enable();
  await s.disable();
  await s.disable();
  assert.ok(existsSync(path.join(home, "config.toml")), "the config survives a second disable");
});

test("enabling keeps the user's model when this route can still serve it", () => {
  // Enabling means "route Codex through the gate", not "pick Codex's model".
  // Overwriting the selection on every enable is how a connected local endpoint
  // silently became the default - and a local model then triggers the
  // small-context tool whitelist, cutting Codex from ~150 tools to 23.
  const managed = buildManagedCodexConfig(ORIGINAL, {
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    model: "deepseek-v4-flash@opencode-go",
    publishedModels: ["gpt-5.6-sol", "deepseek-v4-flash@opencode-go"],
  });
  assert.match(managed, /^model = "gpt-5.6-sol"$/m, "the user's choice survives enable");
});

test("enabling moves the model when the route cannot serve the old one", () => {
  // The half that cannot be skipped: enable also swaps in the published catalog.
  // A DeepSeek-only user logged out of ChatGPT has gpt-5.6-sol in their config
  // and no native model published, so leaving the selection alone would point
  // Codex at a model that no longer exists.
  const managed = buildManagedCodexConfig(ORIGINAL, {
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    model: "deepseek-v4-flash@opencode-go",
    publishedModels: ["deepseek-v4-flash@opencode-go"],
  });
  assert.match(managed, /^model = "deepseek-v4-flash@opencode-go"$/m);
});

test("an unknown published list keeps the old overwrite rather than guessing", () => {
  const managed = buildManagedCodexConfig(ORIGINAL, {
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    model: "deepseek-v4-flash@opencode-go",
  });
  assert.match(managed, /^model = "deepseek-v4-flash@opencode-go"$/m);
});

test("connecting a custom endpoint publishes a model without becoming the default", async (t) => {
  // MODELDOCK_CUSTOM_MAIN persists in .env, so ticking "as main" once made a
  // local 27B the default across every later restart - for sessions that never
  // asked for it. A local model then trips the small-context tool whitelist,
  // which strips Codex from ~150 tools to 23. Connecting publishes a model; it
  // does not select one. MODELDOCK_MAIN_MODEL stays the way to set a default.
  const envFile = path.join(mkdtempSync(path.join(os.tmpdir(), "modeldock-env-")), ".env");
  writeFileSync(envFile, "", "utf8");
  t.after(() => rmSync(path.dirname(envFile), { recursive: true, force: true }));

  const saved = {};
  const set = (key, value) => {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  set("MODELDOCK_ENV_FILE", envFile);
  set("MODELDOCK_MAIN_MODEL", undefined);
  set("MODELDOCK_CUSTOM_MAIN", "1");
  set("MODELDOCK_CUSTOM_MODEL", "qwen3.8:27b");
  set("MODELDOCK_CUSTOM_BASE_URL", "http://127.0.0.1:11435/v1");

  const { loadConfig } = await import("../src/config.mjs");
  const config = loadConfig();
  assert.notEqual(config.mainModel, "qwen3.8:27b@custom", "a connected custom endpoint must not take the main slot");
  assert.equal(config.mainModel, "deepseek-v4-flash@opencode-go");
  assert.equal(config.customModel, "qwen3.8:27b", "the model is still published for the picker");
});

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
import { CodexConfigSwitcher, buildManagedCodexConfig } from "../src/config-switcher.mjs";
import {
  SUBAGENT_AGENT_FILE,
  readSubagentModel,
  writeSubagentAgentFile,
} from "../src/subagent-config.mjs";

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

function switcher(home, nativeModels = []) {
  return new CodexConfigSwitcher({
    codexHome: home,
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    model: "deepseek-v4-flash@opencode-go",
    nativeModels,
    catalogFile: path.join(home, "catalog.json"),
    mcpUrl: "http://127.0.0.1:4097/c/KEY/mcp",
  });
}

// The Sub Agent pick, and the state that forces enable() to rewrite the managed
// config through disable(). Two facts make this the ordinary upgrade path rather
// than an edge case: the pick has exactly one home (the agent file), and the
// Codex App picker leaves a routed slug in the top-level model, which ModelDock
// must repair. The repair used to delete the pick and never put it back, so every
// upgrade silently reset the panel to the built-in default.
const PICK = "gpt-5.6-luna";

function routeTopLevelModel(home) {
  const configPath = path.join(home, "config.toml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(/^model = .*$/m, 'model = "qwen3.8-flash@opencode-go"'),
    "utf8",
  );
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

test("an upgrade-shaped re-enable keeps the Sub Agent pick", async (t) => {
  const home = sandbox(t);
  const s = switcher(home);
  await s.enable();
  writeSubagentAgentFile({ codexHome: home }, PICK);
  assert.equal(readSubagentModel({ codexHome: home }), PICK, "the writer and the reader agree on the file");

  routeTopLevelModel(home);
  const before = await s.status();
  assert.equal(before.topLevelModelNative, false, "the fixture reproduces the rewrite condition");

  const reEnabled = await s.enable();
  assert.equal(reEnabled.enabled, true, "the rewrite still lands on a managed config");
  assert.match(readFileSync(path.join(home, "config.toml"), "utf8"), /^model = "gpt-5\.6-sol"$/m,
    "the routed top-level model is repaired, not left in place");
  assert.equal(
    readSubagentModel({ codexHome: home }),
    PICK,
    "the re-enable deleted the Sub Agent pick and never restored it",
  );
});

test("a deliberate Off then On brings the pick back", async (t) => {
  const home = sandbox(t);
  const s = switcher(home);
  await s.enable();
  writeSubagentAgentFile({ codexHome: home }, PICK);

  await s.disable();
  assert.equal(readSubagentModel({ codexHome: home }), null, "Off still removes the file Codex reads");

  await s.enable();
  assert.equal(readSubagentModel({ codexHome: home }), PICK, "On restores the pick the user made");
  // Restored through the module that owns the format, so Codex gets a usable role
  // rather than whatever string would make the assertion pass.
  const body = readFileSync(path.join(home, "agents", SUBAGENT_AGENT_FILE), "utf8");
  assert.match(body, /name = "modeldock_subagent"/);
  assert.match(body, /model_provider = "openai"/);
  assert.match(body, /model_reasoning_effort = "high"/);
});

test("On invents no agent file for a user who never picked one", async (t) => {
  const home = sandbox(t);
  const s = switcher(home);
  await s.enable();

  routeTopLevelModel(home);
  await s.enable();
  assert.equal(readSubagentModel({ codexHome: home }), null, "a pick that never existed must not appear");
  assert.equal(existsSync(path.join(home, "agents", SUBAGENT_AGENT_FILE)), false);
});

test("On never overwrites a pick made while ModelDock was off", async (t) => {
  // The remembered value is recovery material for a file the switcher deleted, not
  // an owner of the pick. If the dashboard wrote a newer one in the meantime, the
  // newer choice wins, or switching on would roll the user's selection backwards.
  const home = sandbox(t);
  const s = switcher(home);
  await s.enable();
  writeSubagentAgentFile({ codexHome: home }, PICK);
  await s.disable();

  writeSubagentAgentFile({ codexHome: home }, "gpt-5.6-sol");
  await s.enable();
  assert.equal(readSubagentModel({ codexHome: home }), "gpt-5.6-sol", "the newer pick survives the restore");
});

test("the top-level model stays native so Codex can always start", () => {
  // The top-level `model` must be a slug Codex recognizes unconditionally: a
  // routed slug (deepseek-v4-flash@opencode-go) only exists in the published
  // catalog, so writing one into config.toml makes Codex startup depend on
  // ModelDock being healthy. A native model starts under every condition - the
  // gateway down, the catalog stale, or ModelDock off.
  const managed = buildManagedCodexConfig(ORIGINAL, {
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    nativeModels: ["gpt-5.6-sol"],
  });
  assert.match(managed, /^model = "gpt-5.6-sol"$/m, "the user's choice survives enable");
});

test("a non-default native model from the off state survives enable untouched", () => {
  // The source is the off-state config that Codex itself wrote. Whatever native
  // model Codex left there (gpt-5.6-luna here, not the fallback default) is
  // exactly what the managed config must keep: the top-level model follows the
  // machine, so a Codex upgrade that changes its default native model is
  // preserved instead of being overwritten by a hard-coded slug.
  const offState = 'model = "gpt-5.6-luna"\napproval_policy = "on-request"\n';
  const managed = buildManagedCodexConfig(offState, {
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    nativeModels: ["gpt-5.6-sol", "gpt-5.6-luna"],
  });
  assert.match(managed, /^model = "gpt-5.6-luna"$/m, "the off-state native model is kept, not replaced by the default");
});

test("a routed config model is rewritten to a native slug", () => {
  // A previous ModelDock build wrote a routed slug into the top-level model.
  // Enabling again must repair that, not preserve it: the routed slug lives
  // only in the published catalog, so Codex cannot start on it once the catalog
  // or gateway is gone. The managed fallback picks a known native slug instead.
  const managed = buildManagedCodexConfig(ORIGINAL, {
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
    nativeModels: ["gpt-5.6-luna", "gpt-5.6-sol"],
  });
  assert.match(managed, /^model = "gpt-5.6-sol"$/m, "prefers the stable native default when present");
});

test("a native-less install still keeps a native top-level model", () => {
  // Even with no captured native catalog, the top-level model stays a native
  // slug: Codex recognizes native GPT ids unconditionally, while a routed slug
  // exists only in the published catalog and would leave Codex unable to start
  // without it.
  const managed = buildManagedCodexConfig(ORIGINAL, {
    baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
  });
  assert.match(managed, /^model = "gpt-5.6-sol"$/m);
});

test("a non-native top-level model never survives into the managed config", () => {
  const managed = buildManagedCodexConfig(
    'model = "qwen3.8:27b@custom"\napproval_policy = "on-request"\n',
    {
      baseUrl: "http://127.0.0.1:4097/c/KEY/v1",
      nativeModels: ["gpt-5.6-sol"],
    },
  );
  assert.match(managed, /^model = "gpt-5.6-sol"$/m, "a custom/routed top-level model is replaced by native");
});

test("connecting a custom endpoint publishes a model without becoming the default", async (t) => {
  // MODELDOCK_CUSTOM_MAIN persisted in .env, so ticking "as main" once made a
  // local 27B the default across every later restart - for sessions that never
  // asked for it. A local model then trips the small-context tool whitelist,
  // which strips Codex from ~150 tools to 23. Connecting publishes a model; it
  // does not select one. The routing fallback is derived per session and
  // bootstrapped from the native default, not from a persisted env slot.
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

  // The endpoint is configured the way endpoints are configured now: an entry
  // in the list. The MODELDOCK_CUSTOM_* slot this used to set is no longer read
  // by loadConfig - it is folded into the list once at gateway startup -
  // because reading it made it a second source of endpoints that the page
  // managing endpoints could not see, and so could not remove.
  const endpointsFile = path.join(path.dirname(envFile), "custom-endpoints.json");
  const { writeCustomEndpoints } = await import("../src/custom-endpoints.mjs");
  writeCustomEndpoints(endpointsFile, [{
    modelId: "qwen3.8:27b",
    baseUrl: "http://127.0.0.1:11435/v1",
    apiKey: "",
    contextWindow: 0,
    supportsVision: false,
  }]);

  set("MODELDOCK_ENV_FILE", envFile);
  set("MODELDOCK_MAIN_MODEL", undefined);
  set("MODELDOCK_CUSTOM_ENDPOINTS_FILE", endpointsFile);

  const { loadConfig } = await import("../src/config.mjs");
  const config = loadConfig();
  assert.notEqual(config.mainModel, "qwen3.8:27b@custom", "a connected custom endpoint must not take the main slot");
  assert.equal(config.mainModel, "deepseek-v4-flash@opencode-go");
  assert.equal(config.customModel, "qwen3.8:27b", "the model is still published for the picker");
});

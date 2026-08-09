import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { buildManagedCodexConfig, CodexConfigSwitcher } from "./config-switcher.mjs";

const originalConfig = `model = "gpt-5.6-sol"
approval_policy = "on-request"

[features]
multi_agent = true

[mcp_servers.docs]
url = "https://developers.openai.com/mcp"
`;

async function fixture(t) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-config-switch-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, originalConfig, "utf8");
  return {
    codexHome,
    configPath,
    switcher: new CodexConfigSwitcher({
      codexHome,
      baseUrl: "http://127.0.0.1:4097/v1",
      mcpUrl: "http://127.0.0.1:4097/mcp",
      model: "deepseek-v4-flash",
    }),
  };
}

test("managed config keeps the built-in provider and redirects its base URL", () => {
  const managed = buildManagedCodexConfig(originalConfig, {
    baseUrl: "http://127.0.0.1:4097/c/callerkey/v1",
    model: "deepseek-v4-flash",
    catalogFile: "C:/Users/x/.modeldock/codex-model-catalog.json",
    mcpUrl: "http://127.0.0.1:4097/mcp",
  });
  assert.match(managed, /^model = "deepseek-v4-flash"/m);
  assert.match(managed, /^openai_base_url = "http:\/\/127\.0\.0\.1:4097\/c\/callerkey\/v1"$/m);
  assert.doesNotMatch(managed, /model_provider/);
  assert.doesNotMatch(managed, /^web_search\s*=/m);
  assert.doesNotMatch(managed, /model_providers\.modeldock_go/);
  assert.match(managed, /# BEGIN modeldock-managed/);
  assert.match(managed, /# END modeldock-managed/);
  assert.match(managed, /^model_catalog_json = "C:\/Users\/x\/\.modeldock\/codex-model-catalog\.json"$/m);
  assert.match(managed, /^experimental_realtime_webrtc_call_base_url = "https:\/\/chatgpt\.com\/backend-api\/codex"$/m);
  assert.match(managed, /^experimental_realtime_ws_base_url = "https:\/\/api\.openai\.com\/v1"$/m);
  assert.match(managed, /\[features\]\nmulti_agent = true/);
  assert.match(managed, /\[mcp_servers\.docs\]/);
  assert.match(managed, /\[mcp_servers\.modeldock\]\n# Managed by ModelDock: web_search_exa/);
  assert.match(managed, /url = "http:\/\/127\.0\.0\.1:4097\/mcp"/);
  // The managed keys must stay above the first table so the TOML stays valid.
  const table = managed.indexOf("[features]");
  const openaiBase = managed.indexOf("openai_base_url");
  assert.ok(openaiBase < table, "openai_base_url sits before any [table]");
});

test("managed config without mcpUrl writes no mcp_servers.modeldock section", () => {
  const managed = buildManagedCodexConfig(originalConfig, {
    baseUrl: "http://127.0.0.1:4097/v1",
    model: "deepseek-v4-flash",
  });
  assert.doesNotMatch(managed, /\[mcp_servers\.modeldock\]/);
});

test("managed config writes the stdio bridge when mcpCommand is set", () => {
  const managed = buildManagedCodexConfig(originalConfig, {
    baseUrl: "http://127.0.0.1:4097/c/callerkey/v1",
    model: "deepseek-v4-flash",
    mcpCommand: "C:/Program Files/nodejs/node.exe",
    mcpArgs: ["D:/projects/modeldock/src/mcp-standalone.mjs"],
    mcpEnv: { MODELDOCK_GATEWAY_URL: "http://127.0.0.1:4097" },
  });
  assert.match(managed, /\[mcp_servers\.modeldock\]/);
  assert.match(managed, /command = "C:\/Program Files\/nodejs\/node\.exe"/);
  assert.match(managed, /args = \["D:\/projects\/modeldock\/src\/mcp-standalone\.mjs"\]/);
  assert.match(managed, /env = \{ "MODELDOCK_GATEWAY_URL" = "http:\/\/127\.0\.0\.1:4097" \}/);
  assert.doesNotMatch(
    managed,
    /\[mcp_servers\.modeldock\][\s\S]*?^url = /m,
    "stdio mode writes command/args instead of url",
  );
});

test("managed config without catalogFile writes no model_catalog_json", () => {
  const managed = buildManagedCodexConfig(originalConfig, {
    baseUrl: "http://127.0.0.1:4097/v1",
    model: "deepseek-v4-flash",
  });
  assert.doesNotMatch(managed, /model_catalog_json/);
});

test("defaults off, backs up on enable, and restores exact config on disable", async (t) => {
  const { configPath, switcher } = await fixture(t);
  assert.equal((await switcher.status()).enabled, false);

  const enabled = await switcher.enable();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.managed, true);
  assert.equal(enabled.restartRequired, true);
  assert.equal(enabled.targetProvider, "openai");
  assert.equal(enabled.targetMode, "openai_base_url");
  assert.equal(await readFile(enabled.backupPath, "utf8"), originalConfig);
  const managed = await readFile(configPath, "utf8");
  assert.match(managed, /openai_base_url = "http:\/\/127\.0\.0\.1:4097\/v1"/);

  assert.equal((await switcher.acknowledgeRestart()).restartRequired, false);
  const disabled = await switcher.disable();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.restartRequired, true);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.doesNotMatch(await readFile(configPath, "utf8"), /mcp_servers\.modeldock/, "restore removes the ModelDock MCP section");
});

test("markOnboarded persists and survives enable/disable round trips", async (t) => {
  const { switcher } = await fixture(t);
  const fresh = await switcher.status();
  assert.equal(fresh.onboarded, false, "a brand-new switch state starts un-onboarded");
  assert.equal(fresh.onboardedAt, null);

  const marked = await switcher.markOnboarded();
  assert.equal(marked.onboarded, true, "markOnboarded sets the flag");
  assert.ok(marked.onboardedAt, "markOnboarded records a timestamp");

  await switcher.enable();
  const afterEnable = await switcher.status();
  assert.equal(afterEnable.onboarded, true, "enable keeps the onboarding flag");
  assert.equal(afterEnable.onboardedAt, marked.onboardedAt, "enable keeps the onboarding timestamp");

  await switcher.disable();
  const afterDisable = await switcher.status();
  assert.equal(afterDisable.onboarded, true, "disable keeps the onboarding flag");
  assert.equal(afterDisable.onboardedAt, marked.onboardedAt, "disable keeps the onboarding timestamp");
});

test("preserves unrelated edits made after enable while restoring managed fields", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await appendFile(configPath, "\n[plugins.user_added]\nenabled = true\n", "utf8");
  await switcher.disable();
  const restored = await readFile(configPath, "utf8");
  assert.match(restored, /model = "gpt-5.6-sol"/);
  assert.doesNotMatch(restored, /modeldock_go/);
  assert.doesNotMatch(restored, /openai_base_url/);
  assert.doesNotMatch(restored, /Managed by ModelDock/);
  assert.match(restored, /\[plugins\.user_added\]\nenabled = true/);
});

test("restore always proceeds; tampered managed fields are simply replaced by the backup", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  const current = await readFile(configPath, "utf8");
  await writeFile(
    configPath,
    current.replace('openai_base_url = "http://127.0.0.1:4097/v1"', 'openai_base_url = "http://127.0.0.1:9999/v1"'),
    "utf8",
  );
  const disabled = await switcher.disable();
  assert.equal(disabled.enabled, false);
  const restored = await readFile(configPath, "utf8");
  assert.doesNotMatch(restored, /9999/, "the tampered value is gone with the managed fields");
  assert.doesNotMatch(restored, /openai_base_url/);
});

test("a picker-driven model change is not drift and does not block restore", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  const current = await readFile(configPath, "utf8");
  // The Codex App picker rewrites the top-level model on every selection; the
  // catalog exists precisely so it can. That must neither flag drift nor make
  // disable() refuse the restore.
  await writeFile(configPath, current.replace(/^model = .*$/m, 'model = "glm-5.2"'), "utf8");
  const disabled = await switcher.disable();
  assert.equal(disabled.enabled, false);
});

test("recognizes a config already restored outside ModelDock and clears stale state", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await writeFile(configPath, originalConfig, "utf8");
  const status = await switcher.status();
  assert.equal(status.enabled, false);
  assert.equal(status.externallyRestored, true);
  await switcher.disable();
  assert.equal((await switcher.status()).externallyRestored, false);
  assert.equal(await readFile(configPath, "utf8"), originalConfig);
});

test("restores the absence of config when none existed before enable", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-config-switch-empty-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const switcher = new CodexConfigSwitcher({ codexHome, baseUrl: "http://127.0.0.1:4097/v1", model: "deepseek-v4-flash" });
  await switcher.enable();
  await switcher.disable();
  await assert.rejects(() => access(path.join(codexHome, "config.toml")), (error) => error.code === "ENOENT");
});

test("the managed config names the catalog file and restore removes it", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "modeldock-catalog-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const original = 'model = "gpt-5.6-sol"\nmodel_reasoning_effort = "high"\n';
  await writeFile(path.join(home, "config.toml"), original, "utf8");

  const switcher = new CodexConfigSwitcher({
    codexHome: home,
    baseUrl: "http://127.0.0.1:4097/v1",
    model: "deepseek-v4-flash",
    catalogFile: "C:/Users/x/.modeldock/codex-model-catalog.json",
  });
  await switcher.enable();

  const managed = await readFile(path.join(home, "config.toml"), "utf8");
  assert.match(managed, /^model_catalog_json = "C:\/Users\/x\/\.modeldock\/codex-model-catalog\.json"$/m);

  await switcher.disable();
  const restored = await readFile(path.join(home, "config.toml"), "utf8");
  assert.equal(/model_catalog_json/.test(restored), false, "the key is a managed field and goes away with the rest");
  assert.match(restored, /^model = "gpt-5\.6-sol"$/m, "the user's own model comes back");
});

test("a legacy modeldock_go managed config is migrated to the transparent shape", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-migrate-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, originalConfig, "utf8");
  const switcher = new CodexConfigSwitcher({
    codexHome,
    baseUrl: "http://127.0.0.1:4097/v1",
    model: "deepseek-v4-flash",
    catalogFile: "C:/Users/x/.modeldock/codex-model-catalog.json",
  });
  await switcher.enable();
  // Simulate the pre-transparent managed config this gate used to write.
  const legacy = `model = "deepseek-v4-flash"
model_provider = "modeldock_go"
web_search = "disabled"
model_catalog_json = "C:/Users/x/.modeldock/codex-model-catalog.json"

[model_providers.modeldock_go]
# Managed by ModelDock. Use the dashboard to restore the backup.
name = "ModelDock"
base_url = "http://127.0.0.1:4097/c/key/v1"
wire_api = "responses"
experimental_bearer_token = "local-modeldock"
`;
  await writeFile(configPath, legacy, "utf8");
  const status = await switcher.status();
  assert.equal(status.enabled, true);
  assert.equal(status.needsMigration, true);

  const migrated = await switcher.enable();
  assert.equal(migrated.enabled, true);
  assert.equal(migrated.needsMigration, false);
  const text = await readFile(configPath, "utf8");
  assert.match(text, /openai_base_url =/);
  assert.doesNotMatch(text, /model_provider/);
  assert.doesNotMatch(text, /modeldock_go/);
  assert.doesNotMatch(text, /^web_search\s*=/m);
  assert.match(text, /model_catalog_json = "C:\/Users\/x\/\.modeldock\/codex-model-catalog\.json"/);
});

test("enable refuses when codex-router already manages openai_base_url", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-router-conflict-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  const routerManaged = `model = "opencode-go/deepseek-v4-flash"
# BEGIN codex-router-managed
openai_base_url = "http://127.0.0.1:4102/_codex-router/key/v1"
model_catalog_json = "C:/Users/x/codex-router/merged-models.json"
# END codex-router-managed
`;
  await writeFile(configPath, routerManaged, "utf8");
  const switcher = new CodexConfigSwitcher({ codexHome, baseUrl: "http://127.0.0.1:4097/v1", model: "deepseek-v4-flash" });
  await assert.rejects(() => switcher.enable(), (error) => error.code === "EXTERNAL_MANAGED");
  assert.equal(await readFile(configPath, "utf8"), routerManaged, "the conflicting config is left untouched");
});

test("enable refuses a config with duplicated TOML keys and leaves the file untouched", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-duplicate-key-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  const duplicated = 'model = "gpt-5.6-sol"\nmodel = "gpt-5.6-codex"\n';
  await writeFile(configPath, duplicated, "utf8");
  const switcher = new CodexConfigSwitcher({ codexHome, baseUrl: "http://127.0.0.1:4097/v1", model: "deepseek-v4-flash" });
  await assert.rejects(
    () => switcher.enable(),
    (error) => error.code === "DUPLICATE_TOML_KEY" && /duplicate key\(s\): model/.test(error.message),
  );
  assert.equal(await readFile(configPath, "utf8"), duplicated, "the broken config is left untouched");
  await assert.rejects(() => access(path.join(codexHome, "modeldock", "config-manifest.jsonl")), (error) => error.code === "ENOENT", "no manifest entry for the aborted write");
});

test("enable and disable append audit entries to the config manifest", async (t) => {
  const { codexHome, configPath, switcher } = await fixture(t);
  await switcher.enable();
  await switcher.disable();
  const manifestPath = path.join(codexHome, "modeldock", "config-manifest.jsonl");
  const lines = (await readFile(manifestPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2, "one entry per operation");
  const [enabled, disabled] = lines.map((line) => JSON.parse(line));
  assert.equal(enabled.operation, "enable");
  assert.equal(disabled.operation, "disable");
  assert.ok(enabled.backupPath && enabled.originalHash && enabled.managedHash, "the enable entry records backup and hashes");
  assert.ok(enabled.at <= disabled.at, "entries are append-ordered");
  assert.match(await readFile(configPath, "utf8"), /^model = "gpt-5.6-sol"/m, "disable restores the original config");
});

test("login-free managed config writes the provider table instead of openai_base_url", () => {
  const managed = buildManagedCodexConfig(originalConfig, {
    baseUrl: "http://127.0.0.1:4097/c/callerkey/v1",
    model: "deepseek-v4-flash",
    catalogFile: "C:/Users/x/.modeldock/codex-model-catalog.json",
    mcpUrl: "http://127.0.0.1:4097/mcp",
    loginFree: true,
  });
  assert.match(managed, /^model_provider = "modeldock"$/m, "login-free sets the custom provider");
  assert.doesNotMatch(managed, /openai_base_url/, "no transparent redirect in login-free mode");
  assert.doesNotMatch(managed, /experimental_realtime_/, "no realtime endpoints in login-free mode");
  assert.match(managed, /^\[model_providers\.modeldock\]$/m, "the provider table exists");
  assert.match(managed, /base_url = "http:\/\/127\.0\.0\.1:4097\/c\/callerkey\/v1"/);
  assert.match(managed, /wire_api = "responses"/);
  assert.match(managed, /experimental_bearer_token = "modeldock-placeholder"/);
  assert.match(managed, /# BEGIN modeldock-managed/);
  assert.match(managed, /^model_catalog_json = "C:\/Users\/x\/\.modeldock\/codex-model-catalog\.json"$/m);
  assert.match(managed, /\[mcp_servers\.modeldock\]/);
  const table = managed.indexOf("[features]");
  const provider = managed.indexOf("model_provider");
  assert.ok(provider < table, "model_provider sits before any [table]");
});

test("login-free enable writes the provider table and disable restores the original config", async (t) => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-config-switch-loginfree-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, originalConfig, "utf8");
  const switcher = new CodexConfigSwitcher({
    codexHome,
    baseUrl: "http://127.0.0.1:4097/c/callerkey/v1",
    model: "deepseek-v4-flash",
    loginFree: true,
  });

  const enabled = await switcher.enable();
  assert.equal(enabled.targetProvider, "modeldock");
  assert.equal(enabled.targetMode, "provider_table");
  const managed = await readFile(configPath, "utf8");
  assert.match(managed, /^model_provider = "modeldock"$/m);
  assert.match(managed, /^\[model_providers\.modeldock\]$/m);
  assert.doesNotMatch(managed, /openai_base_url/);

  await switcher.disable();
  assert.equal(await readFile(configPath, "utf8"), originalConfig, "disable restores the exact original config");
  assert.doesNotMatch(await readFile(configPath, "utf8"), /model_providers\.modeldock/, "restore removes the provider table");
});

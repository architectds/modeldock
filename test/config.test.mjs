import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { loadConfig, hasChatGptLogin, tokenFromCodexToml, encodePersistedModelRef, decodePersistedModelRef } from "../src/config.mjs";

test("reads an OpenCode bearer token only from a supported provider section", () => {
  const source = `
[model_providers.other]
experimental_bearer_token = "wrong"

[model_providers.opencode]
experimental_bearer_token = "go-token"
`;
  assert.equal(tokenFromCodexToml(source), "go-token");
});

test("supports TOML literal strings for an OpenCode backup token", () => {
  assert.equal(tokenFromCodexToml("[model_providers.opencode_go]\nexperimental_bearer_token = 'literal-token'\n"), "literal-token");
});

test("does not treat an unrelated provider token as OpenCode Go", () => {
  assert.equal(tokenFromCodexToml('[model_providers.openai]\nexperimental_bearer_token = "secret"\n'), "");
});

test("canonicalizes loopback host spellings the SDK's Host guard would not recognize", () => {
  // createMcpExpressApp enables DNS-rebinding Host validation only for the
  // exact spellings "127.0.0.1" | "localhost" | "::1". isLoopbackHost also
  // admits "LOCALHOST" and "[::1]", so loadConfig must canonicalize or those
  // spellings would boot the app with the guard silently off.
  const previous = process.env.MODELDOCK_HOST;
  try {
    process.env.MODELDOCK_HOST = "LOCALHOST";
    assert.equal(loadConfig().host, "localhost");
    process.env.MODELDOCK_HOST = "[::1]";
    assert.equal(loadConfig().host, "::1");
    process.env.MODELDOCK_HOST = "192.168.1.10";
    assert.throws(() => loadConfig(), /loopback/);
  } finally {
    if (previous === undefined) delete process.env.MODELDOCK_HOST;
    else process.env.MODELDOCK_HOST = previous;
  }
});

test("zenBaseUrl resolves from MODELDOCK_ZEN_BASE_URL with the trailing slash normalized", () => {
  const previous = process.env.MODELDOCK_ZEN_BASE_URL;
  process.env.MODELDOCK_ZEN_BASE_URL = "https://zen.example.test/v1/";
  try {
    const config = loadConfig();
    assert.equal(config.zenBaseUrl, "https://zen.example.test/v1");
  } finally {
    if (previous === undefined) delete process.env.MODELDOCK_ZEN_BASE_URL;
    else process.env.MODELDOCK_ZEN_BASE_URL = previous;
  }
});

test("ModelDock ignores a generic CODEX_HOME and uses the Desktop user store", () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousModelDockHome = process.env.MODELDOCK_CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(os.tmpdir(), "codex-cli-runtime-parent");
    delete process.env.MODELDOCK_CODEX_HOME;
    assert.equal(loadConfig().codexHome, path.resolve(path.join(os.homedir(), ".codex")));
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    if (previousModelDockHome === undefined) delete process.env.MODELDOCK_CODEX_HOME;
    else process.env.MODELDOCK_CODEX_HOME = previousModelDockHome;
  }
});

test("a placeholder OPENCODE_GO_TOKEN falls back to the Codex backup and reports its real source", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-config-token-src-"));
  const previousHome = process.env.MODELDOCK_CODEX_HOME;
  const previousEnvFile = process.env.MODELDOCK_ENV_FILE;
  const previousToken = process.env.OPENCODE_GO_TOKEN;
  const previousEvents = process.env.MODELDOCK_SETTINGS_EVENTS_FILE;
  try {
    process.env.MODELDOCK_CODEX_HOME = home;
    process.env.MODELDOCK_ENV_FILE = path.join(home, "isolated.env");
    process.env.MODELDOCK_SETTINGS_EVENTS_FILE = path.join(home, "settings-events.jsonl");
    // A placeholder env token must be ignored: the effective token and its
    // reported source come from the same decision (here: the Codex backup).
    process.env.OPENCODE_GO_TOKEN = "x";
    writeFileSync(
      path.join(home, "config.toml"),
      '[model_providers.opencode_go]\nexperimental_bearer_token = "backup-token"\n',
      "utf8",
    );
    const config = loadConfig();
    assert.equal(config.tokens["opencode-go"], "backup-token",
      "a placeholder env token must not shadow the backup token");
    assert.equal(config.goTokenSource, "codex-config-backup",
      "the source must match where the effective token actually came from");
    // A real env token wins and reports "environment".
    process.env.OPENCODE_GO_TOKEN = "sk-opencode-env-valid-123456";
    const real = loadConfig();
    assert.equal(real.tokens["opencode-go"], "sk-opencode-env-valid-123456");
    assert.equal(real.goTokenSource, "environment");
  } finally {
    if (previousHome === undefined) delete process.env.MODELDOCK_CODEX_HOME;
    else process.env.MODELDOCK_CODEX_HOME = previousHome;
    if (previousEnvFile === undefined) delete process.env.MODELDOCK_ENV_FILE;
    else process.env.MODELDOCK_ENV_FILE = previousEnvFile;
    if (previousToken === undefined) delete process.env.OPENCODE_GO_TOKEN;
    else process.env.OPENCODE_GO_TOKEN = previousToken;
    if (previousEvents === undefined) delete process.env.MODELDOCK_SETTINGS_EVENTS_FILE;
    else process.env.MODELDOCK_SETTINGS_EVENTS_FILE = previousEvents;
    rmSync(home, { recursive: true, force: true });
  }
});

test("nativeMerge defaults to the ChatGPT sign-in state when MODELDOCK_NATIVE_MERGE is unset", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-config-auth-"));
  const previousHome = process.env.MODELDOCK_CODEX_HOME;
  const previousMerge = process.env.MODELDOCK_NATIVE_MERGE;
   const previousEnvFile = process.env.MODELDOCK_ENV_FILE;
   process.env.MODELDOCK_CODEX_HOME = home;
   process.env.MODELDOCK_ENV_FILE = path.join(home, "isolated.env");
   // An earlier loadConfig in this process may have applied the repo .env (the
   // dev fallback for envFileFor), which can carry MODELDOCK_NATIVE_MERGE and
   // would leak into this test. The unset case must start from an empty env.
   delete process.env.MODELDOCK_NATIVE_MERGE;
   try {
    assert.equal(loadConfig().nativeMerge, false, "no ChatGPT sign-in means native GPT models stay unpublished");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "sk-test" } }), "utf8");
    assert.equal(loadConfig().nativeMerge, true, "a detected sign-in keeps the subscriber-native merge");
    process.env.MODELDOCK_NATIVE_MERGE = "0";
    assert.equal(loadConfig().nativeMerge, false, "MODELDOCK_NATIVE_MERGE=0 overrides a detected sign-in");
    delete process.env.MODELDOCK_NATIVE_MERGE;
    process.env.MODELDOCK_NATIVE_MERGE = "1";
    rmSync(path.join(home, "auth.json"), { force: true });
    assert.equal(loadConfig().nativeMerge, true, "MODELDOCK_NATIVE_MERGE=1 overrides a missing sign-in");
  } finally {
    if (previousHome === undefined) delete process.env.MODELDOCK_CODEX_HOME;
    else process.env.MODELDOCK_CODEX_HOME = previousHome;
    if (previousMerge === undefined) delete process.env.MODELDOCK_NATIVE_MERGE;
    else process.env.MODELDOCK_NATIVE_MERGE = previousMerge;
    if (previousEnvFile === undefined) delete process.env.MODELDOCK_ENV_FILE;
    else process.env.MODELDOCK_ENV_FILE = previousEnvFile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("MODELDOCK_VISION_MODEL=none persists a provider with no vision route", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-config-no-vision-"));
  const keys = ["MODELDOCK_CODEX_HOME", "MODELDOCK_ENV_FILE", "MODELDOCK_PROFILE", "MODELDOCK_VISION_MODEL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.MODELDOCK_CODEX_HOME = home;
    process.env.MODELDOCK_ENV_FILE = path.join(home, "isolated.env");
    process.env.MODELDOCK_PROFILE = "deepseek-official";
    process.env.MODELDOCK_VISION_MODEL = "none";
    const config = loadConfig();
    assert.equal(config.profileId, "deepseek-official");
    assert.equal(config.mainModel, "deepseek-v4-flash@deepseek-official");
    assert.equal(config.visionModel, "");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("persisted model references keep the provider identity separate from the Codex wire slug", () => {
  const native = new Set(["gpt-5.6-luna"]);
  assert.equal(encodePersistedModelRef("gpt-5.6-luna"), "gpt-5.6-luna@openai");
  assert.equal(encodePersistedModelRef("gpt-5.6-luna@opencode-go"), "gpt-5.6-luna@opencode-go");
  assert.equal(decodePersistedModelRef("gpt-5.6-luna@openai", { nativeSlugs: native }), "gpt-5.6-luna");
  assert.equal(decodePersistedModelRef("gpt-5.6-luna@opencode-go", { nativeSlugs: native }), "gpt-5.6-luna@opencode-go");
  assert.equal(decodePersistedModelRef("gpt-5.6-luna", { nativeSlugs: native }), "gpt-5.6-luna",
    "the legacy bare native value is migrated without changing its owner");
  assert.equal(decodePersistedModelRef("kimi-k2.5", { nativeSlugs: native }), "kimi-k2.5@opencode-go",
    "a legacy bare routed value resolves through its historical owner, not the active profile");
});

test("a native vision choice reloads as native even while OpenCode Go is the default profile", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-config-native-vision-"));
  const envFile = path.join(home, "isolated.env");
  const nativeCatalogFile = path.join(home, "native-catalog.json");
  const keys = ["MODELDOCK_CODEX_HOME", "MODELDOCK_ENV_FILE", "MODELDOCK_NATIVE_CATALOG_FILE", "MODELDOCK_PROFILE", "MODELDOCK_VISION_MODEL", "MODELDOCK_NATIVE_MERGE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    writeFileSync(nativeCatalogFile, JSON.stringify({
      captured_with: "0.149.0",
      models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" }],
    }), "utf8");
    writeFileSync(envFile, [
      "MODELDOCK_PROFILE=opencode-go",
      "MODELDOCK_VISION_MODEL=gpt-5.6-luna@openai",
      "MODELDOCK_NATIVE_MERGE=1",
      "",
    ].join("\n"), "utf8");
    process.env.MODELDOCK_CODEX_HOME = home;
    process.env.MODELDOCK_ENV_FILE = envFile;
    process.env.MODELDOCK_NATIVE_CATALOG_FILE = nativeCatalogFile;
    delete process.env.MODELDOCK_PROFILE;
    delete process.env.MODELDOCK_VISION_MODEL;
    delete process.env.MODELDOCK_NATIVE_MERGE;
    const config = loadConfig();
    assert.equal(config.profileId, "opencode-go");
    assert.equal(config.visionModel, "gpt-5.6-luna");

    // Existing installs wrote the native slug without its owner. The cached
    // native catalog makes that old value unambiguous during the upgrade.
    writeFileSync(envFile, "MODELDOCK_PROFILE=opencode-go\nMODELDOCK_VISION_MODEL=gpt-5.6-luna\nMODELDOCK_NATIVE_MERGE=1\n", "utf8");
    delete process.env.MODELDOCK_PROFILE;
    delete process.env.MODELDOCK_VISION_MODEL;
    delete process.env.MODELDOCK_NATIVE_MERGE;
    assert.equal(loadConfig().visionModel, "gpt-5.6-luna");

    writeFileSync(envFile, "MODELDOCK_PROFILE=commandcode\nMODELDOCK_VISION_MODEL=gpt-5.6-luna\nMODELDOCK_NATIVE_MERGE=1\n", "utf8");
    delete process.env.MODELDOCK_PROFILE;
    delete process.env.MODELDOCK_VISION_MODEL;
    delete process.env.MODELDOCK_NATIVE_MERGE;
    const otherActiveProfile = loadConfig();
    assert.equal(otherActiveProfile.profileId, "commandcode");
    assert.equal(otherActiveProfile.visionModel, "gpt-5.6-luna",
      "the active provider never takes ownership of a legacy native selection");
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("hasChatGptLogin requires a real token and ignores malformed files", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "modeldock-config-auth2-"));
  try {
    assert.equal(hasChatGptLogin(home), false, "no auth.json means no sign-in");
    writeFileSync(path.join(home, "auth.json"), "{}", "utf8");
    assert.equal(hasChatGptLogin(home), false, "an empty tokens object is not a sign-in");
    writeFileSync(path.join(home, "auth.json"), "not json", "utf8");
    assert.equal(hasChatGptLogin(home), false, "a malformed file is not a sign-in");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }), "utf8");
    assert.equal(hasChatGptLogin(home), true, "the legacy OPENAI_API_KEY shape counts");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: { refresh_token: "r-test" } }), "utf8");
    assert.equal(hasChatGptLogin(home), true, "a refresh token counts (Codex refreshes it silently)");
    writeFileSync(path.join(home, "auth.json"), JSON.stringify({ tokens: {} }), "utf8");
    assert.equal(hasChatGptLogin(home), false, "an empty tokens object is not a sign-in");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

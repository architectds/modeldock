import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  applyPresetToConfig,
  fetchProviderModels,
  listBackups,
  parseSummary,
  restoreConfigBackup,
  saveProfileConfig
} from "../server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "modeldock-smoke-"));
const paths = {
  codexHome: root,
  realCodexHome: root,
  configPath: path.join(root, "config.toml"),
  backupsDir: path.join(root, "modeldock-backups"),
  profilesDir: root
};

await fs.writeFile(
  paths.configPath,
  [
    'model_provider = "openai"',
    'model = "gpt-5.5"',
    "",
    "[projects.'d:\\projects\\stockscan']",
    'trust_level = "trusted"',
    ""
  ].join("\n"),
  "utf8"
);

const preset = {
  providerId: "openrouter",
  providerName: "OpenRouter",
  model: "openai/gpt-5.5",
  reasoningEffort: "medium",
  verbosity: "low",
  wireApi: "responses",
  baseUrl: "https://openrouter.ai/api/v1",
  envKey: "OPENROUTER_API_KEY"
};

const profile = await saveProfileConfig(paths, "openrouter-test", preset);
if (!profile.profilePath.endsWith("openrouter-test.config.toml")) throw new Error("profile path mismatch");

await applyPresetToConfig(paths, preset);
const applied = await fs.readFile(paths.configPath, "utf8");
const summary = parseSummary(applied);
if (summary.modelProvider !== "openrouter") throw new Error("provider was not applied");
if (!applied.includes("[model_providers.openrouter]")) throw new Error("provider block missing");
if (!applied.includes("[projects.'d:\\projects\\stockscan']")) throw new Error("unrelated project config was not preserved");

const backups = await listBackups(paths.backupsDir);
if (!backups.length) throw new Error("backup was not created");

await restoreConfigBackup(paths, backups[0].name);
const restored = await fs.readFile(paths.configPath, "utf8");
if (!restored.includes('model_provider = "openai"')) throw new Error("restore did not restore backup");

const fakeProvider = createServer((request, response) => {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "fake/model-a", context_length: 8192 }, { id: "fake/model-b" }] }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

await new Promise((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
try {
  const address = fakeProvider.address();
  const fakePreset = {
    providerId: "fake",
    providerName: "Fake",
    model: "fake/model-a",
    wireApi: "responses",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    envKey: ""
  };
  const discovered = await fetchProviderModels(fakePreset);
  if (discovered.models.length !== 2) throw new Error("provider model discovery failed");
} finally {
  await new Promise((resolve) => fakeProvider.close(resolve));
}

const fakeAnthropic = createServer((request, response) => {
  if (request.url === "/v1/models" && request.headers["x-api-key"] === "test-anthropic-key") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "claude-test", display_name: "Claude Test" }] }));
    return;
  }
  response.writeHead(401);
  response.end(JSON.stringify({ error: { message: "bad anthropic auth" } }));
});

await new Promise((resolve) => fakeAnthropic.listen(0, "127.0.0.1", resolve));
process.env.TEST_ANTHROPIC_API_KEY = "test-anthropic-key";
try {
  const address = fakeAnthropic.address();
  const anthropicPreset = {
    providerId: "anthropic",
    providerName: "Anthropic",
    model: "claude-test",
    wireApi: "responses",
    baseUrl: `http://127.0.0.1:${address.port}`,
    envKey: "TEST_ANTHROPIC_API_KEY"
  };
  const discovered = await fetchProviderModels(anthropicPreset);
  if (discovered.models[0]?.id !== "claude-test") throw new Error("anthropic model discovery failed");
} finally {
  delete process.env.TEST_ANTHROPIC_API_KEY;
  await new Promise((resolve) => fakeAnthropic.close(resolve));
}

console.log(JSON.stringify({ ok: true, root, backups: backups.length }, null, 2));

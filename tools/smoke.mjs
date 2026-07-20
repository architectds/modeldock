import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPresetToConfig,
  chatCompletionToResponse,
  fetchProviderModels,
  listBackups,
  parseSummary,
  responsesToChatRequest,
  restoreConfigBackup,
  restoreDefaultConfig,
  saveProfileConfig,
  server
} from "../server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "modeldock-smoke-"));
const paths = {
  codexHome: root,
  realCodexHome: root,
  configPath: path.join(root, "config.toml"),
  backupsDir: path.join(root, "modeldock-backups"),
  profilesDir: root
};

function runNodeScript(scriptPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: path.dirname(path.dirname(scriptPath)),
      windowsHide: true
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `${scriptPath} failed with exit code ${code}`));
    });
  });
}

await runNodeScript(path.join(__dirname, "check-dom-ids.mjs"));

async function assertRejects(action, label) {
  try {
    await action();
  } catch {
    return;
  }
  throw new Error(label);
}

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

const initialApplyBackups = await listBackups(paths.backupsDir);
if (!initialApplyBackups.length) throw new Error("backup was not created");
const originalConfigBackupName = initialApplyBackups[0].name;

const aliasPreset = {
  providerId: "openai",
  providerName: "DeepSeek",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
  verbosity: "",
  wireApi: "responses",
  baseUrl: "https://api.deepseek.com",
  envKey: "DEEPSEEK_API_KEY"
};
await assertRejects(() => applyPresetToConfig(paths, aliasPreset), "reserved provider apply should be rejected");
await assertRejects(() => saveProfileConfig(paths, "openai-deepseek-alias", aliasPreset), "reserved provider profile should be rejected");

const deepseekPreset = {
  providerId: "deepseek",
  providerName: "DeepSeek",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
  verbosity: "",
  wireApi: "chat",
  baseUrl: "https://api.deepseek.com",
  envKey: "DEEPSEEK_API_KEY"
};
await assertRejects(() => applyPresetToConfig(paths, deepseekPreset), "chat wire apply should be rejected");
await assertRejects(() => saveProfileConfig(paths, "deepseek-chat", deepseekPreset), "chat wire profile should be rejected");

const deepseekProxyPreset = {
  providerId: "deepseek_proxy",
  providerName: "DeepSeek via ModelDock Proxy",
  model: "deepseek-v4-flash",
  reasoningEffort: "high",
  verbosity: "",
  wireApi: "responses",
  baseUrl: "http://127.0.0.1:8765/proxy/deepseek/v1",
  envKey: "OPENROUTER_API_KEY"
};
const deepseekProxyProfile = await saveProfileConfig(paths, "deepseek-proxy", deepseekProxyPreset);
const deepseekProxyText = await fs.readFile(deepseekProxyProfile.profilePath, "utf8");
if (deepseekProxyText.includes("env_key")) throw new Error("proxy profile should not write env_key");

const directAnthropicPreset = {
  providerId: "anthropic",
  providerName: "Anthropic",
  model: "claude-sonnet-5",
  wireApi: "responses",
  baseUrl: "https://api.anthropic.com",
  envKey: "ANTHROPIC_API_KEY"
};
await assertRejects(() => applyPresetToConfig(paths, directAnthropicPreset), "direct anthropic apply should be rejected");

const backups = await listBackups(paths.backupsDir);
if (!backups.length) throw new Error("backup was not created");

await restoreConfigBackup(paths, originalConfigBackupName);
const restored = await fs.readFile(paths.configPath, "utf8");
if (!restored.includes('model_provider = "openai"')) throw new Error("restore did not restore backup");

await restoreDefaultConfig(paths);
const defaultRestored = await fs.readFile(paths.configPath, "utf8");
if (!defaultRestored.includes('model_provider = "openai"') || !defaultRestored.includes('model = "gpt-5.5"')) {
  throw new Error("default restore did not restore OpenAI baseline");
}

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

const kimiChat = responsesToChatRequest("kimi", {
  model: "kimi-k3",
  instructions: "Be brief.",
  input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
  max_output_tokens: 32
});
if (kimiChat.max_completion_tokens !== 32) throw new Error("kimi proxy token field mismatch");
if (kimiChat.messages[0]?.role !== "system") throw new Error("instructions were not mapped to system");

const responseShape = chatCompletionToResponse(
  { model: "deepseek-v4-flash" },
  {
    id: "chatcmpl-test",
    model: "deepseek-v4-flash",
    choices: [{ message: { role: "assistant", content: "MODELDOCK_PROXY_OK" } }],
    usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
  }
);
if (responseShape.output_text !== "MODELDOCK_PROXY_OK") throw new Error("chat response was not wrapped");
if (responseShape.usage.total_tokens !== 9) throw new Error("chat usage was not wrapped");

const fakeChatProvider = createServer(async (request, response) => {
  if (request.url === "/models" && request.method === "GET" && request.headers.authorization === "Bearer test-deepseek-key") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "deepseek-v4-flash" }] }));
    return;
  }
  if (request.url === "/chat/completions" && request.method === "POST" && request.headers.authorization === "Bearer test-deepseek-key") {
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw);
    if (body.max_tokens !== 64) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad max token field" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "chatcmpl-proxy",
        model: body.model,
        choices: [{ message: { role: "assistant", content: "MODELDOCK_PROXY_OK" } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
      })
    );
    return;
  }
  response.writeHead(404);
  response.end("not found");
});

await new Promise((resolve) => fakeChatProvider.listen(0, "127.0.0.1", resolve));
process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
try {
  const fakeAddress = fakeChatProvider.address();
  process.env.MODELDOCK_PROXY_DEEPSEEK_ENDPOINT = `http://127.0.0.1:${fakeAddress.port}/chat/completions`;
  process.env.MODELDOCK_PROXY_DEEPSEEK_MODELS_URL = `http://127.0.0.1:${fakeAddress.port}/models`;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dockAddress = server.address();
  const modelsResponse = await fetch(`http://127.0.0.1:${dockAddress.port}/proxy/deepseek/v1/models`);
  const modelsData = await modelsResponse.json();
  if (!Array.isArray(modelsData.models) || modelsData.models[0]?.id !== "deepseek-v4-flash") {
    throw new Error("proxy models route did not wrap Codex model list");
  }
  if (modelsData.models[0]?.slug !== "deepseek-v4-flash") throw new Error("proxy models route did not include slug");
  if (modelsData.models[0]?.display_name !== "deepseek-v4-flash") throw new Error("proxy models route did not include display_name");
  if (!Array.isArray(modelsData.models[0]?.supported_reasoning_levels)) {
    throw new Error("proxy models route did not include reasoning metadata");
  }
  const response = await fetch(`http://127.0.0.1:${dockAddress.port}/proxy/deepseek/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: "reply exactly",
      max_output_tokens: 64
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`proxy route failed: ${JSON.stringify(data)}`);
  if (data.output_text !== "MODELDOCK_PROXY_OK") throw new Error("proxy route did not wrap upstream response");
  const sseResponse = await fetch(`http://127.0.0.1:${dockAddress.port}/proxy/deepseek/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      input: "reply exactly",
      max_output_tokens: 64,
      stream: true
    })
  });
  const sseText = await sseResponse.text();
  if (!sseResponse.ok || !sseText.includes("event: response.completed")) {
    throw new Error("proxy route did not emit responses SSE");
  }
} finally {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MODELDOCK_PROXY_DEEPSEEK_ENDPOINT;
  delete process.env.MODELDOCK_PROXY_DEEPSEEK_MODELS_URL;
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => fakeChatProvider.close(resolve));
}

console.log(JSON.stringify({ ok: true, root, backups: backups.length }, null, 2));

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
await runNodeScript(path.join(__dirname, "check-presets.mjs"));

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
  max_output_tokens: 32,
  tools: [
    {
      type: "function",
      name: "shell_command",
      description: "Runs a shell command.\n".repeat(200),
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell script to run in the user's default shell.".repeat(20) },
          sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"] }
        },
        required: ["command"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "update_plan",
      description: "Updates the task plan.",
      parameters: { type: "object", properties: {} }
    },
    {
      type: "function",
      name: "apply_patch",
      description: "Apply patches.\n".repeat(200),
      parameters: { type: "object", properties: { patch: { type: "string", description: "Patch text.".repeat(20) } }, required: ["patch"] }
    },
    {
      type: "function",
      name: "read_mcp_resource",
      description: "MCP read.",
      parameters: { type: "object", properties: {} }
    }
  ]
});
if (kimiChat.max_completion_tokens !== 32) throw new Error("kimi proxy token field mismatch");
if (kimiChat.reasoning_effort !== "max") throw new Error("kimi k3 should use reasoning_effort=max");
if (kimiChat.messages[0]?.role !== "system") throw new Error("instructions were not mapped to system");
if (kimiChat.tools?.[0]?.function?.name !== "shell_command") throw new Error("responses tools were not mapped to chat tools");
const kimiToolNames = kimiChat.tools.map((tool) => tool.function.name).join(",");
if (kimiToolNames !== "shell_command,update_plan,apply_patch") throw new Error(`kimi coding policy exposed wrong tools: ${kimiToolNames}`);
if (kimiChat.tools[0].function.description.length > 120) throw new Error("kimi tool description was not compressed");
if (kimiChat.tools[0].function.parameters.properties.sandbox_permissions) throw new Error("kimi shell schema should be compact");
if (kimiChat.tool_choice !== "auto") throw new Error("chat tool_choice was not enabled");

const deepseekPolicyChat = responsesToChatRequest("deepseek", {
  model: "deepseek-v4-flash",
  input: "inspect and edit",
  tools: [
    {
      type: "function",
      name: "shell_command",
      description: "Runs a shell command.\n".repeat(200),
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
    },
    {
      type: "function",
      name: "apply_patch",
      description: "Apply patches.\n".repeat(200),
      parameters: { type: "object", properties: { patch: { type: "string", description: "Patch text.".repeat(20) } }, required: ["patch"] }
    },
    {
      type: "function",
      name: "update_plan",
      description: "Plan tool.\n".repeat(200),
      parameters: { type: "object", properties: { plan: { type: "array", items: { type: "object", description: "Plan item.".repeat(20) } } } }
    },
    {
      type: "function",
      name: "read_mcp_resource",
      description: "MCP read.",
      parameters: { type: "object", properties: {} }
    }
  ]
});
const deepseekToolNames = deepseekPolicyChat.tools.map((tool) => tool.function.name).join(",");
if (deepseekToolNames !== "shell_command,apply_patch,update_plan") throw new Error(`deepseek coding policy exposed wrong tools: ${deepseekToolNames}`);
if (!deepseekPolicyChat.messages[0]?.content.includes("standard Chat Completions tool_calls")) {
  throw new Error("deepseek tool adapter instruction was not injected");
}
if (JSON.stringify(deepseekPolicyChat.tools).includes("Shell script to run in the user's default shell")) {
  throw new Error("deepseek tool descriptions were not compressed");
}

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

const toolCallShape = chatCompletionToResponse(
  { model: "deepseek-v4-flash" },
  {
    id: "chatcmpl-tool",
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_shell",
              type: "function",
              function: { name: "shell_command", arguments: "{\"command\":\"Get-ChildItem\"}" }
            }
          ]
        }
      }
    ],
    usage: {}
  }
);
if (toolCallShape.output[0]?.type !== "function_call") throw new Error("chat tool_calls were not wrapped as responses function_call");
if (toolCallShape.output[0]?.call_id !== "call_shell") throw new Error("tool call id was not preserved");
if (toolCallShape.usage.total_tokens !== 0) throw new Error("missing usage should default to numeric zero");

const kimiReasoningToolCallShape = chatCompletionToResponse(
  { model: "kimi-k3" },
  {
    id: "chatcmpl-kimi-tool",
    model: "kimi-k3",
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "Need to inspect the directory with a shell command.",
          tool_calls: [
            {
              id: "kimi_shell_call",
              type: "function",
              function: { name: "shell_command", arguments: "{\"command\":\"Get-ChildItem -Name\"}" }
            }
          ]
        }
      }
    ],
    usage: {}
  }
);
const kimiReasoningRoundtrip = responsesToChatRequest("kimi", {
  model: "kimi-k3",
  input: [
    kimiReasoningToolCallShape.output[0],
    {
      type: "function_call_output",
      call_id: "kimi_shell_call",
      output: "server.mjs\npackage.json"
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "summarize" }]
    }
  ]
});
if (kimiReasoningRoundtrip.messages[0]?.reasoning_content !== "Need to inspect the directory with a shell command.") {
  throw new Error("kimi reasoning_content was not preserved across tool roundtrip");
}
if (kimiReasoningRoundtrip.messages[1]?.name !== "shell_command") throw new Error("kimi tool result did not include tool name");
if (kimiReasoningRoundtrip.messages[1]?.tool_call_id !== "kimi_shell_call") throw new Error("kimi tool result call id was not preserved");

const bashFallbackShape = chatCompletionToResponse(
  {
    model: "deepseek-v4-flash",
    tools: [
      {
        type: "function",
        name: "shell_command",
        description: "Runs a Powershell command.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
      }
    ]
  },
  {
    id: "chatcmpl-bash",
    model: "deepseek-v4-flash",
    choices: [{ message: { role: "assistant", content: "当然可以。\n<bash>Get-ChildItem</bash>" } }]
  }
);
if (!bashFallbackShape.output.some((item) => item.type === "function_call" && item.name === "shell_command")) {
  throw new Error("bash text fallback was not converted to a function_call");
}

const xmlFallbackShape = chatCompletionToResponse(
  {
    model: "deepseek-v4-flash",
    tools: [
      {
        type: "function",
        name: "shell_command",
        description: "Runs a Powershell command.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
      }
    ]
  },
  {
    id: "chatcmpl-xml-tool",
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "<functions><function><name>functions.exec</name><parameters><command>Get-ChildItem -Name</command></parameters></function></functions>"
        }
      }
    ]
  }
);
const xmlFunctionCall = xmlFallbackShape.output.find((item) => item.type === "function_call");
if (!xmlFunctionCall || !xmlFunctionCall.arguments.includes("Get-ChildItem -Name")) {
  throw new Error("xml function fallback was not converted to a function_call");
}

const xmlCodeFallbackShape = chatCompletionToResponse(
  { model: "deepseek-v4-flash" },
  {
    id: "chatcmpl-xml-code-tool",
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "<functions><function_call><invoke><tool>functions.exec</tool><parameters><code>Get-ChildItem -Name</code></parameters></invoke></function_call></functions>"
        }
      }
    ]
  }
);
const xmlCodeFunctionCall = xmlCodeFallbackShape.output.find((item) => item.type === "function_call");
if (!xmlCodeFunctionCall || !xmlCodeFunctionCall.arguments.includes("Get-ChildItem -Name")) {
  throw new Error("xml code fallback was not converted to a function_call");
}

const xmlArgumentsFallbackShape = chatCompletionToResponse(
  { model: "deepseek-v4-flash" },
  {
    id: "chatcmpl-xml-arguments-tool",
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "<functions><function><name>functions.exec</name><arguments>{\"command\":\"Get-ChildItem -Name\"}</arguments></function></functions>"
        }
      }
    ]
  }
);
const xmlArgumentsFunctionCall = xmlArgumentsFallbackShape.output.find((item) => item.type === "function_call");
if (!xmlArgumentsFunctionCall || !xmlArgumentsFunctionCall.arguments.includes("Get-ChildItem -Name")) {
  throw new Error("xml arguments fallback was not converted to a function_call");
}

const namedArgumentFallbackShape = chatCompletionToResponse(
  { model: "deepseek-v4-flash" },
  {
    id: "chatcmpl-named-argument-tool",
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "<functions><argument name=\"command\">$command = \"powershell -Command \\\"Get-ChildItem -Name\\\"\"</argument></functions>"
        }
      }
    ]
  }
);
const namedArgumentFunctionCall = namedArgumentFallbackShape.output.find((item) => item.type === "function_call");
if (!namedArgumentFunctionCall || !namedArgumentFunctionCall.arguments.includes("powershell -Command \\\"Get-ChildItem -Name\\\"")) {
  throw new Error("named command argument fallback was not converted to a function_call");
}

const cdataFallbackShape = chatCompletionToResponse(
  { model: "deepseek-v4-flash" },
  {
    id: "chatcmpl-cdata-tool",
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content: "<functions><argument name=\"command\"><![CDATA[Get-ChildItem -Name]]></argument></functions>"
        }
      }
    ]
  }
);
const cdataFunctionCall = cdataFallbackShape.output.find((item) => item.type === "function_call");
if (!cdataFunctionCall || cdataFunctionCall.arguments.includes("CDATA") || !cdataFunctionCall.arguments.includes("Get-ChildItem -Name")) {
  throw new Error("cdata command fallback was not cleaned");
}

const dsmlFallbackShape = chatCompletionToResponse(
  {
    model: "deepseek-v4-flash",
    tools: [
      {
        type: "function",
        name: "shell_command",
        description: "Runs a Powershell command.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }
      }
    ]
  },
  {
    id: "chatcmpl-dsml-tool",
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name=\"functions.exec\"><｜｜DSML｜｜parameter name=\"command\" string=\"true\">Get-ChildItem -Name</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>"
        }
      }
    ]
  }
);
const dsmlFunctionCall = dsmlFallbackShape.output.find((item) => item.type === "function_call");
if (!dsmlFunctionCall || !dsmlFunctionCall.arguments.includes("Get-ChildItem -Name")) {
  throw new Error("dsml function fallback was not converted to a function_call");
}

const toolResultChat = responsesToChatRequest("deepseek", {
  model: "deepseek-v4-flash",
  input: [
    {
      type: "function_call",
      call_id: "call_shell",
      name: "shell_command",
      arguments: "{\"command\":\"Get-ChildItem\"}"
    },
    {
      type: "function_call_output",
      call_id: "call_shell",
      output: "server.mjs\npackage.json"
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "what files did you see?" }]
    }
  ]
});
if (toolResultChat.messages[0]?.tool_calls?.[0]?.id !== "call_shell") throw new Error("function_call input was not mapped to chat assistant tool_calls");
if (toolResultChat.messages[1]?.role !== "tool") throw new Error("function_call_output input was not mapped to chat tool message");
if (toolResultChat.thinking?.type !== "disabled") throw new Error("deepseek proxy should disable thinking mode for tool loops");

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

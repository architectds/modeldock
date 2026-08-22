// Direct caller for the ModelDock MCP tools.
//
// Use this when the Codex session's MCP connection is unavailable (for example
// after a gateway restart, which the Codex client never re-establishes). It
// bypasses the Codex MCP client and talks straight to the gateway's keyed MCP
// endpoint, so the tools work in any session without exposing a bare route.
//
//   node scripts/mcp-call.mjs tools
//   node scripts/mcp-call.mjs list_mcp_tools
//   node scripts/mcp-call.mjs search <query> [numResults]
//   node scripts/mcp-call.mjs vision <path> <question> [mode]
//   node scripts/mcp-call.mjs image <prompt> [size] [model]
//   node scripts/mcp-call.mjs video <prompt> [duration] [aspect_ratio] [resolution] [wait_seconds]
//   node scripts/mcp-call.mjs video --status <request_id>
//   node scripts/mcp-call.mjs speak <text>
//   node scripts/mcp-call.mjs hear <file>
//   node scripts/mcp-call.mjs recall <query> [scope_dir] [limit]
//   node scripts/mcp-call.mjs store <content> [scope_dir] [kind]
//   node scripts/mcp-call.mjs learn <path> [scope_dir]
//
// This file is self-contained ON PURPOSE: it is shipped to installed layouts
// (via install.sh) that have no src/ directory at all, so it must not import
// ../src/mcp-client.mjs or ../src/caller-key.mjs. The ~60 lines below are the
// minimal faithful copy of those two modules (keyed base URL + stateless MCP
// client); keep them in lockstep when either changes.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// State-dir resolution, mirroring src/state-dir.mjs: MODELDOCK_STATE_DIR
// redirects the whole directory (tests, throwaway installs), otherwise
// ~/.modeldock. The gateway and this CLI both resolve the caller key there, so
// they always agree on the keyed base URL.
function stateFile(name) {
  const dir = process.env.MODELDOCK_STATE_DIR
    ? path.resolve(process.env.MODELDOCK_STATE_DIR)
    : path.join(os.homedir(), ".modeldock");
  return path.join(dir, name);
}

// Caller-key resolution, mirroring src/caller-key.mjs. Read the persisted key
// and mint one on first use (the gateway does the same, so whichever runs
// first creates it; both write the same file).
const KEY_PATTERN = /^[A-Za-z0-9_-]{32,}$/;

function loadOrCreateCallerKey() {
  const filePath = stateFile("caller-key");
  try {
    const existing = readFileSync(filePath, "utf8").trim();
    if (KEY_PATTERN.test(existing)) return existing;
  } catch {
    // Missing or unreadable: mint below.
  }
  const key = randomBytes(32).toString("base64url");
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${key}\n`, "utf8");
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Hardening must never block the fallback.
    }
  } catch {
    // Unwritable state dir: the key still works for this process lifetime.
  }
  return key;
}

// Keyed gateway base URL, mirroring src/mcp-client.mjs.
function gatewayBaseUrl() {
  if (process.env.MODELDOCK_GATEWAY_URL) return process.env.MODELDOCK_GATEWAY_URL;
  return `http://127.0.0.1:4097/c/${loadOrCreateCallerKey()}`;
}

async function requestMcp(baseUrl, method, params) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  let message = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      message = JSON.parse(line.slice(5).trim());
      break;
    } catch {
      // Try the next data line.
    }
  }
  if (!message) {
    throw new Error(`MCP ${method} failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }
  if (message.error) {
    throw new Error(message.error.message || JSON.stringify(message.error));
  }
  return message.result;
}

async function listMcpTools(baseUrl = gatewayBaseUrl()) {
  const result = await requestMcp(baseUrl, "tools/list", {});
  return result.tools || [];
}

// Returns the tool result text; when that text is itself JSON the parsed value
// is returned so callers can work with the object directly.
async function callMcpTool(name, args, baseUrl = gatewayBaseUrl()) {
  const result = await requestMcp(baseUrl, "tools/call", { name, arguments: args });
  const text = (result.content || []).find((item) => item.type === "text")?.text ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const [command, ...rest] = process.argv.slice(2);

if (command === "tools") {
  const tools = await listMcpTools();
  console.log(JSON.stringify(tools.map((tool) => tool.name), null, 2));
} else if (command === "list_mcp_tools") {
  // Discovery command: print every tool with its arguments and a ready-to-run
  // example, fetched live from the gateway so the prompt never hardcodes a
  // schema that can drift.
  const tools = await listMcpTools();
  const lines = [];
  for (const tool of tools) {
    const schema = tool.inputSchema || {};
    const required = new Set(schema.required || []);
    const args = Object.entries(schema.properties || {})
      .map(([name, prop]) => `${name}${required.has(name) ? "" : "?"}: ${prop.type || "any"}${prop.description ? ` (${prop.description})` : ""}`)
      .join(", ");
    lines.push(
      `${tool.name}\n  args: ${args || "none"}\n  desc: ${tool.description || ""}\n  example: node scripts/mcp-call.mjs ${exampleFor(tool.name)}`,
    );
  }
  console.log(lines.join("\n"));
} else if (command === "search") {
  const args = { query: rest[0] };
  if (rest[1]) args.numResults = Number(rest[1]);
  console.log(JSON.stringify(await callMcpTool("web_search_exa", args), null, 2));
} else if (command === "recall") {
  const args = { query: rest[0] };
  args.scope_dir = process.env.MODELDOCK_MEMORY_SCOPE || rest[1] || process.cwd();
  if (process.env.MODELDOCK_MEMORY_SCOPE) args.scope_only = true;
  if (rest[2]) args.limit = Number(rest[2]);
  console.log(await callMcpTool("recall_memory", args));
} else if (command === "store") {
  const args = { content: rest[0] };
  args.scope_dir = process.env.MODELDOCK_MEMORY_SCOPE || rest[1] || process.cwd();
  if (rest[2]) args.kind = rest[2];
  console.log(JSON.stringify(await callMcpTool("store_memory", args), null, 2));
} else if (command === "learn") {
  // Same scope contract as recall and store: an explicit scope wins, then the
  // pinned one, then wherever the shell is.
  const args = { path: rest[0] };
  args.scope_dir = process.env.MODELDOCK_MEMORY_SCOPE || rest[1] || process.cwd();
  console.log(JSON.stringify(await callMcpTool("learn", args), null, 2));
} else if (command === "vision") {
  const args = { path: rest[0], question: rest[1] };
  if (rest[2]) args.mode = rest[2];
  console.log(JSON.stringify(await callMcpTool("vision_inspect", args), null, 2));
} else if (command === "image") {
  // image_gen is a first-class tool but was missing here, so a stale MCP
  // connection took it away entirely while the instructions still called it
  // mandatory for frontend work.
  const args = { prompt: rest[0] };
  if (rest[1]) args.size = rest[1];
  if (rest[2]) args.model = rest[2];
  console.log(await callMcpTool("image_gen", args));
} else if (command === "video") {
  const args = rest[0] === "--status"
    ? { action: "status", request_id: rest[1] }
    : { action: "generate", prompt: rest[0] };
  if (args.action === "generate") {
    if (rest[1]) args.duration = Number(rest[1]);
    if (rest[2]) args.aspect_ratio = rest[2];
    if (rest[3]) args.resolution = rest[3];
    if (rest[4]) args.wait_seconds = Number(rest[4]);
  }
  console.log(JSON.stringify(await callMcpTool("grok_video_gen", args), null, 2));
} else if (command === "speak") {
  console.log(await callMcpTool("speak", { text: rest[0] }));
} else if (command === "hear") {
  console.log(await callMcpTool("hear", { file: rest[0] }));
} else {
  console.error("usage: node scripts/mcp-call.mjs <tools|list_mcp_tools|search|vision|image|video|speak|hear|recall|store|learn> ...");
  process.exitCode = 2;
}

function exampleFor(toolName) {
  const examples = {
    web_search_exa: 'search "query"',
    vision_inspect: 'vision <path> "question"',
    image_gen: 'image "prompt" [size]',
    grok_video_gen: 'video "prompt" [duration] [aspect_ratio] [resolution] [wait_seconds]',
    speak: 'speak "text"',
    hear: "hear <file>",
    recall_memory: 'recall "query" [scope_dir]',
    store_memory: 'store "content" [scope_dir] [kind]',
    learn: "learn <path> [scope_dir]",
  };
  return examples[toolName] || `${toolName} <args>`;
}

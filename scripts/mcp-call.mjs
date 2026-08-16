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
//   node scripts/mcp-call.mjs speak <text>
//   node scripts/mcp-call.mjs hear <file>
//   node scripts/mcp-call.mjs recall <query> [scope_dir] [limit]
//   node scripts/mcp-call.mjs store <content> [scope_dir] [kind]

import { callMcpTool, listMcpTools } from "../src/mcp-client.mjs";

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
} else if (command === "speak") {
  console.log(await callMcpTool("speak", { text: rest[0] }));
} else if (command === "hear") {
  console.log(await callMcpTool("hear", { file: rest[0] }));
} else {
  console.error("usage: node scripts/mcp-call.mjs <tools|list_mcp_tools|search|vision|image|speak|hear|recall|store> ...");
  process.exitCode = 2;
}

function exampleFor(toolName) {
  const examples = {
    web_search_exa: 'search "query"',
    vision_inspect: 'vision <path> "question"',
    image_gen: 'image "prompt" [size]',
    speak: 'speak "text"',
    hear: "hear <file>",
    recall_memory: 'recall "query" [scope_dir]',
    store_memory: 'store "content" [scope_dir] [kind]',
  };
  return examples[toolName] || `${toolName} <args>`;
}

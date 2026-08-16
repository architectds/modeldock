// Stdio MCP bridge for ModelDock.
//
// Codex spawns this process (the managed [mcp_servers.modeldock] entry written
// by src/config-switcher.mjs uses command/args instead of url), so its lifetime
// is owned by Codex and gateway restarts never kill it. Tools are registered
// locally - tools/list works even while the gateway is down - while web search
// and vision calls are forwarded to the gateway's keyed MCP endpoint. Speech tools
// (speak/hear) run fully local and never touch the gateway.
//
// Never write to stdout outside the MCP protocol: stdout is the transport.

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp.mjs";
import { callMcpTool, gatewayBaseUrl } from "./mcp-client.mjs";
import { loadConfig } from "./config.mjs";

const baseUrl = gatewayBaseUrl();
const config = loadConfig();

// Codex spawns this bridge from the session working directory, so process.cwd()
// is the project the user is actually in. Defaulting scope_dir to it makes
// stores land in the project bucket and recalls layer project-first without the
// model having to pass the path explicitly.
//
// MODELDOCK_MEMORY_SCOPE (set e.g. by pier for benchmark containers) overrides
// the scope entirely and turns on strict isolation: stores land in that one
// bucket and recalls never fall back to global memory, so a disposable test
// memory can never read or pollute the user's real vault.
const sessionScope = process.env.MODELDOCK_MEMORY_SCOPE || process.cwd();
const strictMemory = Boolean(process.env.MODELDOCK_MEMORY_SCOPE);
const withSessionScope = (args) => (args.scope_dir ? args : { ...args, scope_dir: sessionScope });
const recallScope = (args) => {
  const scoped = withSessionScope(args);
  return strictMemory && !scoped.scope_only ? { ...scoped, scope_only: true } : scoped;
};

const upstreams = {
  searchWeb: (args) => callMcpTool("web_search_exa", args, baseUrl),
  inspectVision: (args) => callMcpTool("vision_inspect", args, baseUrl),
  ...(config.memoryEnabled
    ? {
        recallMemory: (args) => callMcpTool("recall_memory", recallScope(args), baseUrl),
        storeMemory: (args) => callMcpTool("store_memory", withSessionScope(args), baseUrl),
        learnMemory: (args) => callMcpTool("learn", withSessionScope(args), baseUrl),
      }
    : {}),
};

const server = createMcpServer({ upstreams });

console.error(`[modeldock-mcp] stdio bridge starting; forwarding search/vision to ${baseUrl}/mcp`);
try {
  const transport = new StdioServerTransport();
  // Exit when the parent closes stdin. The SDK transport only watches data/error,
  // so a session that ends abruptly (Codex exit, kill, test teardown) would leave
  // this process orphaned forever without these handlers.
  const onStdinGone = () => {
    server.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on("end", onStdinGone);
  process.stdin.on("close", onStdinGone);
  await server.connect(transport);
} catch (error) {
  console.error(`[modeldock-mcp] stdio transport failed: ${error.message}`);
  process.exitCode = 1;
}
console.error("[modeldock-mcp] stdio transport closed");

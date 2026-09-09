import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { codexModelCatalog, createApp, createServices } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";
import { memoryScopeHeaders } from "../src/memory-scope.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return server.address().port;
}

test("publishes a complete Codex model catalog schema", () => {
  const catalog = codexModelCatalog({
    mainModel: "deepseek-v4-flash",
    // Keep the schema check hermetic: without a configured native catalog file
    // the merge would read the real ~/.modeldock capture on a dev machine and
    // the provider-grouped order would put a native GPT model first.
    nativeCatalogFile: path.join(os.tmpdir(), "modeldock-test-native-missing.json"),
  });
  assert.equal(catalog.models[0].slug, "deepseek-v4-flash@opencode-go");
  assert.equal(catalog.models[0].supports_reasoning_summaries, true);
  assert.match(catalog.models[0].base_instructions, /coding agent/);
  assert.equal(catalog.models[0].model_messages.instructions_variables.personality_pragmatic, "");
});

test("serves both local MCP tools over Streamable HTTP", async (t) => {
  // Keep the tool surface hermetic: the memory vault is opt-in, so the default
  // list is exactly the media/web/image tools regardless of the local .env.
  const loaded = loadConfig();
  const config = { ...loaded, tokens: { ...loaded.tokens, "opencode-go": "test-token" }, memoryEnabled: false };
  const instance = createApp(createServices(config));
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await instance.close();
    server.close();
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) };
  const bare = await fetch(`${base}/mcp`, request);
  assert.equal(bare.status, 401);
  assert.equal((await bare.json()).error.type, "caller_key_required");
  const wrong = await fetch(`${base}/c/not-the-caller-key-but-long-enough/mcp`, request);
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error.type, "invalid_caller_key");
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${instance.services.callerKey}/mcp`)));
  t.after(() => client.close());
  const result = await client.listTools();
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["hear", "image_gen", "preview_images", "speak", "vision_inspect", "web_search_exa"]);
});

test("gateway exposes memory writes only with an authenticated project scope", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-server-scopes-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const loaded = loadConfig();
  const config = {
    ...loaded,
    tokens: { ...loaded.tokens, "opencode-go": "test-token" },
    memoryEnabled: true,
    memoryDir: path.join(root, "memory"),
    memoryRefreshHours: 0,
    codexHome: path.join(root, "codex"),
  };
  const instance = createApp(createServices(config));
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await instance.close();
    server.close();
    instance.services.memoryStore?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const endpoint = new URL(`http://127.0.0.1:${server.address().port}/c/${instance.services.callerKey}/mcp`);
  const unscoped = new Client({ name: "unscoped", version: "1.0.0" });
  await unscoped.connect(new StreamableHTTPClientTransport(endpoint));
  t.after(() => unscoped.close());
  const unscopedNames = (await unscoped.listTools()).tools.map((tool) => tool.name);
  assert.ok(unscopedNames.includes("recall_memory"));
  assert.ok(!unscopedNames.includes("store_memory"), "direct HTTP MCP cannot bypass project write scoping");
  assert.ok(!unscopedNames.includes("learn"), "direct HTTP MCP cannot bulk-ingest into an arbitrary scope");

  const forged = new Client({ name: "forged", version: "1.0.0" });
  await forged.connect(new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: memoryScopeHeaders(projectA, "wrong-caller-key-0123456789-abcdef") },
  }));
  t.after(() => forged.close());
  const forgedNames = (await forged.listTools()).tools.map((tool) => tool.name);
  assert.ok(!forgedNames.includes("store_memory"), "a forged project scope degrades to the read-only surface");

  async function scopedClient(name, scope) {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: memoryScopeHeaders(scope, instance.services.callerKey) },
    }));
    t.after(() => client.close());
    return client;
  }

  const [clientA, clientB] = await Promise.all([
    scopedClient("project-a", projectA),
    scopedClient("project-b", projectB),
  ]);
  const scopedTools = (await clientA.listTools()).tools;
  assert.ok(scopedTools.some((tool) => tool.name === "store_memory"));
  assert.equal(scopedTools.find((tool) => tool.name === "store_memory")?.inputSchema?.properties?.scope_dir, undefined);
  assert.equal(scopedTools.find((tool) => tool.name === "learn")?.inputSchema?.properties?.scope_dir, undefined);

  const [storedA, storedB] = await Promise.all([
    clientA.callTool({ name: "store_memory", arguments: { content: "project A fact" } }),
    clientB.callTool({ name: "store_memory", arguments: { content: "project B fact" } }),
  ]);
  const resultA = JSON.parse(storedA.content[0].text);
  const resultB = JSON.parse(storedB.content[0].text);
  assert.equal(resultA.scope, projectA);
  assert.equal(resultB.scope, projectB);

  const escaped = await clientA.callTool({
    name: "store_memory",
    arguments: { content: "wrong project", scope_dir: projectB },
  });
  assert.equal(escaped.isError, true, "old callers with explicit write scopes are rejected");
});

test("adds both Grok media tools only for a connected xAI subscription", async (t) => {
  const config = { ...loadConfig(), tokens: { "opencode-go": "test-token", xai: "grok-subscription-token" }, memoryEnabled: false };
  const instance = createApp(createServices(config));
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await instance.close();
    server.close();
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const base = `http://127.0.0.1:${server.address().port}`;
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${instance.services.callerKey}/mcp`)));
  t.after(() => client.close());
  const result = await client.listTools();
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["grok_image_gen", "grok_video_gen", "hear", "image_gen", "preview_images", "speak", "vision_inspect", "web_search_exa"]);
});

test("serves the memory view when the vault is enabled", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-server-memory-"));
  const loaded = loadConfig();
  const config = {
    ...loaded,
    tokens: { ...loaded.tokens, "opencode-go": "test-token" },
    memoryEnabled: true,
    memoryDir: dir,
    memoryRefreshHours: 0,
    codexHome: path.join(dir, "codex"),
  };
  const instance = createApp(createServices(config));
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await instance.close();
    server.close();
    instance.services.memoryStore?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/memory/view`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.enabled, true);
  assert.ok(Array.isArray(data.content));
  assert.ok(Array.isArray(data.events));
  assert.equal(data.status.dbPath, path.join(dir, "global.db"));
});

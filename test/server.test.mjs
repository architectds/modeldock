import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { codexModelCatalog, createApp, createServices } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

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
  const config = { ...loadConfig(), goToken: "test-token", memoryEnabled: false };
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
  assert.deepEqual(result.tools.map((tool) => tool.name).sort(), ["grok_video_gen", "hear", "image_gen", "speak", "vision_inspect", "web_search_exa"]);
});

test("serves the memory view when the vault is enabled", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-server-memory-"));
  const config = {
    ...loadConfig(),
    goToken: "test-token",
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

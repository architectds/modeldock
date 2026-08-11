import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { startMcpServer } from "./mcp-server.mjs";

function configStub() {
  return {
    host: "127.0.0.1",
    recentLimit: 50,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 1024 * 1024,
    mediaMaxEntries: 8,
    visionModel: "gpt-5.6-luna",
    tokens: { "opencode-go": "go-token" },
    profileId: "opencode-go",
  };
}

async function rpc(url, method, params) {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      try {
        return { status: res.status, parsed: JSON.parse(data) };
      } catch {
        // Try the next data line.
      }
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { status: res.status, parsed };
}

test("MCP sidecar lists web, vision, and speech tools", async () => {
  const instance = await startMcpServer(configStub(), { port: 0 });
  try {
    const { status, parsed } = await rpc(instance.url, "tools/list");
    assert.equal(status, 200);
    const tools = parsed.result?.tools || [];
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("web_search_exa"), `missing web_search_exa in ${names.join(",")}`);
    assert.ok(names.includes("vision_inspect"), `missing vision_inspect in ${names.join(",")}`);
    assert.ok(names.includes("speak"), `missing speak in ${names.join(",")}`);
    assert.ok(names.includes("hear"), `missing hear in ${names.join(",")}`);
    assert.ok(!names.includes("recall_memory"), `recall_memory must be off by default in ${names.join(",")}`);
    assert.ok(!names.includes("store_memory"), `store_memory must be off by default in ${names.join(",")}`);
  } finally {
    await instance.stop();
  }
});

test("MCP sidecar registers recall_memory when memory is enabled", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mcp-memory-"));
  const config = { ...configStub(), memoryEnabled: true, memoryDir: dir };
  const instance = await startMcpServer(config, { port: 0 });
  const project = path.join(dir, "proj-mcp");
  mkdirSync(project);
  try {
    const { status, parsed } = await rpc(instance.url, "tools/list");
    assert.equal(status, 200);
    const names = (parsed.result?.tools || []).map((tool) => tool.name);
    assert.ok(names.includes("recall_memory"), `recall_memory missing from ${names.join(",")}`);
    assert.ok(names.includes("store_memory"), `store_memory missing from ${names.join(",")}`);
    const recallSchema = parsed.result.tools.find((tool) => tool.name === "recall_memory")?.inputSchema || {};
    assert.equal(
      recallSchema.properties?.scope_only?.type,
      "boolean",
      "gateway-side schema keeps scope_only so bridge-injected calls survive validation",
    );

    const call = await rpc(instance.url, "tools/call", {
      name: "recall_memory",
      arguments: { query: "baseline", scope_dir: project, scope_only: true },
    });
    assert.equal(call.status, 200);
    const text = call.parsed.result?.content?.[0]?.text || "";
    assert.match(text, /MEMORY_RECALL/);

    const store = await rpc(instance.url, "tools/call", {
      name: "store_memory",
      arguments: { content: "A test baseline for the vault.", kind: "baseline", scope_dir: project },
    });
    assert.equal(store.status, 200);
    const stored = JSON.parse(store.parsed.result?.content?.[0]?.text || "{}");
    assert.equal(stored.stored, true);
    assert.equal(stored.scope, project);

    const recalled = await rpc(instance.url, "tools/call", {
      name: "recall_memory",
      arguments: { query: "test baseline", scope_dir: project },
    });
    assert.equal(recalled.status, 200);
    const recallText = recalled.parsed.result?.content?.[0]?.text || "";
    assert.match(recallText, /key: /, "recall output exposes the entry key for later updates");
  } finally {
    await instance.stop();
    instance.services.memoryStore?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP sidecar routes web_search_exa calls to the search backend", async () => {
  let searched;
  const config = configStub();
  const instance = await startMcpServer(config, {
    port: 0,
    upstreams: {
      searchWeb: async (args) => {
        searched = args;
        return "search result text";
      },
      inspectVision: async () => ({ answer: "vision" }),
    },
  });
  try {
    const { status, parsed } = await rpc(instance.url, "tools/call", {
      name: "web_search_exa",
      arguments: { query: "deepseek news" },
    });
    assert.equal(status, 200);
    assert.deepEqual(searched, { query: "deepseek news" });
    const text = parsed.result?.content?.[0]?.text || "";
    assert.match(text, /search result text/);
  } finally {
    await instance.stop();
  }
});

test("MCP sidecar healthz reflects token configuration", async () => {
  const instance = await startMcpServer(configStub(), { port: 0 });
  try {
    const ok = await fetch(`${instance.url}/healthz`);
    assert.equal(ok.status, 200);
  } finally {
    await instance.stop();
  }
  const noToken = configStub();
  noToken.tokens = { "opencode-go": "" };
  const instance2 = await startMcpServer(noToken, { port: 0 });
  try {
    const bad = await fetch(`${instance2.url}/healthz`);
    assert.equal(bad.status, 503);
  } finally {
    await instance2.stop();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STANDALONE = fileURLToPath(new URL("../src/mcp-standalone.mjs", import.meta.url));

function startMockGateway() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      calls.push(message);
      let result = {};
      if (message.method === "tools/call") {
        result.content = [
          { type: "text", text: JSON.stringify({ forwarded: message.params.name, args: message.params.arguments }) },
        ];
      } else if (message.method === "tools/list") {
        result.tools = [];
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id ?? null, result })}\n\n`);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function startBridge(gatewayUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [STANDALONE], {
    env: { ...process.env, MODELDOCK_GATEWAY_URL: gatewayUrl, MODELDOCK_MEMORY: "0", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return { child, stderr: () => stderr };
}

function rpc(bridge, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} response`)), 8_000);
    const onData = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (parsed.id === id) {
          clearTimeout(timer);
          bridge.child.stdout.off("data", onData);
          resolve(parsed);
          return;
        }
      }
    };
    bridge.child.stdout.on("data", onData);
    bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(bridge, method, params) {
  bridge.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function stopBridge(bridge) {
  if (bridge.child.exitCode !== null) return;
  bridge.child.stdin.end();
  await Promise.race([once(bridge.child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (bridge.child.exitCode === null) bridge.child.kill();
}

test("stdio bridge omits Grok media tools before a Grok session is connected", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url);
  try {
    const init = await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "modeldock-opencode-go");
    notify(bridge, "notifications/initialized", {});
    const listed = await rpc(bridge, 2, "tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["hear", "image_gen", "speak", "vision_inspect", "web_search_exa"]);
    assert.equal(gateway.calls.some((m) => m.method === "tools/list"), false, "tools/list is served locally");
    const search = listed.result.tools.find((tool) => tool.name === "web_search_exa");
    assert.equal(
      search.annotations?.openWorldHint,
      false,
      "web search is read-only and must not be hidden by Codex's open-world gate",
    );
    // hear writes: sttTranscribe transcodes the input to a WAV with `ffmpeg -y`,
    // at the caller-supplied `output` path when one is given. A readOnlyHint of
    // true tells a client it can run the tool without a write confirmation.
    const hear = listed.result.tools.find((tool) => tool.name === "hear");
    assert.equal(
      hear.annotations?.readOnlyHint,
      false,
      "hear writes an intermediate WAV, so it must not be annotated read-only",
    );
    assert.equal(names.includes("grok_image_gen"), false);
    assert.equal(names.includes("grok_video_gen"), false);
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("stdio bridge exposes and forwards both Grok media tools only after login", async () => {
  const gateway = await startMockGateway();
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mcp-grok-"));
  mkdirSync(stateDir, { recursive: true });
  // Plaintext is acceptable only in this throwaway fixture. readXaiAuth accepts
  // it for migration compatibility; the production writer encrypts the file.
  writeFileSync(path.join(stateDir, "xai-auth.json"), JSON.stringify({
    accessToken: "grok-subscription-token",
    refreshToken: "",
    expiresAt: Date.now() + 60_000,
  }), "utf8");
  const bridge = startBridge(gateway.url, { MODELDOCK_STATE_DIR: stateDir });
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});
    const listed = await rpc(bridge, 2, "tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("grok_image_gen"), `grok_image_gen missing from ${names.join(",")}`);
    assert.ok(names.includes("grok_video_gen"), `grok_video_gen missing from ${names.join(",")}`);
    const video = listed.result.tools.find((tool) => tool.name === "grok_video_gen");
    assert.equal(video.annotations?.readOnlyHint, false, "video generation has an external side effect");
    const image = await rpc(bridge, 3, "tools/call", {
      name: "grok_image_gen",
      arguments: { prompt: "a small blue circle" },
    });
    assert.equal(JSON.parse(image.result.content[0].text).forwarded, "grok_image_gen");
  } finally {
    await stopBridge(bridge);
    await gateway.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("stdio bridge exposes recall_memory when memory is enabled and forwards calls", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url, { MODELDOCK_MEMORY: "1" });
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});
    const listed = await rpc(bridge, 2, "tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("recall_memory"), `recall_memory missing from ${names.join(",")}`);
    assert.ok(names.includes("store_memory"), `store_memory missing from ${names.join(",")}`);
    assert.ok(names.includes("learn"), `learn missing from ${names.join(",")}`);
    const recallSchema = listed.result.tools.find((tool) => tool.name === "recall_memory")?.inputSchema || {};
    assert.equal(
      recallSchema.properties?.scope_only,
      undefined,
      "scope_only must not be advertised to the model through the bridge tools/list",
    );
    assert.ok(recallSchema.properties?.scope_dir, "scope_dir stays visible for explicit project recalls");

    const called = await rpc(bridge, 3, "tools/call", {
      name: "recall_memory",
      arguments: { query: "qcm baseline", scope_dir: "D:\\projects\\stockscan", limit: 5 },
    });
    const parsed = JSON.parse(called.result.content[0].text);
    assert.equal(parsed.forwarded, "recall_memory");
    assert.deepEqual(parsed.args, { query: "qcm baseline", scope_dir: "D:\\projects\\stockscan", limit: 5 });
    const forward = gateway.calls.find((m) => m.method === "tools/call");
    assert.equal(forward.params.name, "recall_memory");
    assert.deepEqual(forward.params.arguments, { query: "qcm baseline", scope_dir: "D:\\projects\\stockscan", limit: 5 });

    const stored = await rpc(bridge, 4, "tools/call", {
      name: "store_memory",
      arguments: { content: "Remember the DIVO baseline.", kind: "baseline", scope_dir: "D:\\projects\\stockscan" },
    });
    const storedParsed = JSON.parse(stored.result.content[0].text);
    assert.equal(storedParsed.forwarded, "store_memory");
    assert.deepEqual(storedParsed.args, { content: "Remember the DIVO baseline.", kind: "baseline", scope_dir: "D:\\projects\\stockscan" });
    const storedForward = gateway.calls.filter((m) => m.method === "tools/call").find((m) => m.params.name === "store_memory");
    assert.equal(storedForward.params.name, "store_memory");
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("stdio bridge defaults recall and store to the session working directory", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url, { MODELDOCK_MEMORY: "1" });
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});

    const called = await rpc(bridge, 2, "tools/call", {
      name: "recall_memory",
      arguments: { query: "baseline" },
    });
    const parsed = JSON.parse(called.result.content[0].text);
    assert.equal(parsed.args.scope_dir, process.cwd(), "recall defaults to the session working directory");

    const stored = await rpc(bridge, 3, "tools/call", {
      name: "store_memory",
      arguments: { content: "Remember the DIVO baseline.", kind: "baseline" },
    });
    const storedParsed = JSON.parse(stored.result.content[0].text);
    assert.equal(storedParsed.args.scope_dir, process.cwd(), "store defaults to the session working directory");
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("MODELDOCK_MEMORY_SCOPE injects the bucket scope and strict recall", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url, {
    MODELDOCK_MEMORY: "1",
    MODELDOCK_MEMORY_SCOPE: "D:\\bench\\deepswe",
  });
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});

    const store = await rpc(bridge, 2, "tools/call", {
      name: "store_memory",
      arguments: { content: "benchmark fact" },
    });
    const storeParsed = JSON.parse(store.result.content[0].text);
    assert.deepEqual(storeParsed.args, { content: "benchmark fact", scope_dir: "D:\\bench\\deepswe" });

    const recall = await rpc(bridge, 3, "tools/call", {
      name: "recall_memory",
      arguments: { query: "benchmark fact" },
    });
    const recallParsed = JSON.parse(recall.result.content[0].text);
    assert.deepEqual(recallParsed.args, {
      query: "benchmark fact",
      scope_dir: "D:\\bench\\deepswe",
      scope_only: true,
    });
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("stdio bridge forwards web_search_exa calls to the gateway", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url);
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});
    const called = await rpc(bridge, 2, "tools/call", {
      name: "web_search_exa",
      arguments: { query: "hello", numResults: 3 },
    });
    const text = called.result.content[0].text;
    const parsed = JSON.parse(text);
    assert.equal(parsed.forwarded, "web_search_exa");
    assert.deepEqual(parsed.args, { query: "hello", numResults: 3 });
    const forward = gateway.calls.find((m) => m.method === "tools/call");
    assert.equal(forward.params.name, "web_search_exa");
    assert.deepEqual(forward.params.arguments, { query: "hello", numResults: 3 });
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("stdio bridge exits when the parent closes stdin", async () => {
  const gateway = await startMockGateway();
  const bridge = startBridge(gateway.url);
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    bridge.child.stdin.end();
    const [code] = await Promise.race([
      once(bridge.child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("bridge did not exit after stdin closed")), 3_000)),
    ]);
    assert.equal(code, 0);
  } finally {
    await gateway.close();
  }
});

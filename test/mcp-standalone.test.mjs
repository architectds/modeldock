import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalMemoryScope, verifiedMemoryScope } from "../src/memory-scope.mjs";

const STANDALONE = process.env.MODELDOCK_TEST_MCP_BUNDLE
  || (process.env.MODELDOCK_TEST_BUNDLE
    ? path.join(path.dirname(path.resolve(process.env.MODELDOCK_TEST_BUNDLE)), "mcp-standalone.mjs")
    : fileURLToPath(new URL("../dist/mcp-standalone.mjs", import.meta.url)));
const CALLER_KEY = "test-caller-key-0123456789-abcdef";
const MCP_HELPER = process.env.MODELDOCK_TEST_MCP_HELPER
  || fileURLToPath(new URL("../scripts/mcp-call.mjs", import.meta.url));

function startMockGateway({ imageError = false, toolErrors = false } = {}) {
  const calls = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      calls.push(message);
      requests.push({ message, headers: req.headers });
      let result = {};
      if (message.method === "tools/call") {
        result.content = message.params.name === "preview_images"
          ? [
              { type: "text", text: JSON.stringify({ forwarded: message.params.name, args: message.params.arguments }) },
              { type: "image", data: Buffer.from("preview-bytes").toString("base64"), mimeType: "image/jpeg" },
            ]
          : [
              { type: "text", text: JSON.stringify({ forwarded: message.params.name, args: message.params.arguments }) },
            ];
        if (imageError && message.params.name === "image_gen") {
          result = { content: [{ type: "text", text: "Native image API returned 503: fixture unavailable" }], isError: true };
        }
        if (toolErrors) {
          result = { content: [{ type: "text", text: `Fixture ${message.params.name} failed` }], isError: true };
        }
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
        url: `http://127.0.0.1:${server.address().port}/c/${CALLER_KEY}`,
        calls,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function startBridge(gatewayUrl, extraEnv = {}, cwd = process.cwd()) {
  const child = spawn(process.execPath, [STANDALONE], {
    env: { ...process.env, MODELDOCK_GATEWAY_URL: gatewayUrl, MODELDOCK_MEMORY: "0", ...extraEnv },
    cwd,
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
    assert.deepEqual(names.sort(), ["hear", "image_gen", "preview_images", "speak", "vision_inspect", "web_search_exa"]);
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
    const preview = await rpc(bridge, 3, "tools/call", {
      name: "preview_images",
      arguments: { paths: ["D:\\shots\\page.png"] },
    });
    assert.equal(preview.result.content[1].type, "image");
    assert.equal(Buffer.from(preview.result.content[1].data, "base64").toString(), "preview-bytes");
    assert.equal(gateway.calls.find((message) => message.params?.name === "preview_images")?.params.arguments.paths[0], "D:\\shots\\page.png");
    for (const [index, threadId] of ["task-a", "task-b", "task-a"].entries()) {
      const vision = await rpc(bridge, 10 + index, "tools/call", {
        name: "vision_inspect", arguments: { image_ref: "img_fixture", question: "read" }, _meta: { threadId },
      });
      assert.equal(vision.result.isError, undefined);
      assert.equal(gateway.requests.at(-1).headers.session_id, threadId);
      assert.equal(gateway.calls.at(-1).params.arguments.sessionId, undefined, "identity must not become a model-visible tool argument");
    }
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
    for (const [index, args] of [
      { action: "generate", prompt: "a blue circle moving right", duration: 2, wait_seconds: 0 },
      { action: "status", request_id: "fixture-video-request" },
    ].entries()) {
      const called = await rpc(bridge, 4 + index, "tools/call", { name: "grok_video_gen", arguments: args });
      assert.equal(called.result.isError, undefined);
      assert.deepEqual(JSON.parse(called.result.content[0].text), { forwarded: "grok_video_gen", args });
      assert.deepEqual(gateway.calls.at(-1).params, { name: "grok_video_gen", arguments: args });
    }
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
    const storeSchema = listed.result.tools.find((tool) => tool.name === "store_memory")?.inputSchema || {};
    const learnSchema = listed.result.tools.find((tool) => tool.name === "learn")?.inputSchema || {};
    assert.equal(storeSchema.properties?.scope_dir, undefined, "store scope is owned by the session bridge");
    assert.equal(learnSchema.properties?.scope_dir, undefined, "learn scope is owned by the session bridge");

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

    const rejected = await rpc(bridge, 4, "tools/call", {
      name: "store_memory",
      arguments: { content: "Remember the DIVO baseline.", kind: "baseline", scope_dir: "D:\\projects\\stockscan" },
    });
    assert.equal(rejected.result.isError, true, "an old caller cannot override the write scope");

    const stored = await rpc(bridge, 5, "tools/call", {
      name: "store_memory",
      arguments: { content: "Remember the DIVO baseline.", kind: "baseline" },
    });
    const storedParsed = JSON.parse(stored.result.content[0].text);
    assert.equal(storedParsed.forwarded, "store_memory");
    assert.deepEqual(storedParsed.args, { content: "Remember the DIVO baseline.", kind: "baseline" });
    const storedForward = gateway.calls.filter((m) => m.method === "tools/call").find((m) => m.params.name === "store_memory");
    assert.equal(storedForward.params.name, "store_memory");
    const storedRequest = gateway.requests.find((request) => request.message.params?.name === "store_memory");
    assert.equal(verifiedMemoryScope(storedRequest.headers, CALLER_KEY), canonicalMemoryScope(process.cwd()));
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
    assert.equal(parsed.args.scope_dir, canonicalMemoryScope(process.cwd()), "recall defaults to the canonical session working directory");

    const stored = await rpc(bridge, 3, "tools/call", {
      name: "store_memory",
      arguments: { content: "Remember the DIVO baseline.", kind: "baseline" },
    });
    const storedParsed = JSON.parse(stored.result.content[0].text);
    assert.equal(storedParsed.args.scope_dir, undefined, "write scope travels as authenticated boundary metadata, not a model argument");
    const storedRequest = gateway.requests.find((request) => request.message.params?.name === "store_memory");
    assert.equal(verifiedMemoryScope(storedRequest.headers, CALLER_KEY), canonicalMemoryScope(process.cwd()));
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

test("two project bridges authenticate distinct write scopes and reject model overrides", async () => {
  const gateway = await startMockGateway();
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-mcp-projects-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  mkdirSync(projectA);
  mkdirSync(projectB);
  const bridgeA = startBridge(gateway.url, { MODELDOCK_MEMORY: "1" }, projectA);
  const bridgeB = startBridge(gateway.url, { MODELDOCK_MEMORY: "1" }, projectB);
  try {
    for (const bridge of [bridgeA, bridgeB]) {
      await rpc(bridge, 1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      notify(bridge, "notifications/initialized", {});
    }
    await Promise.all([
      rpc(bridgeA, 2, "tools/call", { name: "store_memory", arguments: { content: "project A" } }),
      rpc(bridgeB, 2, "tools/call", { name: "store_memory", arguments: { content: "project B" } }),
    ]);

    const scopes = gateway.requests
      .filter((request) => request.message.params?.name === "store_memory")
      .map((request) => verifiedMemoryScope(request.headers, CALLER_KEY))
      .sort();
    assert.deepEqual(scopes, [canonicalMemoryScope(projectA), canonicalMemoryScope(projectB)].sort());

    const rejectedLearn = await rpc(bridgeA, 3, "tools/call", {
      name: "learn",
      arguments: { path: path.join(projectA, "notes.md"), scope_dir: projectB },
    });
    assert.equal(rejectedLearn.result.isError, true, "learn cannot assign content to another project");
    assert.equal(
      gateway.calls.some((message) => message.params?.name === "learn"),
      false,
      "rejected learn calls never reach the gateway",
    );
    const learned = await rpc(bridgeA, 4, "tools/call", {
      name: "learn", arguments: { path: path.join(projectA, "notes.md") },
    });
    assert.equal(learned.result.isError, undefined);
    assert.deepEqual(JSON.parse(learned.result.content[0].text), {
      forwarded: "learn", args: { path: path.join(projectA, "notes.md") },
    });
    assert.equal(verifiedMemoryScope(gateway.requests.at(-1).headers, CALLER_KEY), canonicalMemoryScope(projectA));
  } finally {
    await stopBridge(bridgeA);
    await stopBridge(bridgeB);
    await gateway.close();
    rmSync(root, { recursive: true, force: true });
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
    assert.deepEqual(storeParsed.args, { content: "benchmark fact" });
    const fixedScope = canonicalMemoryScope("D:\\bench\\deepswe");
    const storeRequest = gateway.requests.find((request) => request.message.params?.name === "store_memory");
    assert.equal(verifiedMemoryScope(storeRequest.headers, CALLER_KEY), fixedScope);

    const recall = await rpc(bridge, 3, "tools/call", {
      name: "recall_memory",
      arguments: { query: "benchmark fact" },
    });
    const recallParsed = JSON.parse(recall.result.content[0].text);
    assert.deepEqual(recallParsed.args, {
      query: "benchmark fact",
      scope_dir: fixedScope,
      scope_only: true,
    });

    const rejectedRecall = await rpc(bridge, 4, "tools/call", {
      name: "recall_memory",
      arguments: { query: "benchmark fact", scope_dir: "D:\\another-project" },
    });
    assert.equal(rejectedRecall.result.isError, true, "strict recall cannot escape the configured scope");
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

for (const imageError of [false, true]) test(imageError
  ? "built stdio image_gen preserves a gateway tool failure"
  : "built stdio image_gen reaches the keyed gateway and returns its result", async () => {
  const gateway = await startMockGateway({ imageError });
  const bridge = startBridge(gateway.url);
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "codex-image-replay", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});
    const listed = await rpc(bridge, 2, "tools/list", {});
    assert.ok(listed.result.tools.some((tool) => tool.name === "image_gen"));
    const args = { prompt: "A red apple on a wooden table.", size: "1024x1024", model: "gpt-image-1" };
    const called = await rpc(bridge, 3, "tools/call", { name: "image_gen", arguments: args });
    const forwarded = gateway.calls.filter((message) => message.method === "tools/call");
    assert.equal(forwarded.length, 1, "advertising image_gen is insufficient: the invocation must reach the gateway");
    assert.equal(forwarded[0].params.name, "image_gen");
    assert.deepEqual(forwarded[0].params.arguments, args);
    if (imageError) {
      assert.equal(called.result.isError, true, "gateway failures must not become successful stdio results");
      assert.match(called.result.content[0].text, /Native image API returned 503: fixture unavailable/);
    } else {
      assert.equal(called.result.isError, undefined);
      assert.deepEqual(JSON.parse(called.result.content[0].text), { forwarded: "image_gen", args });
    }
  } finally {
    await stopBridge(bridge);
    await gateway.close();
  }
});

for (const imageError of [false, true]) test(imageError
  ? "shipped MCP helper exits with failure when image_gen returns a tool error"
  : "shipped MCP helper forwards image_gen and returns its successful result", { timeout: 15_000 }, async () => {
  const gateway = await startMockGateway({ imageError });
  const args = { prompt: "fixture helper image", size: "1024x1024", model: "gpt-image-1" };
  const child = spawn(process.execPath, [MCP_HELPER, "image", args.prompt, args.size, args.model], {
    env: { ...process.env, MODELDOCK_GATEWAY_URL: gateway.url },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const [code] = await once(child, "exit");
    const calls = gateway.calls.filter((message) => message.method === "tools/call");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, { name: "image_gen", arguments: args });
    if (imageError) {
      assert.notEqual(code, 0, "tool errors must not become successful CLI exits");
      assert.equal(stdout, "");
      assert.match(stderr, /Native image API returned 503: fixture unavailable/);
    } else {
      assert.equal(code, 0, stderr);
      assert.match(stdout, /forwarded: 'image_gen'/);
      assert.match(stdout, /prompt: 'fixture helper image'/);
    }
  } finally {
    await stopBridge({ child });
    await gateway.close();
  }
});

test("every gateway-backed stdio tool reaches the gateway and preserves its tool error", async () => {
  const gateway = await startMockGateway({ toolErrors: true });
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-mcp-all-tools-"));
  writeFileSync(path.join(stateDir, "xai-auth.json"), JSON.stringify({
    accessToken: "fixture-grok-token", expiresAt: Date.now() + 60_000,
  }), "utf8");
  const bridge = startBridge(gateway.url, { MODELDOCK_MEMORY: "1", MODELDOCK_STATE_DIR: stateDir });
  try {
    await rpc(bridge, 1, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "all-tool-invocations", version: "1.0.0" },
    });
    notify(bridge, "notifications/initialized", {});
    const listed = await rpc(bridge, 2, "tools/list", {});
    const calls = {
      web_search_exa: { query: "fixture search" },
      vision_inspect: { image_ref: "img_fixture", question: "fixture vision" },
      preview_images: { paths: [path.join(stateDir, "shot.png")] },
      image_gen: { prompt: "fixture native image" },
      grok_image_gen: { prompt: "fixture grok image" },
      grok_video_gen: { action: "status", request_id: "fixture-video-request" },
      recall_memory: { query: "fixture memory", scope_dir: stateDir },
      store_memory: { content: "fixture memory", kind: "knowledge" },
      learn: { path: path.join(stateDir, "notes.md") },
    };
    assert.deepEqual(listed.result.tools.map((tool) => tool.name).filter((name) => name !== "speak" && name !== "hear").sort(),
      Object.keys(calls).sort(), "every advertised gateway tool needs an actual invocation, not just a list assertion");
    for (const [index, [name, args]] of Object.entries(calls).entries()) {
      const called = await rpc(bridge, index + 3, "tools/call", { name, arguments: args });
      assert.equal(gateway.calls.at(-1).method, "tools/call", name);
      assert.deepEqual(gateway.calls.at(-1).params, { name, arguments: args }, `${name} must reach the keyed gateway`);
      assert.equal(called.result.isError, true, `${name} must not turn an upstream tool error into a successful result`);
      assert.match(called.result.content[0].text, new RegExp(`Fixture ${name} failed`));
    }
    assert.equal(gateway.calls.filter((message) => message.method === "tools/call").length, Object.keys(calls).length);
  } finally {
    await stopBridge(bridge);
    await gateway.close();
    rmSync(stateDir, { recursive: true, force: true });
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

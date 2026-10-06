import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.resolve(process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs"));
const stdioBundle = path.join(path.dirname(bundle), "mcp-standalone.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function parseMcpResponse(response) {
  const body = await response.text();
  if ((response.headers.get("content-type") || "").includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { return JSON.parse(line.slice(5).trim()); } catch { /* inspect the next event */ }
    }
  }
  return JSON.parse(body);
}

function startStdioBridge(baseUrl, root) {
  const child = spawn(process.execPath, [stdioBundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_GATEWAY_URL: baseUrl,
      MODELDOCK_STATE_DIR: path.join(root, "stdio-state"),
      MODELDOCK_CODEX_HOME: path.join(root, "stdio-codex"),
      MODELDOCK_MEMORY: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  let stderr = "";
  const pending = new Map();
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      } catch { /* ignore protocol diagnostics */ }
    }
  });
  let nextId = 0;
  const rpc = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}: ${stderr}`));
      }, 10_000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  return { child, rpc, notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`) };
}

test("built gateway preserves Exa JSON-RPC tool errors through HTTP and stdio MCP", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-exa-errors-"));
  const callerKey = "fixture-exa-errors-caller-0123456789";
  const scenarios = new Map([
    ["json-error", { kind: "json-error", message: "Exa JSON tool failure" }],
    ["sse-error", { kind: "sse-error", message: "Exa SSE tool failure" }],
    ["rpc-error", { kind: "rpc-error", message: "Exa JSON-RPC failure" }],
    ["empty-error", { kind: "empty-error", message: "Exa MCP returned a tool error" }],
    ["success", { kind: "success", message: "EXA_TEXT_SUCCESS" }],
  ]);
  const seen = [];
  const exa = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === "/prices/dev" || req.url === "/prices/router") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    let request;
    try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const args = request?.params?.arguments || {};
    const queryMatch = /^(json-error|sse-error|rpc-error|empty-error|success)_(http|stdio)_\d+$/.exec(args.query);
    const mode = queryMatch?.[1];
    const scenario = scenarios.get(mode);
    seen.push({ request, mode });
    if (request.jsonrpc !== "2.0" || request.method !== "tools/call"
        || request.params?.name !== "web_search_exa"
        || JSON.stringify(args) !== JSON.stringify({ query: args.query, type: "auto", numResults: 8, livecrawl: "fallback" })
        || !scenario || !queryMatch) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unexpected Exa request" }));
      return;
    }
    const payload = scenario.kind === "rpc-error"
      ? { jsonrpc: "2.0", id: request.id, error: { code: -32001, message: scenario.message } }
      : { jsonrpc: "2.0", id: request.id, result: scenario.kind === "empty-error" ? { isError: true } : {
        ...(scenario.kind === "json-error" || scenario.kind === "sse-error" ? { isError: true } : {}),
        content: [{ type: "text", text: scenario.message }],
      } };
    if (scenario.kind === "sse-error") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  const exaPort = await listen(exa);
  let instance;
  let stdio;
  t.after(async () => {
    if (stdio) {
      stdio.child.stdin.end();
      await stop(stdio.child);
    }
    if (instance) await instance.stop();
    await closeServer(exa);
    await rm(root, { recursive: true, force: true });
  });

  const bundleUrl = pathToFileURL(bundle).href;
  const { startServer } = await import(bundleUrl);
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  const exaOrigin = `http://127.0.0.1:${exaPort}`;
  instance = await startServer({
    host: "127.0.0.1", port: 0,
    profileId: "opencode-go", tokens: { "opencode-go": "fixture-provider-token" },
    opencodeBaseUrl: "http://127.0.0.1:1/v1", mainModel: "deepseek-v4-flash", visionModel: "none",
    codexHome, callerKey, exaMcpUrl: `${exaOrigin}/mcp`, exaApiKey: "",
    stateDir, nativeCatalogFile: path.join(stateDir, "native-catalog.json"), codexCatalogFile: path.join(stateDir, "codex-catalog.json"),
    usageRollupFile: path.join(stateDir, "usage-rollup.json"), usageEventsFile: path.join(stateDir, "usage-events.jsonl"),
    summariesFile: path.join(stateDir, "summaries.json"), apiPricesFile: path.join(stateDir, "api-prices.json"),
    modelsDevPricesUrl: `${exaOrigin}/prices/dev`, openRouterPricesUrl: `${exaOrigin}/prices/router`, apiPricesTimeoutMs: 500,
    refreshNativeCatalog: false, modelDiscoveryEnabled: false, memoryEnabled: false, autostartDefault: false,
    debug: { noSessionCheck: true }, recentLimit: 50,
    mediaTtlMs: 60_000, mediaMaxBytes: 1024 * 1024, mediaMaxEntries: 8,
  });
  const api = `http://127.0.0.1:${instance.server.address().port}`;
  const keyedBase = `${api}/c/${callerKey}`;
  stdio = startStdioBridge(keyedBase, root);
  const initialized = await stdio.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "exa-e2e", version: "1" } });
  assert.equal(initialized.result?.serverInfo?.name, "modeldock-opencode-go");
  stdio.notify("notifications/initialized", {});

  const httpRpc = async (id, method, params) => {
    const response = await fetch(`${keyedBase}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    assert.equal(response.status, 200);
    return parseMcpResponse(response);
  };
  await httpRpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "exa-e2e-http", version: "1" } });

  const status = async () => (await (await fetch(`${api}/api/status`)).json());
  const checkCall = async ({ ingress, mode, index }) => {
    const query = `${mode}_${ingress}_${index}`;
    const rpc = ingress === "http"
      ? await httpRpc(10 + index, "tools/call", { name: "web_search_exa", arguments: { query } })
      : await stdio.rpc("tools/call", { name: "web_search_exa", arguments: { query } });
    const isError = mode !== "success";
    assert.equal(Boolean(rpc.result?.isError), isError, `${query} result error flag`);
    assert.match(rpc.result?.content?.[0]?.text || "", new RegExp(scenarios.get(mode).message));
    const snapshot = await status();
    const metric = snapshot.recent.find((item) => item.kind === "web" && item.query === query);
    assert.ok(metric, `${query} has a web diagnostic record`);
    assert.equal(metric.status, isError ? "error" : "ok", `${query} diagnostics must match the MCP result`);
  };

  let index = 0;
  for (const mode of ["json-error", "sse-error", "rpc-error", "empty-error", "success"]) {
    await checkCall({ ingress: "http", mode, index: index++ });
    await checkCall({ ingress: "stdio", mode, index: index++ });
  }
  assert.equal(seen.length, 10, "each MCP ingress sends exactly one strict Exa request per case");
  assert.deepEqual(seen.map((entry) => entry.request.params.name), Array(10).fill("web_search_exa"));
  const snapshot = await status();
  assert.equal(snapshot.web.errors, 8, "all four Exa error envelopes count as failures through both entrances");
  assert.equal(snapshot.web.ok, 2, "normal text results count as successes through both entrances");
});

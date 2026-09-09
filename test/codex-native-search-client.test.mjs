import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repoRoot, "dist", "modeldock.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => {
    if (error?.code === "ERR_SERVER_NOT_RUNNING") return resolve();
    if (error) return reject(error);
    resolve();
  }));
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function removeFixtureRoot(root) {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has(error?.code)) throw error;
  }
}

async function waitForGateway(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch {
      // The built bundle may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("built gateway did not start");
}

function sse(events) {
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function completed(id) {
  return {
    type: "response.completed",
    response: {
      id,
      usage: {
        input_tokens: 0,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: 0,
      },
    },
  };
}

function customToolStream() {
  return sse([
    { type: "response.created", response: { id: "resp-search-1" } },
    {
      type: "response.output_item.done",
      item: {
        type: "custom_tool_call",
        call_id: "call-search-1",
        name: "exec",
        input: [
          "const result = await tools.web__run({",
          "  search_query: [{ q: 'ModelDock Codex native search test' }],",
          "  response_length: 'short',",
          "});",
          "text(result);",
        ].join("\n"),
      },
    },
    completed("resp-search-1"),
  ]);
}

function finalStream() {
  return sse([
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "msg-search-done",
        content: [{ type: "output_text", text: "NATIVE_SEARCH_PROXY_E2E_OK" }],
      },
    },
    completed("resp-search-2"),
  ]);
}

function bundledSearchModel() {
  const result = spawnSync("codex", ["debug", "models", "--bundled"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") return null;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const catalog = JSON.parse(result.stdout);
  return catalog.models.find((entry) => entry?.tool_mode === "code_mode_only" && entry?.supports_search_tool)
    || null;
}

test("installed Codex web__run crosses the keyed native search relay", { timeout: 180_000 }, async (t) => {
  const nativeModel = bundledSearchModel();
  if (!nativeModel) {
    t.skip("installed Codex has no native code-mode search model");
    return;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-native-search-"));
  const stateDir = path.join(root, "state");
  const gatewayCodexHome = path.join(root, "gateway-codex-home");
  const clientCodexHome = path.join(root, "client-codex-home");
  const workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(gatewayCodexHome, { recursive: true }),
    mkdir(clientCodexHome, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  t.after(() => removeFixtureRoot(root));
  await writeFile(path.join(gatewayCodexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "chatgpt-native-token", account_id: "acct-native" },
  }), "utf8");

  const responseRequests = [];
  const searchRequests = [];
  const native = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === "/alpha/search") {
      searchRequests.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output: "SEARCH_PROXY_E2E_RESULT" }));
      return;
    }
    if (req.url !== "/responses") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected native path" }));
      return;
    }
    responseRequests.push({ headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(responseRequests.length === 1 ? customToolStream() : finalStream());
  });
  const nativePort = await listen(native);
  t.after(() => closeServer(native));

  const nativeCatalogFile = path.join(stateDir, "native-catalog.json");
  await writeFile(nativeCatalogFile, JSON.stringify({
    captured_with: "installed-test-client",
    models: [nativeModel],
  }), "utf8");

  const portProbe = http.createServer();
  const gatewayPort = await listen(portProbe);
  await closeServer(portProbe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\codex-native-search-${process.pid}`;
  const autostartName = `ModelDockCodexNativeSearch${process.pid}`;
  const gateway = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_UPSTREAM_BASE_URL: "http://127.0.0.1:1/v1",
      OPENCODE_GO_TOKEN: "fixture-token",
      CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${nativePort}`,
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CODEX_HOME: gatewayCodexHome,
      MODELDOCK_NATIVE_CATALOG_FILE: nativeCatalogFile,
      MODELDOCK_NATIVE_MERGE: "1",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_MEMORY: "0",
      MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey,
      MODELDOCK_AUTOSTART_NAME: autostartName,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let gatewayStderr = "";
  gateway.stderr.on("data", (chunk) => { gatewayStderr += chunk; });
  t.after(async () => {
    await stop(gateway);
    if (process.platform === "win32") {
      spawnSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore", windowsHide: true });
    }
  });
  await waitForGateway(gatewayPort);

  const catalogFile = path.join(stateDir, "codex-model-catalog.json");
  const callerKey = (await readFile(path.join(stateDir, "caller-key"), "utf8")).trim();
  const args = [
    "exec", "--ephemeral", "--skip-git-repo-check", "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox", "--color", "never", "--json",
    "-C", workspace,
    "-c", `model=${JSON.stringify(nativeModel.slug)}`,
    "-c", `openai_base_url=${JSON.stringify(`http://127.0.0.1:${gatewayPort}/c/${callerKey}/v1`)}`,
    "-c", `model_catalog_json=${JSON.stringify(catalogFile.replace(/\\/g, "/"))}`,
    "-c", "web_search=\"live\"",
    "-c", "approval_policy=\"never\"",
    "-c", "sandbox_mode=\"workspace-write\"",
    "Use your native web search and then reply with the final marker.",
  ];
  const codex = spawn("codex", args, {
    env: { ...process.env, CODEX_HOME: clientCodexHome, OPENAI_API_KEY: "fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  codex.stdout.on("data", (chunk) => { stdout += chunk; });
  codex.stderr.on("data", (chunk) => { stderr += chunk; });
  const [exitCode] = await once(codex, "exit");

  assert.equal(exitCode, 0, `${stderr}\n${stdout}\n${gatewayStderr}`);
  assert.match(stdout, /NATIVE_SEARCH_PROXY_E2E_OK/);
  assert.equal(searchRequests.length, 1, "the real Codex client must execute exactly one native web search");
  assert.equal(searchRequests[0].headers.authorization, "Bearer chatgpt-native-token");
  assert.equal(searchRequests[0].headers["chatgpt-account-id"], "acct-native");
  assert.equal(searchRequests[0].body.model, nativeModel.slug);
  assert.deepEqual(searchRequests[0].body.commands, {
    search_query: [{ q: "ModelDock Codex native search test" }],
    response_length: "short",
  });
  assert.equal(responseRequests.length, 2, "Codex must continue the model turn after search");
  const continuation = responseRequests[1].body.input.find((item) => item?.type === "custom_tool_call_output");
  assert.ok(continuation, "the native search result must return to the same custom tool call");
  assert.match(JSON.stringify(continuation), /SEARCH_PROXY_E2E_RESULT/);
});

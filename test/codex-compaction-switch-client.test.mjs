// Actual installed-client proof, separate from the deterministic wire fixture:
// create a thread on A, make A unavailable, resume on B across comp_hash values.
// Both Codex and the gateway use disposable state; no real account is loaded.
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repo, "dist/modeldock.mjs");
const slug = (model) => `mdr.${Buffer.from("opencode-go").toString("base64url")}.${Buffer.from(model).toString("base64url")}`;
async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
}

test("installed Codex switches away from an unavailable model before pre-turn compaction", { timeout: 120_000 }, async (t) => {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (probe.error?.code === "ENOENT") return t.skip("Codex is not installed on this test host");
  assert.equal(probe.status, 0, probe.stderr);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-compact-switch-client-"));
  const state = path.join(root, "state"), home = path.join(root, "codex");
  await mkdir(state); await mkdir(home);
  const requests = [], ingress = [];
  let switching = false, gateway;
  const clients = [];
  const autostartKey = `HKCU\\Software\\ModelDockTests\\compact-switch-${process.pid}`;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET") { res.end('{"data":[]}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    if (switching && body.model === "deepseek-v4-pro") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"error":{"message":"old model retired"}}'); return;
    }
    const id = `resp_switch_${requests.length}`;
    const item = { type: "message", id: `msg_switch_${requests.length}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: body.stream === false ? "The task is to reply SWITCH_COMPACT_OK. Continue it." : "SWITCH_COMPACT_OK" }] };
    const response = { id, status: "completed", model: body.model, output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
    if (body.stream === false) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([{ type: "response.created", response: { id } }, { type: "response.output_item.done", item },
      { type: "response.completed", response }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  t.after(async () => {
    for (const child of clients) await stop(child);
    await stop(gateway);
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
    if (process.platform === "win32") try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* fixture only */ }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const origin = `http://127.0.0.1:${await listen(upstream)}`;
  const portProbe = http.createServer(); const port = await listen(portProbe);
  await new Promise((resolve) => portProbe.close(resolve));
  const api = `http://127.0.0.1:${port}`;
  const redirect = path.join(root, "fetch.mjs");
  await writeFile(redirect, `const original=globalThis.fetch;
globalThis.fetch=(input,options)=>{
 const url=new URL(String(input));
 if(url.origin!==${JSON.stringify(origin)}) throw Error('isolated test blocked external fetch: '+url.origin);
 return original(input,options);
};`);
  gateway = spawn(process.execPath, ["--import", pathToFileURL(redirect).href, bundle], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MODELDOCK_PORT: String(port), MODELDOCK_PROFILE: "opencode-go",
      MODELDOCK_STATE_DIR: state, MODELDOCK_ENV_FILE: path.join(state, ".env"), MODELDOCK_CODEX_HOME: home,
      MODELDOCK_USAGE_EVENTS_FILE: path.join(state, "usage.jsonl"), MODELDOCK_SETTINGS_EVENTS_FILE: path.join(state, "settings.jsonl"),
      MODELDOCK_CUSTOM_ENDPOINTS_FILE: path.join(state, "endpoints.json"),
      MODELDOCK_UPSTREAM_BASE_URL: `${origin}/v1`, OPENCODE_GO_TOKEN: "fixture-only",
      MODELDOCK_REQUIRE_CALLER_KEY: "0", MODELDOCK_MEMORY: "0", MODELDOCK_VISION_MODEL: "none",
      MODELDOCK_NATIVE_MERGE: "0", MODELDOCK_REFRESH_NATIVE_CATALOG: "0", MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey, MODELDOCK_AUTOSTART_NAME: `ModelDockSwitchClient${process.pid}` },
  });
  let logs = ""; gateway.stdout.on("data", (x) => { logs += x; }); gateway.stderr.on("data", (x) => { logs += x; });
  let ready = false;
  for (let n = 0; n < 150; n++) {
    try { if ((await fetch(`${api}/api/status`)).ok) { ready = true; break; } } catch { /* starting */ }
    if (gateway.exitCode !== null) throw Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const catalog = JSON.parse(await readFile(path.join(state, "codex-model-catalog.json"), "utf8"));
  const models = [slug("deepseek-v4-pro"), slug("deepseek-v4.1-flash")];
  catalog.models = models.map((slug, i) => ({ ...catalog.models.find((entry) => entry.slug === slug), slug,
    comp_hash: `switch-probe-${i}`, base_instructions: "Reply SWITCH_COMPACT_OK. Do not use tools.",
    model_messages: { instructions_template: "Reply SWITCH_COMPACT_OK. Do not use tools." } }));
  const catalogFile = path.join(root, "models.json"); await writeFile(catalogFile, JSON.stringify(catalog));
  // A test-only proxy records the actual client model before gateway rewriting.
  const proxy = http.createServer(async (req, res) => {
    if (req.headers.upgrade) { res.writeHead(426, { connection: "close" }); res.end(); return; }
    const chunks = []; for await (const x of req) chunks.push(x);
    const bytes = Buffer.concat(chunks);
    if (bytes.length) { const body = JSON.parse(bytes); ingress.push({ model: body.model, compact: body.input?.at(-1)?.type === "compaction_trigger" }); }
    const response = await fetch(`${api}${req.url}`, { method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` }, ...(bytes.length ? { body: bytes } : {}) });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); });
  const config = ["-c", `openai_base_url="http://127.0.0.1:${proxyPort}/v1"`, "-c", `model_catalog_json=${JSON.stringify(catalogFile.replace(/\\/g, "/"))}`,
    "-c", "features.apps=false", "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'];
  async function run(args) {
    const client = spawn("codex", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, OPENAI_API_KEY: "fixture-only" } });
    clients.push(client); let out = "", err = "";
    client.stdout.on("data", (x) => { out += x; }); client.stderr.on("data", (x) => { err += x; });
    const [code] = await once(client, "exit"); assert.equal(code, 0, `${out}\n${err}\n${logs}`);
    assert.match(out, /SWITCH_COMPACT_OK/); return out;
  }
  const first = await run(["exec", "--skip-git-repo-check", "--ignore-rules", "--json", "-m", models[0], ...config, "Reply SWITCH_COMPACT_OK."]);
  const id = first.split("\n").map((line) => { try { return JSON.parse(line); } catch { return {}; } }).find((event) => event.type === "thread.started")?.thread_id;
  assert.ok(id); switching = true; const before = requests.length;
  await run(["exec", "resume", "--skip-git-repo-check", "--ignore-rules", "--json", "-m", models[1], ...config, id, "Continue: reply SWITCH_COMPACT_OK."]);
  assert.ok(ingress.some((request) => request.compact && request.model === models[0]), "the actual client must reproduce old-model pre-compaction");
  const after = requests.slice(before);
  assert.equal(after.length, 2, "one compaction on B, then the normal turn on B; no attempt or retry on A");
  assert.ok(after.every((body) => body.model === "deepseek-v4.1-flash"));
  assert.equal(after[0].stream, false); assert.equal(after[1].stream, true);
  assert.match(JSON.stringify(after[1]), /The task is to reply SWITCH_COMPACT_OK/, "the real client replays the new-model summary");
});

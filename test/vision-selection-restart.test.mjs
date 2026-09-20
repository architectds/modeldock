import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codexSlugFor } from "../src/profiles.mjs";

const bundle = pathToFileURL(path.resolve("dist/modeldock.mjs")).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Use the shipped config loader and HTTP handlers, with no launcher/autostart
// side effects. Only this child and its isolated directory can be restarted.
async function boot(env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServices, createApp } from ${JSON.stringify(bundle)};
    const services = createServices();
    const { app, close } = createApp(services);
    const server = app.listen(0, '127.0.0.1', () => {
      console.log('VISION_TEST_PORT=' + server.address().port);
    });
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', async () => {
      try {
        const result = await services.upstreams.inspectVision({
          path: process.env.TEST_IMAGE, question: 'What color is this pixel?',
        });
        console.log('VISION_TEST_RESULT=' + JSON.stringify(result));
      } catch (error) { console.log('VISION_TEST_ERROR=' + error.message); }
    });
    process.on('SIGTERM', async () => {
      server.closeAllConnections();
      await close();
      server.close(() => process.exit(0));
    });
  `], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", (error) => { output += error.message; });
  const stop = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await exited; }
  };
  for (let i = 0; i < 150; i += 1) {
    const port = output.match(/VISION_TEST_PORT=(\d+)/)?.[1];
    if (port) return { child, base: `http://127.0.0.1:${port}`, stop, output: () => output };
    if (child.exitCode !== null) break;
    await pause(100);
  }
  await stop();
  throw new Error(`isolated built gateway failed to start: ${output}`);
}

test("built gateway retains native vision through stale-parent restart and ON mode, and calls native", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-vision-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  await mkdir(codexHome);
  await mkdir(path.join(codexHome, "agents"));
  await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "native-fixture-token" } }));
  await writeFile(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-luna"\n');
  const nativeCatalog = path.join(root, "native-catalog.json");
  await writeFile(nativeCatalog, JSON.stringify({ models: ["gpt-5.6-luna", "gpt-6-astra"].map((slug) => ({
    slug, display_name: slug, visibility: "list", input_modalities: ["text", "image"],
  })) }));
  const envFile = path.join(root, ".env");
  await writeFile(envFile, "MODELDOCK_VISION_MODEL=gpt-5.6-luna@opencode-go\n");
  await writeFile(path.join(root, "codex-model-catalog.json"), JSON.stringify({
    models: [{
      slug: "deepseek-v4-flash@opencode-go",
      auto_review_model_override: "gpt-5.6-luna@opencode-go",
    }],
  }));
  const subagentFile = path.join(codexHome, "agents", "modeldock-subagent.toml");
  await writeFile(subagentFile, 'model = "deepseek-v4-flash@opencode-go"\n');
  const image = path.join(root, "pixel.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64"));

  const calls = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"response.output_text.delta","delta":"white"}\n\ndata: {"type":"response.completed","response":{"id":"resp_fixture","output":[]}}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(MODELDOCK_|OPENCODE_|DEEPSEEK_|CODEX_|XAI_|GROK_)/.test(key)));
  Object.assign(env, {
    MODELDOCK_ENV_FILE: envFile, MODELDOCK_STATE_DIR: root,
    MODELDOCK_CODEX_HOME: codexHome, MODELDOCK_NATIVE_CATALOG_FILE: nativeCatalog,
    MODELDOCK_PROFILE: "opencode-go", MODELDOCK_VISION_MODEL: "gpt-5.6-luna@opencode-go",
    MODELDOCK_NATIVE_MERGE: "1", MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
    MODELDOCK_MODEL_DISCOVERY: "0", MODELDOCK_MODEL_REFRESH_HOURS: "0",
    MODELDOCK_REQUIRE_CALLER_KEY: "0", MODELDOCK_MEMORY: "0",
    MODELDOCK_SETTINGS_EVENTS_FILE: path.join(root, "settings-events.jsonl"),
    MODELDOCK_USAGE_EVENTS_FILE: path.join(root, "usage-events.jsonl"),
    MODELDOCK_UPSTREAM_BASE_URL: `${upstreamBase}/go`, OPENCODE_GO_TOKEN: "go-fixture-token",
    CODEX_NATIVE_BASE_URL: upstreamBase, TEST_IMAGE: image,
  });
  let gateway = await boot(env);
  t.after(() => gateway.stop());
  const safeFlash = codexSlugFor("opencode-go", "deepseek-v4-flash");
  const migratedCatalog = JSON.parse(await readFile(path.join(root, "codex-model-catalog.json"), "utf8"));
  assert.ok(migratedCatalog.models.some((entry) => entry.slug === safeFlash));
  assert.ok((await readFile(subagentFile, "utf8")).split(/\r?\n/).includes(`model = "${safeFlash}"`));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await (await fetch(`${gateway.base}/api/config`)).json();
    if (state.restartRequired) break;
    await pause(25);
  }
  assert.equal((await (await fetch(`${gateway.base}/api/config`)).json()).restartRequired, true,
    "migrating a Codex-facing model identity asks for the required Codex restart");
  const post = async (route, body) => {
    const res = await fetch(`${gateway.base}${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await res.json();
    assert.equal(res.status, 200, JSON.stringify(result));
    return result;
  };
  const assertNative = async () => {
    const models = await (await fetch(`${gateway.base}/api/models`)).json();
    const status = await (await fetch(`${gateway.base}/api/status`)).json();
    assert.equal(models.selected.visionModel, "gpt-5.6-luna");
    assert.equal(models.selectedVisionProvider, "openai");
    assert.equal(status.config.visionModel, models.selected.visionModel);
    assert.match(await readFile(envFile, "utf8"), /^MODELDOCK_VISION_MODEL=gpt-5\.6-luna@openai$/m);
  };
  await post("/api/models", { visionModel: "gpt-5.6-luna" });
  await assertNative();
  for (const inherited of [true, false]) {
    await gateway.stop();
    if (!inherited) delete env.MODELDOCK_VISION_MODEL;
    gateway = await boot(env);
    await assertNative();
    await post("/api/config/mode", { mode: "on" });
    await assertNative();
  }
  gateway.child.stdin.write("inspect\n");
  for (let i = 0; i < 100 && !/VISION_TEST_(RESULT|ERROR)=/.test(gateway.output()); i += 1) await pause(50);
  assert.match(gateway.output(), /VISION_TEST_RESULT=/, gateway.output());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/responses", "no request may reach the OpenCode Go route");
  assert.equal(calls[0].body.model, "gpt-5.6-luna");
  const authFile = path.join(codexHome, "auth.json");
  const auth = await readFile(authFile);
  await rm(authFile);
  await post("/api/config/mode", { mode: "on" });
  await assertNative();
  const unavailable = await (await fetch(`${gateway.base}/api/models`)).json();
  assert.equal(unavailable.options.find((entry) => entry.id === "gpt-5.6-luna").status, "unavailable",
    "a temporarily missing native sign-in is shown honestly without replacing the saved provider");
  await writeFile(authFile, auth);
  await post("/api/models", { visionModel: "" });
  await post("/api/config/mode", { mode: "on" });
  await gateway.stop();
  gateway = await boot(env);
  assert.equal((await (await fetch(`${gateway.base}/api/models`)).json()).selected.visionModel, "",
    "a deliberate None must also survive enable and restart");
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs");
const catalogProvider = (slug) => String(slug || "").startsWith("mdr.")
  ? Buffer.from(String(slug).slice(4).split(".")[0], "base64url").toString("utf8")
  : String(slug || "").split("@").at(-1);

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
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForStatus(port, child, getOutput) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return;
    } catch { /* bundle is still starting */ }
    if (child.exitCode !== null) throw new Error(`gateway exited before ready: ${getOutput()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`built bundle did not start: ${getOutput()}`);
}

test("built bundle disconnects only the requested provider and keeps OpenCode backup disabled after restart", { timeout: 60_000 }, async (t) => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "modeldock-provider-disconnect-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  await mkdir(stateDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(stateDir, ".env"), [
    "DEEPSEEK_API_KEY=sk-provider-disconnect-deepseek-test",
    "COMMANDCODE_API_KEY=user_provider-disconnect-commandcode-test",
    "",
  ].join("\n"), "utf8");
  await writeFile(path.join(codexHome, "config.toml"), [
    "[model_providers.opencode]",
    'experimental_bearer_token = "backup-opencode-go-disconnect-test"',
    "",
  ].join("\n"), "utf8");

  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);

  const baseEnv = { ...process.env };
  for (const key of [
    "OPENCODE_GO_TOKEN",
    "DEEPSEEK_API_KEY",
    "COMMANDCODE_API_KEY",
    "MODELDOCK_DISABLE_OPENCODE_GO_BACKUP",
  ]) delete baseEnv[key];
  const gatewayEnv = {
    ...baseEnv,
    MODELDOCK_PORT: String(port),
    MODELDOCK_PROFILE: "opencode-go",
    MODELDOCK_STATE_DIR: stateDir,
    MODELDOCK_CONFIG_DIR: stateDir,
    MODELDOCK_CODEX_HOME: codexHome,
    MODELDOCK_REQUIRE_CALLER_KEY: "0",
    MODELDOCK_MEMORY: "0",
    MODELDOCK_MODEL_DISCOVERY: "0",
    MODELDOCK_NATIVE_MERGE: "0",
    MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
    MODELDOCK_AUTOSTART: "0",
  };
  const launch = () => spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: gatewayEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let child = launch();
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(() => stop(child));
  await waitForStatus(port, child, () => output);
  const api = `http://127.0.0.1:${port}`;

  const beforeSettings = await (await fetch(`${api}/api/settings`)).json();
  assert.deepEqual(Object.fromEntries(beforeSettings.providers.map(({ id, tokenConfigured }) => [id, tokenConfigured])), {
    "opencode-go": true,
    "deepseek-official": true,
    commandcode: true,
  });
  let beforeModels = await (await fetch(`${api}/api/models`)).json();
  assert.ok(beforeModels.options.some((entry) => entry.provider === "opencode-go"));
  assert.ok(beforeModels.options.some((entry) => entry.provider === "deepseek-official"));

  const rejected = await fetch(`${api}/api/providers/disconnect`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "xai" }),
  });
  assert.equal(rejected.status, 400, "the generic endpoint accepts only credentialProfiles ids");

  const goDisconnect = await fetch(`${api}/api/providers/disconnect`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "opencode-go" }),
  });
  assert.equal(goDisconnect.status, 200);
  const goReply = await goDisconnect.json();
  assert.equal(goReply.settings.providers.find((entry) => entry.id === "opencode-go").tokenConfigured, false);
  assert.equal(goReply.settings.providers.find((entry) => entry.id === "deepseek-official").tokenConfigured, true);
  assert.ok(goReply.models.options.every((entry) => entry.provider !== "opencode-go"), "Go models disappear from the canonical picker immediately");
  assert.ok(goReply.models.options.some((entry) => entry.provider === "deepseek-official"), "other configured providers remain available");
  assert.equal(goReply.models.selected.mainModel.includes("@deepseek-official"), true, "the selected Go model falls back to the remaining provider");

  const catalogFile = path.join(stateDir, "codex-model-catalog.json");
  let catalog = JSON.parse(await readFile(catalogFile, "utf8"));
  assert.ok(catalog.models.every((entry) => catalogProvider(entry.slug) !== "opencode-go"), "the built bundle rewrites the Codex catalog without Go rows");
  assert.ok(catalog.models.some((entry) => catalogProvider(entry.slug) === "deepseek-official"));

  const dsDisconnect = await fetch(`${api}/api/providers/disconnect`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "deepseek-official" }),
  });
  assert.equal(dsDisconnect.status, 200);
  const dsReply = await dsDisconnect.json();
  assert.equal(dsReply.settings.providers.find((entry) => entry.id === "deepseek-official").tokenConfigured, false);
  assert.equal(dsReply.settings.providers.find((entry) => entry.id === "commandcode").tokenConfigured, true);
  assert.ok(dsReply.models.options.every((entry) => entry.provider !== "deepseek-official"));

  const ccDisconnect = await fetch(`${api}/api/providers/disconnect`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "commandcode" }),
  });
  assert.equal(ccDisconnect.status, 200);
  const ccReply = await ccDisconnect.json();
  assert.equal(ccReply.settings.providers.find((entry) => entry.id === "commandcode").tokenConfigured, false);
  assert.equal(ccReply.settings.tokenConfigured, false);

  const env = await readFile(path.join(stateDir, ".env"), "utf8");
  assert.match(env, /^OPENCODE_GO_TOKEN=$/m, "the key is cleared from .env");
  assert.match(env, /^MODELDOCK_DISABLE_OPENCODE_GO_BACKUP=1$/m, "explicit Go disconnect persists backup suppression");
  assert.doesNotMatch(env, /sk-provider-disconnect-deepseek-test|user_provider-disconnect-commandcode-test/);

  await stop(child);
  output = "";
  child = launch();
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  await waitForStatus(port, child, () => output);
  const afterRestart = await (await fetch(`${api}/api/settings`)).json();
  assert.equal(afterRestart.providers.find((entry) => entry.id === "opencode-go").tokenConfigured, false,
    "the Codex config backup does not silently restore a manually disconnected Go token");
  const restartModels = await (await fetch(`${api}/api/models`)).json();
  assert.ok(restartModels.options.every((entry) => !["opencode-go", "deepseek-official", "commandcode"].includes(entry.provider)));
  catalog = JSON.parse(await readFile(catalogFile, "utf8"));
  assert.ok(catalog.models.every((entry) => !["opencode-go", "deepseek-official", "commandcode"].includes(catalogProvider(entry.slug))));
});

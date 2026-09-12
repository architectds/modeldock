import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeLocalEngineSnapshot } from "../src/local-engines.mjs";

test("built local catalog ignores old 70-percent snapshots and follows context edits at 80 percent", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const overrides = {
    MODELDOCK_STATE_DIR: root,
    MODELDOCK_ENV_FILE: path.join(root, ".env"),
    MODELDOCK_CODEX_HOME: path.join(root, "codex"),
    MODELDOCK_PROFILE: "llamacpp",
    MODELDOCK_NATIVE_MERGE: "0",
    MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
    MODELDOCK_MODEL_DISCOVERY: "0",
    MODELDOCK_MODEL_REFRESH_HOURS: "0",
    MODELDOCK_REQUIRE_CALLER_KEY: "0",
    MODELDOCK_MEMORY: "0",
    MODELDOCK_VISION_MODEL: "none",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await mkdir(overrides.MODELDOCK_CODEX_HOME);
  const id = "Qwen3.8-27B@llamacpp";
  writeLocalEngineSnapshot(path.join(root, "local-engines.json"), "llamacpp", {
    baseUrl: "http://127.0.0.1:9/v1",
    models: [{ id: "Qwen3.8-27B", contextWindow: 235_776, autoCompactTokenLimit: 165_043 }],
  });
  const { createApp, createServices } = await import("../dist/modeldock.mjs");
  const services = createServices();
  const { app, close } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const assertPublished = async (window, limit) => {
    const catalog = JSON.parse(await readFile(path.join(root, "codex-model-catalog.json"), "utf8"));
    const entry = catalog.models.find((model) => model.slug === id);
    const models = await (await fetch(`${base}/api/models`)).json();
    assert.equal(entry.context_window, window);
    assert.equal(entry.auto_compact_token_limit, limit);
    assert.equal(models.options.find((model) => model.id === id).contextWindow, window,
      "the picker and published compaction threshold derive from the same effective window");
  };
  await assertPublished(235_776, 188_620);
  for (const [contextWindow, expectedWindow, expectedLimit] of [
    [260_000, 260_000, 208_000],
    [131_072, 131_072, 104_857],
    [null, 235_776, 188_620],
  ]) {
    const res = await fetch(`${base}/api/models/context`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, contextWindow }),
    });
    assert.equal(res.status, 200, await res.text());
    await assertPublished(expectedWindow, expectedLimit);
  }
});

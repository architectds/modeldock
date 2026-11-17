// A live native catalog can advertise modalities newer than the Codex client.
// Boot the shipped bundle and verify its persisted catalog and routed traffic,
// without modifying the authoritative native capture or invoking a real model.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))));

test("built bundle publishes client-compatible native modalities without breaking routed requests", { timeout: 30_000 }, async (t) => {
  assert.equal(fixture.request.tools.length, 164);
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-catalog-modalities-"));
  const nativeCatalogFile = path.join(root, "native-catalog.json");
  const catalogFile = path.join(root, "codex-model-catalog.json");
  writeFileSync(path.join(root, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-native" } }));
  const received = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ type: "response.completed", response: {
      id: "resp_catalog", status: "completed", output: [{
        type: "message", role: "assistant", content: [{ type: "output_text", text: "CATALOG_ROUTE_OK" }],
      }], usage: { input_tokens: 100, output_tokens: 2 },
    } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let instance;
  t.after(async () => {
    if (instance) await instance.stop();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const bundle = path.resolve(process.env.MODELDOCK_TEST_BUNDLE || "dist/modeldock.mjs");
  const { startServer } = await import(pathToFileURL(bundle).href);
  const config = {
    host: "127.0.0.1", port: 0, profileId: "opencode-go", tokens: { "opencode-go": "fixture-go" },
    opencodeBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    mainModel: "deepseek-v4-flash", visionModel: "", codexHome: root,
    nativeCatalogFile, codexCatalogFile: catalogFile, nativeMerge: true,
    refreshNativeCatalog: false, modelDiscoveryEnabled: false, memoryEnabled: false,
    autostartDefault: false, callerKey: "catalog-fixture-caller-0123456789abcd",
    mediaDir: path.join(root, "media"), usageRollupFile: path.join(root, "usage-rollup.json"),
    usageEventsFile: path.join(root, "usage-events.jsonl"), summariesFile: path.join(root, "summaries.json"),
  };
  instance = await startServer(config);
  let base = `http://127.0.0.1:${instance.server.address().port}`;
  // Reuse the bundle's complete current schema rather than hand-authoring a
  // partial native entry that a real Codex parser would reject for other fields.
  const seed = (await (await fetch(`${base}/v1/models`)).json()).models[0];
  await instance.stop();
  instance = null;
  const native = JSON.stringify({ captured_with: "0.167.0-alpha.3.2", models: [{
    ...seed, slug: "gpt-6.2-sol", display_name: "GPT-6.2-Sol", visibility: "list",
    input_modalities: ["text", "image", "audio"],
  }] });
  writeFileSync(nativeCatalogFile, native);
  // Cover both the appended native entry and the selected-native-first path.
  for (const mainModel of [config.mainModel, "gpt-6.2-sol"]) {
    instance = await startServer({ ...config, mainModel });
    base = `http://127.0.0.1:${instance.server.address().port}`;
    const published = await (await fetch(`${base}/v1/models`)).json();
    const persisted = JSON.parse(readFileSync(catalogFile, "utf8"));
    for (const catalog of [published, persisted]) {
      const entry = catalog.models.find((model) => model.slug === "gpt-6.2-sol");
      assert.deepEqual(entry?.input_modalities, ["text", "image"], "one newer modality must not invalidate the whole client catalog");
    }
    assert.equal(readFileSync(nativeCatalogFile, "utf8"), native, "the native capture remains the unmodified source");
    const response = await fetch(`${base}/c/${instance.services.callerKey}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", "x-codex-session-id": `catalog-${mainModel}` },
      body: JSON.stringify({ ...fixture.request, model: "deepseek-v4-flash@opencode-go" }),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /CATALOG_ROUTE_OK/);
    assert.equal(received.at(-1).path, "/v1/responses");
    assert.equal(received.at(-1).body.model, "deepseek-v4-flash");
    assert.ok(received.at(-1).body.tools.length > 0, "the full Codex tool package still reaches the chosen route");
    await instance.stop();
    instance = null;
  }
  assert.equal(received.length, 2);
});

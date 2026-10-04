import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const MODELS = ["gpt-price-discovery", "gpt-price-fallback", "gpt-price-no-cache"];
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(25);
  }
  assert.fail(message);
}

test("built bundle refreshes two public price feeds, keeps offline prices, and values one Stats projection", { timeout: 30_000 }, async (t) => {
  assert.equal(fixture.request.tools.length, 164);
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-price-wire-"));
  const pricesFile = path.join(dir, "api-prices.json");
  const nativeCatalogFile = path.join(dir, "native-catalog.json");
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-native" } }), "utf8");
  writeFileSync(nativeCatalogFile, JSON.stringify({ models: [...MODELS, "gpt-6-astra"].map((slug) => ({
    slug, display_name: slug, visibility: "list", input_modalities: ["text"],
  })) }), "utf8");

  let devMode = "hold";
  let routerMode = "hold";
  let devInput = 4;
  let devCached = 0.4;
  let devOutput = 12;
  let includeAlternative = true;
  let includeAstra = false;
  const priceCalls = [];
  const turns = [];
  const pending = [];
  const feeds = () => ({
    dev: { openai: { id: "openai", models: {
      primary: { id: MODELS[0], cost: { input: devInput, cache_read: devCached, output: devOutput } },
      missingCache: { id: MODELS[2], cost: { input: 2, output: 10 } },
      negative: { id: MODELS[1], cost: { input: -1, cache_read: 0, output: 1 } },
      nullPrice: { id: MODELS[1], cost: { input: null, cache_read: 0, output: 1 } },
      free: { id: MODELS[0], cost: { input: 0, cache_read: 0, output: 0 } },
      ...(includeAstra ? { astra: { id: "gpt-6-astra", cost: { input: 20, cache_read: 2, output: 100 } } } : {}),
    } }, opencode: { id: "opencode", models: {
      ...(includeAlternative ? { alternative: { id: MODELS[0], cost: { input: 8, cache_read: 0.1, output: 8 } } } : {}),
    } } },
    router: { data: [
      { id: `openai/${MODELS[0]}`, pricing: { prompt: "0.000001", input_cache_read: "0.0000009", completion: "0.00005" } },
      { id: `openai/${MODELS[1]}`, pricing: { prompt: "0.000004", input_cache_read: "0.0000003", completion: "0.000006" } },
      { id: `openai/${MODELS[2]}`, pricing: { prompt: "0.000002", completion: "0.00001" } },
      { id: `openai/${MODELS[0]}:batch`, pricing: { prompt: "0.0000001", input_cache_read: "0", completion: "0.0000001" } },
    ] },
  });
  const replyPrice = (res, source, mode) => {
    if (res.destroyed) return;
    res.writeHead(mode === "error" ? 503 : 200, { "content-type": "application/json" });
    res.end(mode === "error" ? "{}" : mode === "malformed" ? "{bad-json"
      : mode === "invalid" ? JSON.stringify({ openai: { models: {
        bad: { id: MODELS[0], cost: { input: -1, cache_read: 0, output: 1 } },
      } } }) : JSON.stringify(feeds()[source]));
  };
  const upstream = createServer(async (req, res) => {
    if (req.url.startsWith("/prices/")) {
      const source = req.url.endsWith("dev") ? "dev" : "router";
      const mode = source === "dev" ? devMode : routerMode;
      priceCalls.push({ source, method: req.method, headers: req.headers });
      if (mode === "hold") pending.push({ res, source });
      else replyPrice(res, source, mode);
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    turns.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "PRICED_OK" })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: {
        id: "resp_price", model: body.model, status: "completed", output: [],
        usage: { input_tokens: 10_000, output_tokens: 1_000, total_tokens: 11_000, input_tokens_details: { cached_tokens: 8_000 } },
      } })}`,
      "data: [DONE]", "",
    ].join("\n\n"));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${upstream.address().port}`;
  process.env.CODEX_NATIVE_BASE_URL = origin;
  const bundleUrl = pathToFileURL(path.resolve(process.env.MODELDOCK_TEST_BUNDLE || "dist/modeldock.mjs")).href;
  const { startServer } = await import(bundleUrl);
  const config = {
    host: "127.0.0.1", port: 0, profileId: "opencode-go", tokens: { "opencode-go": "fixture-go-secret" },
    opencodeBaseUrl: `${origin}/go/v1`, mainModel: "deepseek-v4-flash", visionModel: "none",
    codexHome: dir, nativeCatalogFile, codexCatalogFile: path.join(dir, "codex-catalog.json"),
    usageRollupFile: path.join(dir, "usage-rollup.json"), usageEventsFile: path.join(dir, "usage-events.jsonl"),
    summariesFile: path.join(dir, "summaries.json"), callerKey: "fixture-price-caller-0123456789abcd",
    apiPricesFile: pricesFile, modelsDevPricesUrl: `${origin}/prices/dev`, openRouterPricesUrl: `${origin}/prices/router`,
    apiPricesTimeoutMs: 500, refreshNativeCatalog: false, modelDiscoveryEnabled: false,
    autostartDefault: false, debug: { noSessionCheck: true },
    mediaTtlMs: 60_000, mediaMaxBytes: 1024 * 1024, mediaMaxEntries: 8,
  };
  let instance;
  t.after(async () => {
    for (const held of pending.splice(0)) replyPrice(held.res, held.source, "error");
    if (instance) await instance.stop();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const boot = async (patch = {}) => {
    if (instance) await instance.stop();
    instance = await startServer({ ...config, ...patch });
    return `http://127.0.0.1:${instance.server.address().port}`;
  };
  let api = await boot();
  const getStats = async () => (await fetch(`${api}/api/stats`, { signal: AbortSignal.timeout(1_000) })).json();
  const checkStats = async (costs) => {
    costs = { "gpt-6-astra": 0.078, ...costs };
    const stats = await getStats();
    const total = Object.values(costs).reduce((sum, cost) => sum + (cost ?? 0), 0);
    for (const period of ["hours24", "days7", "days30"]) {
      for (const [model, cost] of Object.entries(costs)) {
        const row = stats.modelPeriods[period].models.find((entry) => entry.id === model);
        assert.ok(row, `${model} has one normalized identity in ${period}`);
        assert.ok(Math.abs(row.estimatedApiCostUsd - (cost ?? 0)) < 1e-12,
          `${model} in ${period}: expected ${cost}, got ${row.estimatedApiCostUsd}`);
        assert.equal(row.costCoverage, cost === null ? 0 : 1, "missing cache price is unpriced, not free");
        const chartCost = stats.series[period].reduce((sum, bucket) => sum + (bucket.byModel[model]?.cost || 0), 0);
        assert.ok(Math.abs(chartCost - (cost ?? 0)) < 1e-12, "the chart shares the model breakdown price");
      }
      assert.ok(Math.abs(stats.periods[period].estimatedApiCostUsd - total) < 1e-12, "the card shares the chart price");
    }
    return stats;
  };

  // The gateway and Stats answer while both public feeds are deliberately held.
  await getStats();
  await until(() => priceCalls, (calls) => calls.length === 2, "boot must fetch both pricing sources in the background");
  for (const call of priceCalls) {
    assert.equal(call.method, "GET");
    assert.equal(call.headers.authorization, undefined, "public feeds never receive provider credentials");
  }
  devMode = routerMode = "ok";
  for (const held of pending.splice(0)) replyPrice(held.res, held.source, "ok");
  await until(() => existsSync(pricesFile) ? JSON.parse(readFileSync(pricesFile, "utf8")) : null,
    (snapshot) => Boolean(snapshot?.sources?.["models.dev"] && snapshot.sources.openrouter), "validated prices are persisted atomically");

  for (const model of [...MODELS, "gpt-6-astra"]) {
    const response = await fetch(`${api}/c/${instance.services.callerKey}/v1/responses`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-native", session_id: `pricing-${model}` },
      body: JSON.stringify({ ...fixture.request, model }), signal: AbortSignal.timeout(3_000),
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /PRICED_OK/);
    assert.equal(turns.at(-1).body.model, model);
    assert.equal(turns.at(-1).path, "/responses");
    assert.ok(turns.at(-1).body.tools.length > 0);
  }
  await until(() => existsSync(config.usageEventsFile) ? readFileSync(config.usageEventsFile, "utf8").trim().split("\n").filter(Boolean) : [],
    (events) => events.length === MODELS.length + 1, "native usage must be metered before restart");

  devMode = routerMode = "error";
  api = await boot();
  const offline = await checkStats({ [MODELS[0]]: 0.0232, [MODELS[1]]: 0.0164, [MODELS[2]]: null });
  await instance.services.runScheduledMaintenance();
  assert.deepEqual((await getStats()).periods, offline.periods, "both source failures retain the last-good prices");
  const count = priceCalls.length;
  for (let index = 0; index < 3; index += 1) await getStats();
  assert.equal(priceCalls.length, count, "reading Stats never fetches an upstream price source");

  // A fresh installation with primary failure still prices through the backup.
  devMode = "malformed";
  routerMode = "ok";
  api = await boot({ apiPricesFile: path.join(dir, "secondary-prices.json") });
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: 0.0592, [MODELS[1]]: 0.0164, [MODELS[2]]: null });

  // Conversely, the primary alone works when the secondary is unavailable.
  devMode = "ok";
  routerMode = "error";
  api = await boot({ apiPricesFile: path.join(dir, "primary-prices.json") });
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: 0.0232, [MODELS[1]]: null, [MODELS[2]]: null });

  // A later maintenance pass changes all views without a release or restart.
  devInput = 10; devCached = 1; devOutput = 30;
  includeAlternative = false;
  includeAstra = true;
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: 0.058, [MODELS[1]]: null, [MODELS[2]]: null, "gpt-6-astra": 0.156 });
  devMode = "error";
  routerMode = "ok";
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: 0.058, [MODELS[1]]: 0.0164, [MODELS[2]]: null, "gpt-6-astra": 0.156 });
  const saved = JSON.parse(readFileSync(instance.services.apiPricing.file, "utf8"));
  assert.ok(saved.sources["models.dev"].fetchedAt);
  assert.ok(saved.sources.openrouter.fetchedAt);
  assert.equal(saved.sources.openrouter.url, config.openRouterPricesUrl);
  const before = priceCalls.length;
  await Promise.all([instance.services.runScheduledMaintenance(), instance.services.runScheduledMaintenance()]);
  assert.equal(priceCalls.length - before, 2, "overlapping maintenance joins one refresh for both sources");

  // HTTP 200 alone is not proof of a usable price directory.
  devMode = "invalid";
  routerMode = "error";
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: 0.058, [MODELS[1]]: 0.0164, [MODELS[2]]: null, "gpt-6-astra": 0.156 });

  // A hung feed times out; the other source and the snapshot still work.
  devMode = "hold";
  routerMode = "ok";
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: 0.058, [MODELS[1]]: 0.0164, [MODELS[2]]: null, "gpt-6-astra": 0.156 });
  for (const held of pending.splice(0)) replyPrice(held.res, held.source, "error");

  // Corrupt disk data cannot inject fake zero prices or lose bundled coverage.
  devMode = routerMode = "error";
  const corruptFile = path.join(dir, "corrupt-prices.json");
  writeFileSync(corruptFile, "{bad-json", "utf8");
  api = await boot({ apiPricesFile: corruptFile });
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: null, [MODELS[1]]: null, [MODELS[2]]: null });

  // Simulate the existing daily timer at a short interval; no page or explicit
  // refresh call is needed for its next price pass.
  api = await boot({ apiPricesFile: path.join(dir, "primary-prices.json"), modelRefreshHours: 0.00005 });
  const timer = instance.services.modelRefreshTimer;
  t.after(() => clearInterval(timer));
  devInput = 12; devCached = 2; devOutput = 24;
  devMode = "ok";
  await until(getStats, (stats) => Math.abs(stats.periods.hours24.estimatedApiCostUsd - (0.0592 + 0.156 + 0.0164)) < 1e-12,
    "the existing scheduled timer updates prices automatically");
  clearInterval(timer);
  await instance.services.runScheduledMaintenance();
  // The retained OpenRouter offer now wins over the more expensive primary.
  await checkStats({ [MODELS[0]]: 0.0592, [MODELS[1]]: 0.0164, [MODELS[2]]: null, "gpt-6-astra": 0.156 });

  // A failed atomic save cannot activate prices that will vanish on restart.
  devMode = routerMode = "ok";
  api = await boot({ apiPricesFile: dir });
  await instance.services.runScheduledMaintenance();
  await checkStats({ [MODELS[0]]: null, [MODELS[1]]: null, [MODELS[2]]: null });
});

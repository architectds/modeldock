import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";

// End-to-end for native vision, with only the ChatGPT backend faked.
//
// The unit tests in test/upstreams.test.mjs inject getNativeSlugs by hand, so
// they prove visionEndpointFor's branch but say nothing about the wiring that
// feeds it: createServices builds the native slug set from the catalog file at
// boot and hands upstreams a getter for it. That ordering is the part that can
// silently break (the set is built once; a catalog written after boot is not in
// it), so this test drives the real createServices/createUpstreams path and
// asserts what actually arrived at the backend.
test("the built bundle refreshes native models, routes vision, and prices the latest GPT models across Stats", async (t) => {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "modeldock-native-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The native catalog must exist before createServices: nativeModelSlugs reads
  // it once at boot. gpt-5.6-terra is in no curated catalog, so reaching the
  // stub at all can only be the native path.
  writeFileSync(
    nodePath.join(dir, "native-catalog.json"),
    JSON.stringify({ models: [{ slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", input_modalities: ["text", "image"] }] }),
    "utf8",
  );
  writeFileSync(
    nodePath.join(dir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "chatgpt-e2e-token", account_id: "acct-e2e" } }),
    "utf8",
  );
  const selfCatalog = nodePath.join(dir, "modeldock-self-catalog.json");
  writeFileSync(selfCatalog, JSON.stringify({ models: [{
    slug: "mdr.bW9kZWxkb2Nr.c2VsZi1yZWZlcmVuY2U",
    display_name: "ModelDock Self Reference",
    visibility: "list",
  }] }), "utf8");
  writeFileSync(nodePath.join(dir, "config.toml"),
    `model_catalog_json = ${JSON.stringify(selfCatalog.replace(/\\/g, "/"))}\n`, "utf8");
  const usageRollupFile = nodePath.join(dir, "usage-rollup.json");
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const hour = `${now.toISOString().slice(0, 13)}:00:00.000Z`;
  const solUsage = {
    "gpt-6-sol@openai": {
      requests: 1, ok: 1, in: 10_000, out: 1_000, cached: 8_000,
      ms: 1_000, okOut: 1_000, okMs: 1_000,
    },
  };
  writeFileSync(usageRollupFile, JSON.stringify({
    version: 2, lastFoldedAt: now.toISOString(),
    days: { [day]: solUsage }, hours: { [hour]: solUsage },
  }), "utf8");
  const pngPath = nodePath.join(dir, "shot.png");
  writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

  const received = [];
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url.startsWith("/models?client_version=")) {
        received.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          account: req.headers["chatgpt-account-id"],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ models: [
          {
            slug: "gpt-6-sol",
            display_name: "GPT-6-Sol",
            visibility: "list",
            priority: 1,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
            default_reasoning_level: "medium",
          },
          {
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6-Terra",
            visibility: "list",
            priority: 2,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
            default_reasoning_level: "medium",
          },
          ...["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"].map((slug) => ({
            slug,
            display_name: slug,
            visibility: "list",
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "medium", description: "Balanced" }],
            default_reasoning_level: "medium",
          })),
          {
            slug: "mdr.bW9kZWxkb2Nr.cmVtb3RlLWVjaG8",
            display_name: "Routed Echo",
            visibility: "list",
          },
        ] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      received.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        account: req.headers["chatgpt-account-id"],
        body,
      });
      // The real backend streams, and puts the words only in the deltas: its
      // response.completed carries an empty output array.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'data: {"type":"response.output_text.delta","delta":"a red bar chart"}',
        `data: ${JSON.stringify({ type: "response.completed", response: {
          id: "resp_e2e", model: body.model, status: "completed", output: [],
          ...(["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"].includes(body.model) ? { usage: {
            input_tokens: 10_000, output_tokens: 1_000, total_tokens: 11_000,
            input_tokens_details: { cached_tokens: 8_000 },
          } } : {}),
        } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  // NATIVE_BASE is read at module load, so the redirect must be in place before
  // src/server.mjs (and through it src/upstreams.mjs) is first evaluated.
  process.env.CODEX_NATIVE_BASE_URL = stubBase;
  const bundleUrl = process.env.MODELDOCK_TEST_BUNDLE
    ? pathToFileURL(nodePath.resolve(process.env.MODELDOCK_TEST_BUNDLE)).href
    : new URL("../dist/modeldock.mjs", import.meta.url).href;
  const { startServer } = await import(bundleUrl);

  const config = {
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    opencodeBaseUrl: "https://go.example.com/v1",
    deepseekBaseUrl: "https://ds.example.com",
    // The only provider credential configured. If the native leg ever falls back
    // to the routed path this is what it would spend, so its absence from the
    // captured request is the assertion that matters.
    tokens: { "opencode-go": "go-token" },
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-terra",
    visionFallbackModel: "kimi-k2.5",
    visionTimeoutMs: 90_000,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxEntries: 64,
    exaMcpUrl: "https://mcp.exa.ai/mcp",
    exaApiKey: "",
    recentLimit: 50,
    debug: { noSessionCheck: true },
    callerKey: "test-caller-key-0123456789abcdefghij",
    refreshNativeCatalog: true,
    modelRefreshHours: 0,
    codexHome: dir,
    nativeCatalogFile: nodePath.join(dir, "native-catalog.json"),
    codexCatalogFile: nodePath.join(dir, "codex-model-catalog.json"),
    usageRollupFile,
    usageEventsFile: nodePath.join(dir, "usage-events.jsonl"),
    summariesFile: nodePath.join(dir, "summaries.json"),
    autostartDefault: false,
  };
  let instance = await startServer(config);
  t.after(() => instance.stop());
  const { services, server: gateway } = instance;

  let captured = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      captured = JSON.parse(readFileSync(services.config.nativeCatalogFile, "utf8"));
      if (captured.models?.some((model) => model.slug === "gpt-6-sol")) break;
    } catch { /* refresh has not committed its atomic file yet */ }
  }
  assert.ok(captured?.models?.some((model) => model.slug === "gpt-6-sol"),
    "a live native model absent from the bundled snapshot is captured");
  assert.equal(captured.models.some((model) => model.slug.startsWith("mdr.")), false,
    "routed ModelDock slugs can never enter the native identity set");
  const published = JSON.parse(readFileSync(services.config.codexCatalogFile, "utf8"));
  assert.ok(published.models?.some((model) => model.slug === "gpt-6-sol"),
    "the live native model reaches the Codex-facing merged catalog");

  const result = await services.upstreams.inspectVision({ path: pngPath, question: "What does it show?" });

  const catalogCalls = received.filter((call) => call.method === "GET");
  assert.equal(catalogCalls.length, 1, "startup performs one live native catalog request");
  assert.equal(catalogCalls[0].auth, "Bearer chatgpt-e2e-token");
  assert.equal(catalogCalls[0].account, "acct-e2e");
  const responseCalls = received.filter((call) => call.method === "POST");
  assert.equal(responseCalls.length, 1, "the native backend was called exactly once for vision");
  const call = responseCalls[0];
  assert.equal(call.url, "/responses", "native vision posts to the Responses path");
  assert.equal(call.auth, "Bearer chatgpt-e2e-token", "the Codex sign-in pays for it, not the OpenCode Go token");
  assert.equal(call.account, "acct-e2e", "the native account header survives the real wiring");
  assert.equal(call.body.model, "gpt-5.6-terra");
  assert.equal(call.body.input[0].content[1].type, "input_image", "the image rides the Responses wire");
  assert.ok(String(call.body.input[0].content[1].image_url).startsWith("data:image/png;base64,"));
  assert.equal(result.answer, "a red bar chart", "the backend's answer comes back through inspectVision");

  const statsResponse = await fetch(`http://127.0.0.1:${gateway.address().port}/api/stats`);
  assert.equal(statsResponse.status, 200);
  const stats = await statsResponse.json();
  const sol = stats.modelPeriods.days30.models.find((entry) => entry.id === "gpt-6-sol");
  assert.ok(sol, "the native model has one normalized Stats identity");
  assert.ok(Math.abs(sol.estimatedApiCostUsd - 0.0156) < 1e-12,
    "Sol's published input, cached, and output rates price the full token mix");
  assert.equal(sol.costCoverage, 1);
  assert.ok(Math.abs(stats.periods.days30.estimatedApiCostUsd - sol.estimatedApiCostUsd) < 1e-12,
    "the aggregate card and model breakdown use the same price");
  const plottedCost = stats.series.days30.reduce((sum, bucket) =>
    sum + (bucket.byModel?.["gpt-6-sol"]?.cost || 0), 0);
  assert.ok(Math.abs(plottedCost - sol.estimatedApiCostUsd) < 1e-12,
    "the spend chart uses the same Sol price as the card and model breakdown");

  // Replay the original full Codex package, changing only the selected model.
  // Prices are asserted after real streamed usage, not injected into Stats.
  const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))));
  assert.equal(fixture.request.tools.length, 164);
  for (const model of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"]) {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/c/${services.callerKey}/v1/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json", "x-codex-session-id": `pricing-${model}`,
        authorization: "Bearer chatgpt-e2e-token", "chatgpt-account-id": "acct-e2e",
      },
      body: JSON.stringify({ ...fixture.request, model }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.match(text, /a red bar chart/);
    const call = received.at(-1);
    assert.equal(call.url, "/responses");
    assert.equal(call.body.model, model, "the native selected identity reaches the upstream unchanged");
    assert.equal(call.auth, "Bearer chatgpt-e2e-token");
    assert.ok(call.body.tools.length > 0, "the full request carries its coding tool surface");
  }
  const expectedCosts = new Map([
    ["gpt-6-sol", 0.0156], ["gpt-6.1-sol", 0.0148],
    ["gpt-6-luna", 0.00078], ["gpt-6-astra", 0.078],
  ]);
  const expectedTotal = [...expectedCosts.values()].reduce((sum, cost) => sum + cost, 0);
  // Wait for metering to finish after the terminal SSE frame, then restart
  // this isolated instance to exercise the production boot-time rollup fold.
  let events = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    events = existsSync(config.usageEventsFile)
      ? readFileSync(config.usageEventsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
    if (events.length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(events.length, 3, "all native streams record their real usage");
  for (const event of events) {
    assert.equal(event.provider, "openai");
    assert.equal(event.status, 200);
    assert.equal(event.inputTokens, 10_000);
    assert.equal(event.cachedTokens, 8_000);
    assert.equal(event.outputTokens, 1_000);
  }
  await instance.stop();
  instance = await startServer(config);
  const pricedResponse = await fetch(`http://127.0.0.1:${instance.server.address().port}/api/stats`);
  assert.equal(pricedResponse.status, 200);
  const pricedStats = await pricedResponse.json();
  for (const period of ["hours24", "days7", "days30"]) {
    for (const [model, cost] of expectedCosts) {
      const row = pricedStats.modelPeriods[period].models.find((entry) => entry.id === model);
      assert.ok(row, `${model} has one normalized identity in ${period}`);
      assert.ok(Math.abs(row.estimatedApiCostUsd - cost) < 1e-12,
        `${model} in ${period}: expected published cache-aware cost ${cost}, received ${row.estimatedApiCostUsd}`);
      assert.equal(row.costCoverage, 1);
      const plotted = pricedStats.series[period].reduce((sum, bucket) => sum + (bucket.byModel?.[model]?.cost || 0), 0);
      assert.ok(Math.abs(plotted - cost) < 1e-12, `${model}'s chart and model breakdown share the ${period} cost`);
    }
    assert.ok(Math.abs(pricedStats.periods[period].estimatedApiCostUsd - expectedTotal) < 1e-12,
      `the aggregate card shares every model's price in ${period}`);
    assert.equal(pricedStats.periods[period].costCoverage, 1);
  }
});

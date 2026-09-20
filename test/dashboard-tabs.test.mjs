// Render every tab and look at it, because nothing else here does.
//
// 0.3.19 was tagged on a green suite, a clean build and a bundle that started,
// and its dashboard was broken on every tab: `.view[data-view="local"]` set
// `display: flex` without requiring `.is-active`, which on specificity beat
// `.view { display: none }`, so Local Hosts rendered on top of whatever tab you
// were on. Every test passed. Twice in one release a defect reached users that
// no assertion could see, because the assertions read modules and the defect
// was on the screen - the other was the Grok panel rendering "xai.title" and
// "xai.signIn" after its keys were deleted.
//
// So this one opens the page. It is slower than the rest of the suite and it
// needs a browser; that is the cost of checking the thing users actually get.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { createApp, createServices } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE, applyLocalEngineProfile } from "../src/profiles.mjs";
import { writeLocalEngineSnapshot } from "../src/local-engines.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

const TABS = ["dashboard", "cloud", "local", "stats", "models"];

const CHROME_CANDIDATES = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
};

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  return (CHROME_CANDIDATES[process.platform] || []).find(existsSync) || null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function availablePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await new Promise((resolve) => probe.once("listening", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A dashboard on a scratch port with its state in a temp dir, so looking at it
// cannot touch the developer's own configuration.

async function startDashboard(t, { nativeVision = false, bundled = false } = {}) {
  const runtime = bundled ? await import("../dist/modeldock.mjs") : { createServices, createApp };
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-tabs-"));
  const port = await availablePort();
  const nativeCatalogFile = path.join(dir, "native-catalog.json");
  if (nativeVision) {
    writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "browser-native-test" } }), "utf8");
    writeFileSync(nativeCatalogFile, JSON.stringify({
      captured_with: "browser-test",
      models: [{
        slug: "gpt-5.6-luna",
        display_name: "GPT-5.6-Luna",
        visibility: "list",
        input_modalities: ["text", "image"],
      }],
    }), "utf8");
  }
  const services = runtime.createServices({
    host: "127.0.0.1",
    port,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    opencodeBaseUrl: "https://go.example.com/v1",
    tokens: { "opencode-go": "tab-render-test" },
    mainModel: "deepseek-v4-flash",
    visionModel: nativeVision ? "qwen3.8-flash@opencode-go" : "gpt-5.6-luna",
    ...(nativeVision ? { codexHome: dir, nativeMerge: true } : {}),
    mediaTtlMs: 60_000,
    mediaMaxBytes: 1024 * 1024,
    mediaMaxEntries: 8,
    recentLimit: 10,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
    autostartDefault: false,
    envFile: path.join(dir, ".env"),
    settingsEventsFile: path.join(dir, "settings-events.jsonl"),
    summariesFile: path.join(dir, "summaries.json"),
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
    nativeCatalogFile,
    usageRollupFile: path.join(dir, "usage-rollup.json"),
    usageEventsFile: path.join(dir, "usage-events.jsonl"),
    visionOverridesFile: path.join(dir, "vision-overrides.json"),
  });
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const currentHour = `${now.toISOString().slice(0, 13)}:00:00.000Z`;
  const yesterdayDate = new Date(now);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const olderDate = new Date(now);
  olderDate.setUTCDate(olderDate.getUTCDate() - 8);
  const older = olderDate.toISOString().slice(0, 10);
  writeFileSync(services.usageRollupFile, JSON.stringify({
    version: 2,
    lastFoldedAt: now.toISOString(),
    days: {
      [older]: {
        // Deliberately exceeds $1K. The dashboard used to construct an invalid
        // Intl.NumberFormat for four-digit compact costs, update only the range
        // labels, then leave every aggregate and chart on the previous period.
        "gpt-5.6-sol@openai": { requests: 4, ok: 4, in: 1_000_000_000, out: 100_000_000, cached: 0, ms: 10_000, okOut: 100_000_000, okMs: 10_000 },
      },
      [yesterday]: {
        "deepseek-v4-flash@opencode-go": { requests: 3, ok: 3, in: 30_000_000_000, out: 3_000_000_000, cached: 18_000_000_000, ms: 9000, okOut: 3_000_000_000, okMs: 9000 },
      },
      [today]: {
        "qwen3.8-flash@opencode-go": { requests: 2, ok: 2, in: 8000, out: 600, cached: 5000, ms: 6000, okOut: 600, okMs: 6000 },
      },
    },
    hours: {
      [currentHour]: {
        "qwen3.8-flash@opencode-go": { requests: 2, ok: 2, in: 8000, out: 600, cached: 5000, ms: 6000, okOut: 600, okMs: 6000 },
      },
    },
  }), "utf8");
  services.localEnginesFile = path.join(dir, "local-engines.json");
  // One configured endpoint, so the Cloud tab renders a row with a Remove
  // button. Without it that section has nothing to check and the escaped-element
  // assertion below walks an empty page - which is exactly how the button came
  // to be rendering in the corner of the window with the suite green.
  services.customEndpointsFile = path.join(dir, "custom-endpoints.json");
  writeFileSync(services.customEndpointsFile, JSON.stringify([{
    providerId: "lab",
    modelId: "some-model",
    baseUrl: "http://127.0.0.1:9/v1",
    apiKey: "",
    label: "http://127.0.0.1:9/v1",
    contextWindow: 8192,
    supportsVision: false,
    addedAt: "2026-01-01T00:00:00.000Z",
  }], null, 2));
  services.engineLogDir = path.join(dir, "engine-logs");
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    observation: {
      modelPath: "D:/models/previous-connected-model.gguf",
      visionProjectorPath: "D:/models/previous-connected-projector.gguf",
      supportsVision: true,
      observedAt: "2026-08-24T20:00:00.000Z",
    },
    models: [{ id: "qwen3.8:27b", contextWindow: 262144 }],
  });
  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "qwen3.8:27b", contextWindow: 262144 }],
  });
  t.after(() => applyLocalEngineProfile("llamacpp", null));
  const observedEngine = {
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: "http://127.0.0.1:11435",
    port: 11435,
    models: ["qwen3.8:27b"],
    connectable: true,
    binary: "D:/llama-cpp/llama-server.exe",
    cmdline: "D:/llama-cpp/llama-server.exe -m D:/models/qwen.gguf -c 262144 --parallel 1 --port 11435",
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
  };
  services.discoverEngines = async () => [observedEngine];
  services.probeGpus = async () => [];

  const { app } = runtime.createApp(services);
  const server = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, services };
}

// The smallest CDP client that can drive a page and read a value back.
async function openBrowser(t, chromePath, { width = 1500, height = 1000, deviceScaleFactor = 1, instance = "default" } = {}) {
  // Top-level node:test cases can overlap. Each dashboard scenario therefore
  // needs its own CDP port, not merely a "default versus other" split.
  const instanceOffset = {
    default: 0,
    narrow: 600,
    "vision-persistence": 2400,
  }[instance] ?? 1500;
  const basePort = 9350 + Math.floor(process.pid % 200) + instanceOffset;
  const profiles = [];
  let ws;
  let live = null;
  t.after(async () => {
    try { ws?.close(); } catch { /* closing a closed socket */ }
    const chrome = live?.chrome;
    if (chrome) {
      // Kill first, then wait for the process to actually leave: Chrome keeps its
      // profile files (CrashpadMetrics-active.pma, lockfile) open for a moment after
      // the signal, and unlinking them in that window fails with EBUSY. A kill whose
      // exit never arrives must not hang the runner either, so the wait is bounded.
      const gone = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await Promise.race([gone, sleep(3_000)]);
    }
    // Best-effort: these are throwaway profile dirs, and a file still held by a dying
    // renderer must not turn a passed render check into a failed one.
    for (const dir of profiles) {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 }).catch(() => {});
    }
  });

  // One Chrome launch, and the page target it must publish. An attempt number shifts
  // the port and the profile so a retry cannot reconnect to the wedged instance.
  const launch = async (attempt) => {
    const port = basePort + attempt * 40;
    const profile = path.join(os.tmpdir(), `modeldock-tabs-profile-${process.pid}-${instance}-${attempt}`);
    profiles.push(profile);
    const chrome = spawn(chromePath, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
      // A CI container gets a 64 MB /dev/shm, and Chrome puts its renderer's
      // shared memory there: without this it dies during startup and the only
      // symptom upstairs is a debugging port that never answers.
      "--disable-dev-shm-usage",
      `--remote-debugging-port=${port}`, `--window-size=${width},${height}`,
      ...(deviceScaleFactor === 1 ? [] : [`--force-device-scale-factor=${deviceScaleFactor}`]),
      `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });

    // Chrome says why it failed on stderr, and this used to be thrown away - so a
    // startup crash arrived as "exposed no page target", which names the symptom
    // and not one cause. Kept and quoted in the failure instead.
    let stderr = "";
    chrome.stderr.on("data", (chunk) => { stderr += String(chunk); });
    let exited = null;
    chrome.on("exit", (code, signal) => { exited = signal || code; });

    let target = null;
    // 30s rather than 10. A cold CI runner is not a warm laptop, and the previous
    // budget was tight enough that this test failed on the runner while passing
    // everywhere else - a flake, which in a render check is worse than useless
    // because it teaches people to re-run it.
    for (let i = 0; i < 120 && !target; i += 1) {
      await sleep(250);
      if (exited !== null) break;
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        target = list.find((entry) => entry.type === "page");
      } catch { /* not listening yet */ }
    }
    return { chrome, exited, port, stderr, target };
  };

  // A runner can also start a Chrome that stays alive and never publishes a target at
  // all, which is exactly what a 30s wait reports. Relaunch once on a fresh port before
  // calling it a failure: the render check still has to render.
  let session = await launch(0);
  if (!session.target) {
    session.chrome.kill();
    session = await launch(1);
  }
  live = session;
  assert.ok(session.target, session.exited !== null
    ? `Chrome exited (${session.exited}) before exposing a page target: ${session.stderr.trim().slice(-600) || "no output"}`
    : `Chrome exposed no page target within 30s (port ${session.port}): ${session.stderr.trim().slice(-600) || "no output"}`);
  const { target } = session;

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error("CDP connection failed")));
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const next = ++id;
    pending.set(next, resolve);
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) {
      throw new Error(`page threw: ${reply.result.exceptionDetails.exception?.description || "unknown"}`);
    }
    return reply.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return { send, evaluate };
}

const chromePath = findChrome();

test("every dashboard tab renders itself and nothing else", { timeout: 120_000 }, async (t) => {
  if (!chromePath) {
    // Forced where it counts: the release workflow runs in CI, and a CI machine
    // without a browser would silently stop checking the only thing that looks
    // at the page.
    assert.ok(!process.env.CI, "CI has no browser, so the render check cannot run - install Chrome on the runner");
    t.skip("no Chrome on this machine; install one or set CHROME_PATH to run the render check");
    return;
  }
  const { base, services } = await startDashboard(t);
  services.recordLatestMainRoute({
    route: { model: "qwen3.8-flash@opencode-go", reason: "client_selected" },
    upstream: "opencode-go",
    httpStatus: 200,
  });
  const oldSession = services.metrics.begin("responses", {
    model: "deepseek-v4-flash@opencode-go",
    sessionId: "model-switch-session",
  });
  oldSession({ ok: true });
  await sleep(2);
  const newSession = services.metrics.begin("responses", {
    model: "qwen3.8-flash@opencode-go",
    sessionId: "model-switch-session",
  });
  newSession({ ok: true });
  for (const record of services.metrics.recent.filter((entry) => entry.sessionId === "model-switch-session")) {
    record.finishedAt = 123456789;
  }
  const { send, evaluate } = await openBrowser(t, chromePath);

  // Record what the page throws, before it has a chance to throw anything.
  //
  // Installed as a new-document script rather than evaluated once: this hook
  // used to be written into about:blank and the very next line navigated away
  // from it, which discards the window it lives on. `window.__pageErrors` was
  // then undefined for the whole run and `window.__pageErrors || []` read as an
  // empty list no matter what the page threw, so the assertion at the bottom
  // could not fail. Measured: typeof window.__pageErrors === "undefined" one
  // evaluate after the navigation.
  //
  // A new-document script runs in every document this target loads, before that
  // document's own scripts do, so it survives the navigation and is in place
  // early enough to catch what the page throws while it is still loading.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__pageErrors = [];
      addEventListener('error', (e) => window.__pageErrors.push(String(e.message)));
      addEventListener('unhandledrejection', (e) => window.__pageErrors.push('unhandled rejection: ' + String(e.reason?.message || e.reason)));
    `,
  });
  await evaluate(`location.href = ${JSON.stringify(base)}`);

  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('.view')`)) break;
  }
  // A temp-dir install is a first run, so the setup wizard covers the page.
  await evaluate(`(() => {
    const skip = [...document.querySelectorAll('a,button')].find((n) => /skip for now/i.test(n.textContent));
    if (skip) skip.click();
    return true;
  })()`);
  await sleep(500);

  const commandCodeIcon = JSON.parse(await evaluate(`new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(JSON.stringify({
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    image.onerror = () => resolve(JSON.stringify({ width: 0, height: 0 }));
    image.src = '/assets/commandcode-favicon.svg';
  })`));
  assert.ok(commandCodeIcon.width > 0 && commandCodeIcon.height > 0,
    "the Command Code provider icon decodes to nonzero browser dimensions");

  // Reproduce the stale DeepSeek card: the configured catalog fallback is
  // DeepSeek, while the latest real Codex request used Qwen. The route header
  // already followed the request; the model block used a separate selection
  // object and stayed wrong indefinitely.
  const currentModel = JSON.parse(await evaluate(`JSON.stringify({
    provider: document.getElementById('main-provider-display')?.textContent.trim(),
    model: document.getElementById('main-model-display-name')?.textContent.trim(),
  })`));
  assert.deepEqual(currentModel, { provider: "OpenCode Go", model: "Qwen 3.8 Flash" },
    "the read-only model block follows the same latest route as the route header");
  assert.match(
    await evaluate(`document.querySelector('#session-select option[value="model-switch-session"]')?.textContent || ''`),
    /qwen3\.8-flash/i,
    "a session chip reports the newest model after a provider/model switch, even when finishes share a timestamp",
  );

  // A model option can keep the same provider-qualified id while discovery
  // corrects a rendered fact such as its label or vision capability. The
  // browser render cache must follow the complete option projection, not only
  // identity. Otherwise every later status event is accepted but the stale DOM
  // remains until an unrelated model is added or removed.
  const qwen = OPENCODE_GO_PROFILE.availableModels.find((model) => model.id === "qwen3.8-flash");
  const originalQwenLabel = qwen.label;
  const originalProviderLabel = OPENCODE_GO_PROFILE.label;
  t.after(() => {
    qwen.label = originalQwenLabel;
    OPENCODE_GO_PROFILE.label = originalProviderLabel;
  });
  qwen.label = "Qwen 3.8 Flash Refreshed";
  OPENCODE_GO_PROFILE.label = "OpenCode Go Refreshed";
  const refreshFinish = services.metrics.begin("responses", { model: "qwen3.8-flash@opencode-go" });
  refreshFinish({ ok: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await evaluate(`document.getElementById('main-model-display-name')?.textContent.trim() === 'Qwen 3.8 Flash Refreshed'`)) break;
    await sleep(50);
  }
  assert.equal(await evaluate(`document.getElementById('main-model-display-name')?.textContent.trim()`), "Qwen 3.8 Flash Refreshed",
    "a changed option projection invalidates the shared model render cache");
  assert.equal(
    await evaluate(`document.querySelector('#vision-provider-select option[value="opencode-go"]')?.textContent.trim()`),
    "OpenCode Go Refreshed",
    "a changed provider projection invalidates the same shared model render cache",
  );
  qwen.label = originalQwenLabel;
  OPENCODE_GO_PROFILE.label = originalProviderLabel;
  const restoreFinish = services.metrics.begin("responses", { model: "qwen3.8-flash@opencode-go" });
  restoreFinish({ ok: true });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await evaluate(`document.getElementById('main-model-display-name')?.textContent.trim() === 'Qwen 3.8 Flash'`)) break;
    await sleep(50);
  }
  assert.equal(await evaluate(`document.getElementById('main-model-display-name')?.textContent.trim()`), "Qwen 3.8 Flash",
    "the same cache also accepts a projection changing back without an identity change");

  for (const tab of TABS) {
    await evaluate(`location.hash = '#${tab}'`);
    await sleep(400);

    // 1. One tab is one view. This is the assertion 0.3.19 needed: Local Hosts
    //    was laid out on every tab because its rule outweighed the one that
    //    hides an inactive view and did not ask whether it was active.
    const shown = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.view')]
      .filter((v) => getComputedStyle(v).display !== 'none').map((v) => v.dataset.view))`));
    assert.deepEqual(shown, [tab], `#${tab} shows ${JSON.stringify(shown)} - a view is displayed while it is not the active one`);
    if (tab === "stats") {
      const bounded = JSON.parse(await evaluate(`JSON.stringify({
        tokenDays: document.querySelectorAll('#stats-token-chart .stats-day').length,
        requestDays: document.querySelectorAll('#stats-request-chart .stats-day').length,
        spendDays: document.querySelectorAll('#stats-spend-chart .stats-day').length,
        models: document.querySelectorAll('#stats-model-chart .stats-share-row').length,
      })`));
      assert.deepEqual(bounded, { tokenDays: 30, requestDays: 30, spendDays: 30, models: 3 }, "Stats replaces one bounded 30-day snapshot instead of growing with polls");
      const costsByRange = new Map();
      for (const range of [7, 1, 30]) {
        await evaluate(`document.querySelector('[data-stats-range="${range}"]').click()`);
        await sleep(50);
        const filtered = JSON.parse(await evaluate(`JSON.stringify({
          tokenDays: document.querySelectorAll('#stats-token-chart .stats-day').length,
          requestDays: document.querySelectorAll('#stats-request-chart .stats-day').length,
          spendDays: document.querySelectorAll('#stats-spend-chart .stats-day').length,
          models: document.querySelectorAll('#stats-model-chart .stats-share-row').length,
          windows: [...document.querySelectorAll('[data-stats-window]')].map((node) => node.textContent),
          activeRange: document.querySelector('[data-stats-range].is-active')?.dataset.statsRange,
          cost: document.getElementById('stats-cost')?.textContent,
        })`));
        costsByRange.set(range, filtered.cost);
        // Abbreviated money is the bug, not the style: the summary card used to
        // render "$1.3K" while the model rows under it showed full amounts, so the
        // number the card exists to report was the one that got thrown away. Requiring
        // decimals is what rejects "$1.3K" and "$1K" both.
        assert.match(
          filtered.cost || "",
          /^\$[\d,]+\.\d{2,4}$/,
          `Stats ${range}D cost must be a full dollar amount, got ${JSON.stringify(filtered.cost)}`,
        );
        const expectedPoints = range === 1 ? 24 : range;
        assert.deepEqual(filtered, {
          tokenDays: expectedPoints,
          requestDays: expectedPoints,
          spendDays: expectedPoints,
          models: range === 1 ? 1 : range === 7 ? 2 : 3,
          windows: Array(filtered.windows.length).fill(`${range}D`),
          activeRange: String(range),
          cost: filtered.cost,
        }, `Stats ${range}D filter must update every aggregate and chart together`);
        const identities = JSON.parse(await evaluate(`JSON.stringify({
          token: [...new Set([...document.querySelectorAll('#stats-token-chart .stats-segment[data-stats-model]')]
            .map((node) => node.dataset.statsModel))].sort(),
          requests: [...new Set([...document.querySelectorAll('#stats-request-chart .stats-segment[data-stats-model]')]
            .map((node) => node.dataset.statsModel))].sort(),
          spend: [...new Set([...document.querySelectorAll('#stats-spend-chart .stats-segment[data-stats-model]')]
            .map((node) => node.dataset.statsModel))].sort(),
          donut: [...document.querySelectorAll('#stats-model-chart .stats-slice')]
            .map((node) => node.dataset.statsModel).sort(),
        })`));
        assert.deepEqual(identities.token, identities.donut,
          `Stats ${range}D token flow must use the donut model identities`);
        assert.deepEqual(identities.requests, identities.donut,
          `Stats ${range}D request flow must use the donut model identities`);
        assert.deepEqual(identities.spend, identities.donut.filter((id) => id !== '__other__'),
          `Stats ${range}D spend must use the priced donut model identities`);
        if (range === 1) {
          const axisLabels = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('#stats-token-chart .stats-axis span')].map((node) => node.textContent))`));
          assert.equal(axisLabels.length, 2);
          assert.notEqual(axisLabels[0], axisLabels[1], "the 1D axis spans twenty-four hours instead of repeating one date");
        }
      }
      assert.equal(new Set(costsByRange.values()).size, 3,
        `Stats range must change the API-cost value, got ${JSON.stringify(Object.fromEntries(costsByRange))}`);

      // Model share is a ring, and every slice is the same model in the same
      // colour the bars use. Two slices wearing one colour would make the whole
      // page unreadable, which is the failure this guards.
      const paint = JSON.parse(await evaluate(`JSON.stringify({
        slices: [...document.querySelectorAll('#stats-model-chart .stats-slice')].map((n) => n.getAttribute('fill')),
        legend: [...document.querySelectorAll('#stats-model-chart .stats-legend-row')].map((n) => n.dataset.statsModel),
        names: [...document.querySelectorAll('#stats-model-chart .stats-share-name')].map((n) => n.textContent),
        centre: document.querySelector('#stats-model-chart .stats-donut-center b')?.textContent,
        barColours: [...new Set([...document.querySelectorAll('#stats-token-chart .stats-segment')]
          .map((n) => n.dataset.statsModel + '=' + n.style.background))],
      })`));
      assert.equal(paint.slices.length, 3, "one slice per model in the period");
      assert.equal(new Set(paint.slices).size, 3, "no two slices may share a colour");
      assert.equal(paint.legend.length, 3);
      assert.ok(paint.names.includes("Qwen 3.8 Flash"), `Stats uses the model catalog's normalized name, not an upstream wire id: ${JSON.stringify(paint.names)}`);
      assert.match(paint.centre, /%$/, "the ring states the share it is highlighting");
      assert.equal(new Set(paint.barColours.map((entry) => entry.split("=")[1])).size, paint.barColours.length,
        "a model keeps one colour in every plot");

      // Hover is the only way to read a per-model breakdown off a stacked bar, so
      // it has to name the model and mute the others across all four cards.
      const hover = JSON.parse(await evaluate(`(() => {
        const bar = document.querySelector('#stats-token-chart .stats-segment[data-stats-tip]');
        bar.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        const tip = document.querySelector('.stats-tip');
        return JSON.stringify({
          hidden: tip ? tip.hidden : 'no layer',
          model: tip?.querySelector('.stats-tip-model em')?.textContent || '',
          rows: [...(tip?.querySelectorAll('.stats-tip-row') || [])].map((n) => n.textContent),
          muted: document.querySelectorAll('.is-mute').length,
        });
      })()`));
      assert.equal(hover.hidden, false, "pointing at a coloured segment opens the tooltip");
      assert.ok(hover.model.length > 0, "the tooltip names the model behind the segment");
      assert.ok(hover.rows.length >= 5, `the tooltip breaks the segment down, got ${hover.rows.length} rows`);
      assert.ok(hover.muted > 0, "every other model dims so the hovered one reads across plots");
      const leave = JSON.parse(await evaluate(`(() => {
        const bar = document.querySelector('#stats-token-chart .stats-segment[data-stats-tip]');
        bar.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
        return JSON.stringify({ hidden: document.querySelector('.stats-tip').hidden, muted: document.querySelectorAll('.is-mute').length });
      })()`));
      assert.equal(leave.hidden, true, "the tooltip closes when the pointer leaves");
      assert.equal(leave.muted, 0, "no model stays muted after the pointer leaves");
    }

    // 2. Nothing is on screen that is a translation key rather than a
    //    translation. t() falls back to the key itself and applyStaticI18n
    //    writes it into textContent, so a deleted key ships as UI text - that
    //    is what the Grok panel did for a whole release.
    //
    //    Judged against the element's own data-i18n rather than a list of keys
    //    read from i18n.js: the failure being guarded is a key deleted from
    //    that file, so a check that expects to find it there cannot see it go.
    //    An element whose rendered text is its own key name is untranslated,
    //    and that is true no matter what the file says.
    const raw = JSON.parse(await evaluate(`JSON.stringify([
      ...[...document.querySelectorAll('[data-i18n]')]
        .filter((n) => n.offsetParent !== null && n.textContent.trim() === n.dataset.i18n)
        .map((n) => n.dataset.i18n),
      ...[...document.querySelectorAll('[data-i18n-title]')]
        .filter((n) => n.offsetParent !== null && n.title === n.dataset.i18nTitle)
        .map((n) => n.dataset.i18nTitle + ' (title)'),
    ])`));
    assert.deepEqual(raw, [], `#${tab} is displaying untranslated keys`);

    // 3. Nothing has escaped the page it belongs to. The endpoint Remove button
    //    was absolutely positioned against a wrapper the renderer had stopped
    //    emitting, so with no positioned ancestor left it resolved against the
    //    document and rendered in the top-right corner of the window, over the
    //    status pill, on a tab whose panel ends 500px to its left.
    const escaped = JSON.parse(await evaluate(`(() => {
      const view = document.querySelector('.view.is-active');
      const box = view.getBoundingClientRect();
      return JSON.stringify([...view.querySelectorAll('*')]
        .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().width > 0)
        .filter((n) => {
          const r = n.getBoundingClientRect();
          return r.right > box.right + 1 || r.left < box.left - 1 || r.bottom < box.top - 1;
        })
        .map((n) => (n.id || n.tagName.toLowerCase() + '.' + n.className) + ' at ' + Math.round(n.getBoundingClientRect().x)));
    })()`));
    assert.deepEqual(escaped, [], `#${tab} renders elements outside the view they belong to`);

    // 4. Every control a person can press says what it is.
    const nameless = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null)
      .filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label') || b.title))
      .map((b) => b.id || b.className))`));
    assert.deepEqual(nameless, [], `#${tab} has controls with no accessible name`);
  }

  // Catalog refresh is a live event, not a page-load detail. Keep Models open
  // while adding a model, then keep Stats open while changing its label: both
  // views must refetch the same server projections without a browser reload.
  await evaluate(`location.hash = '#models'`);
  await sleep(250);
  const originalModels = OPENCODE_GO_PROFILE.availableModels;
  const refreshProbe = {
    id: "catalog-refresh-probe",
    label: "Catalog Refresh Probe",
    endpoint: "responses",
    supportsVision: false,
    status: "available",
  };
  OPENCODE_GO_PROFILE.availableModels = [...originalModels, refreshProbe];
  t.after(() => { OPENCODE_GO_PROFILE.availableModels = originalModels; });
  const rollup = JSON.parse(readFileSync(services.usageRollupFile, "utf8"));
  const refreshNow = new Date();
  const refreshDay = refreshNow.toISOString().slice(0, 10);
  const refreshHour = `${refreshNow.toISOString().slice(0, 13)}:00:00.000Z`;
  const refreshUsage = {
    requests: 9,
    ok: 9,
    in: 90_000_000_000,
    out: 9_000_000_000,
    cached: 45_000_000_000,
    ms: 9_000,
    okOut: 9_000_000_000,
    okMs: 9_000,
  };
  rollup.days[refreshDay] = {
    ...(rollup.days[refreshDay] || {}),
    "catalog-refresh-probe@opencode-go": refreshUsage,
  };
  rollup.hours[refreshHour] = {
    ...(rollup.hours[refreshHour] || {}),
    "catalog-refresh-probe@opencode-go": refreshUsage,
  };
  writeFileSync(services.usageRollupFile, JSON.stringify(rollup), "utf8");
  const revisionBefore = services.modelCatalogRevision;
  services.writeCatalogFile();
  assert.ok(services.modelCatalogRevision > revisionBefore, "a changed catalog advances the shared revision");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate(`document.getElementById('roster-groups')?.textContent.includes('Catalog Refresh Probe')`)) break;
    await sleep(50);
  }
  assert.equal(await evaluate(`document.getElementById('roster-groups')?.textContent.includes('Catalog Refresh Probe')`), true,
    "an open Models view refetches when the canonical catalog changes");

  await evaluate(`location.hash = '#stats'`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate(`document.getElementById('stats-model-chart')?.textContent.includes('Catalog Refresh Probe')`)) break;
    await sleep(50);
  }
  assert.equal(await evaluate(`document.getElementById('stats-model-chart')?.textContent.includes('Catalog Refresh Probe')`), true,
    "Stats drops its ten-minute cache after the same catalog revision changes");

  refreshProbe.label = "Catalog Refresh Probe Renamed";
  services.writeCatalogFile();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await evaluate(`document.getElementById('stats-model-chart')?.textContent.includes('Catalog Refresh Probe Renamed')`)) break;
    await sleep(50);
  }
  assert.equal(await evaluate(`document.getElementById('stats-model-chart')?.textContent.includes('Catalog Refresh Probe Renamed')`), true,
    "an already-open Stats view refetches corrected catalog labels");

  await evaluate(`(() => {
    const original = window.fetch.bind(window);
    window.__catalogFetches = [];
    window.fetch = (...args) => {
      const url = String(args[0] || '');
      if (url.includes('/api/models/roster') || url.includes('/api/stats')) window.__catalogFetches.push(url);
      return original(...args);
    };
  })()`);
  for (let index = 0; index < 20; index += 1) {
    const finish = services.metrics.begin("responses", { model: "qwen3.8-flash@opencode-go" });
    finish({ ok: true });
  }
  await sleep(600);
  assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify(window.__catalogFetches)`)), [],
    "ordinary status events never refetch Models or Stats when the catalog revision is unchanged");

  // Installed bookmarks and older installer links still point at these two
  // hashes. They now converge on Cloud instead of falling back to Dashboard.
  for (const legacy of ["subscriptions", "api"]) {
    await evaluate(`location.hash = '#${legacy}'`);
    await sleep(200);
    const shown = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.view')]
      .filter((view) => getComputedStyle(view).display !== 'none')
      .map((view) => view.dataset.view))`));
    assert.deepEqual(shown, ["cloud"], `#${legacy} must route to the combined Cloud view`);
  }

  await evaluate(`location.hash = '#cloud'`);
  await sleep(200);
  const providerOrder = JSON.parse(await evaluate(`JSON.stringify(
    [...document.querySelectorAll('.cloud-credentials > .field')]
      .map((field) => field.id || field.querySelector('input')?.id)
  )`));
  assert.deepEqual(providerOrder, ["xai-section", "settings-go-token", "commandcode-field", "deepseek-field"],
    "account sign-in providers stay ahead of providers that require API keys");

  // Reproduce the real Cloud-page flow: another provider is already configured,
  // so Command Code starts as optional. Saving its key must update the persistent
  // page from the POST response; waiting for a reload left the stale placeholder
  // visible even though the backend was already using the key.
  const commandBefore = await evaluate(`document.getElementById('settings-commandcode-token').placeholder`);
  assert.match(commandBefore, /optional/i);
  await evaluate(`(() => {
    document.getElementById('settings-commandcode-token').value = 'user_dashboard-commandcode-test-key';
    document.getElementById('settings-save').click();
  })()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const placeholder = await evaluate(`document.getElementById('settings-commandcode-token').placeholder`);
    if (/configured/i.test(placeholder)) break;
    await sleep(50);
  }
  const commandState = JSON.parse(await evaluate(`JSON.stringify({
    placeholder: document.getElementById('settings-commandcode-token').placeholder,
    status: document.getElementById('settings-status').textContent,
    saveDisabled: document.getElementById('settings-save').disabled,
    errors: window.__pageErrors,
  })`));
  assert.match(commandState.placeholder, /configured/i,
    `a successful save immediately marks Command Code configured: ${JSON.stringify(commandState)}`);
  assert.equal(await evaluate(`document.getElementById('settings-commandcode-token').value`), "",
    "the stored key is never echoed back into the field");

  // The drawer is the only local surface that talks to an engine, so it is
  // rendered for real: opening llama.cpp's settings shows the port it was found
  // on and offers to connect. There is deliberately no launch form any more -
  // ModelDock replays the command it watched the engine start with, it does not
  // let a web page compose one, so an assertion that the fields are gone is the
  // regression guard for the control that used to sit here and do nothing.
  await evaluate(`location.hash = '#local'`);
  await sleep(400);
  await evaluate(`document.getElementById('llamacpp-configure').click()`);
  await sleep(250);
  const localDrawer = JSON.parse(await evaluate(`JSON.stringify({
    open: !document.getElementById('local-drawer').hidden,
    title: document.getElementById('local-config-title').textContent.trim(),
    port: document.getElementById('local-config-port').value,
    launchForm: Boolean(document.getElementById('local-host-control')),
    modelField: Boolean(document.getElementById('local-host-model-file')),
    serviceRestart: !document.getElementById('local-service-restart').hidden,
  })`));
  assert.deepEqual(localDrawer, {
    open: true,
    title: "llama.cpp",
    port: "11435",
    launchForm: false,
    modelField: false,
    serviceRestart: true,
  }, "the local drawer configures a port and no longer pretends to own the launch");

  // 5. And none of that produced an error the page swallowed.
  const errors = JSON.parse(await evaluate(`JSON.stringify(window.__pageErrors || [])`));
  assert.deepEqual(errors, [], "the dashboard threw while rendering its tabs");

  const duplicateIds = JSON.parse(await evaluate(`(() => {
    const seen = new Set();
    return JSON.stringify([...document.querySelectorAll('[id]')]
      .map((node) => node.id)
      .filter((id) => seen.has(id) ? true : (seen.add(id), false)));
  })()`));
  assert.deepEqual(duplicateIds, [], "the dashboard has duplicate ids that can direct live data to the wrong card");
});

test("changing only the vision provider persists its selected model across refresh", { timeout: 120_000 }, async (t) => {
  if (!chromePath) {
    assert.ok(!process.env.CI, "CI has no browser, so the render check cannot run - install Chrome on the runner");
    t.skip("no Chrome on this machine; install one or set CHROME_PATH to run the render check");
    return;
  }
  const { base, services } = await startDashboard(t, { nativeVision: true, bundled: true });
  const onboarded = await fetch(`${base}/api/onboarding/complete`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(onboarded.status, 200);
  const { send, evaluate } = await openBrowser(t, chromePath, { instance: "vision-persistence" });
  await evaluate(`location.href = ${JSON.stringify(base)}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    if (await evaluate(`document.querySelector('#vision-provider-select option[value="openai"]') !== null`)) break;
  }
  await evaluate(`(() => {
    const skip = [...document.querySelectorAll('a,button')].find((node) => /skip for now/i.test(node.textContent));
    if (skip) skip.click();
    return true;
  })()`);
  assert.equal(await evaluate(`document.getElementById('vision-provider-select').value`), "opencode-go");
  await evaluate(`(() => {
    const select = document.getElementById('vision-provider-select');
    select.value = 'openai';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await sleep(50);
    if (!existsSync(services.config.envFile)) continue;
    const persisted = readFileSync(services.config.envFile, "utf8");
    if (/^MODELDOCK_VISION_MODEL=gpt-5\.6-luna@openai$/m.test(persisted)) break;
  }
  assert.match(readFileSync(services.config.envFile, "utf8"), /^MODELDOCK_VISION_MODEL=gpt-5\.6-luna@openai$/m,
    "the provider-only interaction writes the provider-qualified native selection");

  await evaluate(`location.reload()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    if (await evaluate(`document.readyState === 'complete' && document.getElementById('vision-provider-select')?.value === 'openai'`)) break;
  }
  assert.deepEqual(JSON.parse(await evaluate(`JSON.stringify({
    provider: document.getElementById('vision-provider-select').value,
    model: document.getElementById('vision-model-select').value,
  })`)), { provider: "openai", model: "gpt-5.6-luna" });
  if (process.env.MODELDOCK_TEST_SCREENSHOT) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(process.env.MODELDOCK_TEST_SCREENSHOT, Buffer.from(shot.result.data, "base64"));
  }
  const cleared = await fetch(`${base}/api/models`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visionModel: "" }),
  });
  assert.equal(cleared.status, 200);
  await evaluate(`location.reload()`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(100);
    if (await evaluate(`document.getElementById('vision-provider-select')?.options.length > 1`)) break;
  }
  assert.equal(await evaluate(`document.getElementById('vision-provider-select').value`), "",
    "a disabled fallback must not pretend to be OpenCode Go");
  assert.equal(await evaluate(`document.getElementById('vision-model-select').value`), "");
  if (process.env.MODELDOCK_TEST_SCREENSHOT) {
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${process.env.MODELDOCK_TEST_SCREENSHOT}.none.png`, Buffer.from(shot.result.data, "base64"));
  }
});


test("the built dashboard keeps local llama.cpp vision user-editable", { timeout: 120_000 }, async (t) => {
  if (!chromePath) {
    assert.ok(!process.env.CI, "CI has no browser, so the render check cannot run - install Chrome on the runner");
    t.skip("no Chrome on this machine; install one or set CHROME_PATH to run the render check");
    return;
  }
  const enginePort = await availablePort();
  const engine = createHttpServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "local-test-model", meta: { n_ctx: 32768 } }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/responses") {
      res.end(JSON.stringify({ id: "resp_local_probe", status: "completed", output: [], usage: {} }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  engine.listen(enginePort, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  t.after(() => new Promise((resolve) => engine.close(resolve)));

  const { base, services } = await startDashboard(t, { bundled: true });
  services.discoverEngines = async () => [{
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: `http://127.0.0.1:${enginePort}/v1`,
    port: enginePort,
    models: ["local-test-model"],
    connectable: true,
    supportsVision: false,
    launch: { model: "", ctxSize: 32768, parallel: 1 },
  }];
  const connected = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  assert.equal(connected.status, 200, await connected.text());

  const { send, evaluate } = await openBrowser(t, chromePath, { instance: "local-vision-toggle" });
  await evaluate(`location.href = ${JSON.stringify(`${base}#models`)}`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    if (await evaluate(`document.getElementById('roster-groups')?.textContent.includes('llama.cpp (local)')`)) break;
  }
  await evaluate(`(() => {
    const skip = [...document.querySelectorAll('a,button')].find((node) => /skip for now/i.test(node.textContent));
    skip?.click();
    return true;
  })()`);
  await sleep(100);
  const before = JSON.parse(await evaluate(`JSON.stringify((() => {
    const row = [...document.querySelectorAll('#roster-groups tr')]
      .find((candidate) => candidate.querySelector('strong')?.textContent.trim() === 'llama.cpp (local)');
    const inputs = row ? [...row.querySelectorAll('input[type="checkbox"]')] : [];
    return { inputs: inputs.length, checked: inputs[1]?.checked, disabled: inputs[1]?.disabled };
  })())`));
  assert.deepEqual(before, { inputs: 2, checked: false, disabled: false });
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#roster-groups tr')]
      .find((candidate) => candidate.querySelector('strong')?.textContent.trim() === 'llama.cpp (local)');
    row.querySelectorAll('input[type="checkbox"]')[1].click();
    return true;
  })()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(50);
    if (!existsSync(services.visionOverridesFile)) continue;
    if (JSON.parse(readFileSync(services.visionOverridesFile, "utf8"))["Local@llamacpp"] === true) break;
  }
  assert.equal(JSON.parse(readFileSync(services.visionOverridesFile, "utf8"))["Local@llamacpp"], true);
  await evaluate(`location.reload()`);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(250);
    if (await evaluate(`document.getElementById('roster-groups')?.textContent.includes('llama.cpp (local)')`)) break;
  }
  await evaluate(`(() => {
    const skip = [...document.querySelectorAll('a,button')].find((node) => /skip for now/i.test(node.textContent));
    skip?.click();
    return true;
  })()`);
  await sleep(100);
  const afterReload = JSON.parse(await evaluate(`JSON.stringify((() => {
    const row = [...document.querySelectorAll('#roster-groups tr')]
      .find((candidate) => candidate.querySelector('strong')?.textContent.trim() === 'llama.cpp (local)');
    const inputs = row ? [...row.querySelectorAll('input[type="checkbox"]')] : [];
    return { checked: inputs[1]?.checked, disabled: inputs[1]?.disabled };
  })())`));
  assert.deepEqual(afterReload, { checked: true, disabled: false },
    "the local vision override must survive a browser reload");
  if (process.env.MODELDOCK_TEST_SCREENSHOT) {
    await evaluate(`(() => {
      const row = [...document.querySelectorAll('#roster-groups tr')]
        .find((candidate) => candidate.querySelector('strong')?.textContent.trim() === 'llama.cpp (local)');
      row?.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    await sleep(100);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${process.env.MODELDOCK_TEST_SCREENSHOT}.local-vision.png`, Buffer.from(shot.result.data, "base64"));
  }
});


test("the narrow local drawer is an opaque configuration surface", { timeout: 120_000 }, async (t) => {
  if (!chromePath) {
    assert.ok(!process.env.CI, "CI has no browser, so the render check cannot run - install Chrome on the runner");
    t.skip("no Chrome on this machine; install one or set CHROME_PATH to run the render check");
    return;
  }
  const { base } = await startDashboard(t);
  const { evaluate } = await openBrowser(t, chromePath, { width: 1100, instance: "narrow" });
  await evaluate(`location.href = ${JSON.stringify(`${base}#local`)}`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('#llamacpp-configure')`)) break;
  }
  await evaluate(`(() => {
    const skip = [...document.querySelectorAll('a,button')].find((node) => /skip for now/i.test(node.textContent));
    if (skip) skip.click();
    document.getElementById('llamacpp-configure').click();
    return true;
  })()`);
  await sleep(400);
  const surface = JSON.parse(await evaluate(`JSON.stringify((() => {
    const drawer = document.getElementById('local-drawer');
    const card = drawer.querySelector('.local-drawer-card');
    const style = getComputedStyle(card);
    return {
      drawerPosition: getComputedStyle(drawer).position,
      cardBackground: style.backgroundColor,
      cardBorder: style.borderTopColor,
      cardVisible: card.offsetParent !== null,
    };
  })())`));
  assert.deepEqual(surface, {
    drawerPosition: "absolute",
    cardBackground: "rgb(16, 27, 38)",
    cardBorder: "rgb(35, 55, 71)",
    cardVisible: true,
  }, "the narrow drawer must cover the engine list with an opaque card");
});


// A canvas is sized from its CSS box, and from nothing else.
//
// This is a source check rather than a render check because the failure needs a
// redraw to happen while the view is hidden, and the only thing that redraws on
// its own is a 15-second poll. What it pins is exact and was live for the whole
// life of the waveform: `canvas.clientWidth || canvas.width` falls back to the
// bitmap, so a hidden canvas - which measures zero - reported its own bitmap
// size instead, and the guard written directly underneath to catch that case
// could never fire. Every poll that arrived while the dashboard sat on another
// tab then re-entered the resize with width = the current bitmap, multiplied it
// by the device pixel ratio again, and assigning canvas.width wipes the canvas.
//
// Measured at 125% display scaling: 345 -> 431 -> 539 -> 674, reaching
// 279239x93075 after thirty polls, from a card 276 CSS pixels wide. At 100% the
// resize condition is false and none of it happens, which is why the bug is
// invisible on an unscaled screen.
test("a canvas is sized from its CSS box, never from its own bitmap", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8")
    // The comment above the fix quotes the pattern it replaced, so the check
    // reads code rather than prose.
    .split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  const fallbacks = app.match(/client(?:Width|Height)\s*\|\|/g) || [];
  assert.deepEqual(fallbacks, [], "a canvas that measures zero is hidden, and must be left alone rather than resized to its own bitmap");
  // And every site that measures one still guards on the zero it can now see.
  const measured = (app.match(/const width = canvas\.clientWidth;/g) || []).length;
  const guarded = (app.match(/if \(!width \|\| !height\) return;/g) || []).length;
  assert.equal(measured, guarded, "each canvas measurement keeps the hidden-view guard beneath it");
  assert.equal(measured, 1, "all dashboard waves share one measured renderer");
  assert.equal((app.match(/drawCacheWave/g) || []).length, 0, "no call site may retain the removed parallel cache renderer");
  assert.ok((app.match(/drawWave\(/g) || []).length >= 8, "every wave delegates to the shared renderer");
});

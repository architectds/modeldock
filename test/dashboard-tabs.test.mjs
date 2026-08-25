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
import { createApp, createServices } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE, applyLocalEngineProfile } from "../src/profiles.mjs";
import { writeLocalEngineSnapshot } from "../src/local-engines.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

const TABS = ["dashboard", "subscriptions", "api", "local", "models", "hostmonitor"];

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

// A dashboard on a scratch port with its state in a temp dir, so looking at it
// cannot touch the developer's own configuration.
function managedHostSnapshot() {
  return {
    managed: true,
    hostId: "host-monitor-render-test",
    profile: { laneCount: 1, laneContextTokens: 215040 },
    maxActiveRequests: 1,
    activeCount: 0,
    pendingCount: 0,
    hotCount: 0,
    slotAffinity: false,
    lanes: [{ slot: 0, state: "cold", lastAccessedAt: 0 }],
    ssd: { totalBytes: 0, budgetBytes: 32 * 1024 ** 3, states: 0 },
    counters: { evictions: 0, expired: 0 },
  };
}

async function startDashboard(t, { managed = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-tabs-"));
  const services = createServices({
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    goBaseUrl: "https://go.example.com/v1",
    goToken: "tab-render-test",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    mediaTtlMs: 60_000,
    mediaMaxBytes: 1024 * 1024,
    mediaMaxEntries: 8,
    recentLimit: 10,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
    autostartDefault: false,
    summariesFile: path.join(dir, "summaries.json"),
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
    nativeCatalogFile: path.join(dir, "native-catalog.json"),
  });
  services.localEnginesFile = path.join(dir, "local-engines.json");
  // One configured endpoint, so the API tab renders a row with a Remove
  // button. Without it that tab has nothing to check and the escaped-element
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
  // A connected, observed llama.cpp host lets the browser prove that the page
  // displays gateway routing separately from the ungranted host-control
  // authority. The server is not real: discovery is injected, so no test ever
  // touches a developer's engine or GPU.
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
  services.discoverEngines = async () => [{
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: "http://127.0.0.1:11435",
    port: 11435,
    models: ["qwen3.8:27b"],
    connectable: true,
    binary: "D:/llama-cpp/llama-server.exe",
    cmdline: "D:/llama-cpp/llama-server.exe -m D:/models/qwen.gguf -c 262144 --parallel 1 --port 11435",
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
  }];
  services.probeGpus = async () => [];
  if (managed) {
    // This is deliberately a server-authoritative fake runtime, not a DOM
    // fixture. The dashboard only opens this tab after /api/status reports an
    // actively managed host, which is the production visibility contract.
    services.localHostRuntime = {
      snapshot: () => managedHostSnapshot(),
      status: async () => managedHostSnapshot(),
    };
  }

  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
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
  const port = 9350 + Math.floor(process.pid % 200) + (instance === "default" ? 0 : 300);
  const profile = path.join(os.tmpdir(), `modeldock-tabs-profile-${process.pid}-${instance}`);
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

  let ws;
  t.after(() => { try { ws?.close(); } catch { /* closing a closed socket */ } chrome.kill(); });

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
  assert.ok(target, exited !== null
    ? `Chrome exited (${exited}) before exposing a page target: ${stderr.trim().slice(-600) || "no output"}`
    : `Chrome exposed no page target within 30s: ${stderr.trim().slice(-600) || "no output"}`);

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
  const { base } = await startDashboard(t);
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

  for (const tab of TABS) {
    await evaluate(`location.hash = '#${tab}'`);
    await sleep(400);

    // 1. One tab is one view. This is the assertion 0.3.19 needed: Local Hosts
    //    was laid out on every tab because its rule outweighed the one that
    //    hides an inactive view and did not ask whether it was active.
    const shown = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.view')]
      .filter((v) => getComputedStyle(v).display !== 'none').map((v) => v.dataset.view))`));
    assert.deepEqual(shown, [tab], `#${tab} shows ${JSON.stringify(shown)} - a view is displayed while it is not the active one`);

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

  // A connection publishes models to the gateway but must not silently grant
  // lifecycle control. This opens the actual drawer and reads rendered text,
  // rather than only importing the functions that calculate it.
  await evaluate(`location.hash = '#local'`);
  await sleep(400);
  await evaluate(`document.getElementById('llamacpp-configure').click()`);
  await sleep(200);
  // The managed-host monitor is the hidden local numbers tab: its rail entry
  // and its content must both stay invisible until a host is under takeover,
  // and a stale #hostmonitor URL explains itself instead of rendering blank.
  const monitor = JSON.parse(await evaluate(`JSON.stringify({
    railHidden: document.getElementById('rail-hostmonitor').hidden,
    sectionHidden: document.getElementById('local-host-dashboard').hidden,
    emptyShown: !document.getElementById('hostdash-empty').hidden,
  })`));
  assert.deepEqual(monitor, { railHidden: true, sectionHidden: true, emptyShown: true },
    "the host monitor tab stays hidden while nothing is managed");

  const hostControl = JSON.parse(await evaluate(`JSON.stringify({
    visible: !document.getElementById('local-host-control').hidden,
    gateway: document.getElementById('local-host-gateway-state').textContent.trim(),
    control: document.getElementById('local-host-management-state').textContent.trim(),
    // The takeover action lives on the drawer's bottom primary in "manage"
    // mode - the standalone "Manage this host" button asked the drawer's own
    // question a second time and was removed.
    saveMode: document.getElementById('local-config-save').dataset.mode,
    saveLabel: document.getElementById('local-config-save').textContent.trim(),
    leaveVisible: document.getElementById('local-host-unmanage').offsetParent !== null,
    modelPath: document.getElementById('local-host-model-file').value,
    projectorHidden: document.getElementById('local-host-vision-projector-row').hidden,
    projectorPath: document.getElementById('local-host-vision-projector').value,
  })`));
  assert.deepEqual(hostControl, {
    visible: true,
    gateway: "Gateway connection: connected. ModelDock can route requests to this local server.",
    control: "Host control: user-owned. ModelDock cannot restart this server or manage its SSD KV state.",
    saveMode: "manage",
    saveLabel: "Save and Manage",
    leaveVisible: false,
    modelPath: "D:/models/previous-connected-model.gguf",
    projectorHidden: false,
    projectorPath: "D:/models/previous-connected-projector.gguf",
  }, "a connected local server stays user-owned until the user explicitly enables host control");

  // 5. And none of that produced an error the page swallowed.
  const errors = JSON.parse(await evaluate(`JSON.stringify(window.__pageErrors || [])`));
  assert.deepEqual(errors, [], "the dashboard threw while rendering its tabs");
});

// The monitor redraws whenever an SSE status snapshot arrives. At fractional
// display scaling a canvas whose bitmap width is also its CSS layout width
// grows by the DPR on each redraw. This opens the actual managed-only tab at
// DPR 1.5 and redraws it repeatedly, so a missing CSS size cannot hide behind
// the headless browser's usual DPR 1.0 default.
test("the managed-host monitor keeps its canvas geometry and history bounded", { timeout: 120_000 }, async (t) => {
  if (!chromePath) {
    assert.ok(!process.env.CI, "CI has no browser, so the render check cannot run - install Chrome on the runner");
    t.skip("no Chrome on this machine; install one or set CHROME_PATH to run the render check");
    return;
  }
  const { base, services } = await startDashboard(t, { managed: true });
  const { evaluate } = await openBrowser(t, chromePath, { deviceScaleFactor: 1.5, instance: "hostmonitor" });
  await evaluate(`location.href = ${JSON.stringify(`${base}#hostmonitor`)}`);
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if (await evaluate(`document.readyState === 'complete' && !document.getElementById('local-host-dashboard').hidden`)) break;
  }
  await evaluate(`(() => {
    const skip = [...document.querySelectorAll('a,button')].find((node) => /skip for now/i.test(node.textContent));
    if (skip) skip.click();
    return true;
  })()`);
  await sleep(300);

  // This uses the same Metrics -> coalesced SSE -> browser render path as a
  // completed local response. The 100ms spacing intentionally lets every
  // status event repaint; direct page calls would miss this integration seam.
  for (let redraw = 0; redraw < 6; redraw += 1) {
    const finish = services.metrics.begin("responses", {
      localCache: { tier: ["gpu", "ssd", "cold", "llama_auto"][redraw % 4] },
      inputTokens: 1_000,
      outputTokens: 100,
    });
    finish.markFirstResponse();
    finish({ localCache: { tier: ["gpu", "ssd", "cold", "llama_auto"][redraw % 4] } });
    await sleep(160);
  }

  const monitor = JSON.parse(await evaluate(`(() => {
    const canvases = ['hostdash-prefill-wave', 'hostdash-decode-wave'].map((id) => {
      const canvas = document.getElementById(id);
      const box = canvas.getBoundingClientRect();
      return { cssWidth: box.width, cssHeight: box.height, bitmapWidth: canvas.width, bitmapHeight: canvas.height };
    });
    return JSON.stringify({
      dpr: window.devicePixelRatio,
      panelHeight: document.getElementById('local-host-dashboard').getBoundingClientRect().height,
      canvases,
      recentTierDots: document.querySelectorAll('#hostdash-tier-strip .tier-dot').length,
    });
  })()`));

  assert.equal(monitor.dpr, 1.5, "the regression must run at fractional display scaling");
  assert.ok(monitor.panelHeight < 900, `monitor panel grew to ${monitor.panelHeight}px after redraws`);
  for (const canvas of monitor.canvases) {
    assert.equal(Math.round(canvas.cssHeight), 92, "monitor canvas keeps its 92px CSS height");
    assert.ok(Math.abs(canvas.bitmapWidth - Math.round(canvas.cssWidth * monitor.dpr)) <= 1,
      "bitmap width follows the fixed CSS box once");
    assert.ok(Math.abs(canvas.bitmapHeight - Math.round(canvas.cssHeight * monitor.dpr)) <= 1,
      "bitmap height follows the fixed CSS box once");
  }
  assert.ok(monitor.recentTierDots > 0 && monitor.recentTierDots <= 6,
    "completed local requests reached the managed-host monitor over SSE");
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
  assert.ok(measured >= 2, "both wave renderers are covered");
});

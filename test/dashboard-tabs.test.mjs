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
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

const TABS = ["dashboard", "subscriptions", "api", "local", "models"];

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
async function startDashboard(t) {
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
  // Nothing on this machine, so the page renders the same on every runner.
  services.discoverEngines = async () => [];
  services.probeGpus = async () => [];

  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// The smallest CDP client that can drive a page and read a value back.
async function openBrowser(t, chromePath) {
  const port = 9350 + Math.floor(process.pid % 200);
  const profile = path.join(os.tmpdir(), `modeldock-tabs-profile-${process.pid}`);
  const chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox",
    `--remote-debugging-port=${port}`, "--window-size=1500,1000",
    `--user-data-dir=${profile}`, "about:blank",
  ], { stdio: "ignore" });

  let ws;
  t.after(() => { try { ws?.close(); } catch { /* closing a closed socket */ } chrome.kill(); });

  let target = null;
  for (let i = 0; i < 40 && !target; i += 1) {
    await sleep(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((entry) => entry.type === "page");
    } catch { /* not listening yet */ }
  }
  assert.ok(target, "Chrome exposed no page target");

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
  const base = await startDashboard(t);
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

  // 5. And none of that produced an error the page swallowed.
  const errors = JSON.parse(await evaluate(`JSON.stringify(window.__pageErrors || [])`));
  assert.deepEqual(errors, [], "the dashboard threw while rendering its tabs");
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

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, parseLatestRelease, parseSumsFile, localVersion, createUpdater, deployFilesAtomically, scheduleRestart } from "../src/update.mjs";

function responseBody(body) {
  const bytes = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.length) },
    arrayBuffer: async () => bytes,
  };
}

function releaseResponse(tag, assets, sums = "") {
  const releaseAssets = { ...assets, ...(sums ? { SHA256SUMS: sums } : {}) };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      tag_name: `v${tag}`,
      html_url: `https://example.com/releases/v${tag}`,
      assets: Object.entries(releaseAssets).map(([name, body]) => ({
        name,
        browser_download_url: `https://assets.example/${tag}/${name}`,
        body,
      })),
    }),
  };
}

function sha256(body) {
  return createHash("sha256").update(body).digest("hex");
}

test("compareVersions orders dotted versions numerically", () => {
  assert.ok(compareVersions("0.2.0", "0.1.0") > 0);
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("v1.2.3", "1.2.2") > 0);
  assert.ok(compareVersions("1.0.1", "1.0") > 0);
});

test("parseLatestRelease flags newer releases with the bundle asset", () => {
  const release = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/x/y/releases/tag/v0.2.0",
    assets: [
      { name: "modeldock.mjs", browser_download_url: "https://example.com/modeldock.mjs" },
      { name: "SHA256SUMS", browser_download_url: "https://example.com/SHA256SUMS" },
    ],
  };
  const parsed = parseLatestRelease(release, "0.1.0");
  assert.equal(parsed.available, true);
  assert.equal(parsed.latestVersion, "0.2.0");
  assert.equal(parsed.assetUrl, "https://example.com/modeldock.mjs");
  assert.equal(parsed.sumsUrl, "https://example.com/SHA256SUMS");
  assert.equal(parsed.notesUrl, "https://github.com/x/y/releases/tag/v0.2.0");
});

test("parseSumsFile reads sha256sum output", () => {
  const hex = "a".repeat(64);
  const sums = parseSumsFile(`${hex}  modeldock.mjs\n${"b".repeat(64)} *other.bin\nnot a sums line\n`);
  assert.equal(sums["modeldock.mjs"], hex);
  assert.equal(sums["other.bin"], "b".repeat(64));
  assert.equal(Object.keys(sums).length, 2);
  assert.deepEqual(parseSumsFile(""), {});
});

test("parseLatestRelease is not available for same or older versions", () => {
  assert.equal(parseLatestRelease({ tag_name: "v0.1.0", assets: [] }, "0.1.0").available, false);
  assert.equal(parseLatestRelease({ tag_name: "v0.0.9", assets: [] }, "0.1.0").available, false);
  assert.equal(parseLatestRelease({}, "0.1.0").available, false);
  assert.equal(parseLatestRelease(null, "0.1.0").available, false);
});

test("localVersion reads package.json in a git checkout", () => {
  assert.match(localVersion(), /^\d+\.\d+\.\d+/);
});

test("createUpdater.check populates state from the release endpoint", async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      tag_name: "v99.0.0",
      html_url: "https://example.com/notes",
      assets: [{ name: "modeldock.mjs", browser_download_url: "https://example.com/dl" }],
    }),
  });
  const updater = createUpdater({ fetchImpl });
  const state = await updater.check();
  assert.equal(state.available, true);
  assert.equal(state.latestVersion, "99.0.0");
  assert.equal(state.error, "");
  assert.ok(state.checkedAt > 0);
});

test("createUpdater.check sends a bearer token when configured", async () => {
  process.env.MODELDOCK_GITHUB_TOKEN = "test-token";
  try {
    let seenHeaders = null;
    const fetchImpl = async (_url, options) => {
      seenHeaders = options.headers;
      return {
        ok: true,
        json: async () => ({ tag_name: "v0.2.0", html_url: "", assets: [] }),
      };
    };
    const updater = createUpdater({ fetchImpl });
    await updater.check();
    assert.equal(seenHeaders.authorization, "Bearer test-token");
    assert.equal(seenHeaders.accept, "application/vnd.github+json");
  } finally {
    delete process.env.MODELDOCK_GITHUB_TOKEN;
  }
});

test("createUpdater.check records errors without throwing", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const updater = createUpdater({ fetchImpl });
  const state = await updater.check();
  assert.equal(state.available, false);
  assert.match(state.error, /503/);
});

test("createUpdater.apply never falls back to cached release assets when the latest recheck fails", async () => {
  let calls = 0;
  let migrations = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return releaseResponse("0.4.0", {
        "modeldock.mjs": "cached bundle",
        "mcp-standalone.mjs": "cached bridge",
        "install.ps1": "cached installer",
      }, "cached sums");
    }
    return { ok: false, status: 503 };
  };
  const updater = createUpdater({
    fetchImpl,
    nodeMajor: 22,
    platform: "win32",
    rootDir: path.join(os.tmpdir(), "modeldock-not-a-checkout"),
    migrateImpl: async () => { migrations += 1; },
  });
  assert.equal((await updater.check()).available, true);
  await assert.rejects(updater.apply(), /No update available/);
  assert.equal(migrations, 0);
  assert.equal(updater.state().available, false);
  assert.match(updater.state().error, /503/);
});

test("createUpdater.apply refuses when no update is available", async () => {
  const updater = createUpdater({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(() => updater.apply(), /No update available/);
});

test("createUpdater.apply hands Node 22 directly to the verified latest installer", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-node-gate-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.3.3" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  const oldBundle = "installed bridge bundle";
  writeFileSync(path.join(rootDir, "dist", "modeldock.mjs"), oldBundle);
  const installer = "Write-Output 'migrate to latest'";
  const bridgeAssets = {
    "modeldock.mjs": "new",
    "mcp-standalone.mjs": "new bridge",
    "install.ps1": installer,
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
    "recover.ps1": "new recovery",
  };
  const sums = Object.entries(bridgeAssets).map(([name, body]) => `${sha256(body)}  ${name}`).join("\n");
  let migration;
  let restartCalls = 0;
  const downloads = [];
  const fetchImpl = async (url) => {
    downloads.push(url);
    if (url.includes("api.github.com")) {
      return releaseResponse("0.4.0", bridgeAssets, sums);
    }
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    if (url.endsWith("/install.ps1")) return responseBody(installer);
    return responseBody("unexpected");
  };
  const updater = createUpdater({
    fetchImpl,
    rootDir,
    platform: "win32",
    nodeMajor: 22,
    restartImpl: () => { restartCalls += 1; },
    migrateImpl: async (options) => { migration = options; },
  });
  await updater.check();
  const result = await updater.apply();
  assert.equal(result.mode, "installer");
  assert.equal(result.latestVersion, "0.4.0");
  assert.equal(restartCalls, 0, "the bridge updater must not restart before runtime migration");
  assert.equal(updater.state().updating, false, "a failed detached migration must remain retryable");
  assert.equal(migration.installerName, "install.ps1");
  assert.equal(migration.body.toString("utf8"), installer);
  assert.ok(downloads.some((url) => url.endsWith("/releases/download/v0.3.3/install.ps1")));
  assert.ok(!downloads.some((url) => url === "https://assets.example/0.4.0/install.ps1"));
  assert.equal(readFileSync(path.join(rootDir, "dist", "modeldock.mjs"), "utf8"), oldBundle);
});

test("createUpdater.apply refuses a tampered migration installer without changing the old bundle", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-node-installer-hash-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.3.3" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  writeFileSync(path.join(rootDir, "dist", "modeldock.mjs"), "old bridge bundle");
  const bridgeAssets = {
    "modeldock.mjs": "new",
    "mcp-standalone.mjs": "new bridge",
    "modeldock-stt-helper": "new Mac helper",
    "install.sh": "tampered installer",
    "start-hidden.sh": "new launcher",
    "restart.sh": "new restart",
    "recover.sh": "new recovery",
  };
  const sums = Object.entries(bridgeAssets)
    .map(([name, body]) => `${sha256(name === "install.sh" ? "expected installer" : body)}  ${name}`)
    .join("\n");
  let migrations = 0;
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) {
      return releaseResponse("0.4.0", bridgeAssets, sums);
    }
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody("tampered installer");
  };
  const updater = createUpdater({
    fetchImpl,
    rootDir,
    platform: "darwin",
    nodeMajor: 22,
    migrateImpl: async () => { migrations += 1; },
  });
  await updater.check();
  await assert.rejects(updater.apply(), /Checksum mismatch/);
  assert.equal(migrations, 0);
  assert.equal(readFileSync(path.join(rootDir, "dist", "modeldock.mjs"), "utf8"), "old bridge bundle");
});

test("one update action migrates Node and then atomically lands on the newest release", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-one-action-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.3.3" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  const oldBundle = "old bridge bundle";
  const newestBundle = "newest gateway".repeat(20_000);
  const assets = {
    "modeldock.mjs": newestBundle,
    "mcp-standalone.mjs": "newest bridge",
    "install.ps1": "Write-Output 'runtime migration'",
    "start-hidden.ps1": "newest launcher",
    "restart.ps1": "newest restart",
    "recover.ps1": "newest recovery",
  };
  const sums = Object.entries(assets).map(([name, body]) => `${sha256(body)}  ${name}`).join("\n");
  writeFileSync(path.join(rootDir, "dist", "modeldock.mjs"), oldBundle);
  for (const relative of ["dist/mcp-standalone.mjs", "scripts/start-hidden.ps1", "scripts/restart.ps1", "scripts/recover.ps1"]) {
    writeFileSync(path.join(rootDir, relative), `old ${relative}`);
  }
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) return releaseResponse("0.6.0", assets, sums);
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody(assets[url.split("/").pop()]);
  };
  let handedOff = false;
  const bridgeUpdater = createUpdater({
    fetchImpl,
    rootDir,
    platform: "win32",
    nodeMajor: 22,
    migrateImpl: async () => { handedOff = true; },
  });
  await bridgeUpdater.check();
  assert.equal((await bridgeUpdater.apply()).mode, "installer");
  assert.equal(handedOff, true);
  assert.equal(readFileSync(path.join(rootDir, "dist", "modeldock.mjs"), "utf8"), oldBundle);

  let restarts = 0;
  const migratedUpdater = createUpdater({
    fetchImpl,
    rootDir,
    platform: "win32",
    nodeMajor: 24,
    restartImpl: () => { restarts += 1; },
  });
  const result = await migratedUpdater.apply();
  assert.equal(result.latestVersion, "0.6.0");
  assert.equal(restarts, 1);
  assert.equal(readFileSync(path.join(rootDir, "dist", "modeldock.mjs"), "utf8"), newestBundle);
});

test("createUpdater.apply deploys the complete Windows install and rechecks at click time", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));

  const oldFiles = {
    "dist/modeldock.mjs": "old gateway",
    "dist/mcp-standalone.mjs": "old bridge",
    "scripts/start-hidden.ps1": "old launcher",
    "scripts/restart.ps1": "old restart",
    "scripts/recover.ps1": "old recovery",
    "scripts/start-hidden.sh": "posix file must not change on Windows",
  };
  for (const [relative, body] of Object.entries(oldFiles)) {
    writeFileSync(path.join(rootDir, relative), body);
  }

  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
    "recover.ps1": "new recovery",
    "start-hidden.sh": "new posix launcher",
  };
  const sums = Object.entries(assets)
    .map(([name, body]) => `${sha256(body)}  ${name}`)
    .join("\n");
  let releaseChecks = 0;
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) {
      releaseChecks += 1;
      return releaseResponse(releaseChecks === 1 ? "0.2.6" : "0.2.7", assets, sums);
    }
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    const name = url.split("/").pop();
    return responseBody(assets[name]);
  };
  let restartCalls = 0;
  const updater = createUpdater({
    fetchImpl,
    restartImpl: () => { restartCalls += 1; },
    rootDir,
    platform: "win32",
  });

  assert.equal((await updater.check()).latestVersion, "0.2.6");
  const result = await updater.apply();

  assert.equal(result.latestVersion, "0.2.7");
  assert.equal(releaseChecks, 2, "apply should re-check instead of trusting stale startup state");
  assert.equal(restartCalls, 1);
  for (const [relative, body] of Object.entries({
    "dist/modeldock.mjs": assets["modeldock.mjs"],
    "dist/mcp-standalone.mjs": assets["mcp-standalone.mjs"],
    "scripts/start-hidden.ps1": assets["start-hidden.ps1"],
    "scripts/restart.ps1": assets["restart.ps1"],
    "scripts/recover.ps1": assets["recover.ps1"],
  })) {
    assert.equal(readFileSync(path.join(rootDir, relative), "utf8"), body, `${relative} should be updated`);
  }
  assert.equal(
    readFileSync(path.join(rootDir, "scripts/start-hidden.sh"), "utf8"),
    oldFiles["scripts/start-hidden.sh"],
    "a non-current-platform helper must not be overwritten",
  );
  const rollbackName = readFileSync(path.join(rootDir, ".modeldock-rollback/current"), "utf8").trim();
  const rollbackDir = path.join(rootDir, ".modeldock-rollback", rollbackName);
  const manifest = JSON.parse(readFileSync(path.join(rollbackDir, "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ["dist/modeldock.mjs", "dist/mcp-standalone.mjs", "scripts/start-hidden.ps1", "scripts/restart.ps1", "scripts/recover.ps1"],
  );
  for (const relative of manifest.files.map((file) => file.path)) {
    assert.equal(readFileSync(path.join(rollbackDir, relative), "utf8"), oldFiles[relative], `${relative} should have a rollback copy`);
  }
});

test("createUpdater.apply deploys the macOS STT helper atomically and keeps it executable", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-mac-stt-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  const original = {
    "dist/modeldock.mjs": "old gateway",
    "dist/mcp-standalone.mjs": "old bridge",
    "dist/modeldock-stt-helper": "old helper",
    "scripts/start-hidden.sh": "old launcher",
    "scripts/restart.sh": "old restart",
    "scripts/recover.sh": "old recovery",
  };
  for (const [relative, body] of Object.entries(original)) writeFileSync(path.join(rootDir, relative), body);
  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "modeldock-stt-helper": "new helper",
    "start-hidden.sh": "new launcher",
    "restart.sh": "new restart",
    "recover.sh": "new recovery",
  };
  const sums = Object.entries(assets).map(([name, body]) => `${sha256(body)}  ${name}`).join("\n");
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) return releaseResponse("0.2.6", assets, sums);
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody(assets[url.split("/").pop()]);
  };
  let restarts = 0;
  const updater = createUpdater({
    fetchImpl,
    restartImpl: () => { restarts += 1; },
    rootDir,
    platform: "darwin",
  });

  await updater.check();
  await updater.apply();
  assert.equal(restarts, 1);
  const helper = path.join(rootDir, "dist", "modeldock-stt-helper");
  assert.equal(readFileSync(helper, "utf8"), assets["modeldock-stt-helper"]);
  if (process.platform !== "win32") {
    assert.ok((statSync(helper).mode & 0o111) !== 0, "the downloaded helper must remain executable after rename");
  }
  const rollbackName = readFileSync(path.join(rootDir, ".modeldock-rollback", "current"), "utf8").trim();
  const manifest = JSON.parse(readFileSync(path.join(rootDir, ".modeldock-rollback", rollbackName, "manifest.json"), "utf8"));
  assert.ok(manifest.files.some((file) => file.path === "dist/modeldock-stt-helper"), "the helper belongs to the same rollback generation");
});

test("createUpdater.apply leaves an installed layout untouched when a helper is missing", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-missing-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  const original = {
    "dist/modeldock.mjs": "installed gateway",
    "dist/mcp-standalone.mjs": "installed bridge",
    "scripts/start-hidden.ps1": "installed launcher",
    "scripts/restart.ps1": "installed restart",
    "scripts/recover.ps1": "installed recovery",
  };
  for (const [relative, body] of Object.entries(original)) writeFileSync(path.join(rootDir, relative), body);
  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
  };
  const sums = Object.entries(assets)
    .map(([name, body]) => `${sha256(body)}  ${name}`)
    .join("\n");
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) return releaseResponse("0.2.6", assets, sums);
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody(assets[url.split("/").pop()]);
  };
  const updater = createUpdater({
    fetchImpl,
    restartImpl: () => assert.fail("restart must not happen after an incomplete release"),
    rootDir,
    platform: "win32",
  });

  await updater.check();
  await assert.rejects(() => updater.apply(), /Release is missing recover\.ps1/);
  for (const [relative, body] of Object.entries(original)) {
    assert.equal(readFileSync(path.join(rootDir, relative), "utf8"), body, `${relative} must remain unchanged`);
  }
});

test("createUpdater.apply rolls back the whole layout when a destination cannot be replaced", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-rollback-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  const original = {
    "dist/modeldock.mjs": "installed gateway",
    "dist/mcp-standalone.mjs": "installed bridge",
    "scripts/restart.ps1": "installed restart",
    "scripts/recover.ps1": "installed recovery",
  };
  for (const [relative, body] of Object.entries(original)) writeFileSync(path.join(rootDir, relative), body);
  // A corrupt layout with a directory at a helper destination used to fail only
  // after the bundle and bridge had already been replaced.
  mkdirSync(path.join(rootDir, "scripts/start-hidden.ps1"));
  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
    "recover.ps1": "new recovery",
  };
  const sums = Object.entries(assets).map(([name, body]) => `${sha256(body)}  ${name}`).join("\n");
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) return releaseResponse("0.2.6", assets, sums);
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody(assets[url.split("/").pop()]);
  };
  const updater = createUpdater({
    fetchImpl,
    restartImpl: () => assert.fail("restart must not happen after a failed deployment"),
    rootDir,
    platform: "win32",
  });

  await updater.check();
  await assert.rejects(() => updater.apply(), /destination is not a file/);
  for (const [relative, body] of Object.entries(original)) {
    assert.equal(readFileSync(path.join(rootDir, relative), "utf8"), body, `${relative} must be rolled back`);
  }
});

test("deployFilesAtomically arms a complete rollback snapshot before the first replacement", (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-crash-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  writeFileSync(path.join(rootDir, "dist/modeldock.mjs"), "old bundle");
  writeFileSync(path.join(rootDir, "scripts/restart.ps1"), "old restart");
  const moduleUrl = new URL("../src/update.mjs", import.meta.url).href;
  const childScript = `
    import path from "node:path";
    import { deployFilesAtomically } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1];
    deployFilesAtomically([
      { body: Buffer.from("new bundle"), dest: path.join(root, "dist/modeldock.mjs") },
      { body: Buffer.from("new restart"), dest: path.join(root, "scripts/restart.ps1") },
    ], root, { afterReplace(count) { if (count === 1) process.exit(73); } });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", childScript, rootDir]);
  assert.equal(child.status, 73);
  assert.equal(readFileSync(path.join(rootDir, "dist/modeldock.mjs"), "utf8"), "new bundle");
  assert.equal(readFileSync(path.join(rootDir, "scripts/restart.ps1"), "utf8"), "old restart");
  const rollbackRoot = path.join(rootDir, ".modeldock-rollback");
  const current = readFileSync(path.join(rollbackRoot, "current"), "utf8").trim();
  const snapshot = path.join(rollbackRoot, current);
  const manifest = JSON.parse(readFileSync(path.join(snapshot, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.files.map((entry) => entry.path), ["dist/modeldock.mjs", "scripts/restart.ps1"]);
  assert.equal(readFileSync(path.join(snapshot, "dist/modeldock.mjs"), "utf8"), "old bundle");
  assert.equal(readFileSync(path.join(snapshot, "scripts/restart.ps1"), "utf8"), "old restart");
  assert.equal(readdirSync(rollbackRoot).some((name) => name.endsWith(".tmp")), false);
});

test("deployFilesAtomically restores the prior marker after an in-process replacement failure", (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-marker-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, ".modeldock-rollback", "100-1"), { recursive: true });
  writeFileSync(path.join(rootDir, ".modeldock-rollback", "current"), "100-1\n");
  writeFileSync(path.join(rootDir, "dist/modeldock.mjs"), "old bundle");
  assert.throws(() => deployFilesAtomically(
    [{ body: Buffer.from("new bundle"), dest: path.join(rootDir, "dist/modeldock.mjs") }],
    rootDir,
    { afterReplace() { throw new Error("injected replacement failure"); } },
  ), /injected replacement failure/);
  assert.equal(readFileSync(path.join(rootDir, "dist/modeldock.mjs"), "utf8"), "old bundle");
  assert.equal(readFileSync(path.join(rootDir, ".modeldock-rollback", "current"), "utf8"), "100-1\n");
  assert.deepEqual(readdirSync(path.join(rootDir, ".modeldock-rollback")).sort(), ["100-1", "current"]);
});

test("deployFilesAtomically preserves recovery material when in-process rollback fails", (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-rollback-failure-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(rootDir, "dist"));
  const destination = path.join(rootDir, "dist/modeldock.mjs");
  writeFileSync(destination, "old bundle");
  assert.throws(() => deployFilesAtomically(
    [{ body: Buffer.from("new bundle"), dest: destination }],
    rootDir,
    { afterReplace() {
      rmSync(`${destination}.${process.pid}.update-backup`);
      throw new Error("injected failure after replacement");
    } },
  ), /rollback failed/);
  assert.equal(readFileSync(destination, "utf8"), "new bundle", "the failed in-process restore remains visible");
  const rollbackRoot = path.join(rootDir, ".modeldock-rollback");
  const current = readFileSync(path.join(rollbackRoot, "current"), "utf8").trim();
  assert.equal(readFileSync(path.join(rollbackRoot, current, "dist/modeldock.mjs"), "utf8"), "old bundle");
  assert.ok(readFileSync(path.join(rollbackRoot, current, "manifest.json"), "utf8").includes("dist/modeldock.mjs"));
});

test("createUpdater.apply rolls back when the complete rollback snapshot cannot be written", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-prev-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  const original = {
    "dist/modeldock.mjs": "installed gateway",
    "dist/mcp-standalone.mjs": "installed bridge",
    "scripts/start-hidden.ps1": "installed launcher",
    "scripts/restart.ps1": "installed restart",
    "scripts/recover.ps1": "installed recovery",
  };
  for (const [relative, body] of Object.entries(original)) writeFileSync(path.join(rootDir, relative), body);
  writeFileSync(path.join(rootDir, ".modeldock-rollback"), "blocked rollback directory");
  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
    "recover.ps1": "new recovery",
  };
  const sums = Object.entries(assets).map(([name, body]) => `${sha256(body)}  ${name}`).join("\n");
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) return releaseResponse("0.2.6", assets, sums);
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody(assets[url.split("/").pop()]);
  };
  const updater = createUpdater({ fetchImpl, restartImpl: () => {}, rootDir, platform: "win32" });

  await updater.check();
  await assert.rejects(() => updater.apply());
  for (const [relative, body] of Object.entries(original)) {
    assert.equal(readFileSync(path.join(rootDir, relative), "utf8"), body, `${relative} must remain unchanged`);
  }
});

test("createUpdater.apply keeps only the two most recent rollback snapshots", async (t) => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-update-prune-"));
  t.after(() => rmSync(rootDir, { recursive: true, force: true }));
  writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ version: "0.2.5" }));
  mkdirSync(path.join(rootDir, "dist"));
  mkdirSync(path.join(rootDir, "scripts"));
  for (const [relative, body] of Object.entries({
    "dist/modeldock.mjs": "installed gateway",
    "dist/mcp-standalone.mjs": "installed bridge",
    "scripts/start-hidden.ps1": "installed launcher",
    "scripts/restart.ps1": "installed restart",
    "scripts/recover.ps1": "installed recovery",
  })) writeFileSync(path.join(rootDir, relative), body);

  const assets = {
    "modeldock.mjs": "new gateway".repeat(20_000),
    "mcp-standalone.mjs": "new bridge",
    "start-hidden.ps1": "new launcher",
    "restart.ps1": "new restart",
    "recover.ps1": "new recovery",
  };
  const sums = Object.entries(assets).map(([name, body]) => `${sha256(body)}  ${name}`).join("\n");
  let releaseChecks = 0;
  const fetchImpl = async (url) => {
    if (url.includes("api.github.com")) {
      releaseChecks += 1;
      return releaseResponse(releaseChecks === 1 ? "0.2.6" : "0.2.7", assets, sums);
    }
    if (url.endsWith("/SHA256SUMS")) return responseBody(sums);
    return responseBody(assets[url.split("/").pop()]);
  };
  // apply() leaves the updater in "updating" state by design (the process
  // restarts right after a real update), so the second deployment uses a fresh
  // instance that shares the release feed.
  const updater = createUpdater({ fetchImpl, restartImpl: () => {}, rootDir, platform: "win32" });
  await updater.check();
  await updater.apply();
  const rollbackRoot = path.join(rootDir, ".modeldock-rollback");
  const firstCurrent = readFileSync(path.join(rollbackRoot, "current"), "utf8").trim();
  // Plant one stale snapshot, then run a second update: the newest snapshot
  // plus the previous real generation must survive, while the stale one is pruned.
  const staleSnapshot = "0000000000000-111";
  const staleDir = path.join(rollbackRoot, staleSnapshot);
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(path.join(staleDir, "manifest.json"), '{"files":[]}\n');
  const updater2 = createUpdater({ fetchImpl, restartImpl: () => {}, rootDir, platform: "win32" });
  await updater2.check();
  await updater2.apply();

  const snapshots = readdirSync(rollbackRoot).filter((name) => /^\d+-\d+$/.test(name)).sort();
  assert.equal(snapshots.length, 2, "only the two most recent snapshots are kept");
  assert.ok(!snapshots.includes(staleSnapshot), "the stale snapshot is pruned");
  assert.ok(snapshots.includes(firstCurrent), "the previous generation survives");
  const current = readFileSync(path.join(rollbackRoot, "current"), "utf8").trim();
  assert.equal(current, snapshots[1], "the marker still points at the newest snapshot");
});

// The Windows restart script stops the gateway that spawned it, so it only
// finishes if it outlives that parent. Measured on Windows 11, a plain child
// does not: kill or exit the parent right after the spawn and the script is
// torn down before its Start-Process, which is the "restarting..." that never
// comes back with the listener gone. Going through cmd's `start` re-parents it.
// This test pins the spawn shape, since that is the entire fix.
test("the Windows restart is re-parented so it survives stopping its own parent", () => {
  const calls = [];
  const rootDir = ["C:", "Users", "Chen Bao", ".modeldock"].join(path.sep);
  scheduleRestart(rootDir, {
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { on() {}, unref() {} };
    },
    platform: "win32",
  });

  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, "cmd.exe", "a direct powershell child dies with the gateway it stops");
  assert.deepEqual(args.slice(0, 4), ["/c", "start", "", "/b"], "start needs its empty window-title argument");
  assert.ok(args.includes("powershell.exe"));
  assert.ok(args.includes("-Force"), "the takeover flag still reaches the script");
  // A path with a space must arrive as one argument; cmd would otherwise split
  // it and powershell would report a script it cannot find.
  assert.ok(
    args.some((arg) => arg === path.join(rootDir, "scripts", "restart.ps1")),
    "the script path stays a single argument",
  );
  assert.notEqual(options.detached, true, "a detached powershell never executes the script on Windows");
});

test("the POSIX restart stays detached rather than going through cmd", () => {
  const calls = [];
  scheduleRestart("/home/u/.modeldock", {
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { on() {}, unref() {} };
    },
    platform: "linux",
  });
  assert.equal(calls[0].command, "sh");
  assert.equal(calls[0].options.detached, true, "detach is the POSIX way to outlive the parent");
});

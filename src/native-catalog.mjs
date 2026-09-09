import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteJsonSync } from "./atomic-file.mjs";

// Async exec so the model-refresh timer and startup capture never block the event
// loop of a live relay: `codex debug models` can take seconds (or hang to its
// timeout), and a synchronous call would stall every in-flight SSE stream.
const execFileAsync = promisify(execFile);
const nativeCatalogCache = new Map();

// The Codex App's picker list is a replacement, not a merge: with
// `model_catalog_json` set it shows exactly that file, otherwise it shows the
// app's bundled native GPT catalog. So native GPT models must be published in
// our own catalog to stay visible beside ours. This module captures that
// bundled catalog from the Codex desktop CLI (`codex debug models --bundled`),
// caches it next to the model catalog file, and exposes the captured slugs so
// the gateway can route them to the native backend instead of an external
// upstream. Same approach codex-router uses for its merged catalog.

// The desktop app bundles its CLI in different places per platform. Windows puts
// it under a version-hashed directory (%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\
// codex.exe); the hash changes on every app update, so scan for the newest
// installed version instead of pinning one. macOS ships it inside the app bundle.
// Keep the current and legacy names as direct candidates, then scan the two
// standard Applications directories for any future app rename that still uses
// the same Resources/codex contract.
function newestCodexInDir(binDir, binaryName) {
  try {
    const matches = readdirSync(binDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binDir, entry.name, binaryName))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return matches[0] || null;
  } catch {
    return null;
  }
}

export function codexAppCandidates(applicationsDir) {
  try {
    return readdirSync(applicationsDir, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name.endsWith(".app"))
      .map((entry) => path.join(applicationsDir, entry.name, "Contents", "Resources", "codex"))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    return [];
  }
}

export function desktopCodexCandidates(platform = process.platform) {
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) return [];
    const bundled = newestCodexInDir(path.join(localAppData, "OpenAI", "Codex", "bin"), "codex.exe");
    return bundled ? [bundled] : [];
  }
  if (platform === "darwin") {
    const userApplications = path.join(os.homedir(), "Applications");
    return [...new Set([
      newestCodexInDir(path.join(os.homedir(), "Library", "Application Support", "OpenAI", "Codex", "bin"), "codex"),
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/OpenAI Codex.app/Contents/Resources/codex",
      path.join(userApplications, "Codex.app", "Contents", "Resources", "codex"),
      path.join(userApplications, "ChatGPT.app", "Contents", "Resources", "codex"),
      path.join(userApplications, "OpenAI Codex.app", "Contents", "Resources", "codex"),
      ...codexAppCandidates("/Applications"),
      ...codexAppCandidates(userApplications),
    ].filter(Boolean))];
  }
  return [];
}

function desktopBundledCodex() {
  return desktopCodexCandidates().find((candidate) => existsSync(candidate)) || null;
}

async function pathCodex() {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync("which", ["codex"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const candidate = String(stdout || "").trim().split(/\r?\n/)[0];
    return candidate && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

async function resolveCodexBinary() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) return process.env.CODEX_BIN;
  return desktopBundledCodex() || (await pathCodex());
}

async function runCodex(args, timeout = 30_000) {
  const binary = await resolveCodexBinary();
  if (!binary) return null;
  const { stdout } = await execFileAsync(binary, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export function nativeCatalogPath(config) {
  return (config && config.nativeCatalogFile)
    || path.join(os.homedir(), ".modeldock", "native-catalog.json");
}

// Synchronous read of the cached native catalog; null when absent or corrupt.
// The catalog builders run synchronously, so the cache file is the only source
// they can consult. Refreshes happen at gateway startup and on the model
// refresh timer.
export function readNativeCatalog(config) {
  const file = nativeCatalogPath(config);
  let signature = "";
  try {
    const stat = statSync(file, { bigint: true });
    signature = `${stat.size}:${stat.mtimeNs}`;
  } catch {
    nativeCatalogCache.delete(file);
    return null;
  }
  const cached = nativeCatalogCache.get(file);
  if (cached?.signature === signature) return cached.value;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const value = Array.isArray(parsed?.models) ? parsed : null;
    nativeCatalogCache.set(file, { signature, value });
    return value;
  } catch {
    // Cache an invalid file at this exact version too. A corrupt external edit
    // should fail closed once, not be reparsed on every status frame; replacing
    // it changes the stat signature and makes the next read retry normally.
    nativeCatalogCache.set(file, { signature, value: null });
    return null;
  }
}

// Every slug the native backend owns, including picker-hidden entries: a hidden
// slug must still reach ChatGPT instead of an external upstream.
export function nativeModelSlugs(config) {
  const catalog = readNativeCatalog(config);
  const slugs = new Set();
  for (const model of catalog?.models || []) {
    if (typeof model?.slug === "string" && model.slug) slugs.add(model.slug);
  }
  return slugs;
}

export function nativeSelectableModelSlugs(config) {
  return (readNativeCatalog(config)?.models || [])
    .filter((model) => typeof model?.slug === "string" && model.slug && model.visibility === "list")
    .map((model) => model.slug);
}

export function nativeVisionModelSlugs(config) {
  return (readNativeCatalog(config)?.models || [])
    .filter((model) => (
      typeof model?.slug === "string"
      && model.slug
      && model.visibility === "list"
      && Array.isArray(model.input_modalities)
      && model.input_modalities.includes("image")
    ))
    .map((model) => model.slug);
}

// `codex --version` prints a banner - "codex-cli 0.145.0" - so the version is
// the first dotted-numeric token, not the first token. Exported because it is
// the only part of codexVersion() that is testable without a real binary.
// Anything unrecognised becomes "", which callers must read as "unknown".
export function parseCodexVersion(output) {
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/.exec(String(output ?? "").trim());
  return match ? match[1] : "";
}

async function codexVersion() {
  try {
    return parseCodexVersion(await runCodex(["--version"], 5_000));
  } catch {
    return "";
  }
}

// Ask the Codex desktop CLI for its bundled native catalog and cache it. A
// capture is versioned by the app build; a stale capture is replaced on the
// next refresh. Returns the captured models, or null when the CLI is missing
// or the capture failed (the catalog then simply keeps the last good cache).
export async function refreshNativeCatalog(config) {
  if (!(await resolveCodexBinary())) {
    console.log("[gate] native model catalog refresh skipped: Codex CLI not found");
    return null;
  }
  try {
    const output = await runCodex(["debug", "models", "--bundled"]);
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed?.models) || parsed.models.length === 0) return null;
    const file = nativeCatalogPath(config);
    atomicWriteJsonSync(file, { captured_with: await codexVersion(), models: parsed.models });
    return parsed.models;
  } catch (error) {
    console.log(`[gate] native model catalog refresh failed: ${error.message}`);
    return null;
  }
}

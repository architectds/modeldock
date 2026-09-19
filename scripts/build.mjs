// Release build: bundle the gateway into a single self-contained ESM file
// (dist/modeldock.mjs) with the dashboard frontend inlined.
//
// The src/static-inline.mjs placeholder (null in a git checkout) is replaced at build
// time by a generated module exporting { public: {...}, assets: {...} }: text files as
// strings, binaries as Buffers. server.mjs serves the dashboard from that tree when it
// is present, so the bundle needs no on-disk public/ or assets/ directories.
//
// Usage: node scripts/build.mjs   (or: npm run build)

import { build, transform } from "esbuild";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "modeldock.mjs");

const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".svg", ".json", ".txt"]);

// Only these top-level assets ship in the bundle. Vision eval images stay on disk and
// are dev-only: loadTaskImage returns null when they are absent and the eval skips.
//
// This list is the shipped asset set, so an entry with no consumer is bytes every user
// downloads. Two were dead weight: dashboard.png (only scripts/shot.mjs writes it, and the
// README uses dashboard-banner.png) and icon.ico (only scripts/create-shortcut.ps1 reads
// it, from disk, and an installed root has no assets/ at all). The browser asks for
// exactly icon.svg, favicon.png, favicon.ico, icon.png and commandcode-favicon.svg, and
// test/codex-wire-full-commandcode-chat.test.mjs boots this bundle and fetches one of
// them over HTTP, so a live file cannot be removed from this list unnoticed.
const INLINE_ASSETS = ["icon.png", "icon.svg", "favicon.png", "favicon.ico", "commandcode-favicon.svg"];

// Minify an inlined text asset before it becomes a string literal in the
// bundle. esbuild's own minify never touches string literals, so without this
// the dashboard's JS/CSS would ship verbatim inside the single file. charset
// stays utf8: the ascii default would re-escape every CJK translation string
// as \uXXXX and make them larger, not smaller.
async function minifyText(code, loader) {
  const result = await transform(code, { minify: true, charset: "utf8", loader });
  return result.code;
}

async function inlineTree(dir, files) {
  const entries = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const ext = path.extname(file).toLowerCase();
    let code;
    if (TEXT_EXTENSIONS.has(ext)) {
      code = readFileSync(full, "utf8");
      if (ext === ".js" || ext === ".css") {
        code = await minifyText(code, ext === ".css" ? "css" : "js");
      }
      entries.push(`  ${JSON.stringify(file)}: ${JSON.stringify(code)}`);
    } else {
      entries.push(`  ${JSON.stringify(file)}: Buffer.from(${JSON.stringify(readFileSync(full).toString("base64"))}, "base64")`);
    }
  }
  return `{\n${entries.join(",\n")}\n}`;
}

async function generateStaticModule() {
  const publicDir = path.join(root, "public");
  const publicFiles = readdirSync(publicDir).filter((f) => statSync(path.join(publicDir, f)).isFile());
  const assetsDir = path.join(root, "assets");
  const assetFiles = INLINE_ASSETS.filter((f) => {
    try { return statSync(path.join(assetsDir, f)).isFile(); } catch { return false; }
  });
  assertAssetsHaveConsumers(assetFiles, publicDir, publicFiles);
  return [
    `import { Buffer } from "node:buffer";`,
    `export default {`,
    `public: ${await inlineTree(publicDir, publicFiles)},`,
    `assets: ${await inlineTree(assetsDir, assetFiles)},`,
    `};`,
  ].join("\n");
}

// An inlined asset is bytes in dist/modeldock.mjs, which is the file every user
// downloads and the gateway keeps in memory. Only the dashboard's own requests and
// src/ can ask for one, so an entry that neither names is pure weight: this is how
// dashboard.png (400 KB of base64, a stale README screenshot) and icon.ico (360 KB,
// read from disk by scripts/create-shortcut.ps1, which an installed root has no assets/
// directory for) reached the shipped package and stayed there. A dev-only script naming
// the file is not a consumer; the file stays in assets/ for that script either way.
// Serving itself is covered end to end: test/codex-wire-full-commandcode-chat.test.mjs
// boots this bundle and fetches /assets/commandcode-favicon.svg over HTTP.
function assertAssetsHaveConsumers(assetFiles, publicDir, publicFiles) {
  const haystack = [
    ...publicFiles.map((f) => readFileSync(path.join(publicDir, f), "utf8")),
    ...readdirSync(path.join(root, "src")).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(path.join(root, "src", f), "utf8")),
  ].join("\n");
  const dead = assetFiles.filter((name) => {
    // Bound the name on both sides, so favicon.ico is not read as a reference to
    // icon.ico and icon.svg is not read as icon.svgz. A leading slash (the browser
    // asks for /assets/icon.svg) is a valid boundary.
    return !new RegExp(`(?<![\\w.\-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(haystack);
  });
  if (!dead.length) return;
  const bytes = dead.map((name) => statSync(path.join(root, "assets", name)).size);
  console.error(`build: inlined assets that nothing requests: ${dead.join(", ")}`);
  console.error(`  (${bytes.map((n) => `${(n / 1024).toFixed(0)} KB`).join(", ")} on disk)`);
  console.error("  Remove the entry from INLINE_ASSETS, or reference it from public/ or src/.");
  process.exit(1);
}

const staticInlinePlugin = {
  name: "static-inline",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /static-inline\.mjs$/ }, async () => ({
      contents: await generateStaticModule(),
      loader: "js",
    }));
  },
};

mkdirSync(path.dirname(outfile), { recursive: true });

const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  logLevel: "info",
  // esbuild defaults to charset:"ascii", which re-escapes every translated string as
  // \uXXXX - correct but unreadable and 2x the bytes for CJK. The bundle is served as
  // UTF-8, so keep the text as text.
  charset: "utf8",
  plugins: [staticInlinePlugin],
  // msedge-tts is a declared dependency and is pure JS, so bundle it into the single
  // file: the installed release then has TTS without a separate on-demand npm install.
  external: [],
  // Bake the version into the bundle so the updater knows what it is running even
  // without a package.json on disk.
  define: { "process.env.MODELDOCK_BUILD_VERSION": JSON.stringify(version) },
  // CJS dependencies (express) use dynamic require internally; give the ESM bundle a
  // real require implementation.
  banner: {
    js: `import { createRequire as __modeldockCreateRequire } from "node:module";\nconst require = __modeldockCreateRequire(import.meta.url);`,
  },
};

// Two bundles: the gateway (modeldock.mjs) and the stdio MCP bridge
// (mcp-standalone.mjs) that Codex spawns for the managed mcp_servers entry.
const entries = [
  { name: "modeldock.mjs", entry: path.join(root, "src", "server.mjs") },
  { name: "mcp-standalone.mjs", entry: path.join(root, "src", "mcp-standalone.mjs") },
];

for (const { name, entry } of entries) {
  const out = path.join(root, "dist", name);
  const result = await build({ ...common, entryPoints: [entry], outfile: out });
  if (result.errors.length) process.exit(1);
  const size = statSync(out).size;
  console.log(`built ${path.relative(root, out)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

// Build the optional native Mac STT helper when we are on macOS. The helper is
// a tiny Swift CLI around SpeechAnalyzer/SpeechTranscriber; it is not bundled
// into the JS bundle, but it should be emitted into dist/ alongside it.
if (process.platform === "darwin") {
  const builder = path.join(root, "scripts", "build-stt-mac.sh");
  if (existsSync(builder)) {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync("sh", ["scripts/build-stt-mac.sh"], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

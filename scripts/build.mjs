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
import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "dist", "modeldock.mjs");

const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".svg", ".json", ".txt"]);

// Only these top-level assets ship in the bundle. Vision eval images stay on disk and
// are dev-only: loadTaskImage returns null when they are absent and the eval skips.
const INLINE_ASSETS = ["dashboard.png", "icon.png", "icon.ico"];

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
  return [
    `import { Buffer } from "node:buffer";`,
    `export default {`,
    `public: ${await inlineTree(publicDir, publicFiles)},`,
    `assets: ${await inlineTree(assetsDir, assetFiles)},`,
    `};`,
  ].join("\n");
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

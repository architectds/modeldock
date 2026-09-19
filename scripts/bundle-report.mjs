// Where the bundle's bytes come from: a dependency subtree, our own src/, or an inlined
// asset. The companion to check-bundle-budget.mjs - one says the package got too big,
// this says who did it, so the next cut is chosen from measurements, not guesses.
//
//   node scripts/bundle-report.mjs                       gateway bundle, grouped
//   node scripts/bundle-report.mjs --stub express        bytes that actually go away
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--") && a !== (process.argv[process.argv.indexOf("--stub") + 1]));
const entry = path.join(root, positional[0] || "src/server.mjs");
const common = {
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [],
  minify: true,
  write: false,
  logLevel: "silent",
};

const bytesOf = (v) => v.bytes ?? v.bytesInOutput ?? 0;
const withMeta = await build({ ...common, metafile: true });
const total = withMeta.outputFiles[0].contents.length;
const outKey = Object.keys(withMeta.metafile.outputs)[0];
const inputs = withMeta.metafile.outputs[outKey].inputs;

const groups = new Map();
const add = (key, bytes) => groups.set(key, (groups.get(key) || 0) + bytes);
for (const [file, info] of Object.entries(inputs)) {
  const rel = file.replace(/\\/g, "/");
  if (rel.includes("node_modules/")) {
    const tail = rel.split("node_modules/").pop().split("/");
    const name = tail[0].startsWith("@") ? `${tail[0]}/${tail[1]}` : tail[0];
    add(`dep  ${name}`, bytesOf(info));
  } else if (rel.startsWith("src/")) add("our src/ (every file)", bytesOf(info));
  else if (rel.startsWith("public/")) add("dashboard text (public/)", bytesOf(info));
  else if (/\.(png|ico|jpe?g|webp|svg)$/.test(rel)) add(`asset  ${rel}`, bytesOf(info));
  else add(`other  ${rel}`, bytesOf(info));
}

const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
console.log(`${entry} -> ${mb(total)} from ${Object.keys(inputs).length} inputs\n`);
for (const [key, bytes] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 24)) {
  if (bytes < 2048) continue;
  console.log(`${(bytes / 1024).toFixed(0).padStart(6)} KB  ${((bytes / total) * 100).toFixed(1).padStart(5)}%  ${key}`);
}

// Grouping over-attributes a dependency two callers share. --stub answers the only
// question that matters for a cut: how many bytes really disappear if an entry stops
// existing. The stub exports every name our code imports, so the build still resolves.
const stubAt = process.argv.indexOf("--stub");
if (stubAt >= 0 && process.argv[stubAt + 1]) {
  const name = process.argv[stubAt + 1];
  const stub = {
    name: "stub",
    setup(b) {
      const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      b.onResolve({ filter: re }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        loader: "js",
        contents: [
          "export default {};",
          "export const decode = () => ({}); export const encode = () => new Uint8Array();",
          "export const MsEdgeTTS = class {}; export const OUTPUT_FORMAT = {};",
          "export const createMcpExpressApp = () => ({ use() {}, get() {}, post() {}, all() {}, disable() {}, listen() {} });",
          "export const Decompress = class {}; export const Compress = class {};",
          "export const cors = () => () => {};",
          "export const McpServer = class {}; export const createMcpHandler = () => () => {};",
        ].join(" "),
      }));
    },
  };
  const a = await build(common);
  const b = await build({ ...common, plugins: [stub] });
  const saved = a.outputFiles[0].contents.length - b.outputFiles[0].contents.length;
  console.log(`\n--stub ${name}: removes ${(saved / 1024).toFixed(0)} KB of ${mb(a.outputFiles[0].contents.length)} (${((saved / a.outputFiles[0].contents.length) * 100).toFixed(1)}%)`);
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(__dirname);
const html = await fs.readFile(path.join(root, "public", "index.html"), "utf8");
const js = await fs.readFile(path.join(root, "public", "app.js"), "utf8");

const idsMatch = js.match(/const ids = \[([\s\S]*?)\];/);
if (!idsMatch) throw new Error("Could not find ids array in public/app.js");

const ids = [...idsMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const missing = ids.filter((id) => !html.includes(`id="${id}"`));
if (missing.length) {
  throw new Error(`Missing DOM ids in public/index.html: ${missing.join(", ")}`);
}

console.log(JSON.stringify({ ok: true, checked: ids.length }, null, 2));

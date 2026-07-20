import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(__dirname);
const presets = JSON.parse(await fs.readFile(path.join(root, "data", "presets.json"), "utf8"));

const ids = new Set();
for (const preset of presets) {
  if (ids.has(preset.id)) throw new Error(`Duplicate preset id: ${preset.id}`);
  ids.add(preset.id);
}

const deepseek = presets.find((preset) => preset.id === "deepseek");
const kimi = presets.find((preset) => preset.id === "kimi");
if (deepseek?.providerId !== "deepseek_proxy" || !deepseek.baseUrl.includes("/proxy/deepseek/")) {
  throw new Error("DeepSeek preset must use the ModelDock runtime proxy.");
}
if (kimi?.providerId !== "kimi_proxy" || !kimi.baseUrl.includes("/proxy/kimi/")) {
  throw new Error("Kimi preset must use the ModelDock runtime proxy.");
}
if (presets.some((preset) => preset.id.endsWith("-proxy") || /via ModelDock Proxy/i.test(preset.label))) {
  throw new Error("Proxy implementation details should not appear as separate presets.");
}

console.log(JSON.stringify({ ok: true, checked: presets.length }, null, 2));

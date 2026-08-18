// Render a 3D scene animation to an mp4 clip (25fps) for the film pipeline.
// Usage: node render-clip.mjs <scene-name> <out.mp4> [duration]
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const req = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE_PATH
  || (() => { try { return req.resolve("playwright-core"); } catch { return null; } })();
if (!pwPath) {
  console.error("playwright-core not found: set PLAYWRIGHT_CORE_PATH or install it");
  process.exit(1);
}
const pw = req(pwPath);
const FF = process.env.FFMPEG_PATH || "ffmpeg";

const [scene, out, durArg] = process.argv.slice(2);
if (!scene || !out) { console.error("usage: node render-clip.mjs <scene> <out.mp4> [duration]"); process.exit(1); }
const FPS = 25;
const DUR = durArg ? Number(durArg) : 12.6;
const tmp = process.env.MODELDOCK_CLIP_DIR || path.join(process.cwd(), "clip");
fs.mkdirSync(tmp, { recursive: true });

const browser = await pw.chromium.launch({
  channel: "msedge", headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("CONSOLE: " + m.text()); });
  await page.goto("http://127.0.0.1:8090/modeldock/scene3d/" + scene + ".html", { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 25000 });
  await page.waitForTimeout(700);
  const n = Math.round(DUR * FPS);
  for (let i = 0; i < n; i++) {
    const t = i / FPS;
    await page.evaluate(async (tt) => {
      const md = window.__modeldock;
      if (md && typeof md.frameAsync === "function") await md.frameAsync(tt);
      else if (md) md.frame(tt);
    }, t);
    await page.screenshot({ path: tmp + "/f" + String(i).padStart(4, "0") + ".png" });
  }
  if (errors.length) console.log("JS errors:", errors.join(" | "));
  await page.close();
} finally {
  await browser.close();
}
execFileSync(FF, [
  "-y", "-v", "error", "-framerate", String(FPS), "-i", tmp + "/f%04d.png",
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart", out,
]);
for (const f of fs.readdirSync(tmp)) fs.rmSync(tmp + "/" + f, { force: true });
console.log("clip written:", out, (DUR).toFixed(1) + "s @" + FPS + "fps");

// Preview renderer: sample 3 frames (0.3/0.55/0.8 of duration) per 3D scene,
// capture page/console errors, write per-frame PNGs and a side-by-side strip.
// Usage: node preview-scenes.mjs [scene1 scene2 ...]   (default: film scenes + s1 candidates)
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const req = createRequire(import.meta.url);
const pwPath = process.env.PLAYWRIGHT_CORE_PATH
  || (() => { try { return req.resolve("playwright-core"); } catch { return null; } })();
if (!pwPath) {
  console.error("playwright-core not found: set PLAYWRIGHT_CORE_PATH or install it");
  process.exit(1);
}
const pw = req(pwPath);
const FF = process.env.FFMPEG_PATH || "ffmpeg";
const BASE = "http://127.0.0.1:8090/modeldock/scene3d/";
const OUT = process.env.MODELDOCK_PREVIEW_OUT || path.join(process.cwd(), "preview");
mkdirSync(OUT, { recursive: true });

const fracs = [0.3, 0.55, 0.8];
const FILM_SCENES = ["s1", "s2", "s3", "s5"]; // the four 3D scenes used in the film
const S1_CANDIDATES = ["s1b", "s1p"];         // scene-1 alternatives for A/B comparison
const scenes = process.argv.length > 2 ? process.argv.slice(2) : [...FILM_SCENES, ...S1_CANDIDATES];

const browser = await pw.chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

const report = [];
try {
  for (const sc of scenes) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push("CONSOLE: " + m.text());
    });
    const entry = { scene: sc, ready: false, duration: null, errors: [], frames: [] };
    await page.goto(BASE + sc + ".html", { waitUntil: "load" });
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 25000 });
      entry.ready = true;
    } catch {
      report.push(entry);
      console.log(JSON.stringify({ scene: sc, ready: false, errors }));
      await page.close();
      continue;
    }
    await page.waitForTimeout(900); // let async textures finish painting
    const dur = await page.evaluate(() => window.__modeldock.duration);
    entry.duration = Math.round(dur * 100) / 100;
    for (const f of fracs) {
      const t = dur * f;
      await page.evaluate((tt) => window.__modeldock.frame(tt), t);
      await page.waitForTimeout(120);
      const p = path.join(OUT, sc + "-" + f + ".png");
      await page.screenshot({ path: p });
      entry.frames.push(p);
    }
    const strip = path.join(OUT, sc + "-strip.png");
    const args = ["-y", "-v", "error"];
    for (const p of entry.frames) args.push("-i", p);
    args.push("-filter_complex", "[0:v][1:v][2:v]hstack=inputs=3", "-frames:v", "1", strip);
    execFileSync(FF, args);
    entry.strip = strip;
    report.push(entry);
    console.log(JSON.stringify({
      scene: sc, ready: true, duration: entry.duration,
      errors: errors.length ? errors : null,
      strip: path.basename(strip),
    }));
    await page.close();
  }
} finally {
  await browser.close();
}
writeFileSync(path.join(OUT, "preview-report.json"), JSON.stringify(report, null, 2), "utf8");
console.log("REPORT " + path.join(OUT, "preview-report.json"));

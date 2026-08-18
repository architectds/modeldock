// Extract QA frames from a finished film: one frame per second, plus
// per-shot and mid-fade frames. Usage:
//   node qa-frames.mjs <video.mp4> <outdir> [shotStarts=csv] [fade=1.0]
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const FF = process.env.FFMPEG_PATH || "ffmpeg";
const [video, outdir, shotStartsArg, fadeArg] = process.argv.slice(2);
if (!video || !outdir) {
  console.error("usage: node qa-frames.mjs <video> <outdir> [shotStarts=csv] [fade]");
  process.exit(1);
}
mkdirSync(outdir, { recursive: true });
const fade = fadeArg ? Number(fadeArg) : 1.0;

execFileSync(FF, ["-y", "-v", "error", "-ss", "0.5", "-i", video, "-vf", "fps=1", path.join(outdir, "f%02d.png")]);
console.log("per-second frames extracted");

if (shotStartsArg) {
  const starts = shotStartsArg.split(",").map(Number);
  for (let i = 0; i < starts.length; i++) {
    const t = starts[i] + fade * 0.4;
    const name = "shot" + String(i + 1).padStart(2, "0") + ".png";
    execFileSync(FF, ["-y", "-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", path.join(outdir, name)]);
    console.log(name, "at", t.toFixed(2));
  }
  for (let i = 1; i < starts.length; i++) {
    const t = starts[i] - fade / 2;
    const name = "fade" + String(i).padStart(2, "0") + ".png";
    execFileSync(FF, ["-y", "-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", path.join(outdir, name)]);
    console.log(name, "at", t.toFixed(2));
  }
}
console.log("done, QA frames in", outdir);

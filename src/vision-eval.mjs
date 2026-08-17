import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The benchmark images ship inside the repo (assets/vision). The old hardcoded
// developer path (D:/projects/...) broke every other checkout; default to the
// repo-relative layout, overridable for mirrored deployments.
const VISION_ASSETS_DIR = process.env.MODELDOCK_VISION_ASSETS_DIR
  || resolve(dirname(fileURLToPath(import.meta.url)), "..", "assets", "vision");

const VERBATIM = " Answer directly and briefly, no explanation.";

export const TASKS = [
  {
    id: "color-red",
    image: "t1-red.png",
    difficulty: 1,
    question: "What color is this solid image? Answer with one word." + VERBATIM,
    check: (answer) => /(^|\W)(red)(\W|$)/i.test(answer),
  },
  {
    id: "color-green",
    image: "t1-green.png",
    difficulty: 1,
    question: "What color is this solid image? Answer with one word." + VERBATIM,
    check: (answer) => /(^|\W)(green)(\W|$)/i.test(answer),
  },
  {
    id: "color-blue",
    image: "t1-blue.png",
    difficulty: 1,
    question: "What color is this solid image? Answer with one word." + VERBATIM,
    check: (answer) => /(^|\W)(blue)(\W|$)/i.test(answer),
  },
  {
    id: "count-shapes",
    image: "t2-shapes.png",
    difficulty: 2,
    question: "How many red circles are in this image? Answer with just a number." + VERBATIM,
    check: (answer) => /\b3\b/.test(answer),
  },
  {
    id: "ocr-text",
    image: "t3-ocr.png",
    difficulty: 3,
    question: "What text is written in this image? Transcribe it exactly." + VERBATIM,
    check: (answer) => /hello/i.test(answer) && /\b42\b/.test(answer),
  },
  {
    id: "chart-reading",
    image: "t4-chart.png",
    difficulty: 4,
    question: "This bar chart shows three bars labeled A, B, C. Which label has the tallest bar and what is its value?" + VERBATIM,
    check: (answer) => /\bb\b/i.test(answer) && /\b5\b/.test(answer),
  },
  {
    id: "direction",
    image: "t5-arrow.png",
    difficulty: 5,
    question: "Which direction does the red arrow point? Answer with one word (left/right/up/down)." + VERBATIM,
    check: (answer) => /(^|\W)(right|east|rightarrow|\u2192)(\W|$)/i.test(answer),
  },
];

export function loadTaskImage(task) {
  const path = join(VISION_ASSETS_DIR, task.image);
  if (!existsSync(path)) return null;
  return readFileSync(path).toString("base64");
}

export function scoreTask(task, answer) {
  if (!answer) return 0;
  return task.check(answer) ? 1 : 0;
}

export function tierForScore(score, maxScore) {
  if (maxScore <= 0) return "unknown";
  const ratio = score / maxScore;
  if (ratio >= 0.8) return "strong";
  if (ratio >= 0.5) return "medium";
  if (ratio >= 0.2) return "basic";
  return "poor";
}

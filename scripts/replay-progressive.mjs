// Step through a real Codex dump from the very first item, replaying each
// growing prefix as a real request (real inference) to find exactly where the
// local 32K model stops fitting. Each row is one real attempt - the history is
// never thrown at the model in one go.
//
// Usage: node scripts/replay-progressive.mjs
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const key = readFileSync(path.join(os.homedir(), ".modeldock", "caller-key"), "utf8").trim();
const dir = process.env.MODELDOCK_DUMP_DIR || "D:/modeldock-dumps";
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const j = JSON.parse(readFileSync(path.join(dir, files[files.length - 1]), "utf8"));
const input = j.input || [];
console.log(`real dump: ${files[files.length - 1]}`);
console.log(`total items: ${input.length}\n`);

const BASE = `http://127.0.0.1:4097/c/${key}`;

async function tryItems(n) {
  const prefix = input.slice(0, n);
  const body = {
    model: "qwen3.8:27b@custom",
    instructions: j.instructions,
    input: [...prefix, { type: "message", role: "user", content: [{ type: "input_text", text: "Reply with exactly: STEP_OK" }] }],
    stream: false,
    max_output_tokens: 64,
  };
  const t0 = Date.now();
  let status, detail, tokens = 0;
  try {
    const r = await fetch(`${BASE}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    status = r.status;
    const tx = await r.text();
    try {
      const jj = JSON.parse(tx);
      if (jj.error) {
        detail = String(jj.error.message || "").slice(0, 100) || "error";
        const m = String(jj.error.message || "").match(/\((\d+) tokens\)/);
        if (m) tokens = Number(m[1]);
      } else {
        detail = "ok";
        tokens = jj.usage?.input_tokens || 0;
      }
    } catch { detail = tx.slice(0, 60); }
  } catch (e) {
    status = 0;
    detail = e.message.slice(0, 90);
  }
  return { status, detail, tokens, dt: ((Date.now() - t0) / 1000).toFixed(1) };
}

// Coarse walk from the first item until failure.
let lastOk = 0;
let lastOkTokens = 0;
let firstFail = null;
for (let n = 50; n <= Math.min(1500, input.length); n += 50) {
  const r = await tryItems(n);
  console.log(`${r.status === 200 ? "OK  " : "FAIL"} items=${n} tokens=${r.tokens} status=${r.status} dt=${r.dt}s ${r.detail}`);
  if (r.status === 200) { lastOk = n; lastOkTokens = r.tokens; }
  else { firstFail = n; break; }
}

// Bisect the failing window to pinpoint the boundary.
if (firstFail) {
  let lo = lastOk, hi = firstFail;
  while (hi - lo > 10) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await tryItems(mid);
    console.log(`  bisect items=${mid} -> ${r.status === 200 ? "OK" : "FAIL"} tokens=${r.tokens}`);
    if (r.status === 200) lo = mid; else hi = mid;
  }
  console.log(`\nboundary: fits up to ${lo} items (~${lastOkTokens} tokens), fails at ~${hi} items`);
} else {
  console.log(`\nall prefixes up to ${Math.min(1500, input.length)} items still fit`);
}

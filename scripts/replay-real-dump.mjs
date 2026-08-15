// Replay a real Codex request dump through the gate to the local llama.cpp
// custom endpoint. This is the honest verification: a request Codex actually
// sent (MODELDOCK_DUMP_ALL=1 captures every body), replayed verbatim except
// for the model id.
//
// Usage: node scripts/replay-real-dump.mjs [model]
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const model = process.argv[2] || "qwen3.8:27b@custom";
const key = readFileSync(path.join(os.homedir(), ".modeldock", "caller-key"), "utf8").trim();
const dir = process.env.MODELDOCK_DUMP_DIR || "D:/modeldock-dumps";
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
if (!files.length) throw new Error(`no dumps in ${dir}`);
const latest = files[files.length - 1];
const j = JSON.parse(readFileSync(path.join(dir, latest), "utf8"));

console.log(`replaying: ${latest}`);
console.log(`original model: ${j.model} -> target: ${model}`);
console.log(`input items: ${(j.input || []).length} | instructions: ${typeof j.instructions}`);

const replay = { ...j, model, stream: false };
delete replay.prompt_cache_key;
delete replay.text;

const t0 = Date.now();
const r = await fetch(`http://127.0.0.1:4097/c/${key}/v1/responses`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(replay),
  signal: AbortSignal.timeout(300000),
});
const tx = await r.text();
console.log(`STATUS: ${r.status} dt=${((Date.now() - t0) / 1000).toFixed(1)}s`);
let msg = "";
try {
  const jj = JSON.parse(tx);
  msg = jj.error?.message || `ok: output=${(jj.output || []).length} items`;
} catch {
  msg = tx.slice(0, 300);
}
console.log(msg);
process.exit(r.status === 200 ? 0 : 1);

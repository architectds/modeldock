// Strict local-llm lifecycle regression: drives the custom llama.cpp endpoint
// through every bug we have hit so far and fails (non-zero exit) on any miss.
//
// Prereq: llama.cpp server running on 127.0.0.1:11435 (start-vulkan-srv.ps1)
// and a connected custom endpoint (MODELDOCK_CUSTOM_BASE_URL in .env).
// Run: npm run test:local-llm
import { loadConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

const LLAMA = "http://127.0.0.1:11435/health";
try {
  const health = await fetch(LLAMA, { signal: AbortSignal.timeout(3000) });
  if (!health.ok) throw new Error(`health ${health.status}`);
} catch {
  throw new Error("llama.cpp is not running on 127.0.0.1:11435 - start it first (start-vulkan-srv.ps1)");
}

const config = loadConfig();
const instance = await startServer({ ...config, port: 0 });
const port = instance.server.address().port;
const base = `http://127.0.0.1:${port}/c/${instance.services.callerKey}`;
const MODEL = "qwen3.8:27b@custom";
const INSTRUCTIONS = "You are Codex. Answer concisely. Use tools when asked.";
const TOOLS = [
  { type: "function", name: "web_search", description: "Search the web.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];

const failures = [];
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

async function post(p, body, timeoutMs = 300000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    const tx = await r.text();
    let json = null;
    try { json = JSON.parse(tx); } catch {}
    return { status: r.status, json, text: tx.slice(0, 300) };
  } finally { clearTimeout(t); }
}
const msg = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const textOf = (item) => (item?.content || []).map((c) => c.text || "").join("");
const answerOf = (json) => json?.output?.find((i) => i.type === "message");

// 1. Plain request with instructions + reasoning effort=high (Codex default).
console.log("--- 1. reasoning effort mapping ---");
{
  const r = await post("/v1/responses", { model: MODEL, instructions: INSTRUCTIONS, input: [msg("user", "Reply with exactly: EFFORT_OK")], reasoning: { effort: "high" }, max_output_tokens: 256 });
  const a = answerOf(r.json);
  check("effort=high does not 500", r.status === 200, `status=${r.status}`);
  check("effort=high yields an answer", Boolean(a && textOf(a).includes("EFFORT_OK")), `text=${textOf(a).slice(0, 40)}`);
}

// 2. Mid-history system without instructions -> hoisted to front.
console.log("--- 2. mid-history system, no instructions ---");
{
  const r = await post("/v1/responses", {
    model: MODEL,
    input: [msg("user", "hi"), msg("system", "checkpoint A"), msg("user", "Reply with exactly: HOIST_OK")],
    max_output_tokens: 256,
  });
  const a = answerOf(r.json);
  check("mid system (no instructions) does not 500", r.status === 200, `status=${r.status}`);
  check("mid system yields answer", Boolean(a && textOf(a).includes("HOIST_OK")), `text=${textOf(a).slice(0, 40)}`);
}

// 3. Mid-history system WITH instructions -> merged into instructions.
console.log("--- 3. mid-history system with instructions ---");
{
  const r = await post("/v1/responses", {
    model: MODEL,
    instructions: INSTRUCTIONS,
    input: [msg("user", "start"), msg("system", "checkpoint B"), msg("user", "Reply with exactly: MERGE_OK")],
    max_output_tokens: 256,
  });
  const a = answerOf(r.json);
  check("system+instructions does not 500", r.status === 200, `status=${r.status}`);
  check("system+instructions yields answer", Boolean(a && textOf(a).includes("MERGE_OK")), `text=${textOf(a).slice(0, 40)}`);
}

// 4. Tool-call loop: function_call -> output -> final answer.
console.log("--- 4. tool-call loop ---");
{
  let input = [msg("user", 'Call web_search for "date", then answer with the result.')];
  const t0 = Date.now();
  const r = await post("/v1/responses", { model: MODEL, instructions: INSTRUCTIONS, input, tools: TOOLS, max_output_tokens: 512 });
  const fcs = (r.json?.output || []).filter((i) => i.type === "function_call");
  check("tool loop round1 calls tool", r.status === 200 && fcs.length >= 1, `fcs=${fcs.length}`);
  let ok = false;
  if (fcs.length) {
    for (const fc of fcs) {
      input = [...input, fc, { type: "function_call_output", call_id: fc.call_id, output: JSON.stringify({ result: "today is 2026-08-14" }) }];
    }
    const r2 = await post("/v1/responses", { model: MODEL, instructions: INSTRUCTIONS, input, tools: TOOLS, max_output_tokens: 512 });
    const a = answerOf(r2.json);
    ok = r2.status === 200 && Boolean(a && textOf(a).length > 0);
  }
  check("tool loop round2 finishes", ok, `dt=${((Date.now()-t0)/1000).toFixed(1)}s`);
}

// 5. v2 compaction -> compaction item -> continue succeeds.
console.log("--- 5. compaction and continue ---");
{
  const hist = [msg("user", "Work on task one."), msg("assistant", "Done with task one."), msg("user", "Work on task two.")];
  const c = await post("/v1/responses", { model: MODEL, instructions: INSTRUCTIONS, input: [...hist, { type: "compaction_trigger" }], stream: false, max_output_tokens: 1024 });
  const item = c.json?.output?.find((i) => i.type === "compaction");
  if (!item) console.log(`  [debug] compact response: ${c.text}`);
  check("compaction returns kcr1 item", c.status === 200 && Boolean(item?.encrypted_content?.startsWith("kcr1:")), `status=${c.status}`);
  let continued = false;
  if (item) {
    const r = await post("/v1/responses", { model: MODEL, instructions: INSTRUCTIONS, input: [item, msg("user", "Reply with exactly: CONTINUE_OK")], max_output_tokens: 256 });
    const a = answerOf(r.json);
    continued = r.status === 200 && Boolean(a && textOf(a).includes("CONTINUE_OK"));
    check("continue after compaction succeeds", continued, `status=${r.status} text=${textOf(a).slice(0, 40)}`);
  } else {
    check("continue after compaction succeeds", false, "no compaction item");
  }
}

await instance.server.close();
console.log(`\n[local-llm lifecycle] ${checks.length - failures.length}/${checks.length} passed`);
process.exit(failures.length ? 1 : 0);

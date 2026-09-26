// End-to-end proof for the repeated-instruction replay defect, in the shape the
// repository demands: the built bundle is booted against a mock llama.cpp Chat
// upstream, a full Codex package is replayed through it, and the assertion is on
// what the local model was actually asked to read - never on a src/ helper's
// return shape.
//
// The defect (measured on a real Trading_Session rollout, 2026-09-26T03:34:56Z):
// a session woken by a periodic automation keeps one full copy of that wake's
// instruction per wake in Codex's compacted history - 39 copies of a single
// 6060-character heartbeat, identical except for <current_time_iso>. The gateway
// forwarded all of them, so the local model re-read 39 near-identical instruction
// bodies (~112K tokens) on the next turn.
//
// Contract under test: whatever the dedupe is, the transcript the local model
// receives carries at most ONE full copy of each distinct periodic-instruction
// body, while the distinct human asks, a revised instruction version, and every
// tool call/output pair survive intact. The compact path must keep producing a
// real CPU handoff summary without calling the upstream at all.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));

const MODEL = "Qwen3.8-27B@llamacpp";
const AUTOMATION_ID = "trader-cycle-simulate";
// The wake that delivered the turn under test.
const CURRENT_WAKE_ISO = "2026-09-26T03:34:56.423Z";

// The standing periodic instruction. Synthetic prose of the real size class
// (~4K characters); every copy below is byte-identical except for the
// <current_time_iso> field, which is exactly the shape that defeated a
// whole-text comparison.
const INSTRUCTION_PARAGRAPHS = [
  "STEP 0 - IDENTIFY THIS WAKE'S SLOT BEFORE ANYTHING ELSE. The heartbeat envelope that delivered this instruction carries the authoritative UTC start of this wake. Convert it to the session timezone, pick the latest scheduled slot at or before that instant, and name the slot explicitly in the report. A wake that fires up to forty-five minutes late still belongs to its slot; a wake later than that is off-grid and does not replay a missed slot.",
  "A turn belongs to exactly one slot from start to finish. Any timestamp written into a file, a state record or a journal during the turn is not a new wake: never relabel your own turn as an off-grid, inter-slot or catch-up wake, and never emit two cycle identifiers for one wake.",
  "Slot table, session time first and exchange time second, shown only to disambiguate the session: 08:00 pre-market recovery and reconciliation; 08:30 market open with the first real session prints; 09:00 market cycle; 10:00 market cycle; 11:00 market cycle; 12:00 market cycle; 13:00 market cycle; 14:00 market cycle; 15:00 regular-session close; 15:30 end-of-day review after the close correction.",
  "Timing consequences you must reason with: every gap between consecutive market slots from 09:00 onward is one hour, and the simulated account has no broker-native stop orders. Judge every entry and hold against the longest blind window the current slot can actually leave open, not against the tightest one.",
  "At the open, treat opening-range noise and a wide early spread as reasons not to act rather than as confirmation. Your own notes, playbook or state that still describes an hourly-only, thirty-minute-only or inter-slot wake cycle is stale, and you must update it in this run.",
  "After the applicable instructions, make the ledger summary the first business fact query. Verify the simulated account, inspect positions, orders and deals, and recover runtime state, position context and the research queue. Resolve unfinished or unknown money operations before any new risk.",
  "Query market state and honor holidays, early closes and the current market state. A missing or stale ledger, missing quotes, missing broker state, missing tools or an unknown money outcome requires fail-closed behavior: no new money operation and no permission workaround.",
  "Preserve cash and collateral, respect limits, freshness, idempotency, risk locks and the naked-call prohibition. Use only actually available and validated execution paths; scheduling does not complete a pending option lifecycle acceptance, does not enable live trading and does not authorize overriding a protected fixture.",
  "During an open regular session, manage existing positions and choose the highest-priority permitted research, trade, review, tool request or no-action decision within the current action budget. Research serves trading decisions, and there is no minimum trade count and no requirement to use the whole budget.",
  "Check prior execution and checkpoint state each cycle and recall relevant private memory when needed rather than the entire archive. Do not overlap risk-increasing cycles, do not refresh the budget when resuming one cycle, do not replay missed cycles as catch-up orders and do not change request identifiers to bypass an unknown outcome.",
  "At the review slot, reconcile actual fills, exposure, commitments and exit plans, and complete at most one substantive daily review per market date. Compare earlier decisions with new evidence, distinguish facts, estimates and hypotheses, and record corrections plus the next prioritized research question.",
  "Finish by saving the cycle checkpoint, unresolved operations and the next concrete step. Make only necessary journal and reusable private-memory updates. Stay quiet when nothing changed; report meaningful decisions and executions, a substantive completed daily review, material failures, or questions that need user attention.",
];

const INSTRUCTION_BODY = INSTRUCTION_PARAGRAPHS.join("\n");
// A revised template must not collapse into the version it replaced: change a
// phrase so the old body is no longer a substring of the new one.
const INSTRUCTION_BODY_V2 = INSTRUCTION_BODY.replace("12:00 market cycle;", "12:15 market cycle;");
assert.notEqual(INSTRUCTION_BODY_V2, INSTRUCTION_BODY, "the revised template must actually differ");

let messageSeq = 0;
function userMessage(text, turn) {
  messageSeq += 1;
  return {
    type: "message",
    id: `msg_heartbeat_${messageSeq}`,
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: `turn_heartbeat_${turn}`, create_time: 1787000000 + turn },
  };
}

function heartbeat(body, iso) {
  return [
    "<heartbeat>",
    `  <automation_id>${AUTOMATION_ID}</automation_id>`,
    `  <current_time_iso>${iso}</current_time_iso>`,
    "  <instructions>",
    body,
    "  </instructions>",
    "</heartbeat>",
  ].join("\n");
}

const HUMAN_ASKS = [
  "Keep the trading session on the standing plan and report the ledger summary at every cycle.",
  "Before the open, re-check the pre-market plan against the actual opening prints instead of assuming it still holds.",
  "Do not place or queue new entries until the ledger has been reconciled and the unknown money operation is resolved.",
];
const OLD_UNRELATED_ASK = `Prepare the archived ceramic-color reference notes for a different project. ${"Old background specifications are not a current market-cycle instruction. ".repeat(35)}`;
const CURRENT_OVERRIDE = "For this cycle, pause new entries until the stale quote and ledger mismatch are resolved.";

function replayHistory() {
  // The leading developer/user guidance of the real Codex package is kept
  // verbatim so the wire structure under test is the shipped one.
  const input = [...fixture.request.input];
  input.push(userMessage("Standing task: run the simulated market-hours cycle from the published playbook.", 0));
  // 39 wakes of the same instruction, one per scheduled cycle, interleaved with
  // the human's real messages and the work they drove.
  for (let wake = 1; wake <= 39; wake += 1) {
    const hour = String(8 + (wake % 8)).padStart(2, "0");
    const minute = String((wake * 7) % 60).padStart(2, "0");
    input.push(userMessage(heartbeat(INSTRUCTION_BODY, `2026-09-1${1 + Math.floor(wake / 24)}T${hour}:${minute}:00.000Z`), wake));
    if (wake === 4) input.push(userMessage(HUMAN_ASKS[0], wake));
    if (wake === 5) input.push(userMessage(OLD_UNRELATED_ASK, wake));
    if (wake === 11) {
      // A tool call/output pair the human's correction triggered.
      input.push({
        type: "function_call",
        id: "fc_ledger_cycle",
        call_id: "call_ledger_cycle",
        name: "get_ledger",
        arguments: JSON.stringify({ view: "summary", refresh: true }),
      });
      input.push({
        type: "function_call_output",
        call_id: "call_ledger_cycle",
        output: JSON.stringify({ account: "SIMULATE", positions: 1, cash: 41234.55 }),
      });
    }
    if (wake === 12) {
      input.push({
        type: "function_call",
        id: "fc_quote_cycle",
        call_id: "call_quote_cycle",
        name: "get_quote",
        arguments: JSON.stringify({ symbol: "TEST", refresh: true }),
      });
      input.push({
        type: "function_call_output",
        call_id: "call_quote_cycle",
        output: JSON.stringify({ error: { code: "QUOTE_STALE", message: "Quote timestamp is older than the allowed freshness window." } }),
      });
    }
    if (wake === 17) input.push(userMessage(HUMAN_ASKS[1], wake));
    if (wake === 33) input.push(userMessage(HUMAN_ASKS[2], wake));
    if (wake === 36) {
      // The template itself was revised mid-session: a new version, not a repeat.
      input.push(userMessage(heartbeat(INSTRUCTION_BODY_V2, "2026-09-25T18:12:00.000Z"), wake));
    }
  }
  // The compaction boundary Codex replayed into this turn, in the exact shape
  // the gateway produces (kcr1: base64 of the CPU handoff text).
  const handoff = [
    "HEAD: task=run the simulated market-hours cycle | phase=ledger reconciled",
    "FAILED: none",
    "---",
    "USER: Standing task: run the simulated market-hours cycle from the published playbook.",
    HUMAN_ASKS[0],
    HUMAN_ASKS[1],
    HUMAN_ASKS[2],
  ].join("\n");
  input.push({
    type: "compaction",
    id: "cmp_heartbeat_fixture",
    encrypted_content: `kcr1:${Buffer.from(handoff, "utf8").toString("base64")}`,
  });
  // The wake that delivered this very turn.
  input.push(userMessage(heartbeat(INSTRUCTION_BODY, CURRENT_WAKE_ISO), 99));
  input.push(userMessage(CURRENT_OVERRIDE, 100));
  return input;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => {
    if (error?.code === "ERR_SERVER_NOT_RUNNING") return resolve();
    if (error) return reject(error);
    resolve();
  }));
}

async function waitForStatus(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("built bundle did not start");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function messageText(message) {
  const content = message?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  return typeof content === "string" ? content : "";
}

test("the built bundle collapses repeated periodic instructions before the local model reads them", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-heartbeat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex-home");
  await mkdir(stateDir, { recursive: true });
  await mkdir(codexHome, { recursive: true });

  const chatRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "expected Chat Completions endpoint" }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    chatRequests.push(body);
    if (body.input !== undefined || body.instructions !== undefined || body.include !== undefined) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Responses-only field reached Chat upstream" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end([
      'data: {"id":"chatcmpl_heartbeat","created":31,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","content":"HEARTBEAT_ACK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":900,"completion_tokens":3}}',
      "data: [DONE]",
      "",
    ].join("\n\n"));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));
  await writeFile(path.join(stateDir, "local-engines.json"), JSON.stringify({
    llamacpp: {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      models: [{ id: "Qwen3.8-27B", upstreamId: "Qwen3.8-27B", label: "Qwen3.8-27B", supportsVision: false, contextWindow: 32_768 }],
    },
  }), "utf8");

  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await closeServer(probe);
  const autostartKey = `HKCU\\Software\\ModelDockTests\\heartbeat-${process.pid}`;
  const child = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "llamacpp",
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CODEX_HOME: codexHome,
      MODELDOCK_REQUIRE_CALLER_KEY: "0",
      MODELDOCK_MEMORY: "0",
      MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_AUTOSTART_KEY: autostartKey,
      MODELDOCK_AUTOSTART_NAME: `ModelDockHeartbeat${process.pid}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(async () => {
    await stop(child);
    if (process.platform === "win32") {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* key may not exist */ }
    }
  });
  await waitForStatus(gatewayPort);

  const history = replayHistory();
  const replayedAsks = history
    .filter((item) => item.type === "message" && item.role === "user")
    .map((item) => item.content[0].text)
    .join("\n");
  assert.equal(countOccurrences(replayedAsks, INSTRUCTION_BODY), 40, "the fixture replays 40 full copies of one instruction (39 wakes plus this turn)");

  // Phase 1: the CPU compact path still produces a real handoff summary and
  // makes no upstream call at all.
  const compactResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": "heartbeat-compact" },
    body: JSON.stringify({ model: MODEL, stream: false, input: [...history, { type: "compaction_trigger" }] }),
  });
  const compactText = await compactResponse.text();
  assert.equal(compactResponse.status, 200, `compact rejected: ${compactText}\n${stderr}`);
  const compactItem = (JSON.parse(compactText).output || []).find((item) => item.type === "compaction");
  assert.ok(compactItem, `the compact response must carry a compaction item: ${compactText.slice(0, 400)}`);
  assert.match(String(compactItem.encrypted_content), /^kcr1:/, "the CPU handoff rides the gateway's own kcr1 payload");
  const summary = Buffer.from(String(compactItem.encrypted_content).slice(5), "base64").toString("utf8");
  assert.match(summary, /HEAD: task=/, `the handoff header must name the task: ${summary.slice(0, 200)}`);
  assert.ok(summary.includes(AUTOMATION_ID), "the handoff must keep the automation identity so the next turn knows the task");
  assert.ok(summary.includes("<historical_user_requests"), "old unrelated user requests become a dated CPU history index after an earlier handoff");
  assert.ok(!summary.includes(OLD_UNRELATED_ASK), "the CPU handoff must not copy an old unrelated request verbatim");
  assert.ok(summary.includes(CURRENT_OVERRIDE), "the active human override must remain intact in the CPU handoff");
  assert.ok(summary.length < 60_000, `the handoff stays a handoff, not a replayed history (${summary.length} chars)`);
  assert.ok(countOccurrences(summary, "<heartbeat>") <= 2, "the CPU handoff must keep at most one copy per instruction version");
  assert.equal(chatRequests.length, 0, "the CPU compact path calls no upstream");

  // Phase 2: the very next turn replays that history to the local model.
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": "heartbeat-replay" },
    body: JSON.stringify({ ...fixture.request, model: MODEL, input: history }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `relay rejected the replayed history: ${text}\n${stderr}`);
  assert.equal(chatRequests.length, 1, "the local model was asked exactly once");
  assert.match(text, /response\.completed/, "the client received a completed response");
  assert.match(text, /HEARTBEAT_ACK/, "the client received the model's answer");

  const upstreamBody = chatRequests[0];
  assert.ok(Array.isArray(upstreamBody.messages) && upstreamBody.messages.length, "the strict Chat upstream received messages");
  const transcript = upstreamBody.messages.map(messageText).join("\n");

  const fullCopies = countOccurrences(transcript, INSTRUCTION_BODY);
  assert.equal(fullCopies, 1, `the local model must receive exactly one full current instruction, got ${fullCopies} copies of ${INSTRUCTION_BODY.length} characters`);
  assert.ok(transcript.includes("12:15 market cycle"), "a revised template is a new version and its changed step survives");
  assert.equal(countOccurrences(transcript, INSTRUCTION_BODY_V2), 1, "the revised instruction version survives exactly once");
  assert.ok(transcript.includes(AUTOMATION_ID), "the periodic instruction is not dropped outright");
  assert.ok(transcript.includes("2026-09-26T03:34:56.423Z"), "the current cycle timestamp survives");
  assert.ok(transcript.includes("<historical_user_requests"), "the relay marks old user requests as dated history, not active turns");
  assert.ok(!transcript.includes(OLD_UNRELATED_ASK), "the local model must not re-read an unrelated weeks-old request verbatim");
  assert.ok(transcript.includes(CURRENT_OVERRIDE), "a human override after compaction remains a full current user turn");

  for (const ask of HUMAN_ASKS) {
    assert.ok(transcript.includes(ask), `the human ask must survive: ${ask}`);
  }

  const serialized = JSON.stringify(upstreamBody.messages);
  assert.ok(serialized.includes("call_ledger_cycle"), "the replayed tool call keeps its call id");
  assert.ok(serialized.includes("41234.55"), "the replayed tool output is still delivered");
  assert.ok(serialized.includes("call_quote_cycle"), "the failed tool call keeps its call id");
  assert.ok(serialized.includes("QUOTE_STALE"), "the real-world stale-quote error shape survives unchanged");
  assert.ok(
    serialized.length < 20 * INSTRUCTION_BODY.length,
    `the transcript must not carry one instruction per wake (${serialized.length} characters)`,
  );

  // Checked last, so a regression in the relay dedupe is still the failure that
  // surfaces first. The handoff must name the wake it was written for: the cycle
  // time is the one thing a folded history cannot recover from the instruction
  // bodies alone.
  assert.ok(summary.includes(CURRENT_WAKE_ISO), `the handoff must name this wake's time: ${summary.slice(0, 200)}`);
});

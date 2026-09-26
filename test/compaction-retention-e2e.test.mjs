// End-to-end proof for the compact-retention defects, in the shape this
// repository demands: the built bundle is booted against a mock llama.cpp Chat
// upstream, a full Codex package is replayed through it, and every assertion is
// on the handoff the CPU compact actually produced or on what the local model
// was actually asked to read - never on a src/ helper's return shape.
//
// Run it against the published release to see it fail:
//   $env:MODELDOCK_TEST_BUNDLE = "$env:USERPROFILE\.modeldock\dist\modeldock.mjs"
//   node --test test/compaction-retention-e2e.test.mjs
//
// Three defects, all measured against the published 0.3.92 bundle:
//
//  1. Buried structured tool failure. Codex can deliver a tool result as an
//     array of input_text parts instead of a string. The CPU extract
//     serializes that array with JSON.stringify and cuts it at its
//     150-character tool-output cap, so a structured failure whose decisive
//     fields sit past the cut ("ok": false, error.code) never reaches the
//     handoff. The decisive-line scan cannot recover it either: the serialized
//     array is a single line longer than that scan's 400-character ceiling and
//     contains braces, which the scan reads as dumped source rather than a
//     runtime failure. A model resuming the session inherits a history whose
//     unknown money operation is invisible.
//  2. Base-handoff collapse. A restored handoff larger than the 40K base
//     budget is bounded by keeping a head, a tail, error lines, tool inventory
//     and recent user asks. When the kept set still exceeds the budget in every
//     tier, the fallback keeps the first two lines alone - so a long-lived
//     session, whose earlier extract carries hundreds of USER: lines, loses its
//     recent state and its latest plan on the very next compact.
//  3. Headless handoff truncation. A restored ModelDock handoff is recognized
//     as already-compressed history by the "HEAD: task=" line inside it. A
//     handoff written by a model (the summarize call, or an older release) has
//     no such line, so it is treated as a fresh user ask and cut to the
//     300-character user cap: everything between its opening edge and its
//     closing edge is dropped.
//
// Contract under test: a structured failure past the tool-output cap survives
// the CPU compact as an explicit failure; a pre-existing handoff over the base
// budget keeps its head and its recent tail; a pre-existing handoff without the
// HEAD marker survives as restored history instead of a capped user ask; and
// the latest substantive assistant plan survives all three.
//
// The plan-mode contract rides the same harness: the local relay's own
// instructions tell the upstream to use update_plan for multi-step or
// long-running work, to update it only on material change, and not to create a
// goal on its own; and the CPU compact carries only the plan the session is
// actually on, as PLAN_STATE, with its decisive step intact past the
// 120-character tool-argument cap.
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
const BASE_BUDGET_CHARS = 40_000;
const TOOL_OUTPUT_CAP_CHARS = 150;

const filler = (length) => "z".repeat(length);

// --- scenario material ----------------------------------------------------

// (1) A tool result delivered as an array of content parts, with the decisive
// fields appended last so they sit past the tool-output cap. This is the shape
// an MCP-backed tool produces when its payload is data first, verdict last.
const LEDGER_RESULT = JSON.stringify({
  account: "SIMULATE",
  as_of: "2026-09-25T15:00:00.000Z",
  positions: ["TEST 100 shares at 41.20", "SPY 5 shares at 540.10"],
  orders: ["ord_1 filled 09:31", "ord_2 filled 10:02", "ord_3 accepted 10:04, no terminal state"],
  deals: ["deal_1 settled 10:03"],
  notes: ["reconciliation window closed", filler(40)],
  ok: false,
  error: {
    code: "UNKNOWN_MONEY_OPERATION",
    message: "Order ord_3 has no terminal state after the reconciliation window; treat the outcome as unknown.",
  },
});
const LEDGER_FAILURE_AT = LEDGER_RESULT.indexOf('"ok":false');
assert.ok(
  LEDGER_FAILURE_AT > TOOL_OUTPUT_CAP_CHARS,
  `the structured failure must sit past the tool-output cap (it sits at ${LEDGER_FAILURE_AT})`,
);
const LEDGER_CALL_ID = "call_ledger_unknown";

// (2) A CPU handoff from a long-lived session, over the base budget. The bulk
// is the accumulated USER: lines a repeatedly compacted session carries, which
// is what defeated every bounding tier.
function longHandoffText() {
  const lines = [
    "HEAD: task=run the simulated market-hours cycle | phase=ledger reconciled at the 14:00 slot",
    "FAILED: QUOTE_STALE at 09:58",
    "TOOLS: get_ledger x4, get_quote x2, place_order x1",
    "---",
  ];
  for (let i = 0; i < 170; i += 1) lines.push(`USER: Cycle note ${i}: ${filler(240)}`);
  lines.push('TOOL_CALL: place_order({"symbol":"TEST","side":"buy","qty":1})');
  lines.push('TOOL_OUTPUT: {"ok":true,"order":"ord_9","code":"FILLED"}');
  lines.push("ASSISTANT: PLAN_B: keep cash, resolve the unknown money operation, then revisit entries.");
  lines.push("RECENT_STATE_B: ledger reconciled, entry paused, next step = re-check quote freshness.");
  return lines.join("\n");
}

// (3) A continuation summary written by a model, so it carries no HEAD marker.
// This is what a session looks like after the user switches it from a routed
// model to a local engine: the stored handoff is prose, not our own extract.
function headlessHandoffText() {
  const lines = [
    "Continuation summary from an earlier model, written as prose with no header block:",
    "The ledger was reconciled and no new entries were placed while the quote feed was stale.",
  ];
  for (let i = 0; i < 55; i += 1) lines.push(`USER: Earlier ask ${i}: ${filler(240)}`);
  lines.push("MIDDLE_C: decisive constraint - no new entry until the stale quote is resolved.");
  lines.push("ASSISTANT: PLAN_C: reconcile the ledger before any new entry, then re-check quotes.");
  lines.push("RECENT_STATE_C: last known state - ledger reconciled, no open orders.");
  return lines.join("\n");
}

const LONG_HANDOFF = longHandoffText();
const HEADLESS_HANDOFF = headlessHandoffText();
assert.ok(LONG_HANDOFF.length > BASE_BUDGET_CHARS, `the long handoff must exceed the base budget (it is ${LONG_HANDOFF.length} chars)`);
assert.ok(HEADLESS_HANDOFF.length < BASE_BUDGET_CHARS, `the headless handoff must stay inside it (it is ${HEADLESS_HANDOFF.length} chars)`);

let messageSeq = 0;
function userMessage(text, turn) {
  messageSeq += 1;
  return {
    type: "message",
    id: `msg_retention_${messageSeq}`,
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: `turn_retention_${turn}`, create_time: 1787000000 + turn },
  };
}

function assistantMessage(text) {
  messageSeq += 1;
  return {
    type: "message",
    id: `msg_retention_${messageSeq}`,
    role: "assistant",
    content: [{ type: "input_text", text }],
  };
}

function toolPair(name, callId, output) {
  return [
    { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify({ view: "summary", refresh: true }) },
    { type: "function_call_output", call_id: callId, output },
  ];
}

// A stored ModelDock handoff, in the exact shape the gateway replays it.
function storedCompaction(summary, id) {
  return { type: "compaction", id, encrypted_content: `kcr1:${Buffer.from(summary, "utf8").toString("base64")}` };
}

const STANDING_TASK = "Standing task: run the simulated market-hours cycle from the published playbook.";
const CYCLE_OVERRIDE = "For this cycle, pause new entries until the stale quote and ledger mismatch are resolved.";
const FINAL_ASK = "Continue the cycle: report the ledger summary and the current plan.";
const PLAN_ASK = "Continue the cycle: report the ledger summary and the plan in force.";

function historyWithBuriedFailure() {
  const input = [...fixture.request.input];
  input.push(userMessage(STANDING_TASK, 1));
  input.push(...toolPair("get_ledger", LEDGER_CALL_ID, [{ type: "input_text", text: LEDGER_RESULT }]));
  input.push(assistantMessage("PLAN_A: keep cash, resolve the unknown money operation before any new entry, then re-check the quote window."));
  input.push(userMessage("Report the ledger summary before any new risk.", 2));
  return input;
}

function historyWithLongHandoff() {
  const input = [...fixture.request.input];
  input.push(userMessage(STANDING_TASK, 1));
  input.push(...toolPair("get_quote", "call_quote_stale", JSON.stringify({ error: { code: "QUOTE_STALE", message: "Quote timestamp is older than the allowed freshness window." } })));
  input.push(storedCompaction(LONG_HANDOFF, "cmp_long_handoff"));
  input.push(userMessage(CYCLE_OVERRIDE, 9));
  return input;
}

function historyWithHeadlessHandoff() {
  const input = [...fixture.request.input];
  input.push(userMessage(STANDING_TASK, 1));
  input.push(storedCompaction(HEADLESS_HANDOFF, "cmp_headless_handoff"));
  input.push(userMessage(CYCLE_OVERRIDE, 9));
  return input;
}

function historyWithManyFailures() {
  const input = [...fixture.request.input, userMessage(STANDING_TASK, 1)];
  for (let index = 0; index < 13; index += 1) {
    input.push(...toolPair("get_quote", `call_old_failure_${index}`, JSON.stringify({
      ok: false,
      error: { code: `OLD_FAILURE_${index}`, message: "A prior quote request failed." },
    })));
  }
  input.push(...toolPair("get_ledger", "call_latest_failure", [{
    type: "input_text",
    text: JSON.stringify({ ok: false, error: { code: "LATEST_UNRESOLVED", message: "The latest money operation remains unresolved." } }),
  }]));
  return input;
}

// The plan-mode contract. A local model keeps no durable plan of its own, so
// the relay has to say how a plan is kept, and the CPU compact has to carry the
// plan the session is actually on - the revised one, in full - instead of
// either dropping it or reprinting a superseded version.
const PLAN_OLD_MARKER = "OLD_PLAN_SUPERSEDED_7c41";
const PLAN_DECISIVE_MARKER = "NEW_PLAN_DECISIVE_9f2c";
const PLAN_OLD_STEP =
  `Retire the legacy importer rows and close the reconciliation ticket (${PLAN_OLD_MARKER}) before any new entry.`;
const PLAN_LONG_STEP =
  `Resolve the unknown money operation before any new entry: trace order ord_3 through the clearing feed, confirm the terminal state with the settlement desk, then ${PLAN_DECISIVE_MARKER} reopen the entry gate only after the ledger summary and the quote freshness both check out.`;
const PLAN_DECISIVE_AT = PLAN_LONG_STEP.indexOf(PLAN_DECISIVE_MARKER);
assert.ok(
  PLAN_DECISIVE_AT > 120,
  `the decisive plan marker must sit past the 120-character tool-argument cap (it sits at ${PLAN_DECISIVE_AT})`,
);

function planPair(callId, plan, output) {
  return [
    { type: "function_call", id: `fc_${callId}`, call_id: callId, name: "update_plan", arguments: JSON.stringify({ plan }) },
    { type: "function_call_output", call_id: callId, output },
  ];
}

// The plan is written, then revised. The first version is pushed out of every
// verbatim window the extract keeps (the 24-line tail and the 40 newest tool
// calls) so it can only come back through a bug, never through the reuse the
// compact is supposed to do. The only place the full revised step text can
// appear is the plan field the handoff is meant to carry.
function historyWithPlans() {
  const input = [...fixture.request.input];
  input.push(userMessage(STANDING_TASK, 1));
  input.push(...planPair("call_plan_old", [{ step: PLAN_OLD_STEP, status: "completed" }], "Plan updated."));
  for (let index = 0; index < 45; index += 1) {
    input.push(...toolPair("get_quote", `call_fill_${index}`, JSON.stringify({ ok: true, symbol: "TEST", bid: 41.2 + index, ask: 41.3 + index })));
  }
  input.push(assistantMessage("The first pass is superseded; the revised plan is the one in force."));
  input.push(...planPair("call_plan_new", [
    { step: "Collect the ledger summary for cycle 7 and confirm the reconciliation window.", status: "completed" },
    { step: PLAN_LONG_STEP, status: "in_progress" },
  ], "Plan updated."));
  input.push(userMessage(PLAN_ASK, 2));
  return input;
}

// --- harness --------------------------------------------------------------

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

function messageText(message) {
  const content = message?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
  return typeof content === "string" ? content : "";
}

// The plan field of a handoff: what stands after the PLAN_STATE label, up to
// the next handoff field. Accepting a one-line field and a label followed by
// step lines keeps the assertion on which plan survives, and how completely,
// rather than on one rendering of it.
const HANDOFF_FIELD_RE = /\n(?=(?:HEAD|FAILED|TOOLS|LAST_ERROR|TOOL_OUTPUTS_OMITTED|PLAN_STATE|TOOL_CALL|TOOL_OUTPUT|USER|ASSISTANT):)/;
function activePlanField(summary) {
  const start = summary.search(/^PLAN_STATE:/m);
  if (start < 0) return "";
  const rest = summary.slice(start);
  const next = HANDOFF_FIELD_RE.exec(rest.slice(1));
  return next ? rest.slice(0, next.index + 1) : rest;
}

// Boot the built bundle in front of a mock llama.cpp Chat upstream that accepts
// only the Chat wire, and hand back the port plus every upstream body it saw.
// Both contracts below measure the same two things: what the CPU extract wrote
// into the handoff, and what the local model was actually asked to read.
async function bootLocalHarness(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-retention-"));
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
      'data: {"id":"chatcmpl_retention","created":41,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","content":"RETENTION_ACK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":900,"completion_tokens":3}}',
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
  const autostartKey = `HKCU\\Software\\ModelDockTests\\retention-${process.pid}`;
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
      MODELDOCK_AUTOSTART_NAME: `ModelDockRetention${process.pid}`,
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
  return { gatewayPort, chatRequests, stderrText: () => stderr };
}

// The CPU compact owns the handoff for a local backend: it must answer with a
// kcr1 payload and make no upstream call at all.
async function compactSession(gatewayPort, stderrText, sessionId, input) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": sessionId },
    body: JSON.stringify({ model: MODEL, stream: false, input: [...input, { type: "compaction_trigger" }] }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `compact rejected (${sessionId}): ${text.slice(0, 400)}\n${stderrText()}`);
  const item = (JSON.parse(text).output || []).find((entry) => entry.type === "compaction");
  assert.ok(item, `the compact response must carry a compaction item (${sessionId}): ${text.slice(0, 300)}`);
  assert.match(String(item.encrypted_content), /^kcr1:/, `the CPU handoff rides the gateway's own kcr1 payload (${sessionId})`);
  return { item, summary: Buffer.from(String(item.encrypted_content).slice(5), "base64").toString("utf8") };
}

// An ordinary local turn: the full Codex request shape, the model the dashboard
// has selected, and the history under test.
async function relaySession(gatewayPort, stderrText, sessionId, input) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": sessionId },
    body: JSON.stringify({ ...fixture.request, model: MODEL, input }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `relay rejected (${sessionId}): ${text}\n${stderrText()}`);
  return text;
}

test("the CPU compact keeps a buried structured failure and every restored handoff", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  const harness = await bootLocalHarness(t);
  const { gatewayPort, chatRequests, stderrText } = harness;
  const compact = (sessionId, input) => compactSession(gatewayPort, stderrText, sessionId, input);

  // --- (1) a structured tool failure buried past the tool-output cap -------
  const buried = await compact("retention-buried", historyWithBuriedFailure());
  assert.ok(
    buried.summary.includes("UNKNOWN_MONEY_OPERATION"),
    `the handoff must keep the error code of a structured failure that sits ${LEDGER_FAILURE_AT} characters into the tool result: ${buried.summary.slice(0, 400)}`,
  );
  assert.match(
    buried.summary,
    /LAST_ERROR:|FAILED:/,
    `the buried failure must arrive as a failure, not as replayed output text: ${buried.summary.slice(0, 400)}`,
  );
  assert.ok(
    buried.summary.includes("PLAN_A"),
    `the latest assistant plan must survive the compact: ${buried.summary.slice(0, 400)}`,
  );

  // --- (2) a pre-existing handoff larger than the base budget --------------
  const long = await compact("retention-long", historyWithLongHandoff());
  assert.ok(
    long.summary.includes("phase=ledger reconciled"),
    `the ${LONG_HANDOFF.length}-character handoff must keep its head: ${long.summary.slice(0, 300)}`,
  );
  assert.ok(
    long.summary.includes("RECENT_STATE_B"),
    `a handoff over the base budget must keep its recent tail instead of collapsing to its first two lines: ${long.summary.slice(0, 600)}`,
  );
  assert.ok(
    long.summary.includes("PLAN_B"),
    `the plan carried by the pre-existing handoff must survive the next compact: ${long.summary.slice(0, 600)}`,
  );
  assert.ok(
    long.summary.length > TOOL_OUTPUT_CAP_CHARS * 6,
    `the next handoff must not collapse to a couple of lines (it is ${long.summary.length} characters)`,
  );

  // --- (3) a restored handoff with no HEAD marker --------------------------
  const headless = await compact("retention-headless", historyWithHeadlessHandoff());
  assert.ok(
    headless.summary.includes("Continuation summary from an earlier model"),
    `a restored handoff with no HEAD marker must keep its opening edge: ${headless.summary.slice(0, 400)}`,
  );
  assert.ok(
    headless.summary.includes("MIDDLE_C"),
    `a restored handoff with no HEAD marker must not be cut to the 300-character user cap: ${headless.summary.slice(0, 400)}`,
  );
  assert.ok(
    headless.summary.includes("RECENT_STATE_C"),
    `a restored handoff with no HEAD marker must keep its closing edge: ${headless.summary.slice(0, 400)}`,
  );
  assert.ok(
    headless.summary.length > HEADLESS_HANDOFF.length * 0.9,
    `the ${HEADLESS_HANDOFF.length}-character handoff must survive as restored history (kept ${headless.summary.length} characters)`,
  );

  // Historical errors cannot fill the bounded failure list ahead of a newer
  // unresolved operation. The latest failure must be explicitly identified.
  const manyFailures = await compact("retention-many-failures", historyWithManyFailures());
  assert.match(manyFailures.summary, /LAST_ERROR: get_ledger: LATEST_UNRESOLVED/, "the latest structured failure survives more than twelve older failures");

  assert.equal(chatRequests.length, 0, "the CPU compact path calls no upstream");

  // --- the very next turn replays that history to the local model ----------
  const replay = [
    ...historyWithBuriedFailure(),
    buried.item,
    userMessage(FINAL_ASK, 200),
  ];
  const text = await relaySession(gatewayPort, stderrText, "retention-replay", replay);
  assert.equal(chatRequests.length, 1, "the local model was asked exactly once");
  assert.match(text, /response\.completed/, "the client received a completed response");
  assert.match(text, /RETENTION_ACK/, "the client received the model's answer");

  const upstreamBody = chatRequests[0];
  assert.ok(Array.isArray(upstreamBody.messages) && upstreamBody.messages.length, "the strict Chat upstream received messages");
  // Chat carries a call id in the assistant message's tool_calls, not in its
  // text, so the pairing check reads the serialized messages while the
  // retention checks read the text the model actually receives.
  const serialized = JSON.stringify(upstreamBody.messages);
  const transcript = upstreamBody.messages.map(messageText).join("\n");
  assert.ok(transcript.includes(FINAL_ASK), "the current human ask remains a full current user turn");
  assert.ok(serialized.includes(LEDGER_CALL_ID), "the replayed tool call keeps its call id");
  assert.ok(transcript.includes("UNKNOWN_MONEY_OPERATION"), "the structured tool failure is still delivered to the model");
  assert.ok(transcript.includes("PLAN_A"), "the plan survives into the next local turn");
});

// (1) What a local model is told and given before any compact happens. Codex's
// own long plan-mode text is not in this package (the captured instructions are
// redacted), so this measures the guidance the relay itself adds.
test("the local relay tells the local model how to keep a plan", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  const { gatewayPort, chatRequests, stderrText } = await bootLocalHarness(t);
  const input = [...fixture.request.input, userMessage(STANDING_TASK, 1), userMessage(PLAN_ASK, 2)];

  await relaySession(gatewayPort, stderrText, "retention-guidance", input);
  assert.equal(chatRequests.length, 1, "the local model was asked exactly once");
  const body = chatRequests[0];
  const system = (body.messages || []).find((message) => message.role === "system");
  assert.ok(system, "the local relay delivers its instructions as the leading system message");
  const guidance = messageText(system);
  assert.match(
    guidance,
    /update_plan/,
    `the upstream instructions must tell the model to use update_plan for multi-step or long-running work: ${guidance.slice(0, 400)}`,
  );
  assert.match(
    guidance,
    /material(?:ly)?\s+chang/i,
    `the upstream instructions must limit plan updates to material change: ${guidance.slice(0, 400)}`,
  );
  assert.match(
    guidance,
    /(?:do not|never|don't)[^.]{0,40}(?:create_goal|create\s+a\s+goal)/i,
    `the upstream instructions must stop the model from creating a goal on its own: ${guidance.slice(0, 400)}`,
  );
  assert.match(
    guidance,
    /unless the user explicitly/i,
    `creating a goal must be gated on an explicit user request: ${guidance.slice(0, 400)}`,
  );
  const declaredTools = (body.tools || []).map((tool) => tool?.function?.name).filter(Boolean);
  assert.ok(
    declaredTools.includes("update_plan"),
    `the update_plan descriptor must still reach the local model: ${declaredTools.slice(0, 20).join(", ")}`,
  );
});

// (2)/(3) The plan the session is actually on: the revised plan is the one the
// handoff carries, in full, the plan it replaced does not come back with it, and
// the next local turn still receives what the compact kept.
test("the local compact carries only the plan in force, and the next turn keeps it", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  const { gatewayPort, chatRequests, stderrText } = await bootLocalHarness(t);

  const planned = await compactSession(gatewayPort, stderrText, "retention-plan", historyWithPlans());
  const active = activePlanField(planned.summary);
  assert.ok(
    active,
    `the compact must carry the latest confirmed plan in a PLAN_STATE field: ${planned.summary.slice(0, 600)}`,
  );
  assert.ok(
    active.includes(PLAN_LONG_STEP),
    `the active plan must carry its decisive step in full - the marker sits ${PLAN_DECISIVE_AT} characters in, past the 120-character tool-argument cap: ${active.slice(0, 700)}`,
  );
  assert.ok(
    active.includes("Collect the ledger summary for cycle 7"),
    `the active plan must carry every step of the plan in force, not just the decisive one: ${active.slice(0, 700)}`,
  );
  assert.ok(
    !active.includes(PLAN_OLD_MARKER),
    `the superseded plan must not ride the active field: ${active.slice(0, 700)}`,
  );
  assert.ok(
    !planned.summary.includes(PLAN_OLD_MARKER),
    `the superseded plan must not survive in the handoff at all: ${planned.summary.slice(0, 800)}`,
  );
  const adjacent = await compactSession(gatewayPort, stderrText, "retention-plan-adjacent", [
    ...fixture.request.input,
    userMessage(STANDING_TASK, 1),
    ...planPair("call_adjacent_old", [{ step: PLAN_OLD_STEP, status: "completed" }], "Plan updated."),
    ...planPair("call_adjacent_new", [{ step: PLAN_LONG_STEP, status: "in_progress" }], "Plan updated."),
  ]);
  assert.ok(activePlanField(adjacent.summary).includes(PLAN_DECISIVE_MARKER), "the adjacent revised plan is carried in full");
  assert.ok(!adjacent.summary.includes(PLAN_OLD_MARKER), "an adjacent superseded plan is not left in a generic tool-call excerpt");
  const priorPlan = `HEAD: task=continue work\n---\nPLAN_STATE: ${JSON.stringify({ source: "update_plan", steps: [{ status: "in_progress", step: "CHECKPOINT_PLAN_CURRENT" }] })}`;
  const afterCheckpoint = await compactSession(gatewayPort, stderrText, "retention-plan-checkpoint", [
    ...fixture.request.input,
    ...planPair("call_before_checkpoint", [{ step: PLAN_OLD_STEP, status: "completed" }], "Plan updated."),
    storedCompaction(priorPlan, "cmp_plan_checkpoint"),
    userMessage(PLAN_ASK, 201),
  ]);
  assert.ok(activePlanField(afterCheckpoint.summary).includes("CHECKPOINT_PLAN_CURRENT"), "a checkpoint's newer plan remains authoritative");
  assert.ok(!afterCheckpoint.summary.includes(PLAN_OLD_MARKER), "a replayed pre-checkpoint tool call cannot overwrite or duplicate the checkpoint plan");
  assert.equal(chatRequests.length, 0, "the plan compact is still CPU-only");

  const planReplay = [
    ...historyWithPlans(),
    planned.item,
    userMessage(PLAN_ASK, 400),
  ];
  await relaySession(gatewayPort, stderrText, "retention-plan-replay", planReplay);
  assert.equal(chatRequests.length, 1, "the planned replay made exactly one upstream call");
  const transcript = (chatRequests[0].messages || []).map(messageText).join("\n");
  assert.ok(transcript.includes(PLAN_ASK), "the planned replay keeps the current human ask");
  assert.ok(
    transcript.includes(PLAN_LONG_STEP),
    `the next local turn must still receive the full decisive step of the plan: ${transcript.slice(0, 700)}`,
  );
});

// End-to-end proof for the message-replay defect, per the repository testing rule: a
// fix is proven by a real request through the built bundle, not by a unit assertion.
//
// The bug: the gateway used to scan every history item for text shaped like a Codex
// collaboration envelope and append the captured text to the request as a trailing
// user turn. Any model that quoted such a header - in an answer or in a reasoning
// summary, which is what auditing this repository produces - had its own prose
// delivered back as the newest instruction, after the human's real message, on every
// routed model. The loop fed itself. This test sends that exact history through the
// shipped bundle and asserts what the upstream actually received.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs");

const QUOTED = "Audit the duplicate pipelines and report findings. Do not edit code.";
const HEADER = `Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\n`;
const LIVE = "LIVE INSTRUCTION: cut the unit tests and report the numbers.";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
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

test("the built bundle never turns quoted collaboration prose into a live user turn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-replay-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });

  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl_replay",
      model: "Qwen3.8-27B",
      choices: [{ index: 0, message: { role: "assistant", content: "ACK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 1 },
    }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  await writeFile(path.join(stateDir, "local-engines.json"), JSON.stringify({
    llamacpp: {
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      models: [{ id: "Qwen3.8-27B", upstreamId: "Qwen3.8-27B", label: "Qwen3.8-27B", supportsVision: false, contextWindow: 32_768 }],
    },
  }), "utf8");

  const probe = http.createServer();
  const gatewayPort = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MODELDOCK_PORT: String(gatewayPort),
      MODELDOCK_PROFILE: "llamacpp",
      MODELDOCK_STATE_DIR: stateDir,
      MODELDOCK_CODEX_HOME: path.join(root, "codex-home"),
      MODELDOCK_REQUIRE_CALLER_KEY: "0",
      MODELDOCK_MEMORY: "0",
      MODELDOCK_MODEL_DISCOVERY: "0",
      MODELDOCK_NATIVE_MERGE: "0",
      MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
      MODELDOCK_AUTOSTART_KEY: `HKCU\\Software\\ModelDockTests\\replay-${process.pid}`,
      MODELDOCK_AUTOSTART_NAME: `ModelDockReplay${process.pid}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
  await waitForStatus(gatewayPort);

  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-codex-session-id": "replay-e2e" },
    body: JSON.stringify({
      model: "Qwen3.8-27B@llamacpp",
      stream: false,
      input: [
        // The model's own rows quoting a collaboration header: history, never a delivery.
        { type: "reasoning", id: "rs_quote", content: [{ type: "reasoning_text", text: `${HEADER}${QUOTED}` }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: `Working on it.\n${HEADER}${QUOTED}` }] },
        // A genuine Codex envelope: it must still reach the model, where it already sits.
        { type: "agent_message", id: "amsg_real", author: "/root", recipient: "/root/worker", content: [
          { type: "input_text", text: HEADER },
          { type: "encrypted_content", encrypted_content: "delegate the pipeline audit" },
        ] },
        { type: "message", role: "user", content: [{ type: "input_text", text: LIVE }] },
      ],
      tools: [{ type: "function", function: { name: "exec_command", parameters: { type: "object", properties: {} } } }],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `bundle rejected the request: ${text}\n${stderr}`);
  assert.equal(received.length, 1, "the routed model was called once");

  const rows = received[0].messages.filter((message) => message.role !== "system");
  const userText = (message) => (Array.isArray(message.content) ? message.content.map((part) => part?.text || "").join("") : String(message.content || ""));
  const users = rows.filter((message) => message.role === "user").map(userText);

  assert.equal(rows.at(-1).role, "user", "the human message stays the last turn");
  assert.ok(userText(rows.at(-1)).includes(LIVE), "and carries the live instruction");
  assert.equal(
    users.filter((content) => content.includes(QUOTED) && !content.startsWith("[agent_message")).length,
    0,
    `no user turn was fabricated from quoted prose; got ${JSON.stringify(users)}`,
  );
  assert.ok(
    users.some((content) => content.startsWith("[agent_message from /root to /root/worker]") && content.includes("delegate the pipeline audit")),
    "the real envelope still reaches the model as a labeled user turn",
  );
  assert.equal(
    rows.filter((message) => userText(message).includes(QUOTED) && message.role === "user").length,
    0,
    "the prose is relayed only inside the assistant and reasoning rows that already held it",
  );
});

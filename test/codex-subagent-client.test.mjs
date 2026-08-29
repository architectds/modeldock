import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeSubagentAgentFile } from "../src/subagent-config.mjs";

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

async function removeFixtureRoot(root) {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    // The real client may release its disposable session files just after the
    // process exits on Windows. The sandbox cleanup removes such a fixture.
    if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has(error?.code)) throw error;
  }
}

function sse(events) {
  return `${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

function responseEnvelope(id, model, output) {
  return {
    id,
    object: "response",
    created_at: 0,
    status: "completed",
    model,
    output,
    usage: {
      input_tokens: 8,
      output_tokens: 4,
      total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function functionCallStream({ id, model, name, namespace, callId, argumentsValue }) {
  const item = {
    id: `fc_${id}`,
    type: "function_call",
    status: "completed",
    name,
    ...(namespace ? { namespace } : {}),
    call_id: callId,
    arguments: argumentsValue,
  };
  return sse([
    {
      type: "response.output_item.added",
      response_id: id,
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      response_id: id,
      item_id: item.id,
      output_index: 0,
      delta: argumentsValue,
    },
    {
      type: "response.function_call_arguments.done",
      response_id: id,
      item_id: item.id,
      output_index: 0,
      arguments: argumentsValue,
    },
    { type: "response.output_item.done", response_id: id, output_index: 0, item },
    { type: "response.completed", response: responseEnvelope(id, model, [item]) },
  ]);
}

function textStream({ id, model, text }) {
  const part = { type: "output_text", annotations: [], logprobs: [], text };
  const item = {
    id: `msg_${id}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [part],
  };
  return sse([
    {
      type: "response.output_item.added",
      response_id: id,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      response_id: id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { ...part, text: "" },
    },
    {
      type: "response.output_text.delta",
      response_id: id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
      logprobs: [],
    },
    {
      type: "response.output_text.done",
      response_id: id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
      logprobs: [],
    },
    {
      type: "response.content_part.done",
      response_id: id,
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part,
    },
    { type: "response.output_item.done", response_id: id, output_index: 0, item },
    { type: "response.completed", response: responseEnvelope(id, model, [item]) },
  ]);
}

async function readJsonlSessions(root) {
  const sessions = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const records = (await readFile(file, "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        sessions.push({ file, records });
      }
    }
  }
  await walk(path.join(root, "sessions"));
  return sessions;
}

test("installed Codex resolves ModelDock's managed subagent role to Luna", { timeout: 180_000 }, async (t) => {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (probe.error?.code === "ENOENT") {
    t.skip("Codex is not installed on this test host");
    return;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-codex-subagent-"));
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  await Promise.all([mkdir(codexHome, { recursive: true }), mkdir(workspace, { recursive: true })]);
  t.after(() => removeFixtureRoot(root));

  // Use the product writer so the coupling check consumes the same managed
  // role file as the dashboard. This test proves real Codex role resolution;
  // a deterministic mock emits spawn_agent, so it intentionally does not
  // claim that the real Sol model independently chose the policy.
  writeSubagentAgentFile({ codexHome }, "gpt-5.6-luna");

  const requests = [];
  let parentCalls = 0;
  let resolveLuna;
  const lunaObserved = new Promise((resolve) => {
    resolveLuna = resolve;
  });

  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "request body must be JSON" } }));
      return;
    }
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization, body });

    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "expected POST /v1/responses" } }));
      return;
    }
    if (body.stream !== true || !Array.isArray(body.input)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `invalid Codex Responses envelope: ${JSON.stringify({
        stream: body.stream,
        inputIsArray: Array.isArray(body.input),
      })}` } }));
      return;
    }

    if (body.model === "gpt-5.6-luna") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      resolveLuna();
      res.end(textStream({ id: "resp_luna_child", model: body.model, text: "CHILD_LUNA_OK" }));
      return;
    }
    if (body.model !== "gpt-5.6-sol") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(textStream({ id: "resp_unexpected_model", model: body.model, text: "UNEXPECTED_MODEL" }));
      return;
    }

    parentCalls += 1;
    if (parentCalls === 1) {
      const declaredTools = [
        ...(body.tools || []),
        ...body.input.filter((item) => item?.type === "additional_tools").flatMap((item) => item.tools || []),
      ];
      const collaboration = declaredTools.find((tool) => tool?.type === "namespace" && tool?.name === "collaboration");
      const spawnTool = collaboration?.tools?.find((tool) => tool?.name === "spawn_agent");
      if (!spawnTool) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `actual Codex request omitted spawn_agent: ${JSON.stringify(
          {
            keys: Object.keys(body).sort(),
            tools: declaredTools.map((tool) => ({
              type: tool?.type,
              name: tool?.name,
              tools: tool?.tools?.map((child) => ({ type: child?.type, name: child?.name })),
            })),
          },
        )}` } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(functionCallStream({
        id: "resp_sol_spawn",
        model: body.model,
        name: "spawn_agent",
        namespace: "collaboration",
        callId: "call_spawn_managed_luna",
        argumentsValue: JSON.stringify({
          task_name: "managed_luna_probe",
          message: "Reply with exactly CHILD_LUNA_OK.",
          agent_type: "modeldock_subagent",
          fork_turns: "none",
        }),
      }));
      return;
    }

    // Keep the parent alive until its asynchronously spawned child has made a
    // real request. This avoids asserting on a child that Codex cancelled when
    // the top-level exec process exited.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    let lunaTimer;
    try {
      await Promise.race([
        lunaObserved,
        new Promise((_, reject) => {
          lunaTimer = setTimeout(() => reject(new Error(
            `the Luna child never reached the upstream; observed ${JSON.stringify(requests.map((entry) => ({
              model: entry.body?.model,
              inputTypes: entry.body?.input?.map((item) => item?.type),
              functionOutputs: entry.body?.input
                ?.filter((item) => item?.type === "function_call_output")
                .map((item) => item.output),
            })))}`,
          )), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(lunaTimer);
    }
    res.end(textStream({ id: "resp_sol_done", model: body.model, text: "PARENT_SOL_OK" }));
  });
  // Native Codex models try Responses WebSockets first. ModelDock intentionally
  // declines upgrades the same way so the real client takes its supported HTTP
  // fallback; treating the handshake as a JSON request would be a fake client
  // failure rather than a role-resolution check.
  upstream.on("upgrade", (_request, socket) => {
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => closeServer(upstream));

  await writeFile(path.join(codexHome, "config.toml"), [
    'model = "gpt-5.6-sol"',
    `openai_base_url = ${JSON.stringify(`http://127.0.0.1:${upstreamPort}/v1`)}`,
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    "",
    "[features]",
    "multi_agent = true",
    "",
  ].join("\n"), "utf8");

  const codex = spawn("codex", [
    "exec",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
    "--color",
    "never",
    "--json",
    "-C",
    workspace,
    "Dispatch the bounded probe to the ModelDock-managed subagent role, then finish.",
  ], {
    env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: "fixture-token" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  codex.stdout.on("data", (chunk) => { stdout += chunk; });
  codex.stderr.on("data", (chunk) => { stderr += chunk; });
  const codexTimer = setTimeout(() => codex.kill("SIGKILL"), 45_000);
  const [exitCode] = await once(codex, "exit");
  clearTimeout(codexTimer);

  assert.equal(exitCode, 0, `${stderr}\n${stdout}\n${JSON.stringify(requests.map((entry) => ({ url: entry.url, model: entry.body?.model })), null, 2)}`);
  assert.match(stdout, /PARENT_SOL_OK/);
  assert.ok(requests.some((entry) => entry.body.model === "gpt-5.6-sol"), "the parent must reach the mock as Sol");
  assert.ok(requests.some((entry) => entry.body.model === "gpt-5.6-luna"), "the child must reach the mock as Luna");

  const sessions = await readJsonlSessions(codexHome);
  const managedChild = sessions.find(({ records }) => records.some((record) =>
    record.type === "session_meta" && record.payload?.agent_role === "modeldock_subagent"));
  assert.ok(managedChild, `missing modeldock_subagent session metadata in ${sessions.map((entry) => entry.file).join(", ")}`);
  const childMeta = managedChild.records.find((record) => record.type === "session_meta")?.payload;
  const childTurn = managedChild.records.find((record) => record.type === "turn_context")?.payload;
  assert.equal(childMeta?.agent_role, "modeldock_subagent");
  assert.equal(childMeta?.source?.subagent?.thread_spawn?.agent_role, "modeldock_subagent");
  assert.equal(childTurn?.model, "gpt-5.6-luna");
});

// End-to-end reproduction of the 2026-09-17 outage against the shipped bundle.
//
// The transition being replayed: a managed local host with ONE lane serves a
// Codex turn; llama.cpp finishes and closes its side of the response; the relay
// never observes the end, so the request keeps the lane forever. Every later
// local turn on any conversation then waits, the GPUs go idle, and the log says
// nothing. The mock engine below reproduces the half-close exactly: it sends the
// lifecycle, ends its own socket, and the relay's client never resolves.
//
// This is the test that must fail if anyone reintroduces an unbounded lease.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  beginHostApply,
  createObservedHost,
  markHostApplying,
  markHostVerified,
  markHostVerifying,
  takeOverHost,
} from "../src/local-hosts.mjs";
import { createLocalHostRegistry, upsertLocalHost, writeLocalHostRegistry } from "../src/local-host-registry.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(repoRoot, "dist", "modeldock.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitForStatus(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (response.ok) return;
    } catch { /* still starting */ }
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

function chatEvents(id, text, finishReason = "stop") {
  return [
    `data: {"id":"${id}","created":1,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","content":"${text}"}}]}`,
    `data: {"id":"${id}","model":"Qwen3.8-27B","choices":[{"index":0,"delta":{},"finish_reason":"${finishReason}"}],"usage":{"prompt_tokens":40,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":0}}}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

test("built bundle reclaims a local lane whose relay never observes the end of its stream", async (t) => {
  assert.equal(true, await import("node:fs/promises").then(({ access }) => access(bundle).then(() => true, () => false)), `missing built bundle: ${bundle}`);
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-lease-reclaim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const kvDirectory = path.join(root, "kv");
  await mkdir(stateDir, { recursive: true });
  await mkdir(kvDirectory, { recursive: true });

  let wedged = false;
  const requests = [];
  const sockets = new Set();
  // A strict llama.cpp Chat endpoint whose first response is *delivered* and
  // then left open: it ends the HTTP body but never lets the socket go away, so
  // a relay that is waiting for something else can hang on it forever.
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "expected Chat Completions endpoint" }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
    if (!wedged) {
      wedged = true;
      // First bytes arrive, so the relay knows the request "started"...
      res.write(`data: {"id":"chatcmpl_wedge","created":1,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","content":"WEDGE"}}]}\n\n`);
      // ...and then the turn simply stops producing. No finish_reason, no
      // [DONE]: exactly the shape that left the lane held for seven hours.
      return;
    }
    res.end(chatEvents("chatcmpl_next", "AFTER_RECLAIM"));
  });
  upstream.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    upstream.closeIdleConnections?.();
    upstream.closeAllConnections?.();
    upstream.close();
  });

  const endpoint = `http://127.0.0.1:${upstreamPort}/v1`;
  const launch = { binary: "D:/llama/llama-server.exe", args: ["-m", "D:/models/Qwen3.8-27B.gguf", "-c", "262144"] };
  let record = takeOverHost(createObservedHost({
    id: "llamacpp-lease-fixture",
    adapterId: "llamacpp-nvidia",
    endpoint,
    launch,
  }), { kvState: { directory: kvDirectory, budgetBytes: 4 * 1024 * 1024 } });
  record = markHostVerified(record);
  const profile = {
    adapterId: "llamacpp-nvidia",
    modelId: "Qwen3.8-27B",
    profileId: "lease-fixture-p1",
    laneCount: 1,
    laneContextTokens: 262_144,
    totalContextTokens: 262_144,
  };
  record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
  record = markHostApplying(record);
  record = markHostVerifying(record);
  record = markHostVerified(record);
  await writeLocalHostRegistry(path.join(stateDir, "local-hosts.json"), upsertLocalHost(createLocalHostRegistry(), record));
  await writeFile(path.join(stateDir, "local-engines.json"), JSON.stringify({
    llamacpp: {
      baseUrl: endpoint,
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
      MODELDOCK_AUTOSTART: "0",
      // Shorten only the watchdog; the reclaim behaviour under test is identical.
      MODELDOCK_LOCAL_STALL_MS: "1500",
      MODELDOCK_LOCAL_LEASE_MS: "8000",
      MODELDOCK_LOCAL_LEASE_TICK_MS: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => stop(child));
  await waitForStatus(gatewayPort);
  // Fail fast and legibly: an unmanaged host has no scheduler, so it would have
  // no watchdog either, and the test would read as a product failure instead of
  // a broken fixture.
  const boot = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/status`)).json();
  assert.equal(boot.localHost?.managed, true, `fixture host is not managed: ${JSON.stringify(boot.localHost)}`);
  assert.equal(boot.localHost?.lease?.stallMs, 1_500, `stall override not applied: ${JSON.stringify(boot.localHost?.lease)}`);
  assert.equal(boot.localHost?.lease?.maxLeaseMs, 8_000, `lease override not applied: ${JSON.stringify(boot.localHost?.lease)}`);

  const send = async (session) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", session_id: session },
      body: JSON.stringify({
        model: "Qwen3.8-27B@llamacpp",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `say hi for ${session}` }] }],
        stream: true,
        max_output_tokens: 64,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    return { status: response.status, text: await response.text() };
  };

  // 1. The wedged turn must come back as an ended stream, not as eternal silence.
  //    Which rule catches it depends on what the relay managed to forward: a
  //    stream that produced events and then stopped is a *stall*, and silence
  //    from the first byte is only caught by the *absolute lease*. The stall
  //    deadline here (1.5s) is well inside the lease (8s), so the stall normally
  //    wins; both are asserted below as "a reclaim happened", because either one
  //    is the fix working and neither may be allowed to regress into a hang.
  //    The 20s bound is the point: before the watchdog this request simply never
  //    ended, and the caller waited for bytes that did not exist any more.
  const firstStartedAt = Date.now();
  const first = await send("lease-wedge");
  const firstElapsedMs = Date.now() - firstStartedAt;
  assert.ok(firstElapsedMs < 20_000, `the wedged turn took ${firstElapsedMs} ms; the watchdog never fired`);

  // 2. The reclaim is visible in status: the lane is free again and the job that
  //    held it is gone. Before the fix this state could not be seen from outside
  //    at all, which is why it ran unnoticed for hours.
  let local = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/status`)).json();
    local = status.localHost || {};
    if ((local.lease?.reclaims?.detected || 0) >= 1 && (local.lease?.active?.length || 0) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(local.managed, true, "the fixture host stayed managed");
  assert.ok(
    (local.lease?.reclaims?.detected || 0) >= 1,
    `expected lease telemetry for the wedged job, got ${JSON.stringify(local.lease)}`,
  );
  assert.equal(local.lease?.active?.length, 0, `the reclaimed job still holds the lane: ${JSON.stringify(local.lease?.active)}`);
  assert.equal(local.activeCount, 0, `the lane was not released: ${JSON.stringify({ activeCount: local.activeCount, lanes: local.lanes })}`);
  assert.equal(local.pendingCount, 0, "nothing is parked behind the reclaimed request");

  // 3. The wedged gateway request is finished *and the caller was told*: the
  //    gateway ended the stream with a failure instead of letting Codex wait for
  //    bytes it will never get. Before this fix the turn was recorded as ended
  //    (and blamed on the client, "client disconnected") while the response was
  //    still open, which is what looked like ModelDock switching itself off.
  const statusAfterReclaim = await (await fetch(`http://127.0.0.1:${gatewayPort}/api/status`)).json();
  const wedgeEntry = (statusAfterReclaim.recent || []).find((row) => row.sessionId === "lease-wedge");
  assert.ok(
    wedgeEntry,
    `the wedged turn is missing from the recent list: ${JSON.stringify((statusAfterReclaim.recent || []).slice(0, 5))}`,
  );
  assert.ok(wedgeEntry.finishedAt, `the wedged request never finished: ${JSON.stringify(wedgeEntry)}`);
  assert.equal(wedgeEntry.status, "error", `expected an ended error turn, got ${JSON.stringify(wedgeEntry)}`);
  assert.equal(
    wedgeEntry.httpStatus,
    503,
    `a cancellation we started must not be reported as a client disconnect: ${JSON.stringify(wedgeEntry)}`,
  );
  assert.match(
    String(wedgeEntry.error),
    /reclaimed|cancelled/i,
    `the caller must be told why the turn ended: ${JSON.stringify(wedgeEntry)}`,
  );
  // And the client itself saw a terminal event rather than an endless stream.
  assert.match(first.text, /response\.failed/, `the wedged client stream must end with a failure event: ${first.text.slice(-400)}`);

  // 4. A later conversation gets served - the point of the whole fix.
  const after = await send("lease-next");
  assert.equal(after.status, 200, `the next conversation must be served, got: ${after.text.slice(0, 200)}`);
  assert.match(after.text, /AFTER_RECLAIM/);

  // 5. And it is in the log: the whole complaint was that this was silent.
  assert.match(
    output,
    /local host lane_(reclaimed|stalled)/,
    `the reclaim must be logged. tail:\n${output.slice(-2000)}`,
  );
});

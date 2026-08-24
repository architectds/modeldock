import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createApp, createServices } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";
import { readLocalEnginesSnapshot, writeLocalEngineSnapshot } from "../src/local-engines.mjs";
import { parseLlamaArgs } from "../src/engine-processes.mjs";
import { kvBytesPerToken, modelShape } from "../src/gguf.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

// Connecting used to fall back to the profile's default port when the caller
// sent no address, so an engine started with `--port 11435` was found by the
// scan and then could not be connected: the scan and the button disagreed
// about where the engine was. Scanning and connecting are one action, so the
// address is discovered on the server and both buttons get the same answer.

// A server that answers just enough of the OpenAI dialect for connect to
// accept it: the model list, then the Responses probe.
function fakeEngine() {
  return createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "qwen3.8:27b" }] }));
      return;
    }
    if (req.url === "/v1/responses") {
      res.end(JSON.stringify({
        id: "resp_1",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "CUSTOM_OK" }] }],
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
}

async function startApp(t, { discoverEngines }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-connect-discovery-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    goBaseUrl: "https://go.example.com/v1",
    goToken: "test-token",
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    mediaTtlMs: 60_000,
    mediaMaxBytes: 1024 * 1024,
    mediaMaxEntries: 8,
    recentLimit: 10,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
    autostartDefault: false,
    summariesFile: path.join(dir, "summaries.json"),
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
    nativeCatalogFile: path.join(dir, "native-catalog.json"),
  };
  const services = createServices(config);
  services.discoverEngines = discoverEngines;
  services.localEnginesFile = path.join(dir, "local-engines.json");
  services.localHostRegistryFile = path.join(dir, "local-hosts.json");
  services.engineLogDir = path.join(dir, "engine-logs");
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}`, services };
}

test("connect attaches the port discovery found, not the profile default", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  assert.notEqual(port, 8080, "the point of this test is that the port is not the default");

  const { base, services } = await startApp(t, {
    discoverEngines: async () => [{
      engine: "llamacpp",
      baseUrl: `http://127.0.0.1:${port}`,
      port,
      models: ["qwen3.8:27b"],
      connectable: true,
    }],
  });

  // No baseUrl in the body - exactly what both buttons send.
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, `connect failed: ${JSON.stringify(payload)}`);
  // normalizeBaseUrl appends the /v1 the Responses dialect lives under; the
  // host and port are what discovery supplied.
  assert.equal(payload.baseUrl, `http://127.0.0.1:${port}/v1`);

  const snapshot = readLocalEnginesSnapshot(services.localEnginesFile);
  assert.equal(snapshot.llamacpp.baseUrl, `http://127.0.0.1:${port}/v1`, "the persisted address is the discovered one");
});

test("gateway connection and explicit host takeover stay separate", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));
  const discovered = {
    engine: "llamacpp",
    label: "llama.cpp",
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    models: ["qwen3.8:27b"],
    connectable: true,
    binary: "D:/llama-cpp-cuda/bin/llama-server.exe",
    cmdline: `"D:/llama-cpp-cuda/bin/llama-server.exe" -m D:/models/qwen.gguf -c 262144 --parallel 1 --host 127.0.0.1 --port ${port}`,
    launch: { model: "D:/models/qwen.gguf", ctxSize: 262144, parallel: 1 },
  };
  const { base, services } = await startApp(t, { discoverEngines: async () => [discovered] });

  const connected = await fetch(`${base}/api/local/connect`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "llamacpp" }),
  });
  assert.equal(connected.status, 200);

  const before = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(before.engines[0].connected, true, "the gateway route is connected");
  assert.equal(before.engines[0].management, null, "connection did not grant process-management authority");

  const managed = await fetch(`${base}/api/local/manage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", cacheDirectory: "D:/ModelDock/KV", cacheBudgetGiB: 64 }),
  });
  const managedBody = await managed.json();
  assert.equal(managed.status, 200, JSON.stringify(managedBody));
  assert.equal(managedBody.management.state, "ready");
  assert.equal(managedBody.management.ssdState, "restart_required", "takeover itself did not restart the engine");
  assert.equal(managedBody.management.cacheBudgetBytes, 64 * 1024 ** 3);

  const after = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(after.engines[0].connected, true, "gateway connection survives takeover");
  assert.equal(after.engines[0].management.state, "ready");
  assert.equal(after.engines[0].management.ssdState, "restart_required");

  const released = await fetch(`${base}/api/local/unmanage`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostId: managedBody.management.id }),
  });
  assert.equal(released.status, 200);
  const finalState = await (await fetch(`${base}/api/local/discover`)).json();
  assert.equal(finalState.engines[0].connected, true, "releasing authority does not disconnect the gateway route");
  assert.equal(finalState.engines[0].management, null);
  assert.equal(services.localHostRegistryFile.endsWith("local-hosts.json"), true);
});

test("connect says nothing is running instead of failing against a default port", async (t) => {
  const { base } = await startApp(t, { discoverEngines: async () => [] });
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 400);
  assert.equal(payload.error.type, "not_found");
  // The old behaviour was a connection error naming 8080, which sent the user
  // looking for a port problem that was never theirs.
  assert.doesNotMatch(payload.error.message, /8080/);
  assert.match(payload.error.message, /Start it/);
});

test("an explicit address still wins over discovery", async (t) => {
  const engine = fakeEngine();
  engine.listen(0, "127.0.0.1");
  await new Promise((resolve) => engine.once("listening", resolve));
  const port = engine.address().port;
  t.after(() => new Promise((resolve) => engine.close(resolve)));

  let discoverCalls = 0;
  const { base } = await startApp(t, {
    discoverEngines: async () => { discoverCalls += 1; return []; },
  });
  const response = await fetch(`${base}/api/local/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", baseUrl: `http://127.0.0.1:${port}` }),
  });
  assert.equal(response.status, 200);
  assert.equal(discoverCalls, 0, "a caller who knows the address is not made to wait for a scan");
});

test("only the engine actually attached is shown as connected", async (t) => {
  // Discovery reads the process table now, so two llama-servers can appear at
  // once. Keying attachment on the engine name marked both connected while only
  // one was, which made the page claim a server was published that never was.
  const { base, services } = await startApp(t, {
    discoverEngines: async () => [
      { engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435, models: ["a"], connectable: true },
      { engine: "llamacpp", baseUrl: "http://127.0.0.1:8080", port: 8080, models: ["b"], connectable: true },
    ],
  });
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    // Stored with the /v1 suffix the connect route appends; discovery reports
    // the bare origin, so this pair must still compare equal.
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a" }],
  });

  const response = await fetch(`${base}/api/local/discover`);
  const { engines } = await response.json();
  const byPort = Object.fromEntries(engines.map((engine) => [engine.port, engine]));
  assert.equal(byPort[11435].connected, true, "the attached one");
  assert.equal(byPort[8080].connected, false, "a second llama.cpp is not attached just by being llama.cpp");
  assert.equal(byPort[8080].connectedModels, 0);
  assert.equal(engines.filter((engine) => engine.connected).length, 1);
});

test("restart refuses to start a second copy of an engine that is answering", async (t) => {
  // The button hides itself while the engine answers, but that is a rendered
  // snapshot. A direct call - or a click after the engine came back - used to
  // spawn a second copy that could only fail to bind the port.
  const { base, services } = await startApp(t, {
    discoverEngines: async () => [
      { engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435, models: ["a"], connectable: true },
    ],
  });
  // We do know how to start it - the race is that it came back on its own.
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a" }],
    launch: { binary: process.execPath, args: ["-e", "0"] },
  });
  const response = await fetch(`${base}/api/local/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 409);
  assert.equal(payload.error.type, "already_running");
});

test("restart reports where the engine's output went", async (t) => {
  // AGENTS.md: a background launch must log, never discard. This button is
  // pressed exactly when the engine already died once, so the reason has to
  // land somewhere the user can be pointed at.
  const { base, services } = await startApp(t, { discoverEngines: async () => [] });
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a" }],
    // Something harmless that exists on every platform and exits immediately.
    launch: { binary: process.execPath, args: ["-e", "process.stderr.write('engine boot\\n')"] },
  });
  const response = await fetch(`${base}/api/local/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.ok(payload.logFile, "the caller is told where the output went");
  assert.match(payload.logFile, /engine-llamacpp\.log$/);
  // Give the detached child a moment to write and exit.
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const written = await readFile(payload.logFile, "utf8");
  // Not just "the string is in there": this test's own -e script carried an
  // escape that JS resolved before the spawn, so node received a real newline
  // inside a quoted string, refused to parse it, and echoed the offending
  // source line - which contains "engine boot" - into the log. The assertion
  // passed on a crash traceback. The child has to have actually run.
  assert.doesNotMatch(written, /SyntaxError|Invalid or unexpected token/, "the child never ran");
  assert.match(written, /^engine boot\s*$/, "stderr reached the log instead of /dev/null");
});

test("apply starts nothing when the old engine will not let go of the port", async (t) => {
  // The wait loop and the success path used to leave by the same door: running
  // out of patience looked exactly like the port coming free, so a process
  // that refused to die was followed by a second one that could only fail to
  // bind - and the reply said started: true either way.
  const stubborn = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => { try { stubborn.kill("SIGKILL"); } catch { /* already gone */ } });
  const cmdline = `${process.execPath} -m model.gguf -c 80000 --port 11435`;
  // Reports the engine as present no matter how often it is asked, which is
  // what a process that ignores the kill looks like from here.
  const { base, services } = await startApp(t, {
    discoverEngines: async () => [{
      engine: "llamacpp",
      baseUrl: "http://127.0.0.1:11435",
      port: 11435,
      models: ["a"],
      connectable: true,
      pid: stubborn.pid,
      binary: process.execPath,
      cmdline,
    }],
  });
  services.stopTimeoutMs = 600;

  const response = await fetch(`${base}/api/local/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", contextTokens: 48000, sessions: 1, kvType: "f16" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 502, JSON.stringify(payload));
  assert.equal(payload.error.type, "stop_timeout");
  assert.notEqual(payload.started, true, "nothing may be reported as started");
});

// The KV precision an engine is running has to survive the whole trip: parsed
// off the command line, into the ledger's arithmetic, and out again as the
// warning that says this stack cannot do it. Every one of those links was
// broken at once, and because the last one was a dead condition rather than a
// wrong answer, nothing failed loudly enough to notice.
const QWEN38_META = {
  "general.architecture": "qwen35",
  "qwen35.block_count": 65,
  "qwen35.nextn_predict_layers": 1,
  "qwen35.full_attention_interval": 4,
  "qwen35.attention.head_count": 24,
  "qwen35.attention.head_count_kv": 4,
  "qwen35.attention.key_length": 256,
  "qwen35.attention.value_length": 256,
  "qwen35.embedding_length": 5120,
  "qwen35.context_length": 262144,
};

function quantizedEngine() {
  const shape = modelShape({ meta: QWEN38_META });
  const cmdline = "llama-server -m D:/models/q3.gguf -c 80000 -ctk q8_0 -ctv q8_0 -ngl 99 --port 11435";
  return {
    engine: "llamacpp",
    baseUrl: "http://127.0.0.1:11435",
    port: 11435,
    models: ["a"],
    connectable: true,
    binary: "C:/llama/llama-server.exe",
    cmdline,
    launch: parseLlamaArgs(cmdline),
    // The ledger is built on weightBytes - the tensors the backend loads - not
    // on the file's size. They differ by the 221.7 MB of multi-token-prediction
    // blocks this model ships and this backend skips, and the overhead constant
    // carries that same amount the other way, so the reconciled total is the
    // one that was measured on the machine either way.
    modelFacts: {
      ...shape,
      fileBytes: Math.round(12.8697 * 1024 ** 3),
      weightBytes: Math.round(12.6429 * 1024 ** 3),
      ignoredBytes: 232470528,
      kvBytesPerToken: kvBytesPerToken(shape, "f16"),
    },
  };
}

test("a quantized KV cache is budgeted as quantized, and warned about", async (t) => {
  const { base, services } = await startApp(t, { discoverEngines: async () => [quantizedEngine()] });
  services.probeGpus = async () => [{ name: "AMD Radeon RX 7900 XT", vendor: "amd", totalBytes: Math.round(19.98 * 1024 ** 3) }];

  const { engines } = await (await fetch(`${base}/api/local/discover`)).json();
  const engine = engines.find((found) => found.port === 11435);

  // 1. The flag is read, not just written.
  assert.equal(engine.launch.cacheTypeK, "q8_0");
  // 2. The ledger budgets the cache that is running. At 80K this shape costs
  //    4.88 GiB at f16 and half that at q8_0, so reporting the f16 figure
  //    spent 2.44 GiB of headroom that was never taken - on a 19.10 GiB usable
  //    card that is the difference between 0.52 GiB left and 2.96 GiB left,
  //    which is the difference between a red bar and a comfortable one.
  assert.equal(engine.vram.kvType, "q8_0");
  const GiB = 1024 ** 3;
  const round = (bytes) => Math.round(bytes / GiB * 100) / 100;
  assert.equal(round(engine.vram.kv), 2.44);
  assert.equal(round(engine.vram.headroom), 2.96);
  // 3. The drawer is handed the engine's own argv, minus the settings it
  //    decides, so its preview is the line Apply runs rather than one composed
  //    from the flags the page happens to know the names of.
  assert.deepEqual(engine.launchBase, ["-m", "D:/models/q3.gguf", "-ngl", "99", "--port", "11435"]);
  // 4. The warning whose condition could never be true now can be.
  assert.ok(
    engine.warnings.some((warning) => warning.code === "kv_quant_unsupported"),
    `no quantization warning on an AMD card: ${JSON.stringify(engine.warnings)}`,
  );
});

test("an engine on the default cache is not warned about, and is budgeted at f16", async (t) => {
  // The other direction, so the warning above is not simply always on.
  const plain = quantizedEngine();
  plain.cmdline = "llama-server -m D:/models/q3.gguf -c 80000 -ngl 99 --port 11435";
  plain.launch = parseLlamaArgs(plain.cmdline);
  const { base, services } = await startApp(t, { discoverEngines: async () => [plain] });
  services.probeGpus = async () => [{ name: "AMD Radeon RX 7900 XT", vendor: "amd", totalBytes: Math.round(19.98 * 1024 ** 3) }];

  const { engines } = await (await fetch(`${base}/api/local/discover`)).json();
  const engine = engines.find((found) => found.port === 11435);
  assert.equal(engine.vram.kvType, "f16");
  assert.equal(Math.round(engine.vram.kv / (1024 ** 3) * 100) / 100, 4.88);
  assert.equal(Math.round(engine.vram.headroom / (1024 ** 3) * 100) / 100, 0.52);
  assert.ok(!engine.warnings.some((warning) => warning.code === "kv_quant_unsupported"));
});

const CARD = {
  amd: { name: "AMD Radeon RX 7900 XT", vendor: "amd", totalBytes: Math.round(19.98 * 1024 ** 3) },
  nvidia: { name: "NVIDIA GeForce RTX 4090", vendor: "nvidia", totalBytes: 24 * 1024 ** 3, usedBytes: 0 },
};

function shiftingEngine() {
  const engine = quantizedEngine();
  engine.cmdline = "llama-server -m D:/models/q3.gguf -c 80000 -ctk q8_0 -ctv q8_0"
    + " -fa auto --context-shift -ngl 99 --port 11435";
  engine.launch = parseLlamaArgs(engine.cmdline);
  return engine;
}

test("an NVIDIA card keeps the settings the AMD one refuses", async (t) => {
  // The refusals are the AMD stack's, not the product's opinion. Written the
  // other way round they would have taken a working quantized cache away from
  // every card, which is the failure mode of a rule phrased as policy instead
  // of as a property of the hardware.
  const { base, services } = await startApp(t, { discoverEngines: async () => [shiftingEngine()] });
  services.probeGpus = async () => [CARD.nvidia];

  const { engines } = await (await fetch(`${base}/api/local/discover`)).json();
  const engine = engines.find((found) => found.port === 11435);

  assert.equal(engine.vram.kvType, "q8_0", "the quantized cache is budgeted, not refused");
  const codes = engine.warnings.map((warning) => warning.code);
  assert.ok(!codes.includes("kv_quant_unsupported"), "nothing is refused on this card");
  assert.ok(!codes.includes("context_shift_refused"));
  // But the architecture warning is not a vendor warning and still applies:
  // this model keeps recurrent state on three layers in four, so context
  // shifting has nothing to slide - reproduced once with -ngl 0, where no GPU
  // is involved at all. Guarding it as an AMD quirk would have missed it here.
  assert.ok(codes.includes("context_shift_ineffective"), `warnings were ${JSON.stringify(codes)}`);
  assert.ok(engine.launchBase.includes("--context-shift"), "the user's context shifting stands");
  assert.ok(engine.launchBase.includes("-fa"));
  // The restart honours the request rather than overriding it.
  const preview = engine.launchBase.join(" ");
  assert.ok(!preview.includes("--no-context-shift"));
});

test("the AMD card refuses both, in the preview as well as the restart", async (t) => {
  const { base, services } = await startApp(t, { discoverEngines: async () => [shiftingEngine()] });
  services.probeGpus = async () => [CARD.amd];

  const { engines } = await (await fetch(`${base}/api/local/discover`)).json();
  const engine = engines.find((found) => found.port === 11435);

  // The ledger still reports what is running - refusing it is not the same as
  // pretending it is not there.
  assert.equal(engine.vram.kvType, "q8_0");
  const codes = engine.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("kv_quant_unsupported"));
  assert.ok(codes.includes("context_shift_refused"), `warnings were ${JSON.stringify(codes)}`);
  assert.ok(!codes.includes("context_shift_ineffective"), "one reason, and it is the one acted on");

  // And the line the drawer shows is the line a restart produces: neither
  // setting is in it, and everything else is.
  assert.ok(!engine.launchBase.includes("-ctk"));
  assert.ok(!engine.launchBase.includes("--context-shift"));
  assert.ok(engine.launchBase.includes("-fa") && engine.launchBase.includes("-ngl"));
});

// Stopping an engine means the process is gone, not that it stopped answering.
//
// discoverLocalEngines drops a port whose probe fails, and llama-server stops
// answering early in its shutdown while it is still unloading the model. Taking
// the scan alone as proof let the replacement start while twelve gigabytes of
// weights were still resident - on the card this feature exists for, 25 GiB
// asked of a 19 GiB card.
// Windows has no window for this to happen in: process.kill terminates there,
// so a signalled process is gone by the next line and there is nothing to
// observe. The gap is a POSIX one - SIGTERM asks, and llama.cpp answers after
// it has finished unloading - so this runs where the defect can exist.
test("an engine that has stopped answering but is still running is not treated as stopped", { skip: process.platform === "win32" && "process.kill terminates on Windows, so the gap this guards cannot occur" }, async (t) => {
  // The child says when it is ready, and this waits for that. spawn returns
  // before node has booted, so a SIGTERM sent in that window takes the default
  // action and kills it - the process would then be genuinely gone, the route
  // would be right to proceed, and the test would be asserting nothing. That
  // race is invisible on the platform where this test is skipped.
  const live = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setTimeout(() => {}, 60000)"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  t.after(() => { try { live.kill("SIGKILL"); } catch { /* already gone */ } });
  await new Promise((resolve, reject) => {
    live.stdout.once("data", resolve);
    live.once("exit", () => reject(new Error("the stand-in engine exited before it was ready")));
  });
  const cmdline = `${process.execPath} -m D:/models/q3.gguf -c 80000 --port 11435`;
  let scans = 0;
  const { base, services } = await startApp(t, {
    // Answers once, then goes quiet - which is what a shutting-down engine
    // looks like to a probe, and what the old check read as "gone".
    discoverEngines: async () => {
      scans += 1;
      return scans > 1 ? [] : [{
        engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435,
        models: ["a"], connectable: true, pid: live.pid,
        binary: process.execPath, cmdline,
      }];
    },
  });
  services.stopTimeoutMs = 700;
  const response = await fetch(`${base}/api/local/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", contextTokens: 48000, sessions: 1, kvType: "f16" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 502, JSON.stringify(payload));
  assert.equal(payload.error.type, "stop_timeout");
});

// The argv is replayed exactly; the directory it was resolved against is not
// ours to read. Restarting from the gateway's own directory would look like a
// restart and be a missing model file, reported only in a log.
test("a relative model path is refused rather than restarted from the wrong directory", async (t) => {
  const untouched = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => { try { untouched.kill("SIGKILL"); } catch { /* already gone */ } });
  const cmdline = `${process.execPath} -m models/q3.gguf -c 80000 --port 11435`;
  const { base } = await startApp(t, {
    discoverEngines: async () => [{
      engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435,
      models: ["a"], connectable: true, pid: untouched.pid,
      binary: process.execPath, cmdline, launch: parseLlamaArgs(cmdline),
    }],
  });
  const response = await fetch(`${base}/api/local/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine: "llamacpp", contextTokens: 48000, sessions: 1, kvType: "f16" }),
  });
  const payload = await response.json();
  assert.equal(response.status, 409, JSON.stringify(payload));
  assert.equal(payload.error.type, "relative_model_path");
  assert.match(payload.error.message, /models\/q3\.gguf/);
  // And the engine it declined to restart is still running.
  assert.equal(untouched.exitCode, null, "nothing was stopped on the way to refusing");
});

// What Codex is told about a local model has to follow what the engine serves.
//
// The published window comes from meta.n_ctx, read once when the engine was
// connected. Restart it smaller - through the drawer or by hand - and the
// figure stayed where it was, so Codex kept packing against the old number and
// auto-compacted near 80% of it. An engine moved from 80K to 32K was being
// asked to hold 64,000 tokens in a window of 32,000, and it failed mid-turn.
test("a window the engine no longer serves is republished, and asks for a restart", async (t) => {
  const cmdline = "llama-server -m D:/models/q3.gguf -c 32000 --port 11435";
  const { base, services } = await startApp(t, {
    discoverEngines: async () => [{
      engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", port: 11435,
      models: ["a"], connectable: true, pid: 4242,
      binary: "C:/llama/llama-server.exe", cmdline, launch: parseLlamaArgs(cmdline),
    }],
  });
  // Connected when it was serving 80K, and published as such.
  writeLocalEngineSnapshot(services.localEnginesFile, "llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "a", label: "a", contextWindow: 80000 }],
  });
  await services.configSwitcher.acknowledgeRestart();

  const response = await fetch(`${base}/api/local/discover`);
  assert.equal(response.status, 200);

  const snapshot = readLocalEnginesSnapshot(services.localEnginesFile);
  assert.equal(snapshot.llamacpp.models[0].contextWindow, 32000, "the published window follows the running one");
  const state = await services.configSwitcher.status();
  assert.equal(state.restartRequired, true, "Codex reads the catalog at startup, so the change lands on its restart");

  // And a scan that changes nothing does not keep asking for restarts.
  await services.configSwitcher.acknowledgeRestart();
  await fetch(`${base}/api/local/discover`);
  const settled = await services.configSwitcher.status();
  assert.equal(settled.restartRequired, false, "a steady engine is not a reason to restart Codex");
});

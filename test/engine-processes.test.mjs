import test from "node:test";
import assert from "node:assert/strict";
import {
  listEngineListeners,
  looksLikeEngineProcess,
  parseLlamaArgs,
  parsePosixListeners,
  parsePosixProcesses,
  parseWindowsInspection,
  tokenizeCommandLine,
  launchSpecFrom,
  applyLaunchOverrides,
  managedLlamaLaunchArgs,
} from "../src/engine-processes.mjs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { discoverLocalEngines } from "../src/local-engines.mjs";

// Verbatim from this machine on 2026-08-19: a llama-server the fixed candidate
// list could never have found, because it is on 11435 and the list only knows
// 8080. Everything the adoption spec needs is in this one line.
const REAL_CMDLINE = '"D:\\llama-cpp-vulkan\\llama-server.exe" -m D:\\models\\Qwen3.8-27B-Q3_K_M.gguf'
  + " -a qwen3.8:27b -fa auto -c 81920 --context-shift --reasoning-budget 4096 -ngl 99"
  + " --host 127.0.0.1 --port 11435 --jinja --parallel 1 -t 16 -mg 1 -sm none";

function windowsPayload({ port = 11435, pid = 36108 } = {}) {
  return JSON.stringify({
    listeners: [
      { LocalAddress: "127.0.0.1", LocalPort: port, OwningProcess: pid },
      { LocalAddress: "0.0.0.0", LocalPort: 445, OwningProcess: 4 },
    ],
    processes: [
      { ProcessId: pid, Name: "llama-server.exe", ExecutablePath: "D:\\llama-cpp-vulkan\\llama-server.exe", CommandLine: REAL_CMDLINE },
      { ProcessId: 4, Name: "System", ExecutablePath: "", CommandLine: "" },
    ],
  });
}

test("the Windows inspector finds an engine on a port no fixed list contains", async () => {
  const listeners = await listEngineListeners({
    platform: "win32",
    runCommand: async () => windowsPayload(),
  });
  assert.equal(listeners.length, 1, "the System port is not an engine and is dropped");
  assert.equal(listeners[0].port, 11435);
  assert.equal(listeners[0].pid, 36108);
  assert.equal(listeners[0].binary, "D:\\llama-cpp-vulkan\\llama-server.exe");
});

test("PowerShell collapsing a one-element array is still read as a list", () => {
  // ConvertTo-Json emits the object itself, not a one-element array. Reading it
  // as an array is how this returns nothing at all on a machine running exactly
  // one engine - the case that matters most.
  const single = JSON.stringify({
    listeners: { LocalAddress: "127.0.0.1", LocalPort: 11435, OwningProcess: 7 },
    processes: { ProcessId: 7, Name: "llama-server.exe", ExecutablePath: "C:\\llama\\llama-server.exe", CommandLine: "llama-server --port 11435" },
  });
  const { listeners, processes } = parseWindowsInspection(single);
  assert.equal(listeners.length, 1);
  assert.equal(processes.get(7).name, "llama-server");
});

test("an inspector that fails degrades to nothing instead of throwing", async () => {
  for (const runCommand of [async () => "", async () => "not json", async () => { throw new Error("denied"); }]) {
    assert.deepEqual(await listEngineListeners({ platform: "win32", runCommand }), []);
  }
});

test("the posix parsers read lsof and ps output", () => {
  const listeners = parsePosixListeners(["p4123", "n127.0.0.1:11435", "n[::1]:8080", "p9", "n*:22"].join("\n"));
  assert.deepEqual(listeners.map((l) => [l.pid, l.port]), [[4123, 11435], [4123, 8080], [9, 22]]);
  const processes = parsePosixProcesses("  4123 llama-server /usr/local/bin/llama-server -m model.gguf --port 11435\n   9 sshd /usr/sbin/sshd");
  assert.equal(processes.get(4123).name, "llama-server");
  assert.match(processes.get(4123).cmdline, /--port 11435/);
});

test("only plausible engine processes are probed", () => {
  assert.equal(looksLikeEngineProcess({ name: "llama-server" }), true);
  assert.equal(looksLikeEngineProcess({ name: "python", cmdline: "python -m vllm.entrypoints.openai.api_server" }), true);
  // The process is inside WSL or a container; the relay that publishes its port
  // is what we can actually see.
  assert.equal(looksLikeEngineProcess({ name: "wslrelay" }), true);
  assert.equal(looksLikeEngineProcess({ name: "svchost" }), false);
  assert.equal(looksLikeEngineProcess({ name: "lsass" }), false);
});

test("a llama.cpp command line parses into an adoption spec", () => {
  const spec = parseLlamaArgs(REAL_CMDLINE);
  assert.equal(spec.model, "D:\\models\\Qwen3.8-27B-Q3_K_M.gguf");
  assert.equal(spec.alias, "qwen3.8:27b");
  assert.equal(spec.ctxSize, 81920);
  assert.equal(spec.gpuLayers, 99);
  assert.equal(spec.parallel, 1, "this is why /props reports total_slots 1");
  assert.equal(spec.port, 11435);
  assert.equal(spec.threads, 16);
  assert.equal(spec.splitMode, "none");
  assert.equal(spec.contextShift, true);
  assert.equal(spec.noKvOffload, undefined, "absent switches are absent, not false-y guesses");
});

test("a quoted path with a space survives tokenizing", () => {
  const spec = parseLlamaArgs('"C:\\Program Files\\llama\\llama-server.exe" -m "D:\\my models\\q4.gguf" -c 4096');
  assert.equal(spec.model, "D:\\my models\\q4.gguf");
  assert.equal(spec.ctxSize, 4096);
  assert.equal(tokenizeCommandLine('a "b c" d').length, 3);
});

test("a flag with no value does not swallow the next flag", () => {
  const spec = parseLlamaArgs("llama-server -m --jinja -c 2048");
  assert.equal(spec.model, undefined, "-m had no value, so there is no model");
  assert.equal(spec.ctxSize, 2048);
});

test("discovery probes the port the process table reported, not just the fixed list", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === "http://127.0.0.1:11435/props") return { ok: true, json: async () => ({ slots_idle: 1 }) };
    if (url === "http://127.0.0.1:11435/v1/models") return { ok: true, json: async () => ({ data: [{ id: "qwen3.8:27b" }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const [found] = await discoverLocalEngines({
    fetchImpl,
    timeoutMs: 50,
    listeners: [{ port: 11435, pid: 36108, name: "llama-server", binary: "D:\\llama-cpp-vulkan\\llama-server.exe", cmdline: REAL_CMDLINE }],
  });
  assert.equal(found.engine, "llamacpp");
  assert.equal(found.baseUrl, "http://127.0.0.1:11435");
  assert.equal(found.pid, 36108);
  assert.equal(found.binary, "D:\\llama-cpp-vulkan\\llama-server.exe");
  assert.equal(found.launch.ctxSize, 81920, "the running context size, read rather than asked for");
  assert.ok(seen.includes("http://127.0.0.1:8080/props"), "the fixed candidates are still probed");
});

test("an unattributed port is still discovered, just without a spec", async () => {
  // The WSL / container case: the port is published on this machine but the
  // process behind it is not ours to see.
  const fetchImpl = async (url) => {
    if (url === "http://127.0.0.1:9999/props") return { ok: true, json: async () => ({ slots_idle: 1 }) };
    if (url === "http://127.0.0.1:9999/v1/models") return { ok: true, json: async () => ({ data: [{ id: "m" }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const [found] = await discoverLocalEngines({
    fetchImpl,
    timeoutMs: 50,
    listeners: [{ port: 9999 }],
  });
  assert.equal(found.engine, "llamacpp");
  assert.equal(found.pid, undefined);
  assert.equal(found.launch, undefined, "no command line means no invented spec");
});

// "Start it again" is only honest if the launch is the one that actually ran.
// A llama-server takes a dozen arguments - the model path, the context size,
// how many layers go to the GPU, which device - and anything composed here
// would be a guess wearing the clothes of a memory.
test("a launch spec is the process's own argv, not a reconstruction", () => {
  const cmdline = String.raw`"D:\llama\llama-server.exe" -m D:\models\Qwen3-27B-Q3_K_M.gguf -a qwen3:27b -fa auto -c 81920 --context-shift -ngl 99 --host 127.0.0.1 --port 11435 --jinja -t 16 -mg 1 -sm none`;
  const spec = launchSpecFrom({ binary: String.raw`D:\llama\llama-server.exe`, cmdline });

  assert.equal(spec.binary, String.raw`D:\llama\llama-server.exe`);
  // argv is a list, so the relaunch never goes through a shell and nothing in a
  // model path can escape into one.
  assert.ok(Array.isArray(spec.args));
  assert.equal(spec.args[0], "-m");
  assert.equal(spec.args[1], String.raw`D:\models\Qwen3-27B-Q3_K_M.gguf`);
  assert.deepEqual(spec.args.slice(-6), ["-t", "16", "-mg", "1", "-sm", "none"],
    "the tail is carried verbatim, device flags included");
  assert.equal(spec.args.includes("81920"), true, "the context size is carried, not re-derived");
  assert.equal(spec.args.includes("99"), true, "so is the GPU layer count");
  // argv[0] is the binary and is not repeated in the argument list.
  assert.equal(spec.args.includes(String.raw`D:\llama\llama-server.exe`), false);
});

test("a port we could not attribute remembers no launch", () => {
  // The fixed candidate list finds a port without a process behind it - inside
  // WSL, in a container, or under another user. Offering to start that would be
  // offering to start something we have never seen.
  assert.equal(launchSpecFrom({ port: 8080 }), null);
  assert.equal(launchSpecFrom({ binary: "llama-server", cmdline: "" }), null);
  assert.equal(launchSpecFrom(null), null);
  assert.equal(launchSpecFrom({ cmdline: "llama-server --port 8080" }), null, "a binary is required");
});

test("the scan is where the model file gets read, and it is read once", async () => {
  // Reading a 12 GiB file on every render would be absurd, so discovery reads
  // it and caches by path. By the time a row turns blue the ledger already has
  // its numbers, and opening the drawer reads nothing.
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-facts-"));
  const cache = path.join(dir, "model-facts.json");
  // A real file, because staleness is decided by its size and mtime - a fixture
  // that disagrees with the disk would look stale on every read.
  const model = path.join(dir, "model.gguf");
  writeFileSync(model, "not really a model");
  const stat = statSync(model);
  let reads = 0;
  const read = (file) => {
    reads += 1;
    // weightBytes is part of what a current record carries: a cached record
    // without it was written by a reader that could not see the tensor ledger,
    // and is re-read rather than trusted. A stub that omits it would look stale
    // on every scan and this test would be measuring nothing.
    return {
      path: file, fileBytes: stat.size, weightBytes: stat.size, ignoredBytes: 0,
      mtimeMs: Math.round(stat.mtimeMs), modelName: "m", modelSlug: "m", arch: "qwen35", layers: 64,
      attentionLayers: 16, kvBytesPerToken: 65536,
    };
  };
  const fetchImpl = async (url) => {
    if (url === "http://127.0.0.1:11435/props") return { ok: true, json: async () => ({ slots_idle: 1 }) };
    if (url === "http://127.0.0.1:11435/v1/models") return { ok: true, json: async () => ({ data: [{ id: "m" }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const cmdline = `"C:\llama\llama-server.exe" -m ${model} -c 81920 --port 11435`;
  const options = {
    fetchImpl,
    timeoutMs: 50,
    listeners: [{ port: 11435, pid: 1, name: "llama-server", binary: "C:\llama\llama-server.exe", cmdline }],
    factsOptions: { file: cache, read },
  };

  const [first] = await discoverLocalEngines(options);
  assert.equal(first.modelFacts.kvBytesPerToken, 65536, "the ledger's input rides along with the scan result");
  assert.equal(reads, 1);

  const [second] = await discoverLocalEngines(options);
  assert.equal(second.modelFacts.kvBytesPerToken, 65536);
  assert.equal(reads, 1, "a second scan uses the cache rather than the file");

  // Re-quantize under the same path and the cache has to notice.
  writeFileSync(model, "a different model entirely, of another size");
  await discoverLocalEngines(options);
  assert.equal(reads, 2, "a changed file is read again");
  rmSync(dir, { recursive: true, force: true });
});

test("a cached record without a model name is re-read rather than trusted", async () => {
  // Records written before the model-name pass carry weightBytes but no
  // modelName. The file is unchanged, but what we know how to read out of it has
  // grown, so the name must be recovered on the next scan - otherwise an
  // already-cached file keeps publishing its raw path forever.
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-facts-name-"));
  const cache = path.join(dir, "model-facts.json");
  const model = path.join(dir, "model.gguf");
  writeFileSync(model, "not really a model");
  const stat = statSync(model);
  const read = (file) => ({
    path: file, fileBytes: stat.size, weightBytes: stat.size, ignoredBytes: 0,
    mtimeMs: Math.round(stat.mtimeMs), modelName: "m", modelSlug: "m", arch: "qwen35",
    layers: 64, attentionLayers: 16, kvBytesPerToken: 65536,
  });
  // Seed the cache with the pre-name shape (no modelName).
  writeFileSync(cache, JSON.stringify({
    [model]: {
      path: model, fileBytes: stat.size, weightBytes: stat.size, ignoredBytes: 0,
      mtimeMs: Math.round(stat.mtimeMs), arch: "qwen35", layers: 64,
      attentionLayers: 16, kvBytesPerToken: 65536,
    },
  }));
  const fetchImpl = async (url) => {
    if (url === "http://127.0.0.1:11435/props") return { ok: true, json: async () => ({ slots_idle: 1 }) };
    if (url === "http://127.0.0.1:11435/v1/models") return { ok: true, json: async () => ({ data: [{ id: "m" }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const cmdline = `"C:\llama\llama-server.exe" -m ${model} -c 81920 --port 11435`;
  const options = {
    fetchImpl,
    timeoutMs: 50,
    listeners: [{ port: 11435, pid: 1, name: "llama-server", binary: "C:\llama\llama-server.exe", cmdline }],
    factsOptions: { file: cache, read },
  };

  const [found] = await discoverLocalEngines(options);
  assert.equal(found.modelFacts.modelName, "m", "the stale record is refreshed with the name");
  const persisted = JSON.parse(readFileSync(cache, "utf8"));
  assert.equal(persisted[model].modelName, "m", "the refreshed cache carries the name");
  rmSync(dir, { recursive: true, force: true });
});

test("an unreadable model costs that row its ledger, not the whole scan", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-facts-bad-"));
  const fetchImpl = async (url) => {
    if (url === "http://127.0.0.1:11435/props") return { ok: true, json: async () => ({ slots_idle: 1 }) };
    if (url === "http://127.0.0.1:11435/v1/models") return { ok: true, json: async () => ({ data: [{ id: "m" }] }) };
    return { ok: false, json: async () => ({}) };
  };
  const [found] = await discoverLocalEngines({
    fetchImpl,
    timeoutMs: 50,
    listeners: [{ port: 11435, pid: 1, name: "llama-server", binary: "b", cmdline: REAL_CMDLINE }],
    factsOptions: { file: path.join(dir, "c.json"), read: () => { throw new Error("gone"); } },
  });
  assert.equal(found.engine, "llamacpp", "the engine is still discovered");
  assert.equal(found.launch.ctxSize, 81920, "and still carries its launch spec");
  assert.equal(found.modelFacts, undefined, "just without a ledger");
  rmSync(dir, { recursive: true, force: true });
});

test("applying overrides edits the argv instead of composing a new one", () => {
  // A composed command line would silently drop whatever this user needed and
  // we did not think of. Only the tuned flags are replaced; the rest survives.
  const args = tokenizeCommandLine(REAL_CMDLINE).slice(1);
  const next = applyLaunchOverrides(args, { ctxSize: 49152, parallel: 1, kvUnified: true });
  const line = next.join(" ");
  assert.match(line, /-c 49152/);
  assert.doesNotMatch(line, /81920/, "the old context is gone, not duplicated");
  assert.equal(next.filter((token) => token === "-c").length, 1);
  assert.equal(next.filter((token) => token === "--parallel").length, 1);
  assert.match(line, /--kv-unified/);
  // Everything the user had that we never asked about is still there.
  for (const kept of ["-fa", "auto", "--context-shift", "-ngl", "99", "-mg", "1", "-sm", "none", "--jinja", "-t", "16"]) {
    assert.ok(next.includes(kept), `${kept} survived`);
  }
  // String.raw, because a Windows path in an ordinary literal quietly loses its
  // separators: "D:\models\..." reads as "D:modelsQwen...".
  assert.ok(next.includes(String.raw`D:\models\Qwen3.8-27B-Q3_K_M.gguf`), "and so did the model");
});

test("KV precision reaches both halves of the cache or neither", () => {
  const args = tokenizeCommandLine(REAL_CMDLINE).slice(1);
  const quantized = applyLaunchOverrides(args, { cacheTypeK: "q8_0", cacheTypeV: "q8_0" });
  assert.ok(quantized.includes("-ctk") && quantized.includes("-ctv"));
  // f16 is the default, so it is expressed by saying nothing rather than by
  // writing a flag the engine already assumes.
  const plain = applyLaunchOverrides(args, { ctxSize: 32768 });
  assert.ok(!plain.includes("-ctk"), "no cache flag when the default is wanted");
});

test("an override never swallows the flag that follows a valueless one", () => {
  const next = applyLaunchOverrides(["-c", "--jinja", "-ngl", "99"], { ctxSize: 8192 });
  assert.ok(next.includes("--jinja"), "the switch after a valueless -c is not eaten");
  assert.ok(next.includes("-ngl") && next.includes("99"));
  assert.equal(next.filter((t) => t === "-c").length, 1);
});

test("an existing unified switch is replaced, not doubled", () => {
  const next = applyLaunchOverrides(["--kv-unified", "-ngl", "99"], { kvUnified: true });
  assert.equal(next.filter((t) => t === "--kv-unified").length, 1);
  // And the opposite switch cannot survive alongside it.
  const flipped = applyLaunchOverrides(["--no-kv-unified", "-ngl", "99"], { kvUnified: true });
  assert.ok(!flipped.includes("--no-kv-unified"));
});

test("the KV precision an engine is running is readable, not just writable", () => {
  // The two flags were in the override table but not in the parse table, so
  // `launch.cacheTypeK` was permanently undefined: every ledger budgeted f16
  // for a cache that might be half or a quarter of that, and the warning that
  // fires on quantized KV could never see a reason to.
  const spec = parseLlamaArgs("llama-server -m m.gguf -c 80000 -ctk q8_0 -ctv q8_0 -ngl 99");
  assert.equal(spec.cacheTypeK, "q8_0");
  assert.equal(spec.cacheTypeV, "q8_0");
  assert.equal(parseLlamaArgs("llama-server -m m.gguf --cache-type-k q4_0").cacheTypeK, "q4_0");
  assert.equal(parseLlamaArgs("llama-server -m m.gguf -c 8192").cacheTypeK, undefined, "absent stays absent");
});

test("choosing the default precision takes the flag off, rather than leaving it", () => {
  // f16 is written by saying nothing, which is why this is not symmetric with
  // setting q8_0: the caller has to be able to say "I own this and the answer
  // is the default". null says that; undefined says "not mine".
  const running = ["-m", "m.gguf", "-ctk", "q8_0", "-ctv", "q8_0", "-c", "80000"];
  const back = applyLaunchOverrides(running, { ctxSize: 48000, cacheTypeK: null, cacheTypeV: null, kvUnified: true });
  assert.ok(!back.includes("-ctk"), "the engine would have come back on q8_0 behind an f16 preview");
  assert.ok(!back.includes("-ctv"));
  assert.ok(back.includes("48000"));
});

test("a setting the caller does not own is left where the user put it", () => {
  // Moving only the context slider must not rewrite unrelated choices. The
  // switch used to be stripped unconditionally, so a deliberate
  // --no-kv-unified vanished on a restart that never mentioned it.
  const kept = applyLaunchOverrides(["-m", "m.gguf", "--no-kv-unified", "-ctk", "q8_0", "-c", "80000"], { ctxSize: 48000 });
  assert.ok(kept.includes("--no-kv-unified"), "an unowned switch survives");
  assert.ok(kept.includes("-ctk"), "an unowned flag survives with its value");
  assert.deepEqual(kept.filter((t) => t === "-c"), ["-c"]);
});

test("the unified switch can be turned off as well as on", () => {
  const off = applyLaunchOverrides(["--kv-unified", "-ngl", "99"], { kvUnified: false });
  assert.ok(off.includes("--no-kv-unified"));
  assert.ok(!off.includes("--kv-unified"));
});

test("managed equal lanes write total context and disable unified KV", () => {
  const running = [
    "-m", "D:/models/qwen.gguf", "-c", "262144", "--parallel", "1",
    "-ngl", "0", "-sm", "none", "-mg", "1", "-dev", "Vulkan1",
    "--kv-unified", "--cache-reuse", "64", "--jinja",
  ];
  const next = managedLlamaLaunchArgs(running, {
    profile: { laneCount: 2, laneContextTokens: 200_000, deviceIndices: [0, 1], tensorSplit: [0.5, 0.5] },
    slotSavePath: "D:/ModelDock/KV",
  });
  assert.equal(next[next.indexOf("-c") + 1], "400000");
  assert.equal(next[next.indexOf("--parallel") + 1], "2");
  assert.equal(next[next.indexOf("-ngl") + 1], "999");
  assert.equal(next[next.indexOf("-sm") + 1], "tensor");
  assert.equal(next[next.indexOf("-ts") + 1], "0.50000000,0.50000000");
  assert.ok(!next.includes("Vulkan1"), "a stale user-owned device restriction cannot survive managed CUDA placement");
  assert.equal(next.filter((value) => value === "-sm").length, 1);
  assert.ok(next.includes("--no-kv-unified"));
  assert.ok(!next.includes("--kv-unified"));
  assert.deepEqual(next.filter((value) => value === "--cache-reuse"), ["--cache-reuse"]);
  assert.equal(next[next.indexOf("--cache-reuse") + 1], "256");
  assert.equal(next[next.indexOf("--slot-save-path") + 1], "D:/ModelDock/KV");
  assert.ok(next.includes("--jinja"));
});

test("managed setup replaces the model and owns the optional vision projector", () => {
  const running = [
    "-m", "D:/models/text.gguf",
    "--mmproj", "D:/models/old-projector.gguf",
    "-c", "262144", "--parallel", "1",
  ];
  const next = managedLlamaLaunchArgs(running, {
    profile: { laneCount: 1, laneContextTokens: 262_144, deviceIndices: [1], tensorSplit: [1] },
    slotSavePath: "D:/ModelDock/KV",
    modelPath: "D:/models/vision-base.gguf",
    visionProjectorPath: "D:/models/vision-projector.gguf",
  });
  assert.deepEqual(next.filter((value) => value === "-m"), ["-m"]);
  assert.equal(next[next.indexOf("-m") + 1], "D:/models/vision-base.gguf");
  assert.deepEqual(next.filter((value) => value === "--mmproj"), ["--mmproj"]);
  assert.equal(next[next.indexOf("--mmproj") + 1], "D:/models/vision-projector.gguf");

  const textOnly = managedLlamaLaunchArgs(next, {
    profile: { laneCount: 1, laneContextTokens: 262_144, deviceIndices: [1], tensorSplit: [1] },
    slotSavePath: "D:/ModelDock/KV",
    visionProjectorPath: null,
  });
  assert.ok(!textOnly.includes("--mmproj"), "clearing local vision removes the inherited projector flag");
  assert.equal(parseLlamaArgs(`llama-server ${next.join(" ")}`).visionProjectorPath, "D:/models/vision-projector.gguf");
});

test("a port held on two addresses is filed under the one this gateway reaches", async () => {
  const rows = (order) => JSON.stringify({
    listeners: order,
    processes: [
      { ProcessId: 111, Name: "llama-server.exe", ExecutablePath: "C:/a/llama-server.exe", CommandLine: "llama-server -m a.gguf --host 127.0.0.1 --port 8080" },
      { ProcessId: 222, Name: "llama-server.exe", ExecutablePath: "D:/b/llama-server.exe", CommandLine: "llama-server -m b.gguf --host 192.168.1.5 --port 8080" },
    ],
  });
  const loopback = { LocalAddress: "127.0.0.1", LocalPort: 8080, OwningProcess: 111 };
  const lan = { LocalAddress: "192.168.1.5", LocalPort: 8080, OwningProcess: 222 };
  for (const order of [[loopback, lan], [lan, loopback]]) {
    const [found] = await listEngineListeners({ platform: "win32", runCommand: async () => rows(order) });
    assert.equal(found.pid, 111, "the loopback row owns the port whichever way they arrive");
  }
});

// Reading another user's command line needs elevation, and a relay hides the
// process outright. Dropping the port makes a moved engine invisible to the
// half of discovery written to find moved engines.
test("a port whose process cannot be read is still offered, without a spec", async () => {
  const stdout = JSON.stringify({
    listeners: [
      { LocalAddress: "127.0.0.1", LocalPort: 11435, OwningProcess: 29704 },
      { LocalAddress: "0.0.0.0", LocalPort: 445, OwningProcess: 4 },
    ],
    // 29704 is missing entirely; 4 is readable and is not an engine.
    processes: [{ ProcessId: 4, Name: "System", ExecutablePath: "", CommandLine: "" }],
  });
  const found = await listEngineListeners({ platform: "win32", runCommand: async () => stdout });
  assert.deepEqual(found.map((f) => f.port), [11435], "the readable non-engine is still dropped");
  assert.equal(found[0].cmdline, "", "no spec is invented for a process we cannot see");
  assert.equal(launchSpecFrom(found[0]), null, "and no launch is remembered from one");
});

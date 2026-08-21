import test from "node:test";
import assert from "node:assert/strict";
import {
  listEngineListeners,
  looksLikeEngineProcess,
  parseLlamaArgs,
  launchBaseArgs,
  drawerLaunchTail,
  drawerLaunchArgs,
  parsePosixListeners,
  parsePosixProcesses,
  parseWindowsInspection,
  tokenizeCommandLine,
  launchSpecFrom,
  applyLaunchOverrides,
} from "../src/engine-processes.mjs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    return { path: file, fileBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs), arch: "qwen35", layers: 64, attentionLayers: 16, kvBytesPerToken: 65536 };
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

// --- the drawer's preview is the line Apply runs ---------------------------

// public/app.js is a browser script, so the page cannot import the module the
// server builds launch arguments with. It carries its own copy of the tail
// half instead, and this reads that copy out of the file and runs it. Without
// this the two drift silently, which is exactly how the preview came to be
// missing eight flags in the first place: nothing compared them.
function pageFunction(name) {
  const source = readFileSync(path.join(root, "public/app.js"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is gone from public/app.js`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${name} in public/app.js is not a top-level function any more`);
  return source.slice(start, end + 2);
}

const REAL_ARGV = tokenizeCommandLine(REAL_CMDLINE).slice(1);

test("the page's copy of the launch tail is the server's copy", () => {
  const { tuneTail } = new Function(`${pageFunction("tuneTail")}\nreturn { tuneTail };`)();
  for (const contextTokens of [16000, 48000, 262144]) {
    for (const sessions of [1, 4]) {
      for (const kvType of ["f16", "q8_0", "q4_0"]) {
        const state = { context: contextTokens, sessions, kv: kvType };
        assert.deepEqual(
          tuneTail(state),
          drawerLaunchTail({ contextTokens, sessions, kvType }),
          `public/app.js tuneTail drifted at ${contextTokens}/${sessions}/${kvType} - `
          + "a setting was added to one half of the drawer and not the other",
        );
      }
    }
  }
});

test("base plus tail is exactly what Apply spawns", () => {
  // The split only holds if stripping and rewriting are the same operation
  // seen from two sides. If they ever are not, the preview is a different
  // command from the one the button runs - which is the whole defect.
  for (const choices of [
    { contextTokens: 48000, sessions: 1, kvType: "f16" },
    { contextTokens: 16000, sessions: 4, kvType: "q8_0" },
    { contextTokens: 262144, sessions: 2, kvType: "q4_0" },
  ]) {
    assert.deepEqual(
      [...launchBaseArgs(REAL_ARGV), ...drawerLaunchTail(choices)],
      drawerLaunchArgs(REAL_ARGV, choices),
      `preview and spawn disagree at ${JSON.stringify(choices)}`,
    );
  }
});

test("the preview keeps every flag the restart keeps", () => {
  // The eight this engine carries that the old composed line dropped. -a is
  // the one that bites hardest: it is the model id the engine serves under, so
  // pasting a line without it brings the engine back under a different name
  // and ModelDock's own connection no longer matches.
  const base = launchBaseArgs(REAL_ARGV);
  for (const flag of ["-a", "-fa", "--context-shift", "--reasoning-budget", "-ngl", "--jinja", "-t", "-mg", "-sm"]) {
    assert.ok(base.includes(flag), `${flag} is not in the line the drawer shows`);
  }
  // And none of the five the drawer decides, because it appends those itself.
  for (const flag of ["-c", "--ctx-size", "-np", "--parallel", "-ctk", "-ctv", "--kv-unified", "--no-kv-unified"]) {
    assert.ok(!base.includes(flag), `${flag} would appear twice`);
  }
});

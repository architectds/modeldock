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
} from "../src/engine-processes.mjs";
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

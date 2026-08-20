// Where a local inference engine actually listens, asked of the operating
// system instead of guessed from a list of default ports.
//
// The fixed candidate list this supplements can only find an engine that was
// never moved. A llama-server started with `--port 11435` was invisible to it,
// and that is the ordinary case the moment a machine runs two of anything.
// The process table has no such blind spot, and it carries more than the port:
// the binary (including which backend build - vulkan, cuda, hip) and the full
// command line, which is also exactly what adopting a running engine needs.
//
// Every function here degrades to an empty result instead of throwing.
// Discovery must keep working through the fixed candidates on a machine where
// the inspector is missing, slow, or not permitted - reading another user's
// command line needs elevation on every platform, and an engine the user did
// not start is not our business anyway.
import { execFile } from "node:child_process";

// Process names worth probing. Matched case-insensitively against both the
// process name and the binary path, so `llama-server.exe` and a renamed copy
// under `D:\llama-cpp-vulkan\` both hit.
//
// python covers vLLM, which is never its own executable. The wsl/docker relay
// names cover an engine running inside a VM or container: the process lives
// where we cannot see it, but the relay that publishes its port to this
// machine is a local process we can.
const ENGINE_HINTS = [
  "llama",
  "vllm",
  "ollama",
  "python",
  "wslrelay",
  "wslhost",
  "vmmem",
  "docker",
];

export function looksLikeEngineProcess({ name = "", binary = "", cmdline = "" } = {}) {
  const haystack = `${name} ${binary} ${cmdline}`.toLowerCase();
  return ENGINE_HINTS.some((hint) => haystack.includes(hint));
}

// One PowerShell round trip for both halves. The join happens in PowerShell so
// the payload stays proportional to the number of listening sockets (tens)
// rather than the number of processes (hundreds).
const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$l = Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess;",
  "$ids = $l | Select-Object -ExpandProperty OwningProcess -Unique;",
  "$p = Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ProcessId } |",
  "  Select-Object ProcessId,Name,ExecutablePath,CommandLine;",
  "ConvertTo-Json -Compress -Depth 3 @{ listeners = @($l); processes = @($p) }",
].join(" ");

// PowerShell collapses a one-element array to the element itself, so every
// list coming back from ConvertTo-Json has to be re-widened before use.
function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

export function parseWindowsInspection(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { listeners: [], processes: new Map() };
  }
  const listeners = asArray(parsed?.listeners)
    .map((row) => ({
      port: Number(row?.LocalPort),
      pid: Number(row?.OwningProcess),
      address: String(row?.LocalAddress || ""),
    }))
    .filter((row) => Number.isInteger(row.port) && row.port > 0);
  const processes = new Map();
  for (const row of asArray(parsed?.processes)) {
    const pid = Number(row?.ProcessId);
    if (!Number.isInteger(pid)) continue;
    processes.set(pid, {
      pid,
      name: String(row?.Name || "").replace(/\.exe$/i, ""),
      binary: String(row?.ExecutablePath || ""),
      cmdline: String(row?.CommandLine || ""),
    });
  }
  return { listeners, processes };
}

// `lsof -nP -iTCP -sTCP:LISTEN -FpnL` emits one field per line, prefixed by a
// tag: p<pid> starts a process block, n<addr:port> is one of its sockets.
export function parsePosixListeners(stdout) {
  const listeners = [];
  let pid = 0;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = Number(value) || 0;
      continue;
    }
    if (tag !== "n") continue;
    // Trailing form is always :port; the address may be IPv6 in brackets.
    const match = /:(\d+)$/.exec(value);
    if (!match) continue;
    listeners.push({ port: Number(match[1]), pid, address: value.slice(0, match.index) });
  }
  return listeners;
}

// `ps -axo pid=,comm=,args=` - comm has no spaces, args is the rest of the line.
export function parsePosixProcesses(stdout) {
  const processes = new Map();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      name: match[2].split("/").pop() || match[2],
      binary: match[2],
      cmdline: match[3] || "",
    });
  }
  return processes;
}

function runCommandDefault(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? "" : String(stdout || ""));
    });
  });
}

// Returns [{ port, pid, name, binary, cmdline }] for every loopback-reachable
// listening socket whose owning process looks like an inference engine.
// A port with no attributable process still comes back (pid 0) when it is
// reachable, because a container or VM relay hides the real process.
export async function listEngineListeners({
  platform = process.platform,
  runCommand = runCommandDefault,
  timeoutMs = 4000,
} = {}) {
  try {
    let listeners = [];
    let processes = new Map();
    if (platform === "win32") {
      const stdout = await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], timeoutMs);
      ({ listeners, processes } = parseWindowsInspection(stdout));
    } else {
      // Unverified on macOS and Linux: the parsers are covered by tests but the
      // commands themselves are not exercised on this machine. A missing lsof
      // or ps yields "", which parses to nothing and falls back to the fixed
      // candidate ports - the behaviour every platform had before.
      const [sockets, procs] = await Promise.all([
        runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpnL"], timeoutMs),
        runCommand("ps", ["-axo", "pid=,comm=,args="], timeoutMs),
      ]);
      listeners = parsePosixListeners(sockets);
      processes = parsePosixProcesses(procs);
    }
    const seen = new Map();
    for (const listener of listeners) {
      const info = processes.get(listener.pid) || { pid: listener.pid, name: "", binary: "", cmdline: "" };
      if (!looksLikeEngineProcess(info)) continue;
      // One row per port: a process may hold the same port on several
      // addresses (IPv4 and IPv6), and that is one engine, not two.
      if (seen.has(listener.port)) continue;
      seen.set(listener.port, { port: listener.port, ...info });
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}

// llama-server's command line is a complete adoption spec. Parsing it is what
// turns "an engine is running on 11435" into "Qwen3.8-27B Q3_K_M, 80K context,
// one slot, vulkan build" without asking the user to retype any of it.
const LLAMA_FLAGS = [
  ["model", ["-m", "--model"]],
  ["alias", ["-a", "--alias"]],
  ["ctxSize", ["-c", "--ctx-size"]],
  ["gpuLayers", ["-ngl", "--n-gpu-layers", "--gpu-layers"]],
  ["parallel", ["-np", "--parallel"]],
  ["threads", ["-t", "--threads"]],
  ["host", ["--host"]],
  ["port", ["--port"]],
  ["mainGpu", ["-mg", "--main-gpu"]],
  ["splitMode", ["-sm", "--split-mode"]],
  ["slotSavePath", ["--slot-save-path"]],
];

// Splits on whitespace but keeps quoted runs together, so a model path with a
// space in it survives as one token.
export function tokenizeCommandLine(cmdline) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(cmdline || "")))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export function parseLlamaArgs(cmdline) {
  const tokens = tokenizeCommandLine(cmdline);
  const spec = {};
  for (let i = 0; i < tokens.length; i += 1) {
    for (const [key, aliases] of LLAMA_FLAGS) {
      if (!aliases.includes(tokens[i])) continue;
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("-")) break;
      spec[key] = /^\d+$/.test(value) ? Number(value) : value;
      break;
    }
  }
  // Presence-only switches worth surfacing: they change what the engine can do,
  // not just how fast it is.
  for (const [key, flag] of [["flashAttention", "-fa"], ["contextShift", "--context-shift"], ["jinja", "--jinja"], ["noKvOffload", "--no-kv-offload"]]) {
    if (tokens.includes(flag)) spec[key] = true;
  }
  return spec;
}

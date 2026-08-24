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
import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

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

// An address this gateway can actually reach a listener on. Loopback and the
// wildcards qualify; a socket bound only to a LAN address does not, and its
// pid does not belong to the port we probe at 127.0.0.1.
function reachableAddress(address) {
  const host = String(address || "").replace(/^\[/, "").replace(/\]$/, "");
  return host === "" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::" || host === "::1";
}

// Returns [{ port, address, pid, name, binary, cmdline }] for every listening
// socket whose owning process looks like an inference engine, plus every socket
// whose process could not be attributed at all - those come back without a spec
// rather than being dropped, because a container or VM relay hides the real
// process and elevation is needed to read another user's command line.
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
      const known = processes.get(listener.pid);
      // A port whose process we could not read still comes back. Reading
      // another user's command line needs elevation on every platform, and a
      // container relay hides the process outright, so the alternative to
      // returning it without a spec is not returning it at all - and then a
      // llama-server on --port 11435 is invisible to the half of discovery
      // that exists to find exactly that. The probe decides whether it is ours.
      //
      // Only genuinely unattributed pids get this. A process we can see and
      // whose name is not an engine is still dropped, so the machine's other
      // fifty listening sockets are not probed on every scan.
      const info = known || { pid: listener.pid, name: "", binary: "", cmdline: "" };
      if (known && !looksLikeEngineProcess(info)) continue;
      // One row per port: a process may hold the same port on several
      // addresses (IPv4 and IPv6), and that is one engine, not two.
      //
      // Which row wins is not arbitrary. Two DIFFERENT processes can hold the
      // same port number on different local addresses, and Get-NetTCPConnection
      // does not promise an order, so keeping whichever arrived first can file
      // a port under the pid of a process that is not answering on it. The one
      // this gateway reaches is the one bound to loopback or to the wildcard,
      // and that pid is what a restart signals - so it is the one kept.
      const already = seen.get(listener.port);
      if (already && !(reachableAddress(listener.address) && !reachableAddress(already.address))) continue;
      seen.set(listener.port, { port: listener.port, address: listener.address || "", ...info });
    }
    return [...seen.values()];
  } catch {
    return [];
  }
}

// Rewrite a llama-server argv with the settings a user chose, keeping every
// other argument exactly as it was.
//
// Editing the observed argv rather than composing a fresh one is deliberate: a
// composed line would silently drop whatever this user needed and we did not
// think of - a chat template, a device selection, an alias, a LoRA. The parts
// being tuned are replaced by name; everything else survives untouched.
const OVERRIDE_FLAGS = {
  modelPath: ["-m", "--model"],
  ctxSize: ["-c", "--ctx-size"],
  parallel: ["-np", "--parallel"],
  cacheTypeK: ["-ctk", "--cache-type-k"],
  cacheTypeV: ["-ctv", "--cache-type-v"],
  slotSavePath: ["--slot-save-path"],
  visionProjectorPath: ["--mmproj"],
};

// Presence-only switches: there is no value token to step over, and the two
// spellings are opposites rather than aliases.
const OVERRIDE_SWITCHES = {
  kvUnified: {
    on: "--kv-unified",
    off: "--no-kv-unified",
    spellings: ["--kv-unified", "-kvu", "--no-kv-unified", "-no-kvu"],
  },
  // Turned off by writing the negative form rather than by removing the
  // positive one. llama.cpp has flipped this default once already, so a
  // configuration that means it has to say it; both spellings are present in
  // the builds this targets, and the older ones that only ever had
  // --no-context-shift are the ones where the default was the wrong way round.
  contextShift: {
    on: "--context-shift",
    off: "--no-context-shift",
    spellings: ["--context-shift", "--no-context-shift"],
  },
};

// Three states per key, not two. `undefined` means the caller does not own this
// setting and whatever is on the command line stays. Any other value - `null`
// included - means the caller owns it, so the existing flag comes off first and
// is rewritten only if there is something to write.
//
// The distinction is the whole fix. Choosing f16 in the drawer passes no cache
// type, which under the old rule skipped the key entirely, so an existing
// `-ctk q8_0` survived a restart whose own preview line said f16 - the engine
// came back running something the UI had just told the user it was leaving. The
// switch had the mirror bug: it was stripped unconditionally, so a user's
// deliberate `--no-kv-unified` disappeared on a restart that only moved the
// context slider.
export function applyLaunchOverrides(args, overrides = {}) {
  const out = [];
  const drop = new Set();
  const dropSwitch = new Set();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    for (const flag of OVERRIDE_FLAGS[key] || []) drop.add(flag);
    for (const flag of OVERRIDE_SWITCHES[key]?.spellings || []) dropSwitch.add(flag);
  }
  const source = Array.isArray(args) ? args : [];
  for (let i = 0; i < source.length; i += 1) {
    const token = source[i];
    if (dropSwitch.has(token)) continue;
    if (drop.has(token)) {
      // Skip the flag and the value that belongs to it, but never swallow the
      // next flag when this one was written without a value.
      const next = source[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    out.push(token);
  }
  if (overrides.modelPath) out.push("-m", String(overrides.modelPath));
  if (overrides.ctxSize) out.push("-c", String(overrides.ctxSize));
  if (overrides.parallel) out.push("--parallel", String(overrides.parallel));
  if (overrides.cacheTypeK) out.push("-ctk", String(overrides.cacheTypeK));
  if (overrides.cacheTypeV) out.push("-ctv", String(overrides.cacheTypeV));
  if (overrides.slotSavePath) out.push("--slot-save-path", String(overrides.slotSavePath));
  if (overrides.visionProjectorPath) out.push("--mmproj", String(overrides.visionProjectorPath));
  // Write the cache topology explicitly. Managed profiles use independent,
  // equal lanes; inheriting a previous unified pool would invalidate both the
  // per-lane catalog promise and the numbered SSD slot mapping.
  if (typeof overrides.kvUnified === "boolean") {
    out.push(overrides.kvUnified ? OVERRIDE_SWITCHES.kvUnified.on : OVERRIDE_SWITCHES.kvUnified.off);
  }
  if (typeof overrides.contextShift === "boolean") {
    out.push(overrides.contextShift ? OVERRIDE_SWITCHES.contextShift.on : OVERRIDE_SWITCHES.contextShift.off);
  }
  return out;
}

// llama-server's command line is a complete adoption spec. Parsing it is what
// turns "an engine is running on 11435" into "Qwen3.8-27B Q3_K_M, 80K context,
// one slot, vulkan build" without asking the user to retype any of it.
const LLAMA_FLAGS = [
  ["model", ["-m", "--model"]],
  ["visionProjectorPath", ["--mmproj"]],
  ["alias", ["-a", "--alias"]],
  ["ctxSize", ["-c", "--ctx-size"]],
  ["gpuLayers", ["-ngl", "--n-gpu-layers", "--gpu-layers"]],
  ["parallel", ["-np", "--parallel"]],
  ["threads", ["-t", "--threads"]],
  ["host", ["--host"]],
  ["port", ["--port"]],
  ["mainGpu", ["-mg", "--main-gpu"]],
  ["splitMode", ["-sm", "--split-mode"]],
  ["tensorSplit", ["-ts", "--tensor-split"]],
  ["device", ["-dev", "--device"]],
  ["slotSavePath", ["--slot-save-path"]],
  // Read, not just written: without these the KV precision an engine is
  // actually running was invisible, so the budget assumed f16 for a cache that
  // was half that size, and the "KV quantization is broken here" warning could
  // never fire because its condition was permanently undefined.
  ["cacheTypeK", ["-ctk", "--cache-type-k"]],
  ["cacheTypeV", ["-ctv", "--cache-type-v"]],
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


// What it takes to start this engine again, taken from the process that was
// already serving it. We do not compose a command line: a llama-server is
// started with a dozen arguments - the model path, the context size, how many
// layers go to the GPU, which device - and anything we invented would be a
// guess presented as a memory. Replaying exactly what ran is the only honest
// version of "start it again".
//
// argv is stored as a list rather than a string so the relaunch never goes
// through a shell: there is nothing for a quote or a semicolon in a model path
// to escape into.
export function launchSpecFrom(listener) {
  if (!listener?.binary || !listener.cmdline) return null;
  const tokens = tokenizeCommandLine(listener.cmdline);
  if (!tokens.length) return null;
  return { binary: listener.binary, args: tokens.slice(1) };
}

// Start an engine and let go of it. This sequence used to live inline in two
// route handlers (restart and apply), which put OS process management inside
// Express - and two copies of the rule that a background launch must log,
// never discard (AGENTS.md: an engine that dies on a missing model file or a
// held port says so on stderr and nowhere else).
export function spawnEngineDetached({ binary, args, engine, logDir }) {
  mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `engine-${engine}.log`);
  const log = openSync(logFile, "a");
  const child = spawn(binary, args, {
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  // A missing executable reports asynchronously. The lifecycle verifier owns
  // the user-visible failure and log path; without a listener Node treats this
  // event as uncaught and can take the ModelDock gateway down with the engine.
  child.on("error", () => {});
  // The parent's copy of the descriptor is not needed once the child owns it.
  closeSync(log);
  // Ours to start, not ours to hold: the engine outlives this gateway, and a
  // restart of ModelDock must not take the user's model down with it.
  child.unref();
  return { pid: child.pid, logFile };
}

// Wait for a signalled engine to actually be gone, against a real deadline.
//
// The port does not free instantly, and starting a second copy onto a held
// port is the failure this waits out. Running out of patience is not the same
// as the port coming free: the old loop left by the same door either way and
// spawned regardless, so a process that refused to die produced a second one
// that could not bind, and the reply still said started: true.
//
// Gone means gone from the process table AND gone from the scan, not either
// one. The scan drops a port whose probe fails, and llama-server stops
// answering early in its shutdown while it is still unloading the model - so
// the scan alone reports "stopped" while the old process is still holding
// twelve gigabytes of weights, and the replacement allocates on top of it.
// On the card this feature exists for that is 25 GiB asked of a 19 GiB card.
export async function waitForEngineStop({ pid, discover, timeoutMs = 10_000 }) {
  const alive = (candidate) => {
    try {
      // Signal 0 asks the question without sending anything. EPERM means the
      // process is there and not ours to signal, which is still there.
      process.kill(candidate, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
  // A real deadline rather than a count of turns: every pass through this
  // loop is a full port scan, so "40 iterations of 250ms" is not ten seconds
  // and a message quoting the timeout would be quoting a number nothing
  // measured.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listed = (await discover()).some((found) => found.pid === pid);
    if (!listed && !alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// The managed launcher owns only the capacity and residency switches. Model,
// device topology, templates, draft settings and every other observed argument
// remain byte-for-byte argv entries from the user's pre-takeover process.
// llama.cpp's -c is the total KV budget: independent equal lanes therefore use
// P * C here while Codex is told only the per-lane C.
export function managedLlamaLaunchArgs(args, { profile, slotSavePath, modelPath, visionProjectorPath } = {}) {
  const lanes = Number(profile?.laneCount);
  const perLane = Number(profile?.laneContextTokens);
  if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > 3) {
    throw new TypeError("A managed llama.cpp launch needs one through three lanes.");
  }
  if (!Number.isSafeInteger(perLane) || perLane <= 0) {
    throw new TypeError("A managed llama.cpp launch needs a positive per-lane context.");
  }
  const root = typeof slotSavePath === "string" ? slotSavePath.trim() : "";
  if (!root) throw new TypeError("A managed llama.cpp launch needs an SSD slot-state directory.");
  return applyLaunchOverrides(args, {
    modelPath,
    ctxSize: lanes * perLane,
    parallel: lanes,
    slotSavePath: root,
    visionProjectorPath,
    kvUnified: false,
  });
}

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

// Rewrite a llama-server argv with the settings a user chose, keeping every
// other argument exactly as it was.
//
// Editing the observed argv rather than composing a fresh one is deliberate: a
// composed line would silently drop whatever this user needed and we did not
// think of - a chat template, a device selection, an alias, a LoRA. The parts
// being tuned are replaced by name; everything else survives untouched.
const OVERRIDE_FLAGS = {
  ctxSize: ["-c", "--ctx-size"],
  parallel: ["-np", "--parallel"],
  cacheTypeK: ["-ctk", "--cache-type-k"],
  cacheTypeV: ["-ctv", "--cache-type-v"],
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
  if (overrides.ctxSize) out.push("-c", String(overrides.ctxSize));
  if (overrides.parallel) out.push("--parallel", String(overrides.parallel));
  if (overrides.cacheTypeK) out.push("-ctk", String(overrides.cacheTypeK));
  if (overrides.cacheTypeV) out.push("-ctv", String(overrides.cacheTypeV));
  // Slots that each see the whole window rather than a reserved slice. Written
  // explicitly because llama.cpp only defaults it on when the slot count is
  // auto, so setting --parallel silently turns it off.
  if (typeof overrides.kvUnified === "boolean") {
    out.push(overrides.kvUnified ? OVERRIDE_SWITCHES.kvUnified.on : OVERRIDE_SWITCHES.kvUnified.off);
  }
  if (typeof overrides.contextShift === "boolean") {
    out.push(overrides.contextShift ? OVERRIDE_SWITCHES.contextShift.on : OVERRIDE_SWITCHES.contextShift.off);
  }
  return out;
}

// The settings the tuning drawer owns, and the only place they are named.
//
// The drawer has to show the command its own Apply would run, and for a while
// it built that line from scratch out of a short list of flags it knew about.
// A real llama-server is started with a dozen: the alias the model is served
// under, -fa, --jinja, -mg/-sm pinning it to a card. None of those were in the
// list, so the line under "start it with" was missing eight flags that Apply
// itself preserves - harmless if pressed, silently different if pasted.
//
// So the page no longer composes anything. The server strips exactly these
// keys from the real argv and sends the remainder; the page appends its three
// choices to it. Adding a knob means adding it here, and the test next to
// `drawerLaunchTail` fails until both halves know about it.
const DRAWER_OWNED = { ctxSize: null, parallel: null, cacheTypeK: null, cacheTypeV: null, kvUnified: null };

// Two settings this stack cannot be trusted with, refused rather than offered.
//
// Quantized KV returns wrong answers here rather than slow ones, and context
// shifting is turned off because it is not something we are willing to have
// running on this vendor. Both are enforced where the argv is built, not in
// the page: greying a control out stops the dashboard from asking for it and
// stops nothing else, and /api/local/apply takes its settings from a request
// body that need never have come from the page.
export function vendorRefusals(vendor) {
  const amd = String(vendor || "").toLowerCase() === "amd";
  return { quantizedKv: amd, contextShift: amd };
}

// Everything the engine was started with except what the drawer decides. The
// vendor matters because a refusal is a setting the drawer owns too - it has
// to come off the base, or the preview would show a flag the restart removes.
export function launchBaseArgs(args, { vendor } = {}) {
  const refuse = vendorRefusals(vendor);
  return applyLaunchOverrides(args, {
    ...DRAWER_OWNED,
    ...(refuse.contextShift ? { contextShift: null } : {}),
  });
}

// The drawer's three choices as flags, in the order applyLaunchOverrides
// writes them. This is the half the page duplicates, so it is kept to a shape
// with no branching worth getting wrong, and pinned by a test.
export function drawerLaunchTail({ contextTokens, sessions, kvType, vendor } = {}) {
  const refuse = vendorRefusals(vendor);
  const tail = [];
  if (Number(contextTokens)) tail.push("-c", String(Number(contextTokens)));
  if (Number(sessions)) tail.push("--parallel", String(Number(sessions)));
  // f16 is llama.cpp's default, so it is expressed by writing nothing.
  if (!refuse.quantizedKv && kvType && kvType !== "f16") tail.push("-ctk", String(kvType), "-ctv", String(kvType));
  tail.push("--kv-unified");
  if (refuse.contextShift) tail.push("--no-context-shift");
  return tail;
}

// What Apply runs. The one caller that actually spawns, and the definition the
// preview above is measured against.
export function drawerLaunchArgs(args, choices = {}) {
  const refuse = vendorRefusals(choices.vendor);
  // A refused setting is not a default the caller may override: whatever the
  // request asked for, the cache comes back to f16 and context shifting is
  // written off, so a body that never came from the page cannot get around it.
  const cache = !refuse.quantizedKv && choices.kvType && choices.kvType !== "f16" ? choices.kvType : null;
  return applyLaunchOverrides(args, {
    ctxSize: Number(choices.contextTokens) || undefined,
    parallel: Number(choices.sessions) || undefined,
    cacheTypeK: cache,
    cacheTypeV: cache,
    kvUnified: true,
    contextShift: refuse.contextShift ? false : undefined,
  });
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
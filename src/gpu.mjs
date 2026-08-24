// How much video memory each card actually has, and how much of it is spoken
// for right now.
//
// Capacity is not as easy to ask for as it looks. `Win32_VideoController`
// carries `AdapterRAM` as a 32-bit value, so every card larger than 4 GB
// reports exactly 4 GB - measured on this machine, where a 20 GB Radeon and a
// 6 GB GeForce both claimed 4.00 GiB. The driver's own `qwMemorySize` in the
// display-class registry key is 64-bit and correct; nvidia-smi is better still
// where it exists, because it reports live usage too.
//
// Capacity alone is not the interesting number anyway. A configuration is
// evicted not because it never fitted but because something ELSE later wanted
// memory, so the budget needs the peak of other consumers, and only a resident
// service can watch long enough to see it.
import { execFile } from "node:child_process";

function runCommandDefault(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? "" : String(stdout || ""));
    });
  });
}

const WINDOWS_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*';",
  "$cards = Get-ItemProperty -Path $k |",
  "  Where-Object { $_.'HardwareInformation.qwMemorySize' } |",
  "  Select-Object @{n='name';e={$_.DriverDesc}}, @{n='totalBytes';e={[int64]$_.'HardwareInformation.qwMemorySize'}};",
  "ConvertTo-Json -Compress -Depth 3 @($cards)",
].join(" ");

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

export function parseWindowsGpus(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  return asArray(parsed)
    .map((row) => ({
      name: String(row?.name || "").trim(),
      totalBytes: Number(row?.totalBytes) || 0,
      vendor: vendorOf(String(row?.name || "")),
    }))
    .filter((gpu) => gpu.totalBytes > 0);
}

// Current probe format is index,uuid,name,total,used,free. The three-column legacy
// form remains accepted because tests and older embedders call this parser
// directly. Driver index and UUID survive sorting, which is required when a
// managed tensor split accounts for each physical card independently.
export function parseNvidiaSmi(stdout) {
  const gpus = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 2 || !parts[0]) continue;
    const extended = parts.length >= 5 && /^GPU-/i.test(parts[1]);
    const name = extended ? parts[2] : parts[0];
    const total = Number(extended ? parts[3] : parts[1]);
    if (!Number.isFinite(total) || total <= 0) continue;
    const used = Number(extended ? parts[4] : parts[2]);
    const free = Number(extended && parts.length >= 6 ? parts[5] : NaN);
    gpus.push({
      ...(extended ? { index: Number(parts[0]), uuid: parts[1] } : {}),
      name,
      vendor: "nvidia",
      // nounits reports MiB.
      totalBytes: Math.round(total * 1024 * 1024),
      usedBytes: Number.isFinite(used) ? Math.round(used * 1024 * 1024) : undefined,
      // Do not reconstruct this from total - used. NVIDIA can reserve memory
      // outside the process figure, and the driver already reports the real
      // amount a later allocation can use.
      freeBytes: Number.isFinite(free) ? Math.round(free * 1024 * 1024) : undefined,
    });
  }
  return gpus;
}

// A card never offers all of itself. The driver and the compositor hold some
// back, so the number an allocator can actually reach is below the capacity the
// registry reports: this machine's 7900 XT reads as 19.98 GiB and had 19.1 GiB
// available, a reserve of about 0.88 GiB or 4.4%.
//
// Budgeting against the raw figure is not a rounding error, it is a wrong
// answer in the dangerous direction: it overstates headroom by most of a
// gigabyte and recommends a context that gets evicted. Measured once here;
// override when a better figure per vendor lands.
export const USABLE_VRAM_FRACTION = 0.956;

export function usableBytesOf(gpu) {
  if (!gpu?.totalBytes) return 0;
  // nvidia-smi already reports what the allocator can reach, so it is not
  // discounted a second time.
  if (gpu.vendor === "nvidia" && gpu.usedBytes !== undefined) return gpu.totalBytes;
  return Math.floor(gpu.totalBytes * USABLE_VRAM_FRACTION);
}

export function vendorOf(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.includes("nvidia") || lower.includes("geforce") || lower.includes("quadro") || lower.includes("tesla")) return "nvidia";
  if (lower.includes("amd") || lower.includes("radeon")) return "amd";
  if (lower.includes("intel") || lower.includes("arc")) return "intel";
  return "unknown";
}

// Every card this machine has, largest first: the biggest one is the only
// plausible host for a 12 GB model, and picking it beats asking the user which
// index the driver assigned. Returns [] rather than throwing when nothing can
// be probed, so a budget degrades to "no card size known" instead of failing.
export async function probeGpus({
  platform = process.platform,
  runCommand = runCommandDefault,
  timeoutMs = 5000,
} = {}) {
  try {
    const found = [];
    if (platform === "win32") {
      found.push(...parseWindowsGpus(await runCommand("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], timeoutMs)));
    }
    // nvidia-smi wins for the entire NVIDIA set: it is the vendor's own live
    // enumeration. Merging by name is incorrect when two identical cards are
    // installed (the second overwrites the first) and preserves stale registry
    // adapters. Keep only non-NVIDIA registry rows whenever smi answered.
    const smi = parseNvidiaSmi(await runCommand(
      "nvidia-smi",
      ["--query-gpu=index,uuid,name,memory.total,memory.used,memory.free", "--format=csv,noheader,nounits"],
      timeoutMs,
    ));
    const merged = smi.length
      ? [...found.filter((gpu) => gpu.vendor !== "nvidia"), ...smi]
      : found;
    return merged.sort((a, b) => b.totalBytes - a.totalBytes);
  } catch {
    return [];
  }
}

// The card a local engine is most likely running on. `-mg N` names a device
// index in the driver's order, which is not the order this list is in, so it is
// only honoured when it lands on a card big enough to be plausible; otherwise
// the largest card wins. Guessing small would understate the budget and tell a
// user to shrink a context that was fine.
export function primaryGpu(gpus, { mainGpu } = {}) {
  if (!Array.isArray(gpus) || !gpus.length) return null;
  const largest = gpus[0];
  if (!Number.isInteger(mainGpu) || mainGpu < 0) return largest;
  const named = gpus.find((gpu) => gpu.index === mainGpu) || gpus[mainGpu];
  return named && named.totalBytes >= largest.totalBytes ? named : largest;
}

import test from "node:test";
import assert from "node:assert/strict";
import { parseNvidiaSmi, parseWindowsGpus, primaryGpu, probeGpus, usableBytesOf, vendorOf } from "../src/gpu.mjs";

const GiB = 1024 ** 3;

test("card capacity comes from the 64-bit driver value, not AdapterRAM", () => {
  // Win32_VideoController reports AdapterRAM as a 32-bit number, so every card
  // over 4 GB claims exactly 4 GB - measured on this machine, where a 20 GB
  // Radeon and a 6 GB GeForce both said 4.00 GiB. qwMemorySize is the honest one.
  const gpus = parseWindowsGpus(JSON.stringify([
    { name: "AMD Radeon RX 7900 XT", totalBytes: 21454355456 },
    { name: "NVIDIA GeForce GTX 1060 6GB", totalBytes: 6442450944 },
  ]));
  assert.equal(gpus.length, 2);
  assert.equal(Math.round(gpus[0].totalBytes / GiB * 100) / 100, 19.98);
  assert.equal(gpus[0].vendor, "amd");
  assert.equal(gpus[1].vendor, "nvidia");
});

test("a single card is still read as a list", () => {
  // PowerShell's ConvertTo-Json collapses a one-element array to the object.
  const gpus = parseWindowsGpus(JSON.stringify({ name: "AMD Radeon RX 7900 XT", totalBytes: 21454355456 }));
  assert.equal(gpus.length, 1);
});

test("cards that report no size are dropped rather than counted as zero", () => {
  const gpus = parseWindowsGpus(JSON.stringify([
    { name: "Microsoft Basic Display Adapter", totalBytes: 0 },
    { name: "AMD Radeon RX 7900 XT", totalBytes: 21454355456 },
  ]));
  assert.deepEqual(gpus.map((g) => g.name), ["AMD Radeon RX 7900 XT"]);
});

test("nvidia-smi supplies live usage the registry cannot", () => {
  const gpus = parseNvidiaSmi("NVIDIA GeForce GTX 1060 6GB, 6144, 1996\nNVIDIA RTX 5060 Ti, 16384, 0\n");
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].totalBytes, 6144 * 1024 * 1024);
  assert.equal(gpus[0].usedBytes, 1996 * 1024 * 1024);
  assert.equal(gpus[1].usedBytes, 0);
});

test("two identical NVIDIA cards retain distinct driver identities", async () => {
  const smi = [
    "0, GPU-a, NVIDIA RTX 5060 Ti, 16311, 15710",
    "1, GPU-b, NVIDIA RTX 5060 Ti, 16311, 13758",
  ].join("\n");
  const runCommand = async (file) => file === "nvidia-smi"
    ? smi
    : JSON.stringify([
        { name: "NVIDIA RTX 5060 Ti", totalBytes: 17103323136 },
        { name: "NVIDIA RTX 5060 Ti", totalBytes: 17103323136 },
      ]);
  const gpus = await probeGpus({ platform: "win32", runCommand });
  assert.deepEqual(gpus.map((gpu) => gpu.index), [0, 1]);
  assert.deepEqual(gpus.map((gpu) => gpu.uuid), ["GPU-a", "GPU-b"]);
});

test("a probe that fails yields no cards instead of throwing", async () => {
  for (const runCommand of [async () => "", async () => "not json", async () => { throw new Error("denied"); }]) {
    assert.deepEqual(await probeGpus({ platform: "win32", runCommand }), []);
  }
});

test("nvidia-smi and the registry describe one card, not two", async () => {
  const runCommand = async (file) => (file === "nvidia-smi"
    ? "NVIDIA GeForce GTX 1060 6GB, 6144, 1996"
    : JSON.stringify([
      { name: "AMD Radeon RX 7900 XT", totalBytes: 21454355456 },
      { name: "NVIDIA GeForce GTX 1060 6GB", totalBytes: 6442450944 },
    ]));
  const gpus = await probeGpus({ platform: "win32", runCommand });
  assert.equal(gpus.length, 2, "the GeForce is merged, not appended");
  assert.equal(gpus[0].name, "AMD Radeon RX 7900 XT", "largest first");
  const geforce = gpus.find((g) => g.vendor === "nvidia");
  assert.equal(geforce.usedBytes, 1996 * 1024 * 1024, "usage came from nvidia-smi");
});

test("a main-gpu index is not trusted to point at the big card", () => {
  // `-mg 1` names a driver device index, which is not this list's order. On
  // this machine index 1 would land on a 6 GB card that cannot hold a 12.87 GiB
  // model; believing it would tell the user to shrink a context that was fine.
  const gpus = [
    { name: "AMD Radeon RX 7900 XT", totalBytes: 21454355456, vendor: "amd" },
    { name: "NVIDIA GeForce GTX 1060 6GB", totalBytes: 6442450944, vendor: "nvidia" },
  ];
  assert.equal(primaryGpu(gpus, { mainGpu: 1 }).name, "AMD Radeon RX 7900 XT");
  assert.equal(primaryGpu(gpus, { mainGpu: 0 }).name, "AMD Radeon RX 7900 XT");
  assert.equal(primaryGpu(gpus, {}).name, "AMD Radeon RX 7900 XT");
  assert.equal(primaryGpu(gpus, { mainGpu: 9 }).name, "AMD Radeon RX 7900 XT", "out of range is ignored");
  assert.equal(primaryGpu([], {}), null);
});

test("vendors are named from what the driver calls the card", () => {
  assert.equal(vendorOf("AMD Radeon RX 7900 XT"), "amd");
  assert.equal(vendorOf("NVIDIA GeForce RTX 5060 Ti"), "nvidia");
  assert.equal(vendorOf("Intel Arc A770"), "intel");
  assert.equal(vendorOf("Some Unknown Adapter"), "unknown");
});

test("a budget is built on what an allocator can reach, not the card's capacity", () => {
  // Measured: this 7900 XT reads as 19.98 GiB from the driver and had 19.1 GiB
  // available. Budgeting against the raw figure overstates headroom by most of
  // a gigabyte - it recommended a 68K context where 52K is the honest answer,
  // and 68K is the shape that gets evicted.
  const amd = { name: "AMD Radeon RX 7900 XT", vendor: "amd", totalBytes: 21454355456 };
  const usable = usableBytesOf(amd);
  assert.equal(Math.round(usable / GiB * 10) / 10, 19.1);
  assert.ok(usable < amd.totalBytes);
});

test("nvidia-smi's total is already the reachable figure and is not discounted twice", () => {
  const smi = { name: "RTX 5060 Ti", vendor: "nvidia", totalBytes: 16 * GiB, usedBytes: 0 };
  assert.equal(usableBytesOf(smi), 16 * GiB);
  // Without live usage it is a registry reading like any other, so it is.
  const registry = { name: "RTX 5060 Ti", vendor: "nvidia", totalBytes: 16 * GiB };
  assert.ok(usableBytesOf(registry) < 16 * GiB);
});

test("no card means no usable size rather than a zero that reads as a real limit", () => {
  assert.equal(usableBytesOf(null), 0);
  assert.equal(usableBytesOf({ vendor: "amd" }), 0);
});

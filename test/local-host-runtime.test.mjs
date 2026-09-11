import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  beginHostApply,
  createObservedHost,
  markHostApplying,
  markHostVerified,
  markHostVerifying,
  takeOverHost,
} from "../src/local-hosts.mjs";
import { createLocalHostRegistry, upsertLocalHost, writeLocalHostRegistry } from "../src/local-host-registry.mjs";
import { LocalHostRuntime } from "../src/local-host-runtime.mjs";

test("runtime lazily restores a managed record and dispatches a Codex session to its slot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-runtime-"));
  try {
    const registryFile = path.join(root, "local-hosts.json");
    const storage = { directory: path.join(root, "states"), budgetBytes: 4 * 1024 ** 3 };
    const launch = { binary: "D:/llama/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] };
    let record = takeOverHost(createObservedHost({
      id: "llamacpp-11435",
      adapterId: "llamacpp-nvidia",
      endpoint: "http://127.0.0.1:11435/v1",
      launch,
    }), { kvState: storage });
    record = markHostVerified(record);
    const profile = {
      adapterId: "llamacpp-nvidia",
      modelId: "qwen",
      profileId: "static-p1-c262144",
      laneCount: 1,
      laneContextTokens: 262_144,
      totalContextTokens: 262_144,
    };
    record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
    record = markHostApplying(record);
    record = markHostVerifying(record);
    record = markHostVerified(record);
    await writeLocalHostRegistry(registryFile, upsertLocalHost(createLocalHostRegistry(), record));

    const calls = [];
    const runtime = new LocalHostRuntime({
      registryFile,
      manifestDirectory: path.join(root, "manifests"),
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ n_erased: 0 }), { status: 200 });
      },
    });
    const result = await runtime.run({
      sessionId: "codex-session-a",
      run: async ({ slot, cache }) => ({ ok: true, slot, cache }),
    });
    assert.deepEqual(result, { ok: true, slot: 0, cache: { tier: "cold" } });
    assert.ok(calls.some((url) => url.includes("/slots/0?action=erase")));
    assert.equal(runtime.snapshot().hotCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime closes admission during a managed transition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-runtime-transition-"));
  try {
    const registryFile = path.join(root, "local-hosts.json");
    await writeLocalHostRegistry(registryFile, createLocalHostRegistry());
    const runtime = new LocalHostRuntime({
      registryFile,
      manifestDirectory: path.join(root, "manifests"),
    });
    await runtime.status();
    const release = runtime.beginTransition();
    let entered = false;
    const pending = runtime.run({
      sessionId: "codex-session-waiting",
      run: async () => {
        entered = true;
        return "done";
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(entered, false, "no new request enters while process ownership is changing");
    release();
    assert.equal(await pending, "done");
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway-restart preparation checkpoints a hot session and a new runtime restores the same Codex session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-runtime-restart-"));
  try {
    const registryFile = path.join(root, "local-hosts.json");
    const storage = { directory: path.join(root, "states"), budgetBytes: 4 * 1024 ** 3 };
    const launch = { binary: "D:/llama/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] };
    let record = takeOverHost(createObservedHost({
      id: "llamacpp-11435",
      adapterId: "llamacpp-nvidia",
      endpoint: "http://127.0.0.1:11435/v1",
      launch,
    }), { kvState: storage });
    record = markHostVerified(record);
    const profile = {
      adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "static-p1-c262144",
      laneCount: 1, laneContextTokens: 262_144, totalContextTokens: 262_144,
    };
    record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
    record = markHostApplying(record);
    record = markHostVerifying(record);
    record = markHostVerified(record);
    await writeLocalHostRegistry(registryFile, upsertLocalHost(createLocalHostRegistry(), record));

    const calls = [];
    const fetchImpl = async (url, options = {}) => {
      const parsed = new URL(url);
      const action = parsed.searchParams.get("action");
      calls.push(action);
      if (action === "save") {
        const { filename } = JSON.parse(options.body);
        await writeFile(path.join(storage.directory, filename), Buffer.alloc(32));
        return new Response(JSON.stringify({ n_written: 32, n_saved: 123, timings: { save_ms: 2 } }), { status: 200 });
      }
      if (action === "restore") return new Response(JSON.stringify({ n_read: 32, n_restored: 123, timings: { restore_ms: 3 } }), { status: 200 });
      return new Response(JSON.stringify({ n_erased: 0 }), { status: 200 });
    };
    const runtime = new LocalHostRuntime({ registryFile, manifestDirectory: path.join(root, "manifests"), fetchImpl });
    await runtime.run({ sessionId: "codex-session-resume", run: async () => ({ ok: true }) });
    const prepared = await runtime.prepareGatewayRestart({ holdMs: 1_000 });
    assert.deepEqual(prepared, { managed: true, saved: 1, failed: 0, interrupted: 0, idle: true, holdMs: 1_000 });
    assert.ok(calls.includes("save"), "the still-live runtime saves the hot llama slot before Node stops");

    const replacement = new LocalHostRuntime({ registryFile, manifestDirectory: path.join(root, "manifests"), fetchImpl });
    const resumed = await replacement.run({
      sessionId: "codex-session-resume",
      run: async ({ cache }) => ({ ok: true, cache }),
    });
    assert.deepEqual(resumed, { ok: true, cache: { tier: "ssd", restoreMs: 3 } });
    assert.ok(calls.includes("restore"), "the replacement maps the same Codex session to its saved state");
    assert.equal(runtime.releaseGatewayRestartPreparation(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway restart cancels an active local turn instead of waiting for generation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-runtime-interrupt-"));
  try {
    const registryFile = path.join(root, "local-hosts.json");
    const storage = { directory: path.join(root, "states"), budgetBytes: 4 * 1024 ** 3 };
    const launch = { binary: "D:/llama/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] };
    let record = takeOverHost(createObservedHost({
      id: "llamacpp-11435",
      adapterId: "llamacpp-nvidia",
      endpoint: "http://127.0.0.1:11435/v1",
      launch,
    }), { kvState: storage });
    record = markHostVerified(record);
    const profile = {
      adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "static-p1-c262144",
      laneCount: 1, laneContextTokens: 262_144, totalContextTokens: 262_144,
    };
    record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
    record = markHostApplying(record);
    record = markHostVerifying(record);
    record = markHostVerified(record);
    await writeLocalHostRegistry(registryFile, upsertLocalHost(createLocalHostRegistry(), record));

    const calls = [];
    const fetchImpl = async (url) => {
      const action = new URL(url).searchParams.get("action");
      calls.push(action);
      return new Response(JSON.stringify({ n_erased: 1 }), { status: 200 });
    };
    const runtime = new LocalHostRuntime({ registryFile, manifestDirectory: path.join(root, "manifests"), fetchImpl });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const active = runtime.run({
      sessionId: "codex-active-generation",
      run: async ({ signal }) => {
        entered();
        await new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const interruptedRequest = assert.rejects(active, /interrupted by ModelDock restart/);
    await started;

    const startedAt = Date.now();
    const prepared = await runtime.prepareGatewayRestart({ timeoutMs: 1_000, holdMs: 1_000 });
    assert.equal(prepared.interrupted, 1);
    assert.equal(prepared.idle, true);
    assert.equal(prepared.saved, 0, "an interrupted partial turn must not be checkpointed");
    assert.ok(Date.now() - startedAt < 500, "restart preparation should cancel rather than drain generation");
    await interruptedRequest;
    assert.ok(calls.includes("erase"), "the incomplete slot is erased after cancellation");
    runtime.releaseGatewayRestartPreparation();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gateway restart proceeds when an active local turn ignores cancellation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-runtime-stuck-"));
  try {
    const registryFile = path.join(root, "local-hosts.json");
    const storage = { directory: path.join(root, "states"), budgetBytes: 4 * 1024 ** 3 };
    const launch = { binary: "D:/llama/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] };
    let record = takeOverHost(createObservedHost({
      id: "llamacpp-11435",
      adapterId: "llamacpp-nvidia",
      endpoint: "http://127.0.0.1:11435/v1",
      launch,
    }), { kvState: storage });
    record = markHostVerified(record);
    const profile = {
      adapterId: "llamacpp-nvidia", modelId: "qwen", profileId: "static-p1-c262144",
      laneCount: 1, laneContextTokens: 262_144, totalContextTokens: 262_144,
    };
    record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
    record = markHostApplying(record);
    record = markHostVerifying(record);
    record = markHostVerified(record);
    await writeLocalHostRegistry(registryFile, upsertLocalHost(createLocalHostRegistry(), record));

    const runtime = new LocalHostRuntime({
      registryFile,
      manifestDirectory: path.join(root, "manifests"),
      fetchImpl: async () => new Response(JSON.stringify({ n_erased: 0 }), { status: 200 }),
    });
    let entered;
    let finish;
    const started = new Promise((resolve) => { entered = resolve; });
    const active = runtime.run({
      sessionId: "codex-ignores-abort",
      run: async () => {
        entered();
        return new Promise((resolve) => { finish = resolve; });
      },
    });
    await started;

    const startedAt = Date.now();
    const prepared = await runtime.prepareGatewayRestart({ timeoutMs: 25, holdMs: 1_000 });
    assert.equal(prepared.interrupted, 1);
    assert.equal(prepared.idle, false);
    assert.equal(prepared.saved, 0);
    assert.ok(Date.now() - startedAt < 500, "an uncooperative relay must not lock restart");

    runtime.releaseGatewayRestartPreparation();
    finish({ ok: true });
    await active;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

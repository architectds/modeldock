import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalHostLifecycleOperations,
  probeLlamaRequestSlotAffinity,
  sameLaunchSpec,
} from "../src/local-host-lifecycle.mjs";

const SPEC = {
  binary: "D:/llama/llama-server.exe",
  args: ["-m", "D:/models/qwen.gguf", "-c", "400000", "--parallel", "2", "--no-kv-unified"],
};

test("verified lifecycle requires the exact argv and the selected equal-slot shape", async () => {
  const operations = createLocalHostLifecycleOperations({
    hostId: "llamacpp-11435",
    endpoint: "http://127.0.0.1:11435/v1",
    registryFile: "D:/state/local-hosts.json",
    discover: async () => [{
      engine: "llamacpp",
      baseUrl: "http://127.0.0.1:11435",
      pid: 42,
      binary: SPEC.binary,
      cmdline: `"${SPEC.binary}" ${SPEC.args.join(" ")}`,
    }],
    fetchImpl: async (url) => new Response(JSON.stringify(
      String(url).endsWith("/slots")
        ? [{ id: 0, n_ctx: 200_000 }, { id: 1, n_ctx: 200_000 }]
        : { total_slots: 2, modalities: { vision: false } },
    ), { status: 200 }),
  });
  const result = await operations.verify(SPEC, {
    desiredProfile: { laneCount: 2, laneContextTokens: 200_000 },
  });
  assert.equal(result.ok, true);
  assert.equal(sameLaunchSpec(SPEC, { ...SPEC, binary: "d:/LLAMA/llama-server.exe" }), process.platform === "win32");
});

test("ready llama.cpp fails immediately on a slot or visual-capability mismatch", async () => {
  const operations = createLocalHostLifecycleOperations({
    hostId: "llamacpp-11435",
    endpoint: "http://127.0.0.1:11435/v1",
    registryFile: "D:/state/local-hosts.json",
    discover: async () => [{
      engine: "llamacpp",
      baseUrl: "http://127.0.0.1:11435",
      pid: 42,
      binary: SPEC.binary,
      cmdline: `"${SPEC.binary}" ${SPEC.args.join(" ")}`,
    }],
    fetchImpl: async (url) => new Response(JSON.stringify(
      String(url).endsWith("/slots")
        ? [{ id: 0, n_ctx: 200_256 }, { id: 1, n_ctx: 200_256 }]
        : { total_slots: 2, modalities: { vision: false } },
    ), { status: 200 }),
  });
  await assert.rejects(
    () => operations.verify(SPEC, {
      desiredProfile: { laneCount: 2, laneContextTokens: 200_000 },
      capabilities: { visionProjectorPath: "D:/models/mmproj.gguf" },
    }),
    /slot 0 reported 200256 tokens instead of 200000/,
  );
});

test("a managed restart checkpoints hot sessions only after both drains pass", async () => {
  const steps = [];
  const operations = createLocalHostLifecycleOperations({
    hostId: "llamacpp-11435",
    endpoint: "http://127.0.0.1:11435/v1",
    registryFile: "D:/state/local-hosts.json",
    discover: async () => [{ engine: "llamacpp", baseUrl: "http://127.0.0.1:11435", pid: 42, binary: SPEC.binary, cmdline: `\"${SPEC.binary}\" ${SPEC.args.join(" ")}` }],
    runtime: {
      drain: async () => { steps.push("runtime-drain"); return true; },
      checkpointHotStates: async () => { steps.push("checkpoint"); return { saved: 1, failed: 0 }; },
    },
    fetchImpl: async () => {
      steps.push("slot-idle");
      return new Response(JSON.stringify([{ is_processing: false }]), { status: 200 });
    },
  });
  await operations.drain();
  assert.deepEqual(steps, ["runtime-drain", "slot-idle", "checkpoint"]);
});

test("a launched llama.cpp process that exits fails verification without waiting for the full deadline", async () => {
  const operations = createLocalHostLifecycleOperations({
    hostId: "llamacpp-11435",
    endpoint: "http://127.0.0.1:11435/v1",
    registryFile: "D:/state/local-hosts.json",
    discover: async () => [],
    spawn: () => ({ pid: 999_999_999 }),
    verifyTimeoutMs: 10_000,
  });
  await operations.start(SPEC);
  await assert.rejects(
    () => operations.verify(SPEC, { desiredProfile: null }),
    /newly launched llama\.cpp process exited before it served the managed endpoint/,
  );
});

test("slot-affinity probe is bounded and requires the requested slot id back", async () => {
  let request;
  let calls = 0;
  const supported = await probeLlamaRequestSlotAffinity({
    endpoint: "http://127.0.0.1:11435/v1",
    model: "qwen",
    slot: 2,
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) {
        request = JSON.parse(options.body);
        return new Response(JSON.stringify({ output: [] }), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: 2, n_prompt_tokens: 3 }]), { status: 200 });
    },
  });
  assert.equal(supported, true);
  assert.equal(request.model, "qwen");
  assert.equal(request.id_slot, 2);
  assert.equal(request.max_output_tokens, 1);
});

test("boot recovery may stop the durably recorded failed candidate", async () => {
  const failed = { ...SPEC, args: [...SPEC.args, "--alias", "failed-candidate"] };
  let running = true;
  let stoppedPid = 0;
  const operations = createLocalHostLifecycleOperations({
    hostId: "llamacpp-11435",
    endpoint: "http://127.0.0.1:11435/v1",
    registryFile: "D:/state/local-hosts.json",
    discover: async () => running ? [{
      engine: "llamacpp",
      baseUrl: "http://127.0.0.1:11435",
      pid: 84,
      binary: failed.binary,
      cmdline: `"${failed.binary}" ${failed.args.join(" ")}`,
    }] : [],
    stopProcess(pid) {
      stoppedPid = pid;
      running = false;
    },
    waitForStop: async () => true,
  });
  await operations.stop({
    activeSpec: SPEC,
    desiredSpec: SPEC,
    preTakeoverSpec: SPEC,
    recoverySpec: failed,
  });
  assert.equal(stoppedPid, 84);
});

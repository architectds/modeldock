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
    fetchImpl: async () => new Response(JSON.stringify({
      total_slots: 2,
      default_generation_settings: { n_ctx: 200_000 },
    }), { status: 200 }),
  });
  const result = await operations.verify(SPEC, {
    desiredProfile: { laneCount: 2, laneContextTokens: 200_000 },
  });
  assert.equal(result.ok, true);
  assert.equal(sameLaunchSpec(SPEC, { ...SPEC, binary: "d:/LLAMA/llama-server.exe" }), process.platform === "win32");
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
  });
  await operations.stop({
    activeSpec: SPEC,
    desiredSpec: SPEC,
    preTakeoverSpec: SPEC,
    recoverySpec: failed,
  });
  assert.equal(stoppedPid, 84);
});

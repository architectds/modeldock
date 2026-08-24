import assert from "node:assert/strict";
import test from "node:test";
import { LlamaCppSlotStateClient, LlamaCppSlotStateError, assertLlamaSlotFilename, llamaServerRoot } from "../src/llamacpp-slot-state.mjs";

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("slot client uses the server root rather than the Responses /v1 path", async () => {
  const calls = [];
  const client = new LlamaCppSlotStateClient({
    baseUrl: "http://127.0.0.1:11435/v1",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return reply(200, { id_slot: 0, filename: "a.bin", n_saved: 130041, n_written: 2556931480, timings: { save_ms: 2943.071 } });
    },
  });
  const saved = await client.save({ filename: "a.bin" });
  assert.equal(calls[0].url, "http://127.0.0.1:11435/slots/0?action=save");
  assert.deepEqual(JSON.parse(calls[0].options.body), { filename: "a.bin" });
  assert.deepEqual(saved, { slot: 0, filename: "a.bin", bytes: 2556931480, promptTokens: 130041, saveMs: 2943.071 });
});

test("slot client restores the exact managed filename and reports adapter timing", async () => {
  const client = new LlamaCppSlotStateClient({
    baseUrl: "http://127.0.0.1:11435",
    fetchImpl: async () => reply(200, { id_slot: 0, filename: "a.bin", n_restored: 130041, n_read: 2556931480, timings: { restore_ms: 3862.088 } }),
  });
  const restored = await client.restore({ slot: 0, filename: "a.bin" });
  assert.deepEqual(restored, { slot: 0, filename: "a.bin", bytes: 2556931480, promptTokens: 130041, restoreMs: 3862.088 });
});

test("slot client fails closed for a disabled endpoint or an unsafe filename", async () => {
  const client = new LlamaCppSlotStateClient({
    baseUrl: "http://127.0.0.1:11435/v1",
    fetchImpl: async () => reply(501, { error: { message: "This server does not support slots action. Start it with --slot-save-path" } }),
  });
  await assert.rejects(
    () => client.save({ filename: "a.bin" }),
    (error) => error instanceof LlamaCppSlotStateError && error.status === 501 && error.action === "save",
  );
  assert.throws(() => assertLlamaSlotFilename("../a.bin"), /simple .bin filename/);
  assert.throws(() => assertLlamaSlotFilename("a.json"), /simple .bin filename/);
});

test("slot client validates malformed successful responses instead of inventing state size", async () => {
  const client = new LlamaCppSlotStateClient({ baseUrl: "http://127.0.0.1:11435", fetchImpl: async () => reply(200, { n_saved: 1, n_written: 0 }) });
  await assert.rejects(() => client.save({ filename: "a.bin" }), /saved slot bytes/);
  assert.equal(llamaServerRoot("http://localhost:11435/v1/"), "http://localhost:11435");
});

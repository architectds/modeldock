import { test } from "node:test";
import assert from "node:assert/strict";
import { Metrics, extractResponseUsage, extractUsageFromSse } from "../src/metrics.mjs";

function makeMetrics() {
  return new Metrics({ recentLimit: 20 });
}

test("begin increments total and active, finish ok records success", () => {
  const metrics = makeMetrics();
  const finish = metrics.begin("web", { operation: "test" });
  assert.equal(metrics.web.total, 1);
  assert.equal(metrics.web.active, 1);
  finish({ ok: true });
  assert.equal(metrics.web.active, 0);
  assert.equal(metrics.web.ok, 1);
  assert.equal(metrics.web.errors, 0);
  assert.ok(metrics.web.lastLatencyMs >= 0);
  assert.equal(metrics.recent[0].status, "ok");
});

test("markFirstResponse records time to the first upstream response separately", () => {
  const metrics = makeMetrics();
  const finish = metrics.begin("responses", {});
  finish.markFirstResponse();
  const first = metrics.recent[0].firstResponseLatencyMs;
  assert.ok(Number.isInteger(first));
  finish.markFirstResponse();
  assert.equal(metrics.recent[0].firstResponseLatencyMs, first);
  finish({ ok: true });
  assert.ok(metrics.recent[0].latencyMs >= first);
});

test("finish without ok flag counts as success (contract: ok !== false)", () => {
  const metrics = makeMetrics();
  const finish = metrics.begin("web", {});
  finish({ error: "boom" });
  assert.equal(metrics.web.ok, 1, "missing ok flag means success by contract");
  assert.equal(metrics.web.errors, 0);
  assert.equal(metrics.recent[0].status, "ok");
});

test("explicit ok:false counts as error", () => {
  const metrics = makeMetrics();
  const finish = metrics.begin("web", {});
  finish({ ok: false, error: "boom" });
  assert.equal(metrics.web.errors, 1);
  assert.equal(metrics.web.ok, 0);
  assert.equal(metrics.recent[0].status, "error");
});

test("double finish is idempotent", () => {
  const metrics = makeMetrics();
  const finish = metrics.begin("web", {});
  finish({ ok: true });
  finish({ ok: false });
  assert.equal(metrics.web.ok, 1);
  assert.equal(metrics.web.errors, 0);
  assert.equal(metrics.web.total, 1);
});

test("unknown metric kind throws", () => {
  const metrics = makeMetrics();
  assert.throws(() => metrics.begin("nope", {}), /Unknown metric kind/);
});

test("recent is capped at recentLimit", () => {
  const metrics = makeMetrics();
  for (let index = 0; index < 30; index += 1) {
    const finish = metrics.begin("web", {});
    finish({ ok: true });
  }
  assert.equal(metrics.recent.length, 20);
});

test("recordResponseTransform accumulates counters", () => {
  const metrics = makeMetrics();
  metrics.recordResponseTransform(
    {
      blocked: { tool_search: 2, web_search: 1 },
      toolChoiceRewritten: true,
      imageRefs: ["a", "b", "a"],
      nativeToolCalls: 4,
      nativeToolOutputs: 3,
      fallbackToolResults: 1,
    },
    { bytesIn: 100, streaming: true },
  );
  assert.equal(metrics.responses.filteredToolSearch, 2);
  assert.equal(metrics.responses.filteredWebSearch, 1);
  assert.equal(metrics.responses.rewrittenToolChoice, 1);
  assert.equal(metrics.responses.nativeToolCalls, 4);
  assert.equal(metrics.responses.nativeToolOutputs, 3);
  assert.equal(metrics.responses.fallbackToolResults, 1);
  assert.equal(metrics.responses.imageAttachments, 3);
  assert.equal(metrics.responses.bytesIn, 100);
  assert.equal(metrics.responses.streaming, 1);
});

test("recordResponseUsage accumulates tokens and bytes", () => {
  const metrics = makeMetrics();
  metrics.recordResponseUsage({ bytesOut: 512, usage: { input_tokens: 10, output_tokens: 20 } });
  metrics.recordResponseUsage({ bytesOut: 256, usage: undefined });
  assert.equal(metrics.responses.bytesOut, 768);
  assert.equal(metrics.responses.inputTokens, 10);
  assert.equal(metrics.responses.outputTokens, 20);
});

test("recordVisionModel counts per model and fallback", () => {
  const metrics = makeMetrics();
  metrics.recordVisionModel("gpt-5.6-luna", false);
  metrics.recordVisionModel("gpt-5.6-luna", false);
  metrics.recordVisionModel("kimi-k2.5", true);
  assert.deepEqual(metrics.vision.byModel, { "gpt-5.6-luna": 2, "kimi-k2.5": 1 });
  assert.equal(metrics.vision.fallback, 1);
});

test("snapshot shape and average latency", () => {
  const metrics = makeMetrics();
  const finish = metrics.begin("web", {});
  finish({ ok: true });
  const snap = metrics.snapshot({ ready: true });
  assert.equal(snap.ready, true);
  assert.ok(snap.uptimeMs >= 0);
  assert.ok(snap.recent.length >= 1);
  assert.ok(Number.isInteger(snap.web.averageLatencyMs));
  assert.ok(snap.responses.averageLatencyMs >= 0);
});

test("extractResponseUsage reads top-level usage", () => {
  assert.deepEqual(extractResponseUsage({ usage: { input_tokens: 1 } }), { input_tokens: 1 });
});

test("extractResponseUsage reads nested response usage", () => {
  assert.deepEqual(extractResponseUsage({ response: { usage: { input_tokens: 2 } } }), { input_tokens: 2 });
});

test("extractResponseUsage returns undefined for empty bodies", () => {
  assert.equal(extractResponseUsage(undefined), undefined);
  assert.equal(extractResponseUsage(null), undefined);
  assert.equal(extractResponseUsage("text"), undefined);
});

test("extractUsageFromSse takes the last usage event", () => {
  const sse = [
    'data: {"type":"response.output_text.delta","delta":"hi"}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":50}}}',
    "data: [DONE]",
  ].join("\n\n");
  assert.deepEqual(extractUsageFromSse(sse), { input_tokens: 100, output_tokens: 50 });
});

test("extractUsageFromSse prefers later usage over earlier", () => {
  const sse = [
    'data: {"usage":{"input_tokens":10,"output_tokens":5}}',
    'data: {"type":"response.completed","usage":{"input_tokens":99,"output_tokens":66}}',
  ].join("\n\n");
  assert.deepEqual(extractUsageFromSse(sse), { input_tokens: 99, output_tokens: 66 });
});

test("extractUsageFromSse returns undefined when nothing present", () => {
  assert.equal(extractUsageFromSse("data: [DONE]"), undefined);
  assert.equal(extractUsageFromSse("random text"), undefined);
  assert.equal(extractUsageFromSse(""), undefined);
});

test("extractUsageFromSse tolerates malformed lines", () => {
  const sse = [
    "event: message",
    "data: {not json",
    'data: {"usage":{"input_tokens":7}}',
  ].join("\n");
  assert.deepEqual(extractUsageFromSse(sse), { input_tokens: 7 });
});

test("extractUsageFromSse handles the usage field inside a nested response item", () => {
  const sse = 'data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":3,"output_tokens":1}}}';
  assert.deepEqual(extractUsageFromSse(sse), { input_tokens: 3, output_tokens: 1 });
});

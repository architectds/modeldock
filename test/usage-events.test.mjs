import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mainRouteFromUsageEvent, readLatestMainRoute, readRecentConversations, recordUsageEvent, usageFromRelayResult } from "../src/usage-events.mjs";

function tempFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-usage-"));
  return { dir, file: path.join(dir, "usage-events.jsonl") };
}

test("recordUsageEvent appends one JSON line per event", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  recordUsageEvent({ model: "deepseek-v4-flash", provider: "opencode-go", route: "default_main", status: 200, durationMs: 1234.6, inputTokens: 10, outputTokens: 5, totalTokens: 15, filePath: file });
  recordUsageEvent({ model: "gpt-5.6-luna", provider: "opencode-go", status: 200, durationMs: 50, filePath: file });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.model, "deepseek-v4-flash");
  assert.equal(first.durationMs, 1235);
  assert.equal(first.totalTokens, 15);
  const second = JSON.parse(lines[1]);
  assert.equal(second.inputTokens, undefined, "absent counts are omitted, not zeroed");
});

test("latest main route survives restart without treating helper routes as model choices", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-latest-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage-events.jsonl");
  recordUsageEvent({ model: "qwen3.8-flash@opencode-go", provider: "opencode-go", route: "client_selected", status: 200, at: "2026-09-02T10:00:00.000Z", filePath: file });
  recordUsageEvent({ model: "gpt-5.6-luna", provider: "openai", route: "current_turn_image", status: 200, at: "2026-09-02T10:01:00.000Z", filePath: file });
  recordUsageEvent({ model: "gpt-5.6-luna", provider: "openai", route: "tool_continuation", status: 200, at: "2026-09-02T10:02:00.000Z", filePath: file });
  recordUsageEvent({ model: "gpt-5.6-terra", provider: "openai", route: "native_passthrough", status: 500, at: "2026-09-02T10:03:00.000Z", filePath: file });
  assert.deepEqual(readLatestMainRoute(file), {
    model: "qwen3.8-flash@opencode-go",
    provider: "opencode-go",
    at: "2026-09-02T10:00:00.000Z",
  });
});

test("native and default main routes are eligible for the one current-model projection", () => {
  assert.deepEqual(mainRouteFromUsageEvent({
    model: "gpt-5.6-luna", provider: "openai", route: "native_passthrough", status: 200, at: "2026-09-02T11:00:00.000Z",
  }), { model: "gpt-5.6-luna", provider: "openai", at: "2026-09-02T11:00:00.000Z" });
  assert.deepEqual(mainRouteFromUsageEvent({
    model: "Qwen/Qwen3.8-Flash@commandcode", provider: "commandcode", route: "default_main", status: 200, at: "2026-09-02T12:00:00.000Z",
  }), { model: "Qwen/Qwen3.8-Flash@commandcode", provider: "commandcode", at: "2026-09-02T12:00:00.000Z" });
});

test("recordUsageEvent records session and thread ids when present", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = recordUsageEvent({
    model: "deepseek-v4-flash",
    sessionId: "session-123",
    threadId: "thread-456",
    filePath: file,
  });
  assert.equal(event.meteringVersion, 2);
  assert.equal(event.sessionId, "session-123");
  assert.equal(event.threadId, "thread-456");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), event);
});

test("recordUsageEvent omits missing and blank session ids", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = recordUsageEvent({ sessionId: "   ", threadId: undefined, filePath: file });
  assert.equal("sessionId" in event, false);
  assert.equal("threadId" in event, false);
});

test("recordUsageEvent bounds session and thread ids", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = recordUsageEvent({
    sessionId: "s".repeat(200),
    threadId: "t".repeat(200),
    filePath: file,
  });
  assert.equal(event.sessionId.length, 160);
  assert.equal(event.threadId.length, 160);
});

test("recordUsageEvent sanitizes junk without throwing", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = recordUsageEvent({ model: 42, status: "nope", durationMs: -5, inputTokens: "NaN", filePath: file });
  assert.equal(event.model, "unknown");
  assert.equal(event.status, 0);
  assert.equal(event.durationMs, 0);
  assert.equal(event.inputTokens, undefined);
});

test("recordUsageEvent records CPU compaction chars when present", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const event = recordUsageEvent({ model: "qwen3.8:27b@custom", compression: { fromChars: 17910, toChars: 4946 }, filePath: file });
  assert.deepEqual(event.compression, { fromChars: 17910, toChars: 4946 });
  assert.equal(event.compression.fromChars, 17910);
  assert.equal(event.compression.toChars, 4946);
});

test("recordUsageEvent omits compression when absent or incomplete", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plain = recordUsageEvent({ model: "x", filePath: file });
  assert.equal("compression" in plain, false);
  const partial = recordUsageEvent({ model: "x", compression: { fromChars: 1 }, filePath: file });
  assert.equal("compression" in partial, false);
});

test("recordUsageEvent never throws when the path is unwritable", () => {
  // A directory path that cannot be a file: append must fail silently.
  const event = recordUsageEvent({ model: "x", filePath: os.tmpdir() });
  assert.equal(event.model, "x");
});

test("rotates the file once past the cap instead of growing forever", (t) => {
  const { dir, file } = tempFile();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(file, "x".repeat(5 * 1024 * 1024 + 1));
  recordUsageEvent({ model: "after-rotate", filePath: file });
  assert.equal(existsSync(`${file}.1`), true, "old file rotated to .1");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).model, "after-rotate");
});

test("usageFromRelayResult maps a relay result to event fields", () => {
  const mapped = usageFromRelayResult({
    httpStatus: 200,
    latencyMs: 900,
    upstream: "deepseek-official",
    route: { model: "deepseek-v4-flash@deepseek-official", reason: "client_selected" },
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  });
  assert.equal(mapped.provider, "deepseek-official");
  assert.equal(mapped.route, "client_selected");
  assert.equal(mapped.totalTokens, 10);
});

test("recent conversations list the threads that really used a provider, newest first", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-recent-conversations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage-events.jsonl");
  const local = (threadId, at, route = "tool_continuation") => recordUsageEvent({
    model: "Qwen3.8-27B@llamacpp", provider: "llamacpp", route, status: 200, threadId, at, filePath: file,
  });
  local("thread-early", "2026-09-16T10:00:00.000Z");
  local("thread-late", "2026-09-17T10:00:00.000Z");
  local("thread-late", "2026-09-17T11:00:00.000Z");
  // A session id is the only identity for a client that reports no thread id.
  recordUsageEvent({ model: "Qwen3.8-27B@llamacpp", provider: "llamacpp", route: "default_main", status: 200, sessionId: "session-only", at: "2026-09-17T09:00:00.000Z", filePath: file });
  // Neither a different provider nor an id-less event is a local conversation.
  recordUsageEvent({ model: "deepseek-v4-flash", provider: "opencode-go", route: "client_selected", status: 200, threadId: "thread-remote", at: "2026-09-17T12:00:00.000Z", filePath: file });
  recordUsageEvent({ model: "Qwen3.8-27B@llamacpp", provider: "llamacpp", route: "client_selected", status: 200, at: "2026-09-17T13:00:00.000Z", filePath: file });
  assert.deepEqual(readRecentConversations({ provider: "llamacpp", filePath: file }), [
    "thread-late", "session-only", "thread-early",
  ], "ordered by the newest event of each conversation, not by file order");
  assert.deepEqual(readRecentConversations({ provider: "llamacpp", filePath: file, limit: 1 }), ["thread-late"]);
  assert.deepEqual(readRecentConversations({ provider: "nobody", filePath: file }), []);
  assert.deepEqual(readRecentConversations({ provider: "llamacpp", filePath: path.join(dir, "missing.jsonl") }), [],
    "no metering yet is an ordinary empty answer, not a failure");
});

test("recent conversations read through the rotation like every other projection", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-recent-conversations-rotated-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "usage-events.jsonl");
  writeFileSync(`${file}.1`, `${JSON.stringify({
    at: "2026-09-15T10:00:00.000Z", provider: "llamacpp", route: "client_selected", status: 200, threadId: "thread-rotated",
  })}\n`, "utf8");
  recordUsageEvent({ model: "Qwen3.8-27B@llamacpp", provider: "llamacpp", route: "client_selected", status: 200, threadId: "thread-current", at: "2026-09-17T10:00:00.000Z", filePath: file });
  assert.deepEqual(readRecentConversations({ provider: "llamacpp", filePath: file }), ["thread-current", "thread-rotated"]);
});

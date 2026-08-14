import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordUsageEvent, usageFromRelayResult } from "../src/usage-events.mjs";

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

import test from "node:test";
import assert from "node:assert/strict";
import { compressConversation } from "../src/compress.mjs";
import { encodeCompactionSummary, normalizeGatewayInput } from "../src/gateway.mjs";

// Full-path multi-hop test. Every hop goes through the real seam - the gateway
// encodes the compress output as a kcr1 compaction item, and the next request
// arrives with that item expanded by normalizeGatewayInput back into a user
// message. A producer/detector marker mismatch (e.g. the detector keying on a
// header the producer stopped writing) fails here even when single-side
// fixtures stay green, because the seam is crossed inside the test.

function buildSession() {
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push({ type: "message", role: "user", content: [{ type: "input_text", text: `\u7B2C ${i} \u8F6E\u4EFB\u52A1\uFF1A\u5B8C\u6210\u6A21\u5757 ${i}` }] });
    items.push({ type: "reasoning", content: [{ type: "reasoning_text", text: `\u601D\u8003 ${i}` }] });
    items.push({ type: "function_call", name: "shell_command", arguments: `{"cmd":"probe ${i}"}` });
    items.push({ type: "function_call_output", output: `probe ${i} \u7684\u8F93\u51FA` });
    items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `\u7B2C ${i} \u8F6E\u7ED3\u8BBA\uFF1A\u7EE7\u7EED\u63A8\u8FDB\u3002` }] });
  }
  return items;
}

function addNew() {
  return [
    { type: "message", role: "user", content: [{ type: "input_text", text: "\u7EE7\u7EED\uFF0C\u628A\u4E0A\u4E00\u6B65\u7684\u62A5\u9519\u4FEE\u6389" }] },
    { type: "function_call", name: "apply_patch", arguments: "{}" },
    { type: "function_call_output", output: "Exit code: 1\nError: boom" },
  ];
}

test("three hops through the real compaction seam keep the original task", () => {
  const KEY = "\u7B2C 0 \u8F6E\u4EFB\u52A1\uFF1A\u5B8C\u6210\u6A21\u5757 0";
  let input = buildSession();
  let text = compressConversation(input).text;
  const sizes = [text.length];
  assert.ok(text.includes(KEY), "hop 1 keeps the original task");
  for (let hop = 2; hop <= 4; hop++) {
    const restored = normalizeGatewayInput([
      { type: "compaction", encrypted_content: encodeCompactionSummary(text) },
    ]);
    assert.equal(restored.length, 1, "the compaction item expands to one message");
    assert.equal(restored[0].type, "message");
    assert.equal(restored[0].role, "user");
    input = [...restored, ...addNew()];
    text = compressConversation(input).text;
    sizes.push(text.length);
    assert.ok(text.includes(KEY), `hop ${hop} keeps the original task (${text.length} chars)`);
  }
  assert.ok(sizes[3] <= sizes[2] + 2000, `the size converges after the first hop, got ${sizes}`);
});

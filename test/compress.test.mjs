import test from "node:test";
import assert from "node:assert/strict";
import { compressConversation, flattenConversation, aggregateToolCalls } from "../src/compress.mjs";

function item({ type, role = "", text = "", name = "", args = "", output = "" }) {
  if (type === "message") {
    return { type: "message", role, content: [{ type: "input_text", text }] };
  }
  if (type === "function_call") {
    return { type: "function_call", name, input: args, arguments: args || "{}" };
  }
  if (type === "function_call_output") {
    return { type: "function_call_output", output };
  }
  if (type === "reasoning") {
    return { type: "reasoning", content: [{ type: "reasoning_text", text }] };
  }
  return { type };
}

function conversation() {
  const items = [];
  for (let i = 0; i < 60; i++) {
    items.push(item({ type: "message", role: "user", text: `User request number ${i} about the widget` }));
    items.push(item({ type: "reasoning", text: `thinking about ${i}` }));
    items.push(item({ type: "function_call", name: "exec_command", args: `{"cmd":"probe ${i}"}` }));
    items.push(item({ type: "function_call_output", output: `result of probe ${i}` }));
    items.push(item({ type: "message", role: "assistant", text: `Handled request ${i} by probing the subsystem and confirming the widget works.` }));
  }
  return items;
}

test("flattenConversation keeps messages and tool calls, drops reasoning, truncates outputs", () => {
  const lines = flattenConversation([
    item({ type: "message", role: "user", text: "hello" }),
    item({ type: "reasoning", text: "hidden thought" }),
    item({ type: "function_call", name: "apply_patch", args: "{}" }),
    item({ type: "function_call_output", output: "x".repeat(500) }),
  ]);
  assert.equal(lines.length, 3, "reasoning is dropped");
  assert.equal(lines[0].text, "USER: hello");
  assert.ok(lines[1].text.startsWith("TOOL_CALL: apply_patch"));
  assert.ok(lines[2].text.length < 200, "tool output is truncated");
});

test("compressConversation keeps the task, the tail, and aggregates old tool calls", () => {
  const { text, originalChars, compressedChars } = compressConversation(conversation());
  assert.ok(compressedChars < originalChars, "compression shrinks the text");
  assert.ok(text.includes("User request number 0"), "early user asks survive");
  assert.ok(text.includes("Handled request 59"), "the tail survives");
  assert.ok(text.includes("TOOLS_AGGREGATED"), "older tool calls are aggregated");
  assert.ok(!text.includes("result of probe 0"), "old tool outputs are dropped (the tail keeps recent ones)");
  assert.ok(!text.includes("thinking about"), "reasoning is dropped");
});

test("compressConversation is deterministic", () => {
  const a = compressConversation(conversation());
  const b = compressConversation(conversation());
  assert.equal(a.text, b.text);
  assert.equal(a.compressedChars, b.compressedChars);
});

test("compressConversation passes small histories through untouched", () => {
  const small = [
    item({ type: "message", role: "user", text: "one quick question" }),
    item({ type: "message", role: "assistant", text: "a short answer." }),
  ];
  const { text, originalChars, compressedChars } = compressConversation(small);
  assert.equal(text, "USER: one quick question\nASSISTANT: a short answer.");
  assert.equal(compressedChars, originalChars);
});

test("aggregateToolCalls builds an inventory line", () => {
  const lines = [
    { kind: "tool", text: "TOOL_CALL: exec_command({\"cmd\":\"probe A\"})" },
    { kind: "tool", text: "TOOL_CALL: exec_command({\"cmd\":\"probe B\"})" },
    { kind: "tool", text: "TOOL_CALL: apply_patch({\"input\":\"*** Update File: D:/p/x.js\"})" },
  ];
  const inventory = aggregateToolCalls(lines, () => false);
  assert.match(inventory, /exec_command×2/);
  assert.match(inventory, /apply_patch×1/);
  assert.match(inventory, /files: p\/x\.js/);
});

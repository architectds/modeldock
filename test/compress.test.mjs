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
  assert.ok(compressedChars > originalChars, "the prefixed extract of a tiny exchange is larger than the raw input, so the gateway's 0.95 guard keeps the raw history");
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

// A long assistant message is truncated to its opening claim and its closing
// conclusion. The boundary search used to accept "。" only, so English - the
// common case - never matched and always fell back to a blind character cut at
// 60% of the cap, slicing mid-word.
function assistantLine(text) {
  const input = [
    item({ type: "message", role: "user", text: "why did it fail" }),
    item({ type: "message", role: "assistant", text }),
  ];
  return compressConversation(input).text.split("\n").find((line) => line.startsWith("ASSISTANT:")) || "";
}

test("a long English finding is cut at a sentence boundary, not mid-word", () => {
  const line = assistantLine(
    "The restart never ran because detached spawn is broken on Windows. "
    + "I reproduced it outside the gateway with a marker file and the script never executed at all. "
    + "Removing the detached flag makes it run every time, and unref alone suffices because Windows keeps children alive. "
    + "So the fix is to keep detached only on POSIX.",
  );
  const [head, tail] = line.replace(/^ASSISTANT: /, "").split(" ... ");
  assert.ok(tail, "a message past the cap is split into head and tail");
  assert.ok(head.endsWith("."), `head should end at a sentence boundary, got ${JSON.stringify(head.slice(-30))}`);
  assert.ok(!/\s\w{1,2}$/.test(head), "head must not end on a word fragment");
  assert.ok(/^[A-Z]|^\w/.test(tail), `tail should start at a word, got ${JSON.stringify(tail.slice(0, 30))}`);
  assert.ok(!tail.startsWith(" "), "tail is trimmed");
});

test("a long Chinese finding still splits on the ideographic full stop", () => {
  const line = assistantLine(
    "重启从来没有真正执行过，因为 Windows 上的 detached spawn 是坏的。"
    + "我在网关之外用标记文件复现了这个问题，脚本一次都没有跑起来，日志里一个字节都没有。"
    + "去掉 detached 之后每次都正常，而且 unref 就够了，因为 Windows 不会因为父进程退出而杀掉子进程。"
    + "所以结论是 detached 只保留在 POSIX 上。",
  );
  const head = line.replace(/^ASSISTANT: /, "").split(" ... ")[0];
  assert.ok(head.endsWith("。"), `head should end at 。, got ${JSON.stringify(head.slice(-20))}`);
});

test("the head stays inside the cap even when the first sentence is enormous", () => {
  // Searching the whole text for the first terminator let a message whose first
  // sentence ended thousands of characters in ignore the cap entirely.
  const line = assistantLine(`${"word ".repeat(400)}. and then a short tail sentence.`);
  assert.ok(line.length < 400, `expected the cap to bound the head, got ${line.length} chars`);
});

test("the tool inventory finds paths on every platform, not just C/D/E drives", () => {
  const call = (args) => ({ kind: "tool", text: `TOOL_CALL: apply_patch(${args})` });
  const files = (line) => aggregateToolCalls([line], () => false);
  // The old pattern was /(?:D|C|E):[\/].../, so macOS and Linux - platforms this
  // project ships installers for - never contributed a single file.
  assert.match(files(call('{"path":"F:\\work\\app\\main.ts"}')), /files: app\/main\.ts/);
  assert.match(files(call('{"path":"/Users/me/project/src/foo.mjs"}')), /files: src\/foo\.mjs/);
  assert.match(files(call('{"path":"src/compress.mjs"}')), /files: src\/compress\.mjs/);
  assert.match(files(call('{"path":"./scripts/build.mjs"}')), /files: scripts\/build\.mjs/);
  // Requiring an extension keeps bare flags and directory arguments out.
  assert.doesNotMatch(aggregateToolCalls([{ kind: "tool", text: 'TOOL_CALL: exec_command({"cmd":"ls -la /tmp"})' }], () => false), /files:/);
});

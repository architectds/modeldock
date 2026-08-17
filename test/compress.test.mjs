import test from "node:test";
import assert from "node:assert/strict";
import { compressConversation, flattenConversation, aggregateToolCalls, extractErrorLines } from "../src/compress.mjs";

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

test("compressConversation passes small histories through with just a header", () => {
  const small = [
    item({ type: "message", role: "user", text: "one quick question" }),
    item({ type: "message", role: "assistant", text: "a short answer." }),
  ];
  const { text, originalChars, compressedChars } = compressConversation(small);
  assert.ok(text.startsWith("HEAD: task=one quick question | phase=a short answer.\n---"), `header first, got ${JSON.stringify(text)}`);
  assert.ok(text.endsWith("USER: one quick question\nASSISTANT: a short answer."), "the exchange itself is unchanged");
  assert.ok(compressedChars > originalChars, "the prefixed extract of a tiny exchange is larger than the raw input, so the gateway's 0.95 guard keeps the raw history");
});

test("aggregateToolCalls builds an inventory line", () => {
  const lines = [
    { kind: "tool", text: "TOOL_CALL: exec_command({\"cmd\":\"probe A\"})" },
    { kind: "tool", text: "TOOL_CALL: exec_command({\"cmd\":\"probe B\"})" },
    { kind: "tool", text: "TOOL_CALL: apply_patch({\"input\":\"*** Update File: D:/p/x.js\"})" },
  ];
  const inventory = aggregateToolCalls(lines, () => false);
  assert.match(inventory, /exec_command\u00D72/);
  assert.match(inventory, /apply_patch\u00D71/);
  assert.match(inventory, /files: p\/x\.js/);
});

// A long assistant message is truncated to its opening claim and its closing
// conclusion. The boundary search used to accept the ideographic full stop
// (U+3002) only, so English - the
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
    "\u91CD\u542F\u4ECE\u6765\u6CA1\u6709\u771F\u6B63\u6267\u884C\u8FC7\uFF0C\u56E0\u4E3A Windows \u4E0A\u7684 detached spawn \u662F\u574F\u7684\u3002"
    + "\u6211\u5728\u7F51\u5173\u4E4B\u5916\u7528\u6807\u8BB0\u6587\u4EF6\u590D\u73B0\u4E86\u8FD9\u4E2A\u95EE\u9898\uFF0C\u811A\u672C\u4E00\u6B21\u90FD\u6CA1\u6709\u8DD1\u8D77\u6765\uFF0C\u65E5\u5FD7\u91CC\u4E00\u4E2A\u5B57\u8282\u90FD\u6CA1\u6709\u3002"
    + "\u53BB\u6389 detached \u4E4B\u540E\u6BCF\u6B21\u90FD\u6B63\u5E38\uFF0C\u800C\u4E14 unref \u5C31\u591F\u4E86\uFF0C\u56E0\u4E3A Windows \u4E0D\u4F1A\u56E0\u4E3A\u7236\u8FDB\u7A0B\u9000\u51FA\u800C\u6740\u6389\u5B50\u8FDB\u7A0B\u3002"
    + "\u6240\u4EE5\u7ED3\u8BBA\u662F detached \u53EA\u4FDD\u7559\u5728 POSIX \u4E0A\u3002",
  );
  const head = line.replace(/^ASSISTANT: /, "").split(" ... ")[0];
  assert.ok(head.endsWith("\u3002"), `head should end at \u3002, got ${JSON.stringify(head.slice(-20))}`);
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

test("extractErrorLines keeps decisive failures and skips source/stat/table noise", () => {
  const out = (output) => [{ type: "function_call_output", output }];
  const lines = extractErrorLines([
    ...out("Success. Updated the following files:\nM src/gateway.mjs"),
    ...out("Exit code: 1\n\nError: the probe failed"),
    ...out("Traceback (most recent call last):\n  File \"x.py\", line 3, in <module>\nZeroDivisionError: division by zero"),
    // Source text dumped by Get-Content must not look like a failure.
    ...out('const msg = `Unable to decompress request body: ${error.message}`;'),
    // Coverage/stat rows and markdown tables are not failures either.
    ...out("3742 D:\\projects\\modeldock\\src\\error-translation.mjs\n| step | error |\n|---|\n| a | b |"),
    ...out("apply_patch verification failed: Failed to find expected lines in architecture.md:"),
  ]);
  const joined = lines.join("\n");
  assert.ok(joined.includes("Exit code: 1"), "nonzero exit code is kept");
  assert.ok(joined.includes("Traceback"), "stack trace is kept");
  assert.ok(joined.includes("ZeroDivisionError"), "exception line is kept");
  assert.ok(joined.includes("apply_patch verification failed"), "apply failure is kept");
  assert.ok(!joined.includes("Unable to decompress"), "dumped source is not an error line");
  assert.ok(!joined.includes("error-translation.mjs"), "coverage/stat rows are not error lines");
  assert.ok(!joined.includes("| step |"), "table rows are not error lines");
});

test("a decisive assistant sentence outranks ambient prose under equal TF-IDF", () => {
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push(item({ type: "message", role: "user", text: `Repeat probe ${i} against the fixture` }));
    items.push(item({ type: "function_call", name: "exec_command", args: `{"cmd":"run ${i}"}` }));
    items.push(item({ type: "function_call_output", output: `probe ${i} returned a row` }));
    // Ambient prose, information-dense but no decision signal.
    items.push(item({ type: "message", role: "assistant", text: `Probe ${i} executed against the fixture and the executor returned without complaint.` }));
  }
  // A single decisive message buried mid-history: root cause + fix.
  items.push(item({ type: "message", role: "assistant", text: "\u6839\u56E0\u662F\u7F13\u5B58\u952E\u6CA1\u6309 provider \u533A\u5206\uFF0C\u4FEE\u590D\u65B9\u6848\u662F\u628A provider \u62FC\u8FDB key\u3002" }));
  const { text } = compressConversation(items, { tailLines: 8 });
  assert.ok(text.includes("\u6839\u56E0\u662F\u7F13\u5B58\u952E"), "the decisive sentence survives compression");
});

test("a long user ask keeps both edges instead of a blind head-cut", () => {
  const tail = "\u4EE5\u4E0A\u5C31\u662F\u5168\u90E8\u62A5\u9519\u4FE1\u606F\uFF0C\u8BF7\u5148\u4FEE\u8FD9\u4E2A\u518D\u7EE7\u7EED\u3002".repeat(12);
  const head = "\u8BF7\u628A\u7F51\u5173\u7684\u9519\u8BEF\u5904\u7406\u6539\u6389\uFF1A";
  const { text } = compressConversation([item({ type: "message", role: "user", text: head + "x".repeat(400) + tail })], { tailLines: 2 });
  assert.ok(text.includes("\u8BF7\u628A\u7F51\u5173\u7684\u9519\u8BEF\u5904\u7406\u6539\u6389"), "the ask head survives");
  assert.ok(text.includes("\u8BF7\u5148\u4FEE\u8FD9\u4E2A\u518D\u7EE7\u7EED"), "the decisive tail survives the cap");
});

test("a restored compaction item is not capped like a fresh user ask", () => {
  // The gateway expands a compaction item into a user message whose text is our
  // previous extract, starting with the handoff header line. The restored unit
  // is already-compressed history: task lines, errors, and the tool inventory
  // must survive the second hop instead of collapsing to userCap.
  const extract = ("HEAD: task=\u539F\u59CB\u4EFB\u52A1\u5173\u952E\u8BCD | phase=\u67D0\u8F6E\u7ED3\u8BBA\nFAILED: boom\n---\nUSER: \u539F\u59CB\u4EFB\u52A1\u5173\u952E\u8BCD\nASSISTANT: \u67D0\u8F6E\u7ED3\u8BBA\nLAST_ERROR: boom\n").repeat(120);
  const { text } = compressConversation(
    [
      { type: "message", role: "user", content: [{ type: "input_text", text: `[Compressed conversation history]\n${extract}` }] },
      item({ type: "message", role: "user", text: "\u7EE7\u7EED\u4FEE" }),
      item({ type: "message", role: "assistant", text: "\u597D\uFF0C\u7EE7\u7EED\u3002" }),
    ],
    { tailLines: 2 },
  );
  assert.ok(text.includes("\u539F\u59CB\u4EFB\u52A1\u5173\u952E\u8BCD"), "the task line survives the hop");
  assert.ok(text.includes("LAST_ERROR: boom"), "error lines survive the hop");
  assert.ok(text.length > 2000, "the extract is not truncated to the user cap");
  assert.ok(!text.includes("USER: USER:"), "no role-prefix pileup on the restored unit");
});

test("repeated compaction converges instead of doubling or forgetting", () => {
  const marker = "HEAD: task=\u7EE7\u7EED\u4FEE | phase=\u597D\u7684\u7EE7\u7EED\n---\n";
  const add = () => [
    item({ type: "message", role: "user", text: "\u7EE7\u7EED" }),
    item({ type: "message", role: "assistant", text: "\u597D\u7684\uFF0C\u7EE7\u7EED\u5904\u7406\u3002" }),
    item({ type: "function_call", name: "apply_patch", args: "{}" }),
    item({ type: "function_call_output", output: "ok" }),
  ];
  let text = ("USER: \u4EFB\u52A1\u7532\nASSISTANT: \u7ED3\u8BBA\u4E59\n").repeat(2500); // ~60K, over the base budget
  const sizes = [text.length];
  for (let hop = 0; hop < 5; hop++) {
    text = compressConversation([{ type: "message", role: "user", content: [{ type: "input_text", text: marker + text }] }, ...add()]).text;
    sizes.push(text.length);
  }
  assert.ok(text.includes("\u4EFB\u52A1\u7532"), "the original task survives five hops");
  assert.ok(text.includes("USER: \u4EFB\u52A1\u7532"), "task line is preserved verbatim");
  assert.ok(sizes[2] <= sizes[1] + 2000, `size converges after the first hop, got ${sizes}`);
  assert.ok(sizes[4] <= sizes[2] + 2000, `no unbounded growth across hops, got ${sizes}`);
});

test("the handoff header states task, phase, failures, and tool usage", () => {
  const items = [];
  for (let i = 0; i < 30; i++) {
    items.push(item({ type: "message", role: "user", text: `\u7B2C ${i} \u8F6E\u80CC\u666F\u8BF7\u6C42` }));
    items.push(item({ type: "message", role: "assistant", text: `\u7B2C ${i} \u8F6E\u80CC\u666F\u7ED3\u8BBA\u3002` }));
  }
  // An old tool call, pushed out of the verbatim tail by newer calls below, so
  // it is aggregated rather than kept verbatim.
  items.push(item({ type: "function_call", name: "apply_patch", args: "{}" }));
  items.push(item({ type: "function_call_output", output: "ok" }));
  for (let i = 0; i < 45; i++) {
    items.push(item({ type: "function_call", name: "exec_command", args: `{"cmd":"bg ${i}"}` }));
    items.push(item({ type: "function_call_output", output: "ok" }));
  }
  // The recent edge: the real ask, its conclusion, and a failing output.
  items.push(item({ type: "message", role: "user", text: "\u8BF7\u4FEE\u590D\u7F51\u5173\u7684\u538B\u7F29 bug" }));
  items.push(item({ type: "message", role: "assistant", text: "\u6839\u56E0\u662F userCap\uFF0C\u6211\u6539\u4E86\u8BC6\u522B\u903B\u8F91\u5E76\u52A0\u4E86\u6D4B\u8BD5\u3002" }));
  items.push(item({ type: "function_call_output", output: "Exit code: 1\nError: boom" }));
  const { text } = compressConversation(items);
  assert.ok(text.startsWith("HEAD: task=\u8BF7\u4FEE\u590D\u7F51\u5173\u7684\u538B\u7F29 bug | phase=\u6839\u56E0\u662F userCap"), `task is the real ask, not the injected block, got ${JSON.stringify(text.slice(0, 80))}`);
  assert.ok(text.includes("Error: boom"), "the header lists the failure");
  assert.ok(text.includes("TOOLS: apply_patch\u00D71"), "the header lists tool usage");
  assert.ok(text.includes("\n---\n"), "the header is separated from the body");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGatewayInput, normalizeOpenCodeFlashInput, normalizeOpenCodeProInput,
  normalizeXaiInput, normalizeOllamaInput, normalizeNativeInput,
} from "../src/gateway.mjs";
import { responsesToChat } from "../src/local-chat-bridge.mjs";

const call = (id, n = 1) => ({ type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: `echo ${n}` }) });
const output = (id, text) => ({ type: "function_call_output", call_id: id, output: text });
const pair = (id, n) => [call(id, n), output(id, `result ${n}`)];
const chatCall = (id, n = 1) => ({ type: "message", role: "assistant", content: "checking", tool_calls: [{ id, type: "function", function: { name: "exec_command", arguments: call(id, n).arguments } }] });
const outputs = (input) => input.filter((item) => item.type === "function_call_output").map((item) => item.output);

test("closed calls may reuse an id without losing any later round", () => {
  const input = [1, 2, 3].flatMap((n) => pair("exec_command_0", n));
  const normalized = normalizeGatewayInput(input);
  assert.deepEqual(outputs(normalized), ["result 1", "result 2", "result 3"]);
  assert.equal(new Set(normalized.filter((i) => i.type === "function_call").map((i) => i.call_id)).size, 3);
});

test("a duplicate pending call must not steal the next invocation's result", () => {
  const input = [call("x"), call("x"), output("x", "first"), ...pair("x", 2)];
  assert.deepEqual(outputs(normalizeGatewayInput(input)), ["first", "result 2"]);
});

test("identical work repeated after completion is still a new invocation", () => {
  assert.deepEqual(outputs(normalizeGatewayInput([...pair("x", 1), ...pair("x", 1)])), ["result 1", "result 1"]);
});

test("mixed pending copies with object and serialized arguments count as one call", () => {
  const first = { ...call("x"), arguments: '{"b":2,"a":1}' };
  const duplicate = chatCall("x");
  duplicate.tool_calls[0].function.arguments = { a: 1, b: 2 };
  const normalized = normalizeGatewayInput([first, duplicate, output("x", "first"), ...pair("x", 2)]);
  assert.deepEqual(outputs(normalized), ["first", "result 2"]);
  assert.equal(normalized.filter((i) => i.type === "function_call").length, 2);
  assert.equal(normalized[0].arguments, first.arguments);
});

test("generated aliases never collide with later original ids or rewrite an earlier prefix", () => {
  const before = normalizeGatewayInput([...pair("x", 1), ...pair("x", 2)]);
  const generated = before[2].call_id;
  const after = normalizeGatewayInput([...pair("x", 1), ...pair("x", 2), ...pair(generated, 3)]);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(outputs(after), ["result 1", "result 2", "result 3"]);
  assert.equal(new Set(after.filter((i) => i.type === "function_call").map((i) => i.call_id)).size, 3);
});

test("different pending calls sharing one id fail explicitly instead of guessing their output mapping", () => {
  assert.throws(() => normalizeGatewayInput([call("x", 1), call("x", 2), output("x", "ambiguous")]), /ambiguous.*tool.*history/i);
});

test("reused correlation ids also produce distinct Responses item ids", () => {
  const first = { ...call("x", 1), id: "fc_reused" };
  const second = { ...call("x", 2), id: "fc_reused" };
  const normalized = normalizeGatewayInput([first, output("x", "first"), second, output("x", "second")]);
  const calls = normalized.filter((i) => i.type === "function_call");
  assert.notEqual(calls[0].id, calls[1].id);
  assert.ok(calls.every((i) => i.id.startsWith("fc_")));
});

for (const [name, normalize] of Object.entries({ generic: normalizeGatewayInput, flash: normalizeOpenCodeFlashInput, pro: normalizeOpenCodeProInput, xai: normalizeXaiInput, local: normalizeOllamaInput })) {
  test(`${name} preserves mixed-dialect results in order and through the Chat bridge`, () => {
    const input = [chatCall("x", 1), output("x", "first"), chatCall("x", 2), { type: "message", role: "tool", tool_call_id: "x", content: "second" }];
    const original = structuredClone(input);
    const normalized = normalize(input);
    assert.deepEqual(outputs(normalized), ["first", "second"]);
    assert.deepEqual(input, original, "normalization must not modify Codex's input object");
    assert.deepEqual(normalizeGatewayInput(normalized), normalized, "the shared history normalization must be idempotent after provider adaptation");
    const chat = responsesToChat({ model: "fixture", input: normalized, tools: [] }).payload;
    assert.deepEqual(chat.messages.filter((m) => m.role === "tool").map((m) => m.content), ["first", "second"]);
    const declared = chat.messages.flatMap((m) => m.tool_calls || []).map((c) => c.id);
    assert.deepEqual(chat.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id), declared);
  });
}

test("Chat flattening preserves parallel groups, reasoning, structured output and namespace", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,fixture" };
  const input = [
    { ...chatCall("a"), content: null, reasoning_content: "check both", tool_calls: [
      { id: "a", type: "function", namespace: "tools", function: { name: "one", arguments: { a: 1 } } },
      { id: "b", type: "function", function: { name: "two", arguments: "{}" } },
    ] },
    { type: "message", role: "tool", tool_call_id: "b", content: "B" },
    output("a", [{ type: "input_text", text: "A" }, image]),
  ];
  const normalized = normalizeGatewayInput(input);
  assert.equal(normalized[0].type, "reasoning");
  assert.equal(normalized[0].content[0].text, "check both");
  assert.deepEqual(normalized.slice(1).map((i) => [i.type, i.call_id]), [
    ["function_call", "a"], ["function_call", "b"], ["function_call_output", "a"], ["function_call_output", "b"],
  ]);
  assert.deepEqual(normalized[1].arguments, { a: 1 });
  assert.equal(normalized[1].namespace, "tools");
  assert.deepEqual(normalized[3].output, [{ type: "input_text", text: "A" }, image]);
});

test("custom tool call payloads and pair types survive id reuse", () => {
  const input = [1, 2].flatMap((n) => [
    { type: "custom_tool_call", call_id: "patch", name: "apply_patch", input: `patch ${n}` },
    { type: "custom_tool_call_output", call_id: "patch", output: `applied ${n}` },
  ]);
  const normalized = normalizeGatewayInput(input);
  assert.deepEqual(normalized.map((i) => i.input || i.output), ["patch 1", "applied 1", "patch 2", "applied 2"]);
  assert.deepEqual(normalized.map((i) => i.type), input.map((i) => i.type));
});

test("well-formed native history stays on its existing native path", () => {
  const input = [{ ...call("native"), id: "fc_native" }, output("native", "ok")];
  assert.deepEqual(normalizeNativeInput(input), input);
});

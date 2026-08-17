import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import {
  RouteAffinity,
  applyToolPolicy,
  compactFailureReport,
  createUsageTee,
  currentTurnStartForTesting,
  decodeCompactionSummary,
  describeInputShape,
  dropUnpairedToolItems,
  encodeCompactionSummary,
  freeResponseFailure,
  hoistLocalSystem,
  isCompactV1Request,
  isCompactV2Request,
  isNativeModel,
  isLocalBackend,
  nativeTarget,
  normalizeNativeInput,
  normalizeGatewayInput,
  normalizeLocalInput,
  normalizeLocalPayload,
  normalizeLocalReasoning,
  normalizeOllamaInput,
  normalizeOpenCodeFlashInput,
  normalizeOpenCodeProInput,
  pipeGatewayStream,
  pipeNormalizedStream,
  redactBearer,
  relayCompaction,
  relayNativeImage,
  relayNativeResponses,
  relayResponses,
  rewriteHistoricalImages,
  routeGatewayRequest,
  sessionIdsFrom,
  stripLocalInstructions,
  upstreamTargetFor,
} from "../src/gateway.mjs";

function configStub() {
  return {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    opencodeBaseUrl: "https://opencode.ai/zen/go/v1",
    deepseekBaseUrl: "https://api.deepseek.com",
    goToken: "go-token",
    tokens: { "opencode-go": "go-token", "deepseek-official": "ds-token" },
    profileId: "opencode-go",
  };
}

test("sessionIdsFrom extracts Codex ids with stable header precedence", () => {
  assert.deepEqual(sessionIdsFrom({
    "x-codex-parent-thread-id": "parent-thread",
    "x-codex-thread-id": "child-thread",
    "thread-id": "legacy-thread",
    session_id: "session-1",
    "x-codex-session-id": "session-2",
  }), {
    sessionId: "session-1",
    threadId: "parent-thread",
  });
});

test("sessionIdsFrom accepts array-valued request headers and trims them", () => {
  assert.deepEqual(sessionIdsFrom({
    "x-codex-thread-id": [" thread-array ", "ignored"],
    "x-codex-session-id": [" session-array "],
  }), {
    sessionId: "session-array",
    threadId: "thread-array",
  });
});

// Decorate the underlying Writable with ServerResponse-shaped helpers instead of
// wrapping it in a plain object: pipeGatewayStream uses stream .pipe(), which
// needs a real Writable target (event emitter, backpressure) on the res side.
function responseStub(res) {
  return Object.assign(res, {
    statusCode: 200,
    headersSent: false,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      return this.headers[name];
    },
    flushHeaders() {
      this.headersSent = true;
    },
  });
}

function collectStream() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  writable.chunks = chunks;
  return writable;
}

function readAllFromStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

test("normalizeGatewayInput removes compaction triggers and expands compaction summaries", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "compaction_trigger", skipped: true },
    { type: "compaction", encrypted_content: [{ type: "summary_text", text: "earlier context" }] },
  ];
  const normalized = normalizeGatewayInput(input);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].type, "message");
  assert.equal(normalized[1].type, "message");
  assert.equal(normalized[1].role, "user");
  assert.equal(normalized[1].content[0].text, "earlier context");
});

test("compaction summaries round-trip through the kcr1 payload", () => {
  const encoded = encodeCompactionSummary("keep this handoff");
  assert.match(encoded, /^kcr1:/);
  assert.equal(decodeCompactionSummary(encoded), "keep this handoff");
  assert.equal(decodeCompactionSummary("kcr1:!!not-base64!!"), undefined);
  assert.equal(decodeCompactionSummary("gAAAAAopaque"), undefined);
  assert.equal(decodeCompactionSummary("not prefixed"), undefined);
});

test("compact request detection distinguishes v1 paths and v2 triggers", () => {
  assert.equal(isCompactV1Request("/c/k123/v1/responses/compact"), true);
  assert.equal(isCompactV1Request("/v1/responses/compact"), true);
  assert.equal(isCompactV1Request("/responses/compact"), true);
  assert.equal(isCompactV1Request("/v1/responses"), false);
  assert.equal(isCompactV1Request(undefined), false);
  assert.equal(
    isCompactV2Request({
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "compaction_trigger" },
      ],
    }),
    true,
  );
  assert.equal(isCompactV2Request({ input: [{ type: "message", role: "user", content: [] }] }), false);
  assert.equal(isCompactV2Request({}), false);
});

test("normalizeGatewayInput expands kcr1 compaction items into continuation messages", () => {
  const input = [
    { type: "compaction", encrypted_content: encodeCompactionSummary("earlier context") },
    { type: "compaction_trigger", skipped: true },
  ];
  const normalized = normalizeGatewayInput(input);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].type, "message");
  assert.equal(normalized[0].role, "user");
  assert.match(normalized[0].content[0].text, /earlier context/);
});

test("normalizeNativeInput expands kcr1 compaction items and keeps opaque native tokens", () => {
  const input = [
    { type: "compaction", encrypted_content: encodeCompactionSummary("earlier context") },
    { type: "compaction", encrypted_content: "gAAAAABopaque_fernettoken" },
  ];
  const out = normalizeNativeInput(input);
  assert.equal(out[0].type, "message");
  assert.match(out[0].content[0].text, /earlier context/);
  assert.equal(out[1].encrypted_content, "gAAAAABopaque_fernettoken", "opaque native compaction token passes through");
});

test("normalizeGatewayInput keeps paired tool history untouched", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "call_00_x", name: "ls", arguments: "{}" },
    { type: "function_call_output", call_id: "call_00_x", output: "[]" },
  ];
  const normalized = normalizeGatewayInput(input);
  assert.deepEqual(normalized, input);
});

test("normalizeOpenCodeProInput fills reasoning ids missing from Codex's wire input", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "think one" }] },
    { type: "reasoning", id: "kept", content: [{ type: "reasoning_text", text: "think two" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] },
  ];
  const normalized = normalizeOpenCodeProInput(input);
  assert.match(normalized[1].id, /^reasoning_[0-9a-f]{16}$/, "missing id is synthesized");
  assert.equal(normalized[2].id, "kept", "existing id is untouched");
  assert.equal(normalized[0].id, undefined, "non-reasoning items are untouched");
});

test("normalizeOpenCodeProInput synthesizes reasoning ids deterministically per content", () => {
  const base = [{ type: "reasoning", content: [{ type: "reasoning_text", text: "same thought" }] }];
  const first = normalizeOpenCodeProInput(base);
  const second = normalizeOpenCodeProInput(base);
  assert.equal(first[0].id, second[0].id, "identical content yields a stable id across turns");
  const other = normalizeOpenCodeProInput([{ type: "reasoning", content: [{ type: "reasoning_text", text: "different thought" }] }]);
  assert.notEqual(first[0].id, other[0].id, "different content yields a different id");
});

test("normalizeOpenCodeProInput promotes a compacted reasoning summary to reasoning_text", () => {
  const normalized = normalizeOpenCodeProInput([
    {
      type: "reasoning",
      id: "rs_compacted",
      content: [],
      summary: [{ type: "summary_text", text: "  Recovered public reasoning summary.  " }],
      encrypted_content: "opaque-native-provider-state",
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);
  assert.equal(normalized[0].id, "rs_compacted");
  assert.deepEqual(normalized[0].content, [
    { type: "reasoning_text", text: "Recovered public reasoning summary." },
  ]);
  assert.equal(normalized[0].encrypted_content, undefined, "provider-private state is not sent to Console Go");
});

test("normalizeOpenCodeFlashInput repairs only summary-only reasoning", () => {
  const assistant = { type: "message", role: "assistant", content: [{ type: "output_text", text: "kept as an array" }] };
  const call = { type: "function_call", id: "fc_flash", call_id: "call_flash", name: "probe", arguments: "{}" };
  const output = { type: "function_call_output", call_id: "call_flash", output: "done" };
  const normalized = normalizeOpenCodeFlashInput([
    {
      type: "reasoning",
      id: "rs_flash",
      content: [],
      summary: [{ type: "summary_text", text: "  Flash public reasoning summary.  " }],
      encrypted_content: "opaque-native-provider-state",
    },
    assistant,
    call,
    output,
  ]);
  assert.deepEqual(normalized[0].content, [
    { type: "reasoning_text", text: "Flash public reasoning summary." },
  ]);
  assert.equal(normalized[0].encrypted_content, undefined);
  assert.deepEqual(normalized.slice(1), [assistant, call, output], "Pro-only assistant and tool rewrites stay disabled");
});

test("hoistLocalSystem merges mid-history system items into one leading system", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { role: "system", content: [{ type: "input_text", text: "mid note" }] },
    { role: "assistant", content: [{ type: "output_text", text: "hello" }] },
    { role: "system", content: [{ type: "input_text", text: "second note" }] },
  ];
  const out = hoistLocalSystem(input);
  assert.equal(out[0].role, "system", "system is hoisted to the front");
  assert.equal(out[0].content[0].text, "mid note\nsecond note", "system texts merge in order");
  assert.deepEqual(
    out.slice(1).map((i) => i.role),
    ["user", "assistant"],
    "mid-history system items are dropped, order preserved",
  );
  const passthrough = hoistLocalSystem([{ role: "user", content: [{ type: "input_text", text: "only" }] }]);
  assert.deepEqual(passthrough, [{ role: "user", content: [{ type: "input_text", text: "only" }] }], "no system -> passthrough");
});

test("normalizeLocalInput hoists system after generic gateway normalization", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "go" }] },
    { role: "system", content: [{ type: "input_text", text: "rules" }] },
  ];
  const out = normalizeLocalInput(input);
  assert.equal(out[0].role, "system", "system first for llama.cpp");
  assert.equal(out[1].role, "user");
});

test("normalizeLocalPayload merges system items into instructions when present", () => {
  const out = normalizeLocalPayload({
    instructions: "Base system prompt",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "system", content: [{ type: "input_text", text: "Checkpoint A" }] },
      { role: "user", content: [{ type: "input_text", text: "bye" }] },
    ],
  });
  assert.equal(out.instructions, "Base system prompt\nCheckpoint A", "system text merges into instructions");
  assert.deepEqual(
    out.input.map((i) => i.role),
    ["user", "user"],
    "system items are dropped from input when instructions exist",
  );
});

test("normalizeLocalPayload flattens array instructions before merging system", () => {
  const out = normalizeLocalPayload({
    instructions: [{ type: "input_text", text: "Base system prompt" }],
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "system", content: [{ type: "input_text", text: "Checkpoint A" }] },
      { role: "user", content: [{ type: "input_text", text: "bye" }] },
    ],
  });
  assert.equal(out.instructions, "Base system prompt\nCheckpoint A", "array instructions flatten and merge");
  assert.deepEqual(
    out.input.map((i) => i.role),
    ["user", "user"],
    "system dropped from input when instructions exist",
  );
});

test("normalizeLocalPayload treats developer role like system (Codex sends developer)", () => {
  const out = normalizeLocalPayload({
    instructions: "Base system prompt",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "developer", content: [{ type: "input_text", text: "Dev guidance" }] },
      { role: "system", content: [{ type: "input_text", text: "Sys guidance" }] },
      { role: "user", content: [{ type: "input_text", text: "bye" }] },
    ],
  });
  assert.equal(out.instructions, "Base system prompt\nDev guidance\nSys guidance", "developer+system merge into instructions in order");
  assert.deepEqual(
    out.input.map((i) => i.role),
    ["user", "user"],
    "both developer and system dropped from input",
  );
});

test("normalizeLocalPayload hoists system to the front without instructions", () => {
  const out = normalizeLocalPayload({
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "system", content: [{ type: "input_text", text: "rules" }] },
    ],
  });
  assert.equal(out.input[0].role, "system", "no instructions -> hoist to front");
  assert.equal(out.instructions, undefined, "no instructions field is added");
});

test("normalizeLocalInput rewrites Codex tool items to the standard wire for llama.cpp", () => {
  // llama.cpp implements the same Responses subset as Ollama and rejects Codex's
  // own item types. An agentic turn is almost always a tool call, so a custom
  // llama.cpp endpoint failed immediately without this rewrite.
  const input = [
    { role: "user", content: [{ type: "input_text", text: "run it" }] },
    { type: "local_shell_call", call_id: "c1", input: { command: ["ls"] } },
    { type: "local_shell_call_output", call_id: "c1", output: "ok" },
  ];
  const out = normalizeLocalInput(input);
  const call = out.find((item) => item.call_id === "c1" && item.type?.endsWith("_call"));
  const result = out.find((item) => item.call_id === "c1" && item.type?.endsWith("_call_output"));
  assert.equal(call?.type, "function_call", "local_shell_call becomes function_call");
  assert.equal(call?.arguments, JSON.stringify({ command: ["ls"] }), "input is serialized into arguments");
  assert.equal(call?.input, undefined, "the non-standard input field is dropped");
  assert.equal(result?.type, "function_call_output", "the output item is rewritten too");
});

test("normalizeLocalReasoning maps high to xhigh and drops unsupported efforts", () => {
  // Codex default "high" is rejected by llama.cpp qwen3.8 -> map to xhigh.
  const mapped = normalizeLocalReasoning({ model: "m", reasoning: { effort: "high" } });
  assert.equal(mapped.reasoning.effort, "xhigh", "high maps to the closest accepted value");
  // Valid llama.cpp efforts pass through.
  for (const effort of ["xhigh", "medium", "low"]) {
    const kept = normalizeLocalReasoning({ model: "m", reasoning: { effort } });
    assert.equal(kept.reasoning.effort, effort, `${effort} is preserved`);
  }
  // Unknown efforts are dropped entirely.
  const dropped = normalizeLocalReasoning({ model: "m", reasoning: { effort: "ultra" } });
  assert.equal("reasoning" in dropped, false, "unsupported effort is removed");
});

test("normalizeOllamaInput wraps double-encoded custom tool input as valid arguments", () => {
  // Each call needs its output: normalizeGatewayInput runs the pairing pass
  // first, and an unpaired call is dropped before the rewrite ever sees it.
  const out = normalizeOllamaInput([
    { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: '"*** Begin Patch\\n+hello"' },
    { type: "custom_tool_call_output", call_id: "c1", output: "applied" },
    { type: "local_shell_call", call_id: "c2", name: "exec_command", input: { cmd: "npm test" } },
    { type: "local_shell_call_output", call_id: "c2", output: "ok" },
  ]);
  const patch = out.find((i) => i.call_id === "c1");
  assert.equal(patch.type, "function_call");
  assert.doesNotThrow(() => JSON.parse(patch.arguments), "arguments must parse as JSON");
  const parsed = JSON.parse(patch.arguments);
  assert.equal(typeof parsed, "object", "arguments normalize to an object");
  const shell = out.find((i) => i.call_id === "c2");
  assert.deepEqual(JSON.parse(shell.arguments), { cmd: "npm test" }, "object input reserializes cleanly");
});

test("normalizeOpenCodeProInput drops opaque reasoning with no replayable text", () => {
  const normalized = normalizeOpenCodeProInput([
    { type: "reasoning", id: "rs_opaque", content: [], summary: [], encrypted_content: "opaque" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);
  assert.equal(normalized.some((item) => item.id === "rs_opaque"), false);
  assert.equal(normalized[0].role, "user");
});

test("normalizeOpenCodeProInput flattens assistant content arrays into chat-style strings", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "reasoning", id: "r1", content: [{ type: "reasoning_text", text: "think" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] },
  ];
  const normalized = normalizeOpenCodeProInput(input);
  assert.equal(normalized[0].content[0].type, "input_text", "user content stays an array");
  assert.equal(normalized[2].content, "pong", "assistant content array flattens to a string");
});

test("normalizeOpenCodeProInput leaves string assistant content and keeps completed tool turns", () => {
  const input = [
    { type: "message", role: "assistant", content: "already string" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "call" }] },
    { type: "function_call", call_id: "call_1", name: "x", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
  ];
  const normalized = normalizeOpenCodeProInput(input);
  assert.equal(normalized[0].content, "already string");
  assert.equal(normalized[1].content, "call");
  assert.equal(normalized[2].type, "function_call");
  assert.equal(normalized[3].type, "function_call_output");
  assert.equal(normalized[4].role, "user", "a trailing tool output gets an explicit continuation turn");
});

test("normalizeOpenCodeProInput drops empty assistant placeholders before custom tool history", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "use the result" }] },
    { type: "message", role: "assistant", content: [] },
    { type: "custom_tool_call", call_id: "call_1", name: "probe", input: "ALPHA" },
    { type: "custom_tool_call_output", call_id: "call_1", output: "ok" },
    { type: "message", role: "assistant", content: "" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
  const normalized = normalizeOpenCodeProInput(input);
  assert.equal(normalized.length, 4);
  assert.equal(normalized[0].role, "user");
  assert.equal(normalized[1].type, "custom_tool_call");
  assert.equal(normalized[2].type, "custom_tool_call_output");
  assert.equal(normalized[3].role, "user", "the original user continuation stays in place");
});

test("normalizeOpenCodeProInput keeps empty chat assistants that carry tool calls", () => {
  const input = [
    {
      type: "message",
      role: "assistant",
      content: [],
      tool_calls: [{ id: "call_1", type: "function", function: { name: "probe", arguments: "{}" } }],
    },
    { type: "message", role: "tool", tool_call_id: "call_1", content: "ok" },
  ];
  const normalized = normalizeOpenCodeProInput(input);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].content, "");
  assert.equal(normalized[0].tool_calls[0].id, "call_1");
});

test("normalizeOpenCodeProInput interleaves parallel calls with their outputs", () => {
  const input = [
    { type: "function_call", call_id: "call_a", name: "probe_a", arguments: "{}" },
    { type: "function_call", call_id: "call_b", name: "probe_b", arguments: "{}" },
    { type: "function_call_output", call_id: "call_a", output: "A" },
    { type: "function_call_output", call_id: "call_b", output: "B" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
  const normalized = normalizeOpenCodeProInput(input);
  assert.deepEqual(normalized.map((item) => item.call_id || item.type), [
    "call_a", "call_a", "call_b", "call_b", "message",
  ]);
  assert.equal(normalized[0].id, "call_a", "a missing function-call id is copied from call_id");
  assert.equal(normalized[2].id, "call_b", "every parallel call receives its own id");
});

test("normalizeOpenCodeProInput preserves an existing tool-call id", () => {
  const normalized = normalizeOpenCodeProInput([
    { type: "function_call", id: "fc_existing", call_id: "call_existing", name: "probe", arguments: "{}" },
    { type: "function_call_output", call_id: "call_existing", output: "ok" },
  ]);
  assert.equal(normalized[0].id, "fc_existing");
});

test("normalizeOpenCodeProInput appends a continuation when custom tool history is current", () => {
  const normalized = normalizeOpenCodeProInput([
    { type: "custom_tool_call", call_id: "call_custom", name: "apply_patch", input: "*** Begin Patch" },
    { type: "custom_tool_call_output", call_id: "call_custom", output: "Done" },
  ]);
  assert.equal(normalized[0].type, "custom_tool_call");
  assert.equal(normalized[1].type, "custom_tool_call_output");
  assert.equal(normalized[2].role, "user");
  assert.match(normalized[2].id, /^msg_pro_continue_[0-9a-f]{16}$/);
  assert.match(normalized[2].content[0].text, /Continue from the tool results/);
});

test("normalizeOpenCodeProInput appends a continuation after dropping a trailing empty assistant", () => {
  const normalized = normalizeOpenCodeProInput([
    { type: "function_call", call_id: "call_shell", name: "shell_command", arguments: "{}" },
    { type: "function_call_output", call_id: "call_shell", output: "ok" },
    { type: "message", role: "assistant", content: [] },
  ]);
  assert.deepEqual(normalized.map((item) => item.type), [
    "function_call", "function_call_output", "message",
  ]);
  assert.equal(normalized[2].role, "user");
  assert.match(normalized[2].id, /^msg_pro_continue_[0-9a-f]{16}$/);
  assert.match(normalized[2].content[0].text, /Continue from the tool results/);
});

test("normalizeOpenCodeProInput keeps action persistence guidance next to the current user turn", () => {
  const normalized = normalizeOpenCodeProInput([
    { type: "message", role: "user", content: [{ type: "input_text", text: "earlier" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "push now" }] },
  ]);
  assert.equal(normalized[0].content.length, 1, "historical user messages stay untouched");
  assert.equal(normalized[2].content[0].text, "push now");
  assert.match(normalized[2].content[1].text, /do not end with a progress update/);
  assert.match(normalized[2].content[1].text, /completed evidence or the blocker/);
});

test("normalizeGatewayInput does not add Pro execution guidance", () => {
  const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "push now" }] }];
  assert.deepEqual(normalizeGatewayInput(input), input);
});

test("describeInputShape reports item counts and reasoning shapes for the trace", () => {
  const shape = describeInputShape([
    { type: "message", role: "user" },
    { type: "reasoning", id: "rs_1", status: "completed", content: [{ type: "reasoning_text", text: "think" }], summary: [] },
    { type: "reasoning", id: "rs_2", status: "in_progress", content: [], summary: [] },
    { type: "function_call", call_id: "call_1" },
    { type: "function_call_output", call_id: "call_1" },
  ]);
  assert.equal(shape.itemTypes.message, 1);
  assert.equal(shape.itemTypes.reasoning, 2);
  assert.equal(shape.itemTypes.function_call, 1);
  assert.equal(shape.reasoning.length, 2);
  assert.deepEqual(shape.reasoning[0], {
    index: 1,
    status: "completed",
    contentTypes: ["reasoning_text"],
    hasReasoningText: true,
    hasSummary: false,
    hasId: true,
  });
  assert.equal(shape.reasoning[1].hasReasoningText, false);
  assert.equal(shape.reasoning[1].status, "in_progress");
});

test("describeInputShape tolerates malformed input", () => {
  assert.deepEqual(describeInputShape(null), { itemTypes: {}, reasoning: [] });
  assert.deepEqual(describeInputShape([null, 42, { type: "reasoning" }]).reasoning[0].status, "missing");
});

test("dropUnpairedToolItems keeps paired calls and drops both orphan sides", () => {
  const input = [
    { type: "function_call", call_id: "a", name: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "a", output: "1" },
    { type: "custom_tool_call", call_id: "b", name: "g", arguments: "{}" },
    { type: "custom_tool_call_output", call_id: "b", output: "2" },
    { type: "function_call", call_id: "orphan", name: "h", arguments: "{}" },
    { type: "function_call_output", call_id: "dangling", output: "3" },
    { type: "message", role: "user", content: [] },
  ];
  const out = dropUnpairedToolItems(input);
  assert.deepEqual(out.map((item) => item.call_id ?? item.type), ["a", "a", "b", "b", "message"]);
});

test("dropUnpairedToolItems pairs the chat shape (message.tool_calls + role:tool) too", () => {
  const input = [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "let me check" }],
      tool_calls: [
        { id: "call_00_orphan", type: "function", function: { name: "ls", arguments: "{}" } },
        { id: "call_00_paired", type: "function", function: { name: "read", arguments: "{}" } },
      ],
    },
    { type: "message", role: "tool", tool_call_id: "call_00_paired", content: "[]" },
    { type: "message", role: "tool", tool_call_id: "call_00_dangling", content: "[]" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
  ];
  const out = dropUnpairedToolItems(input);
  assert.equal(out.length, 3, "dangling tool message is dropped");
  assert.deepEqual(out[0].tool_calls.map((call) => call.id), ["call_00_paired"], "orphaned chat call is trimmed from the assistant message");
  assert.equal(out[1].tool_call_id, "call_00_paired");
  assert.equal(out[2].type, "message");
});

test("dropUnpairedToolItems drops an assistant message whose chat calls all lack results", () => {
  const input = [
    {
      type: "message",
      role: "assistant",
      tool_calls: [{ id: "call_00_zViPA3xCB2wYsU7H6dZW5091", type: "function", function: { name: "shell_command", arguments: "{}" } }],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
  const out = dropUnpairedToolItems(input);
  assert.deepEqual(out.map((item) => item.role), ["user"], "orphaned assistant tool call does not reach the upstream");
});

test("normalizeGatewayInput drops unpaired tool items from a sliced compact history", () => {
  const input = [
    { type: "function_call", call_id: "call_00_orphan", name: "ls", arguments: "{}" },
    { type: "custom_tool_call_output", call_id: "call_00_dangling", output: "{}" },
    { type: "function_call", call_id: "call_00_paired", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_00_paired", output: "{}" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
  ];
  const normalized = normalizeGatewayInput(input);
  assert.deepEqual(
    normalized.map((item) => item.call_id ?? item.type),
    ["call_00_paired", "call_00_paired", "message"],
  );
});

test("dropUnpairedToolItems relocates a severed output past an intervening assistant text", () => {
  // The compact task sliced an assistant turn apart: the tool result no longer
  // directly follows its call. Go's chat translation then emits the tool row
  // after a different assistant and rejects the whole request.
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "call_00_severed", name: "shell_command", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "lead-in text" }] },
    { type: "function_call_output", call_id: "call_00_severed", output: "done" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
  ];
  const out = dropUnpairedToolItems(input);
  assert.deepEqual(out.map((item) => item.call_id ?? item.type), [
    "message",
    "call_00_severed",
    "call_00_severed",
    "message",
    "message",
  ]);
  assert.equal(out[1].type, "function_call");
  assert.equal(out[2].type, "function_call_output", "output is relocated to directly follow its call");
  assert.equal(out[3].role, "assistant", "intervening assistant text moves after the tool row");
});

test("dropUnpairedToolItems keeps a parallel call group intact and moves interleaved text after the outputs", () => {
  const input = [
    { type: "function_call", call_id: "call_a", name: "f", arguments: "{}" },
    { type: "function_call", call_id: "call_b", name: "g", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "splitting note" }] },
    { type: "function_call_output", call_id: "call_a", output: "1" },
    { type: "function_call_output", call_id: "call_b", output: "2" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
  const out = dropUnpairedToolItems(input);
  assert.deepEqual(out.map((item) => item.call_id ?? item.type), [
    "call_a",
    "call_b",
    "call_a",
    "call_b",
    "message",
    "message",
  ]);
});

test("dropUnpairedToolItems drops duplicate outputs and an output that precedes its call", () => {
  const input = [
    { type: "function_call_output", call_id: "call_a", output: "first" },
    { type: "function_call", call_id: "call_a", name: "f", arguments: "{}" },
    { type: "function_call_output", call_id: "call_a", output: "duplicate" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "go on" }] },
  ];
  const out = dropUnpairedToolItems(input);
  assert.deepEqual(out.map((item) => item.call_id ?? item.type), ["call_a", "call_a", "message"]);
  assert.equal(out[1].output, "first", "the relocated output is the first one for the call");
});

test("normalizeGatewayInput repairs the real severed compact history shape", () => {
  // Live repro: an assistant text message sat between function_call
  // call_00_zViPA3xCB2wYsU7H6dZW5091 and its output; the upstream rejected the
  // request with "No tool output found for tool call call_00_...".
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "call_00_zViPA3xCB2wYsU7H6dZW5091", name: "shell_command", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "lead-in" }] },
    { type: "function_call_output", call_id: "call_00_zViPA3xCB2wYsU7H6dZW5091", output: "done" },
    { type: "function_call", call_id: "call_00_next", name: "shell_command", arguments: "{}" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "another lead-in" }] },
    { type: "function_call_output", call_id: "call_00_next", output: "ok" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
  const normalized = normalizeGatewayInput(input);
  const calls = normalized.filter((item) => item.type === "function_call");
  const outputs = normalized.filter((item) => item.type === "function_call_output");
  assert.equal(calls.length, 2);
  assert.equal(outputs.length, 2);
  // Each call is immediately followed by its own output in the repaired list.
  for (const call of calls) {
    const position = normalized.indexOf(call);
    assert.equal(normalized[position + 1]?.call_id, call.call_id);
    assert.equal(normalized[position + 1]?.type, "function_call_output");
  }
});

test("currentTurnStart is the item after the last assistant turn (or agentic marker)", () => {
  const input = [
    { type: "message", role: "user", content: [] },
    { type: "message", role: "assistant", content: [] },
    { type: "message", role: "user", content: [] },
  ];
  assert.equal(currentTurnStartForTesting(input), 2);
  assert.equal(currentTurnStartForTesting([{ type: "message", role: "user", content: [] }]), 0);
  assert.equal(
    currentTurnStartForTesting([
      { type: "message", role: "user", content: [] },
      { type: "function_call", name: "shell_command", arguments: "{}" },
      { type: "message", role: "user", content: [] },
    ]),
    2,
  );
});

test("rewriteHistoricalImages replaces all images with refs by default", () => {
  const mediaStore = {
    put: (url) => `img_${url.length}`,
  };
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "before" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "handled" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "current" }, { type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
  ];
  const rewritten = rewriteHistoricalImages(input, mediaStore);
  assert.match(rewritten[0].content[1].text, /\[Image attachment img_\d+\./);
  assert.equal(rewritten[0].content[1].type, "input_text");
  assert.equal(rewritten[2].content[1].type, "input_text", "current-turn image is also replaced by default");
  assert.equal(rewritten[1], input[1], "assistant history is untouched");
});

test("rewriteHistoricalImages preserves current images when requested", () => {
  const mediaStore = {
    put: (url) => `img_${url.length}`,
  };
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "handled" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "current" }, { type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
  ];
  const rewritten = rewriteHistoricalImages(input, mediaStore, { preserveCurrentImages: true });
  assert.equal(rewritten[0].content[0].type, "input_text", "historical image is replaced");
  assert.equal(rewritten[2].content[1].type, "input_image", "current-turn image stays untouched");
});

test("rewriteHistoricalImages degrades to a plain placeholder without a media store", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] },
    { type: "message", role: "assistant", content: [] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
  ];
  const rewritten = rewriteHistoricalImages(input, null);
  assert.equal(rewritten[0].content[0].type, "input_text");
  assert.match(rewritten[0].content[0].text, /handled in a prior turn/);
});

test("applyToolPolicy strips hosted tool schemas", () => {
  const tools = [
    { type: "function", name: "shell_command", parameters: {} },
    { type: "web_search", name: "web_search" },
    { type: "tool_search", name: "tool_search" },
    { type: "computer_use", name: "computer_use" },
  ];
  const { tools: kept, stripped } = applyToolPolicy(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, "shell_command");
  assert.equal(stripped.toolSearch, 1);
  assert.equal(stripped.webSearch, 1);
  assert.equal(stripped.otherHosted, 1);
  assert.equal(stripped.toolSearch + stripped.webSearch + stripped.otherHosted, 3);
});

test("applyToolPolicy hides view_image for text-only models", () => {
  const tools = [
    { type: "function", name: "view_image", parameters: {} },
    { type: "function", name: "vision_inspect", parameters: {} },
  ];
  const { tools: kept, stripped } = applyToolPolicy(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, "vision_inspect");
  assert.equal(stripped.hidden, 1);
});

test("applyToolPolicy flattens MCP namespaces into qualified functions", () => {
  const tools = [
    {
      type: "namespace",
      name: "namespace:mcp__test",
      tools: [
        { type: "function", name: "hello", parameters: {} },
        { type: "function", name: "view_image", parameters: {} },
      ],
    },
  ];
  const { tools: kept, stripped } = applyToolPolicy(tools);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].type, "function");
  assert.equal(kept[0].name, "namespace:mcp__test__hello");
  assert.equal(stripped.namespaceChildren, 1);
  assert.equal(stripped.hidden, 1);
});

test("applyToolPolicy whitelist keeps only allowed tools and counts trims", () => {
  const tools = [
    { type: "function", name: "exec_command" },
    { type: "function", name: "apply_patch" },
    { type: "function", name: "mcp__modeldock__recall_memory" },
    { type: "function", name: "mcp__modeldock__web_search_exa" },
    { type: "function", name: "mcp__github__create_issue" },
    { type: "function", name: "mcp__node_repl__js" },
    { type: "namespace", name: "mcp__sites", tools: [{ name: "deploy" }, { name: "create_site" }] },
  ];
  const { tools: kept, stripped } = applyToolPolicy(tools, {
    allowToolNames: new Set(["exec_command", "apply_patch", "mcp__modeldock__recall_memory", "mcp__modeldock__web_search_exa", "deploy"]),
  });
  assert.deepEqual(
    kept.map((t) => t.name),
    ["exec_command", "apply_patch", "mcp__modeldock__recall_memory", "mcp__modeldock__web_search_exa", "mcp__sites__deploy"],
    "only whitelisted survive",
  );
  assert.equal(stripped.allowlist, 3, "mcp flat + namespace child counts as trims");
});

test("isLocalBackend identifies loopback custom/ollama backends only", () => {
  const base = configStub();
  const customCfg = (baseUrl, ctx) => ({
    ...base,
    profileId: "custom",
    tokens: { ...base.tokens, custom: "k" },
    customBaseUrl: baseUrl,
    customModel: "qwen3.8:27b",
    profile: { id: "custom", availableModels: [{ id: "qwen3.8:27b", contextWindow: ctx }] },
  });
  assert.equal(
    isLocalBackend(customCfg("http://127.0.0.1:11435/v1", 80_000), "qwen3.8:27b@custom"),
    true,
    "a loopback custom backend is local",
  );
  assert.equal(isLocalBackend(customCfg("http://localhost:11435/v1", 128_000), "qwen3.8:27b@custom"), true, "localhost counts");
  assert.equal(
    isLocalBackend(customCfg("https://api.example.com/v1", 80_000), "qwen3.8:27b@custom"),
    false,
    "a remote custom endpoint is not local even with a small window",
  );
  assert.equal(isLocalBackend(customCfg("http://192.168.1.5:11435/v1", 80_000), "qwen3.8:27b@custom"), false, "a LAN host is not loopback");

  const ollamaCfg = {
    ...base,
    profileId: "ollama",
    ollamaBaseUrl: "http://127.0.0.1:11434",
    profile: { id: "ollama", availableModels: [{ id: "qwen3.8:27b", contextWindow: 80_000 }] },
  };
  assert.equal(isLocalBackend(ollamaCfg, "qwen3.8:27b@ollama"), true, "a loopback ollama backend is local");

  assert.equal(
    isLocalBackend(base, "deepseek-v4-flash@opencode-go"),
    false,
    "non-custom/ollama providers are never local",
  );
});

test("stripLocalInstructions keeps the local + office skills, compressed to one line", () => {
  const instructions = `<skills_instructions>
## Skills
- hyperframes: Mandatory video entry point (file: C:/x/hyperframes/SKILL.md)
- hyperframes-animation: Animation rules (file: C:/x/hyperframes-animation/SKILL.md)
- hyperframes-cli: CLI loop (file: C:/x/hyperframes-cli/SKILL.md)
- imagegen: Generate or edit raster images when the task benefits from AI-created bitmap visuals. Use when Codex should create a brand-new image. (file: C:/x/imagegen/SKILL.md)
- content-to-video: Turn arbitrary source content into a finished high-quality MP4 video with TTS voiceover and quality gates. Use when the user asks to make a video. (file: C:/x/content-to-video/SKILL.md)
- openai-docs: Use for Codex models, pricing, settings and OpenAI APIs. Do not use for generic tasks. (file: C:/x/openai-docs/SKILL.md)
- documents: Create, edit, redline and comment on Word documents with a render-and-verify workflow. Use for docx work. (file: C:/x/documents/SKILL.md)
- presentations: Read, create or edit PowerPoint or Google Slides decks. Use for slide deck work. (file: C:/x/presentations/SKILL.md)
- spreadsheets: Create, edit and verify spreadsheet files. Use for xlsx or sheets work. (file: C:/x/spreadsheets/SKILL.md)
- spreadsheets:excel-live-control: Control an open Excel workbook through the add-in. (file: C:/x/excel-live-control/SKILL.md)
- github:gh-fix-ci: Use when the user asks to debug CI. (file: C:/x/gh-fix-ci/SKILL.md)
</skills_instructions>`;
  const out = stripLocalInstructions(instructions);
  assert.ok(!out.includes("hyperframes"), "every hyperframes-* variant is removed");
  assert.ok(!out.includes("github"), "skills whose tools are not whitelisted are dropped");
  assert.ok(out.includes("imagegen"), "imagegen survives");
  assert.ok(out.includes("openai-docs") && out.includes("content-to-video"), "the four local skills survive");
  assert.ok(out.includes("documents"), "office skills whose tools are whitelisted survive");
  assert.ok(out.includes("presentations") && out.includes("spreadsheets"), "PPT and spreadsheet skills survive");
  assert.ok(out.includes("excel-live-control"), "the excel-live-control entry survives via the spreadsheets prefix");
  assert.ok(!out.includes("brand-new image"), "kept skills are compressed to one sentence (second sentence gone)");
  assert.ok(out.includes("(file: C:/x/imagegen/SKILL.md)"), "the locator is retained");
  assert.ok(out.includes("<skills_instructions>") && out.includes("</skills_instructions>"), "block structure intact");
});

test("stripLocalInstructions drops dead app-context, agent, and memory-ceremony sections", () => {
  const instructions = [
    "You are Codex.",
    "<app-context>\n### Images/Visuals/Files\n- Use markdown image syntax.\n### Automations\n- Use automation_update for reminders.\n### Thread Coordination\n- Use create_thread for threads.\n### Workspace Dependencies\n- Call load_workspace_dependencies for sheets.\n### Inline Code Comments\n- Use ::code-comment directives.\n### Git\n- Branch prefix: codex/.\n</app-context>",
    "Memory citation requirements:\n- append exactly one <oai-mem-citation> block\n- use rollout_ids to track sessions\n- never cite blank lines\nUpdating memories:\n- only when the user asks.",
    "<apps_instructions>\n- Apps are MCP tool sets.\n</apps_instructions>\nYou are `/root`, the primary agent in a team of agents.\nYou can use spawn_agent and send_message.\n<multi_agent_mode>Do not spawn sub-agents.</multi_agent_mode>",
  ].join("\n");
  const out = stripLocalInstructions(instructions);
  assert.ok(!out.includes("Automations"), "automation guidance dropped");
  assert.ok(!out.includes("Thread Coordination"), "thread guidance dropped");
  assert.ok(!out.includes("Workspace Dependencies"), "workspace-dependencies guidance dropped");
  assert.ok(out.includes("Images/Visuals/Files") && out.includes("Inline Code Comments") && out.includes("Branch prefix"), "functional app-context survives");
  assert.ok(!out.includes("oai-mem-citation"), "memory citation ceremony dropped");
  assert.ok(out.includes("Updating memories:"), "the updating-memories rule survives");
  assert.ok(!out.includes("spawn_agent"), "multi-agent guidance for non-whitelisted tools dropped");
  assert.ok(!out.includes("apps_instructions"), "apps-connector guidance dropped");
});

test("stripLocalInstructions handles array-of-parts instructions and leaves no-ops untouched", () => {
  const parts = [
    { type: "input_text", text: "You are Codex." },
    { type: "input_text", text: "<skills_instructions>\n- hyperframes: video (file: a)\n- github: gh (file: b)\n- imagegen: images (file: c)\n</skills_instructions>" },
  ];
  const out = stripLocalInstructions(parts);
  assert.equal(out[0], parts[0], "parts without the block are untouched");
  assert.ok(!out[1].text.includes("hyperframes"));
  assert.ok(!out[1].text.includes("github"), "skills with stripped tools do not survive");
  assert.ok(out[1].text.includes("imagegen"), "the four local skills survive in array parts");
  // No-op inputs are returned by reference so the upstream prefix cache is stable.
  const plain = "no skills block here";
  assert.equal(stripLocalInstructions(plain), plain);
  assert.equal(stripLocalInstructions(undefined), undefined);
  const onlyKept = "<skills_instructions>\n- imagegen: images (file: c)\n</skills_instructions>";
  assert.equal(stripLocalInstructions(onlyKept), onlyKept);
});

test("stripLocalInstructions compresses the platform action rule and restart text", () => {
  const instructions = [
    "You are Codex, a coding agent.",
    "IMPORTANT: To perform any action (read a file, run a command, search, edit, inspect an image), you MUST emit a function_call for the appropriate tool in THIS turn. Never describe an action in text and expect it to be performed. Never say 'let me read X' or 'I will do X' - emit the tool call now. If a previous turn's tool result was missing, re-emit the call.",
    'Restarting the gateway: if you need to restart the ModelDock service (e.g. after config or model changes), run: powershell -ExecutionPolicy Bypass -File "D:\\projects\\modeldock\\scripts\\restart.ps1". It stops the process on the configured port, starts a fresh detached instance, and prints \'started gateway from <root>\' once launched; wait for that line before continuing.',
  ].join("\n");
  const out = stripLocalInstructions(instructions);
  assert.ok(out.includes("You are Codex, a coding agent."), "the platform identity is untouched");
  assert.ok(out.includes("emitting a function_call"), "the action rule essence survives");
  assert.ok(!out.includes("Never say 'let me read X'"), "redundant action-rule reinforcement dropped");
  assert.ok(out.includes('"D:\\projects\\modeldock\\scripts\\restart.ps1"'), "the restart command survives");
  assert.ok(!out.includes("starts a fresh detached instance"), "restart explanation dropped");
  assert.ok(out.includes("wait for the \"started gateway\" line"), "the launch marker instruction survives");
});

test("relayResponses strips dead-weight sections from instructions for an 80K custom model", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ body: JSON.parse(options.body) });
    return summaryResponse("ok");
  };
  try {
    const services = {
      ...compactServices(),
      mainModel: "qwen3.8:27b@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "qwen3.8:27b@custom",
        customBaseUrl: "http://127.0.0.1:11435/v1",
        customModel: "qwen3.8:27b",
        profile: { availableModels: [{ id: "qwen3.8:27b", contextWindow: 81920 }] },
        tokens: { ...configStub().tokens, custom: "local-key" },
      },
      knownModels: new Set(["qwen3.8:27b@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const instructions = `<skills_instructions>\n- hyperframes: video (file: a)\n- imagegen: images (file: b)\n</skills_instructions>`;
    const result = await relayResponses(
      {
        model: "qwen3.8:27b@custom",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        instructions,
      },
      res,
      services,
    );
    assert.equal(result.ok, true);
    const sent = calls[0].body;
    assert.ok(!sent.instructions.includes("hyperframes"), "hyperframes stripped for an 80K custom model");
    assert.ok(sent.instructions.includes("imagegen"), "other skill entries survive the relay");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses keeps hyperframes for a 128K custom model", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ body: JSON.parse(options.body) });
    return summaryResponse("ok");
  };
  try {
    const services = {
      ...compactServices(),
      mainModel: "big-model@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "big-model@custom",
        customBaseUrl: "https://api.example.com/v1",
        customModel: "big-model",
        profile: { availableModels: [{ id: "big-model", contextWindow: 128000 }] },
        tokens: { ...configStub().tokens, custom: "big-key" },
      },
      knownModels: new Set(["big-model@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const instructions = `<skills_instructions>\n- hyperframes: video (file: a)\n- imagegen: images (file: b)\n</skills_instructions>`;
    const result = await relayResponses(
      { model: "big-model@custom", stream: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], instructions },
      res,
      services,
    );
    assert.equal(result.ok, true);
    assert.ok(calls[0].body.instructions.includes("hyperframes"), "128K+ custom models keep the full skills block");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses keeps codex_apps office tools for small-context custom models", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ body: JSON.parse(options.body) });
    return summaryResponse("ok");
  };
  try {
    const services = {
      ...compactServices(),
      mainModel: "qwen3.8:27b@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "qwen3.8:27b@custom",
        customBaseUrl: "http://127.0.0.1:11435/v1",
        customModel: "qwen3.8:27b",
        profile: { availableModels: [{ id: "qwen3.8:27b", contextWindow: 81920 }] },
        tokens: { ...configStub().tokens, custom: "local-key" },
      },
      knownModels: new Set(["qwen3.8:27b@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const tools = [
      { type: "function", name: "exec_command" },
      { type: "function", name: "mcp__codex_apps__codex_document_control___execute_d_7437ad2e4ffa" },
      { type: "function", name: "mcp__codex_apps__codex_document_control___get_docum_83c7f0565c0f" },
      { type: "function", name: "mcp__codex_apps__codex_document_control___list_document_sessions" },
      { type: "function", name: "mcp__codex_apps__github___create_issue" },
    ];
    const result = await relayResponses(
      {
        model: "qwen3.8:27b@custom",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools,
      },
      res,
      services,
    );
    assert.equal(result.ok, true);
    const names = (calls[0].body.tools || []).map((tool) => tool.name);
    assert.ok(
      names.includes("mcp__codex_apps__codex_document_control___execute_d_7437ad2e4ffa"),
      "office execute tool survives the whitelist",
    );
    assert.ok(names.includes("mcp__codex_apps__codex_document_control___list_document_sessions"), "office list survives");
    assert.ok(names.includes("exec_command"), "core tools still survive");
    assert.ok(!names.some((n) => n.includes("github___create_issue")), "github tools stay stripped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses keeps goal tools for small-context custom models", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ body: JSON.parse(options.body) });
    return summaryResponse("ok");
  };
  try {
    const services = {
      ...compactServices(),
      mainModel: "qwen3.8:27b@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "qwen3.8:27b@custom",
        customBaseUrl: "http://127.0.0.1:11435/v1",
        customModel: "qwen3.8:27b",
        profile: { availableModels: [{ id: "qwen3.8:27b", contextWindow: 81920 }] },
        tokens: { ...configStub().tokens, custom: "local-key" },
      },
      knownModels: new Set(["qwen3.8:27b@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const tools = [
      { type: "function", name: "get_goal" },
      { type: "function", name: "create_goal" },
      { type: "function", name: "update_goal" },
      { type: "function", name: "request_user_input" },
    ];
    const result = await relayResponses(
      {
        model: "qwen3.8:27b@custom",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools,
      },
      res,
      services,
    );
    assert.equal(result.ok, true);
    const names = (calls[0].body.tools || []).map((tool) => tool.name);
    for (const goal of ["get_goal", "create_goal", "update_goal"]) {
      assert.ok(names.includes(goal), `${goal} survives the whitelist`);
    }
    assert.ok(!names.includes("mcp__node_repl__js"), "other flat tools stay stripped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses keeps speak, hear, and request_user_input for small-context custom models", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ body: JSON.parse(options.body) });
    return summaryResponse("ok");
  };
  try {
    const services = {
      ...compactServices(),
      mainModel: "qwen3.8:27b@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "qwen3.8:27b@custom",
        customBaseUrl: "http://127.0.0.1:11435/v1",
        customModel: "qwen3.8:27b",
        profile: { availableModels: [{ id: "qwen3.8:27b", contextWindow: 81920 }] },
        tokens: { ...configStub().tokens, custom: "local-key" },
      },
      knownModels: new Set(["qwen3.8:27b@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const tools = [
      { type: "function", name: "mcp__modeldock__speak" },
      { type: "function", name: "mcp__modeldock__hear" },
      { type: "function", name: "request_user_input" },
      { type: "function", name: "mcp__node_repl__js" },
    ];
    const result = await relayResponses(
      {
        model: "qwen3.8:27b@custom",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools,
      },
      res,
      services,
    );
    assert.equal(result.ok, true);
    const names = (calls[0].body.tools || []).map((tool) => tool.name);
    assert.ok(names.includes("mcp__modeldock__speak"), "speak survives the whitelist");
    assert.ok(names.includes("mcp__modeldock__hear"), "hear survives the whitelist");
    assert.ok(names.includes("request_user_input"), "request_user_input survives the whitelist");
    assert.ok(!names.includes("mcp__node_repl__js"), "node_repl stays stripped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeOpenCodeProInput repairs duplicate tool calls persisted from a hybrid Pro stream", () => {
  const normalized = normalizeOpenCodeProInput([
    { type: "function_call", id: "fc_duplicate", call_id: "call_duplicate", name: "probe", arguments: "{}" },
    { type: "function_call", id: "fc_duplicate", call_id: "call_duplicate", name: "probe", arguments: "{}" },
    { type: "function_call_output", call_id: "call_duplicate", output: "first" },
    { type: "function_call_output", call_id: "call_duplicate", output: "duplicate" },
  ]);
  assert.equal(normalized.filter((item) => item.type === "function_call").length, 1);
  assert.equal(normalized.filter((item) => item.type === "function_call_output").length, 1);
  assert.deepEqual(normalized.slice(0, 2).map((item) => item.call_id), ["call_duplicate", "call_duplicate"]);
  assert.equal(normalized[1].output, "first");
});

test("upstreamTargetFor routes by owning provider", () => {
  const config = configStub();
  const go = upstreamTargetFor(config, "deepseek-v4-flash");
  assert.equal(go.provider, "opencode-go");
  assert.equal(go.url, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(go.token, "go-token");

  const ds = upstreamTargetFor(config, "deepseek-v4-flash@deepseek-official");
  assert.equal(ds.provider, "deepseek-official");
  assert.equal(ds.model, "deepseek-v4-flash");
  assert.equal(ds.url, "https://api.deepseek.com/responses");
  assert.equal(ds.token, "ds-token");

  // A bare id is a legacy reference and always means the default provider, even
  // when another profile is active: the picker label said OpenCode Go, so the
  // billing source must be OpenCode Go too.
  const legacyUnderDeepseekProfile = upstreamTargetFor({ ...config, profileId: "deepseek-official" }, "deepseek-v4-flash");
  assert.equal(legacyUnderDeepseekProfile.provider, "opencode-go");
  assert.equal(legacyUnderDeepseekProfile.url, "https://opencode.ai/zen/go/v1/responses");
  assert.equal(legacyUnderDeepseekProfile.token, "go-token");
});

test("upstreamTargetFor routes zen free models to the zen/v1 responses endpoint", () => {
  const config = configStub();
  const free = upstreamTargetFor(config, "deepseek-v4-flash-free");
  assert.equal(free.provider, "opencode-go");
  assert.equal(free.url, "https://opencode.ai/zen/v1/responses");
  assert.equal(free.token, "go-token");
  assert.equal(free.free, true, "free models are flagged so failures carry free-tier guidance");

  const mimo = upstreamTargetFor(config, "mimo-v2.5-free");
  assert.equal(mimo.url, "https://opencode.ai/zen/v1/responses");
  assert.equal(mimo.free, true);

  const paid = upstreamTargetFor(config, "deepseek-v4-flash");
  assert.equal(paid.free, false, "paid models keep the generic error hints");
});

test("freeResponseFailure classifies silent zen free 200 bodies", () => {
  assert.equal(freeResponseFailure({ id: "r", output: [], stop_reason: "max_output_tokens" }), "empty_output");
  assert.equal(
    freeResponseFailure({ id: "r", error: { type: "server_error", message: "upstream failed" } }),
    "upstream_error",
  );
  assert.equal(
    freeResponseFailure({
      id: "r",
      output: [{ id: "m", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
    }),
    null,
  );
  assert.equal(freeResponseFailure({ id: "r", output: [{ type: "reasoning" }] }), null);
  assert.equal(freeResponseFailure(null), null);
  assert.equal(freeResponseFailure([]), null);
});

test("routeGatewayRequest escalates current-turn images to the vision model", () => {
  const source = {
    model: "deepseek-v4-flash",
    input: [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] },
    ],
  };
  const route = routeGatewayRequest(source, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    affinity: new RouteAffinity(),
    knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
  });
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.directVision, true);
  assert.equal(route.reason, "current_turn_image");
});

test("routeGatewayRequest lets an explicit client model reclaim a stale vision pin", () => {
  const affinity = new RouteAffinity();
  affinity.register("call_00_vision", "gpt-5.6-luna");
  // Codex sends its picker model (deepseek) on the continuation. It must win over
  // the Luna pin left by an earlier image turn, so a single visual turn cannot
  // cascade the whole session onto Luna and never return to the selected model.
  const source = {
    model: "deepseek-v4-flash",
    input: [
      { type: "function_call_output", call_id: "call_00_vision", output: "{}" },
    ],
  };
  const route = routeGatewayRequest(source, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    affinity,
    knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
  });
  assert.equal(route.model, "deepseek-v4-flash");
  assert.notEqual(route.reason, "tool_continuation");
});

test("routeGatewayRequest defaults to the main model without images", () => {
  const source = {
    model: "deepseek-v4-flash",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };
  const route = routeGatewayRequest(source, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    affinity: new RouteAffinity(),
    knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
  });
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.directVision, false);
});

test("createUsageTee extracts usage from response.completed events across chunks", () => {
  const usages = [];
  const tee = createUsageTee((event) => {
    if (event?.type === "response.completed" && event.response?.usage) usages.push(event.response.usage);
  });
  const sse = [
    'event: response.completed\n',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
  ];
  tee.push(sse[0]);
  tee.push(sse[1]);
  tee.end();
  assert.equal(usages.length, 1);
  assert.equal(usages[0].input_tokens, 10);
  assert.equal(usages[0].output_tokens, 5);
});

test("createUsageTee extracts usage and output from a full non-streaming JSON body on end", () => {
  const events = [];
  const tee = createUsageTee((event) => events.push(event));
  const body = JSON.stringify({
    id: "resp_x",
    object: "response",
    status: "completed",
    output: [{ type: "function_call", call_id: "call_00_nonstream", name: "ls", arguments: "{}" }],
    usage: { input_tokens: 33, output_tokens: 9, total_tokens: 42 },
  });
  tee.push(body);
  tee.end();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "response.completed");
  assert.equal(events[0].response.usage.input_tokens, 33);
  assert.equal(events[0].response.output[0].call_id, "call_00_nonstream");
});

test("pipeGatewayStream forwards bytes verbatim and feeds the tee", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const teeChunks = [];
  let firstResponseCount = 0;
  const tee = createUsageTee(() => {});
  const originalPush = tee.push.bind(tee);
  tee.push = (chunk) => {
    teeChunks.push(Buffer.from(chunk));
    originalPush(chunk);
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
      controller.enqueue(Buffer.from(": keepalive\n\n"));
      controller.close();
    },
  });
  await pipeGatewayStream(body, res, tee, () => { firstResponseCount += 1; });
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.match(forwarded, /response\.output_text\.delta/);
  assert.match(forwarded, /keepalive/);
  assert.equal(Buffer.concat(teeChunks).toString("utf8"), forwarded);
  assert.equal(firstResponseCount, 1);
});

test("pipeGatewayStream settles when the client disconnects mid-stream", async () => {
  // A client disconnect emits "close" without "finish". The pipe must settle
  // (not hang forever) and must destroy the upstream reader so the fetch body
  // stops being consumed.
  let upstreamCancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from("data: first\n\n"));
      // Never closes: simulates an upstream still streaming.
    },
    cancel() {
      upstreamCancelled = true;
    },
  });
  const sink = collectStream();
  const res = responseStub(sink);
  const piping = pipeGatewayStream(body, res, null);
  // Give the first chunk a tick to flow, then drop the client.
  await new Promise((resolve) => setTimeout(resolve, 20));
  res.emit("close");
  const result = await piping;
  assert.equal(result.interrupted, true, "a close before a terminal event remains a real interruption");
  assert.equal(upstreamCancelled, true, "upstream body must be cancelled on client disconnect");
});

test("pipeNormalizedStream synthesizes the lifecycle for a bare-delta stream", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"id":"resp_1","type":"response.output_text.delta","delta":"ping","response":{"id":"resp_1","model":"deepseek-v4-pro"}}\n\n'));
      controller.enqueue(Buffer.from('data: {"id":"resp_1","type":"response.completed","response":{"id":"resp_1","model":"deepseek-v4-pro","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"ping","cost":"0"}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.equal(result.rewrote, true);
  assert.match(forwarded, /"type":"response\.created"/);
  assert.match(forwarded, /"type":"response\.output_item\.added"/);
  assert.match(forwarded, /"type":"response\.content_part\.added"/);
  assert.match(forwarded, /"type":"response\.output_text\.done"/);
  assert.match(forwarded, /"type":"response\.content_part\.done"/);
  assert.match(forwarded, /"type":"response\.output_item\.done"/);
  assert.match(forwarded, /"output":\[\{[^}]*"type":"message"/);
  assert.match(forwarded, /"delta":"ping"/);
  const parsedEvents = forwarded
    .split(/\r\n\r\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
  const addedItem = parsedEvents.find((event) => event.type === "response.output_item.added")?.item;
  const delta = parsedEvents.find((event) => event.type === "response.output_text.delta");
  assert.equal(delta.item_id, addedItem.id, "delta is framed onto the synthesized item");
  assert.equal(delta.output_index, 0);
  assert.equal(delta.content_index, 0);
});

test("pipeNormalizedStream recognizes bare deltas after a response prelude", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.created","response":{"id":"resp_prelude","model":"deepseek-v4-pro"}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.in_progress","response":{"id":"resp_prelude","model":"deepseek-v4-pro"}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"PRELUDE_OK"}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.completed","response":{"id":"resp_prelude","model":"deepseek-v4-pro"}}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const events = Buffer.concat(sink.chunks).toString("utf8")
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
  assert.equal(result.rewrote, true);
  assert.equal(result.failure, "");
  assert.equal(events.filter((event) => event.type === "response.created").length, 1, "the upstream prelude is not duplicated");
  assert.ok(events.some((event) => event.type === "response.output_item.added"), "missing item lifecycle is synthesized after the prelude");
  assert.equal(events.find((event) => event.type === "response.output_text.delta").item_id, "resp_prelude-message-0");
  assert.equal(events.find((event) => event.type === "response.completed").response.output[0].content[0].text, "PRELUDE_OK");
});

test("pipeNormalizedStream turns an empty Pro completion into an explicit failure", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.completed","response":{"id":"resp_empty","model":"deepseek-v4-pro","output":[]}}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.match(result.failure, /without an assistant message or tool call/);
  assert.match(forwarded, /"type":"response.failed"/);
  assert.doesNotMatch(forwarded, /"type":"response.completed"/);
});

test("pipeNormalizedStream fails when the Pro stream ends without a terminal event", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.match(result.failure, /before a terminal response event/);
  assert.match(forwarded, /"type":"response.failed"/);
});

test("pipeNormalizedStream passes a full lifecycle stream through unchanged", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const full = [
    'data: {"id":"resp_1","type":"response.created","response":{"id":"resp_1","model":"deepseek-v4-flash"}}\n\n',
    'data: {"id":"resp_1","type":"response.output_item.added","item":{"id":"m1","type":"message","role":"assistant","status":"in_progress"}}\n\n',
    'data: {"id":"resp_1","type":"response.content_part.added","item_id":"m1","part":{"type":"output_text","text":""}}\n\n',
    'data: {"id":"resp_1","type":"response.output_text.delta","delta":"ping","item_id":"m1"}\n\n',
    'data: {"id":"resp_1","type":"response.output_item.done","item":{"id":"m1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ping"}]}}\n\n',
    'data: {"id":"resp_1","type":"response.completed","response":{"id":"resp_1","model":"deepseek-v4-flash","output":[{"id":"m1","type":"message","role":"assistant","content":[{"type":"output_text","text":"ping"}]}]}}\n\n',
  ].join("");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(full));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.equal(result.rewrote, false, "a complete stream is not rewritten");
  assert.equal(forwarded, full, "bytes pass through unchanged");
});

test("pipeNormalizedStream frames a sparse function_call stream onto its item", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"id":"resp_1","type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"function_call","name":"shell_command","call_id":"call_1","arguments":""}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"command\\":\\"dir\\"}"}\n\n'));
      controller.enqueue(Buffer.from('data: {"id":"resp_1","type":"response.completed","response":{"id":"resp_1","model":"deepseek-v4-pro","usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.equal(result.rewrote, true);
  const parsedEvents = forwarded
    .split(/\r\n\r\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
  const delta = parsedEvents.find((event) => event.type === "response.function_call_arguments.delta");
  assert.equal(delta.item_id, "call_1", "argument delta is framed onto the function_call item");
  assert.ok(parsedEvents.some((event) => event.type === "response.function_call_arguments.done"), "argument done is synthesized");
  assert.ok(parsedEvents.some((event) => event.type === "response.output_item.done"), "output_item.done is synthesized");
  const completed = parsedEvents.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].type, "function_call", "completed carries the function_call output");
  assert.match(completed.response.output[0].arguments, /"command":"dir"/);
});

test("pipeNormalizedStream separates sparse parallel calls with repeated upstream indexes", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"function_call","name":"probe_a","call_id":"call_1","arguments":""}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"value\\":\\"ALPHA\\"}"}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_2","type":"function_call","name":"probe_b","call_id":"call_2","arguments":""}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"value\\":\\"BETA\\"}"}\n\n'));
      controller.enqueue(Buffer.from('data: {"id":"resp_1","type":"response.completed","response":{"id":"resp_1","model":"deepseek-v4-pro"}}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const events = Buffer.concat(sink.chunks).toString("utf8")
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
  assert.equal(result.rewrote, true);
  const added = events.filter((event) => event.type === "response.output_item.added");
  assert.deepEqual(added.map((event) => event.output_index), [0, 1]);
  const deltas = events.filter((event) => event.type === "response.function_call_arguments.delta");
  assert.deepEqual(deltas.map((event) => event.item_id), ["call_1", "call_2"]);
  assert.deepEqual(deltas.map((event) => event.output_index), [0, 1]);
  const completed = events.find((event) => event.type === "response.completed");
  assert.deepEqual(completed.response.output.map((item) => item.name), ["probe_a", "probe_b"]);
  assert.deepEqual(completed.response.output.map((item) => item.arguments), [
    '{"value":"ALPHA"}',
    '{"value":"BETA"}',
  ]);
});

test("redactBearer masks upstream tokens in error bodies", () => {
  const text = "Authorization: Bearer sk-abcdef123456, url https://x";
  const redacted = redactBearer(text);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.doesNotMatch(redacted, /sk-abcdef123456/);
});

test("relayResponses forwards a streamed response and records usage", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const blockedReports = [];
  const finishResults = [];
  const usageEvents = [];
  const metrics = {
    begin: () => (result) => finishResults.push(result),
    recordResponseTransform: (report) => blockedReports.push(report.blocked),
    recordResponseUsage: () => {},
  };
  const affinity = new RouteAffinity();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-luna","output":[{"type":"function_call","call_id":"call_00_vis","name":"x","arguments":"{}"}],"usage":{"input_tokens":4,"output_tokens":2,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":1}}}}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const result = await relayResponses(
      {
        model: "deepseek-v4-flash",
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/p.png" }] }],
        tools: [{ type: "web_search" }, { type: "function", name: "shell_command", parameters: {} }],
      },
      res,
      {
        recordUsage: (event) => usageEvents.push(event),
        config: configStub(),
        metrics,
        routeAffinity: affinity,
        knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.model, "gpt-5.6-luna");
    assert.equal(result.usage.input_tokens, 4);
    assert.match(calls[0].url, /opencode\.ai\/zen\/go\/v1\/responses/);
    const sentHeaders = Object.keys(calls[0].headers || {});
    assert.ok(!sentHeaders.some((name) => name.startsWith("x-opencode-")), "no opencode session spoofing headers are sent");
    assert.equal(affinity.snapshot().activeCallIds, 1);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.completed/);
    const blocked = blockedReports[blockedReports.length - 1];
    assert.deepEqual(blocked, { tool_search: 0, web_search: 1 }, "web_search is counted separately from tool_search");
    // The dashboard's context-token waveform reads recent[].inputTokens, which
    // comes from the finish() payload - regression guard for the flat-line bug.
    const finished = finishResults[finishResults.length - 1];
    assert.equal(finished.inputTokens, 4, "finish must carry input tokens onto the trace record");
    assert.equal(finished.outputTokens, 2, "finish must carry output tokens onto the trace record");
    assert.equal(usageEvents[0].cachedTokens, 3, "usage event must carry cached tokens from the upstream details");
    assert.equal(usageEvents[0].reasoningTokens, 1, "usage event must carry reasoning tokens from the upstream details");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses treats a client close after response.completed as success", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const finishResults = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":12,"output_tokens":4}}}\n\n'));
        // The transport remains open briefly after the semantic terminal event.
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  try {
    const pending = relayResponses(
      {
        model: "deepseek-v4-flash",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      },
      res,
      {
        recordUsage: () => {},
        config: configStub(),
        metrics: {
          begin: () => (result) => finishResults.push(result),
          recordResponseTransform: () => {},
          recordResponseUsage: () => {},
        },
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    while (sink.chunks.length === 0) await new Promise((resolve) => setImmediate(resolve));
    res.emit("close");
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.usage.output_tokens, 4);
    assert.equal(finishResults.at(-1).ok, true);
    assert.equal(finishResults.at(-1).error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses ends a mid-stream upstream failure with response.failed", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hel"}\n\n'));
          controller.error(new Error("upstream burst Bearer sk-abc123456"));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const result = await relayResponses(
      {
        model: "deepseek-v4-flash",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      },
      res,
      {
        recordUsage: () => {},
        config: configStub(),
        metrics: { begin: () => () => {}, recordResponseTransform: () => {}, recordResponseUsage: () => {} },
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    assert.equal(result.ok, false);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.failed/);
    assert.match(forwarded, /upstream_failed/);
    assert.match(forwarded, /upstream burst/, "the failure reason is passed to the client");
    assert.doesNotMatch(forwarded, /sk-abc123456/, "bearer tokens are redacted from the event");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses redacts upstream errors and never forwards the token", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "Bearer sk-secret123 rejected" } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
  try {
    const result = await relayResponses(
      { model: "deepseek-v4-flash", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      res,
      {
        recordUsage: () => {},
        config: configStub(),
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 400);
    const body = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(body, /Bearer \[redacted\]/);
    assert.doesNotMatch(body, /sk-secret123/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses rejects requests without a configured upstream token", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const config = configStub();
  config.tokens = { "opencode-go": "" };
  config.goToken = "";
  const result = await relayResponses(
    { model: "deepseek-v4-flash", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    res,
    {
      recordUsage: () => {},
      config,
      routeAffinity: new RouteAffinity(),
      knownModels: new Set(["deepseek-v4-flash"]),
      mainModel: "deepseek-v4-flash",
      visionModel: "gpt-5.6-luna",
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 503);
  const body = Buffer.concat(sink.chunks).toString("utf8");
  assert.match(body, /configuration_error/);
});

test("isNativeModel distinguishes catalog slugs from native GPT ids", () => {
  const known = new Set(["deepseek-v4-flash", "gpt-5.6-luna"]);
  assert.equal(isNativeModel("gpt-5.6-sol", known), true);
  assert.equal(isNativeModel("gpt-5.5", known), true);
  assert.equal(isNativeModel("deepseek-v4-flash", known), false);
  assert.equal(isNativeModel("gpt-5.6-luna", known), false);
  assert.equal(isNativeModel("", known), false, "an empty model id stays on the routed path");
  assert.equal(isNativeModel(undefined, known), false);
});

test("isNativeModel sends published native slugs to the native leg even when in the catalog", () => {
  const known = new Set(["deepseek-v4-flash", "gpt-5.6-luna", "gpt-5.6-sol"]);
  const nativeSlugs = new Set(["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.equal(isNativeModel("gpt-5.6-luna", known, nativeSlugs), true, "captured native slug routes native");
  assert.equal(isNativeModel("gpt-5.6-sol", known, nativeSlugs), true, "captured native slug routes native");
  assert.equal(isNativeModel("deepseek-v4-flash", known, nativeSlugs), false, "catalog model stays routed");
  assert.equal(isNativeModel("", known, nativeSlugs), false, "empty id stays on the routed path");
});

test("nativeTarget strips the keyed and bare /v1 prefixes", () => {
  assert.equal(nativeTarget("/c/k123/v1/responses", ""), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(nativeTarget("/v1/responses", ""), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(nativeTarget("/v1/images/generations", "?model=x"), "https://chatgpt.com/backend-api/codex/images/generations?model=x");
});

test("normalizeNativeInput strips non-opaque reasoning and expands summaries", () => {
  const input = [
    { type: "reasoning", encrypted_content: "local plaintext reasoning with spaces", summary: "kept" },
    { type: "reasoning", encrypted_content: "gAAAAABopaque_token_without_spaces", summary: "kept" },
    { type: "compaction", encrypted_content: [{ type: "summary_text", text: "earlier context" }] },
    { type: "compaction", encrypted_content: "gAAAAABopaque_fernettoken" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
  ];
  const out = normalizeNativeInput(input);
  assert.equal(out[0].encrypted_content, undefined, "non-opaque reasoning blob is stripped");
  assert.equal(out[0].summary, "kept");
  assert.equal(out[1].encrypted_content, "gAAAAABopaque_token_without_spaces", "opaque native token passes through");
  assert.equal(out[2].type, "message");
  assert.match(out[2].content[0].text, /earlier context/);
  assert.equal(out[3].encrypted_content, "gAAAAABopaque_fernettoken", "opaque compaction token passes through");
  assert.equal(out[4], input[4]);
});

test("normalizeNativeInput converts malformed encrypted agent messages to plain input", () => {
  const malformed = {
    type: "agent_message",
    content: [
      { type: "input_text", text: "Message Type: NEW_TASK" },
      { type: "encrypted_content", encrypted_content: "Run the status command and report back." },
    ],
  };
  const valid = {
    type: "agent_message",
    content: [
      { type: "encrypted_content", encrypted_content: "gAAAAABvalid_native_cipher_token" },
    ],
  };
  const out = normalizeNativeInput([malformed, valid]);
  assert.deepEqual(out[0].content[1], {
    type: "input_text",
    text: "Run the status command and report back.",
  });
  assert.equal(out[1], valid, "a real native encrypted part passes through byte-for-byte");
});

test("normalizeNativeInput leaves orphaned tool items untouched (native leg has no pairing filter)", () => {
  const orphan = { type: "function_call", call_id: "call_00_orphan", name: "ls", arguments: "{}" };
  const out = normalizeNativeInput([orphan]);
  assert.deepEqual(out, [orphan]);
});

test("relayNativeResponses forwards native GPT traffic to the ChatGPT backend", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3}}}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const result = await relayNativeResponses(
      {
        model: "gpt-5.6-sol",
        input: [
          { type: "reasoning", encrypted_content: "local plaintext reasoning" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          {
            type: "agent_message",
            content: [{ type: "encrypted_content", encrypted_content: "Run the probe and report back." }],
          },
        ],
        previous_response_id: "resp_old",
        tools: [{ type: "web_search" }],
      },
      res,
      {
        recordUsage: () => {},
        metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
        incomingHeaders: {
          authorization: "Bearer chatgpt-token",
          "chatgpt-account-id": "acct-1",
          "x-oai-attestation": "attest",
          "x-codex-window-id": "w1",
          host: "127.0.0.1:4097",
        },
        requestUrl: "/c/key123/v1/responses",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.upstream, "openai");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/responses");
    assert.equal(calls[0].headers.authorization, "Bearer chatgpt-token");
    assert.equal(calls[0].headers["chatgpt-account-id"], "acct-1");
    assert.equal(calls[0].headers["x-oai-attestation"], "attest");
    assert.equal(calls[0].headers["x-codex-window-id"], "w1");
    assert.equal(calls[0].headers.host, undefined, "loopback bookkeeping headers are not forwarded");
    assert.equal(calls[0].body.previous_response_id, undefined, "previous_response_id is dropped for native");
    assert.equal(calls[0].body.model, "gpt-5.6-sol");
    assert.equal(calls[0].body.input[0].encrypted_content, undefined, "non-opaque reasoning is stripped");
    assert.equal(calls[0].body.input[1].content[0].text, "hi");
    assert.deepEqual(calls[0].body.input[2].content[0], {
      type: "input_text",
      text: "Run the probe and report back.",
    }, "malformed encrypted agent content is repaired before the native fetch");
    assert.equal(result.usage.input_tokens, 9);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeResponses treats a client close after response.completed as success", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const finishResults = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":6}}}\n\n'));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  try {
    const pending = relayNativeResponses(
      { model: "gpt-5.6-sol", input: [{ type: "message", role: "user", content: [] }] },
      res,
      {
        recordUsage: () => {},
        metrics: {
          begin: () => (result) => finishResults.push(result),
          recordResponseTransform: () => {},
          recordResponseUsage: () => {},
        },
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/v1/responses",
      },
    );
    while (sink.chunks.length === 0) await new Promise((resolve) => setImmediate(resolve));
    res.emit("close");
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.usage.output_tokens, 6);
    assert.equal(finishResults.at(-1).ok, true);
    assert.equal(finishResults.at(-1).error, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeResponses records a streamed response.failed as an error", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const finishResults = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"Encrypted function output content could not be decrypted or decoded."}}}\n\n'));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  try {
    const result = await relayNativeResponses(
      { model: "gpt-5.6-luna", input: [] },
      res,
      {
        recordUsage: () => {},
        metrics: {
          begin: () => (value) => finishResults.push(value),
          recordResponseTransform: () => {},
          recordResponseUsage: () => {},
        },
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /could not be decrypted/);
    assert.equal(finishResults.at(-1).ok, false);
    assert.match(finishResults.at(-1).error, /could not be decrypted/);
    assert.match(Buffer.concat(sink.chunks).toString("utf8"), /response\.failed/,
      "the client still receives the native semantic failure event unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses registers Pro tool affinity from the rewritten completion", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const affinity = new RouteAffinity();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_pro","type":"function_call","name":"probe","call_id":"call_pro","arguments":""}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_pro","model":"deepseek-v4-pro","usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  try {
    const config = configStub();
    config.mainModel = "deepseek-v4-pro@opencode-go";
    const result = await relayResponses(
      {
        model: "deepseek-v4-pro@opencode-go",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "call probe" }] }],
        tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: {} } }],
      },
      res,
      {
        recordUsage: () => {},
        config,
        metrics: { begin: () => () => {}, recordResponseTransform: () => {}, recordResponseUsage: () => {} },
        routeAffinity: affinity,
        knownModels: new Set(["deepseek-v4-pro@opencode-go"]),
        mainModel: "deepseek-v4-pro@opencode-go",
        visionModel: "none",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(affinity.snapshot().activeCallIds, 1, "the synthesized completed output registers its call id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses sends summary-only Flash reasoning to Console Go as reasoning_text", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(
      'data: {"type":"response.completed","response":{"id":"resp_flash_compact","model":"deepseek-v4-flash","output":[]}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const config = configStub();
    config.mainModel = "deepseek-v4-flash@opencode-go";
    const call = { type: "function_call", id: "fc_flash", call_id: "call_flash", name: "probe", arguments: "{}" };
    const output = { type: "function_call_output", call_id: "call_flash", output: "driver status" };
    const result = await relayResponses(
      {
        model: "deepseek-v4-flash@opencode-go",
        stream: true,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Check the driver." }] },
          {
            type: "reasoning",
            id: "rs_flash_compacted",
            content: [],
            summary: [{ type: "summary_text", text: "Inspect the installed display driver." }],
            encrypted_content: "opaque-native-provider-state",
          },
          call,
          output,
        ],
        tools: [{ type: "function", name: "probe", parameters: { type: "object", properties: {} } }],
      },
      res,
      {
        recordUsage: () => {},
        config,
        metrics: { begin: () => () => {}, recordResponseTransform: () => {}, recordResponseUsage: () => {} },
        knownModels: new Set(["deepseek-v4-flash@opencode-go"]),
        mainModel: "deepseek-v4-flash@opencode-go",
        visionModel: "none",
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(upstreamBody.input[1].content, [
      { type: "reasoning_text", text: "Inspect the installed display driver." },
    ]);
    assert.equal(upstreamBody.input[1].encrypted_content, undefined);
    assert.deepEqual(upstreamBody.input.slice(2), [call, output], "Flash tool history is otherwise unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses sends compacted Pro reasoning to Console Go as reasoning_text", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(
      'data: {"type":"response.output_text.delta","delta":"done","response":{"id":"resp_pro_compact","model":"deepseek-v4-pro"}}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp_pro_compact","model":"deepseek-v4-pro"}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const config = configStub();
    config.mainModel = "deepseek-v4-pro@opencode-go";
    const result = await relayResponses(
      {
        model: "deepseek-v4-pro@opencode-go",
        stream: true,
        input: [
          {
            type: "reasoning",
            id: "rs_compacted",
            content: [],
            summary: [{ type: "summary_text", text: "Compacted reasoning summary" }],
            encrypted_content: "opaque-native-provider-state",
          },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      },
      res,
      {
        recordUsage: () => {},
        config,
        metrics: { begin: () => () => {}, recordResponseTransform: () => {}, recordResponseUsage: () => {} },
        knownModels: new Set(["deepseek-v4-pro@opencode-go"]),
        mainModel: "deepseek-v4-pro@opencode-go",
        visionModel: "none",
      },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(upstreamBody.input[0].content, [
      { type: "reasoning_text", text: "Compacted reasoning summary" },
    ]);
    assert.equal(upstreamBody.input[0].encrypted_content, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses records a streamed Pro response.failed as an error", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const finishResults = [];
  const usageEvents = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"type":"response.failed","response":{"id":"resp_fail","status":"failed","error":{"message":"thinking continuation rejected"}}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  try {
    const config = configStub();
    config.mainModel = "deepseek-v4-pro@opencode-go";
    const result = await relayResponses(
      { model: "deepseek-v4-pro@opencode-go", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] }] },
      res,
      {
        recordUsage: (event) => usageEvents.push(event),
        config,
        metrics: { begin: () => (value) => finishResults.push(value), recordResponseTransform: () => {}, recordResponseUsage: () => {} },
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-pro@opencode-go"]),
        mainModel: "deepseek-v4-pro@opencode-go",
        visionModel: "none",
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /thinking continuation rejected/);
    assert.equal(finishResults.at(-1).ok, false);
    assert.equal(usageEvents.at(-1).status, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeResponses forwards native errors untouched", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "native says no" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  try {
    const result = await relayNativeResponses(
      { model: "gpt-5.6-sol", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      res,
      {
        recordUsage: () => {},
        metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    const body = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(body, /native says no/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses routes unknown slugs to the native leg instead of default_main", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify({ error: { message: "x" } }), { status: 401 });
  };
  try {
    const result = await relayResponses(
      { model: "gpt-5.5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      res,
      {
        recordUsage: () => {},
        config: configStub(),
        metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0], /chatgpt\.com\/backend-api\/codex\/responses/);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses drops orphaned tool calls and previous_response_id on the routed leg", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from('event: response.completed\ndata: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const result = await relayResponses(
      {
        model: "deepseek-v4-flash",
        previous_response_id: "resp_1",
        input: [
          { type: "function_call", call_id: "call_00_zViPA3xCB2wYsU7H6dZW5091", name: "shell_command", arguments: "{}" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
        ],
      },
      res,
      {
        recordUsage: () => {},
        config: configStub(),
        metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.previous_response_id, undefined, "routed leg replays full history, no server-side continuation");
    assert.ok(!calls[0].body.input.some((item) => item.call_id === "call_00_zViPA3xCB2wYsU7H6dZW5091"), "orphaned call never reaches the upstream");
    assert.equal(calls[0].body.input.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeImage forwards image generation to the native backend", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ data: [{ b64_json: "abc" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await relayNativeImage(
      { model: "gpt-image-2", prompt: "a dashboard mockup", size: "1536x1024" },
      res,
      {
        incomingHeaders: { authorization: "Bearer chatgpt-token" },
        requestUrl: "/c/key123/v1/images/generations",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
    assert.equal(calls[0].body.prompt, "a dashboard mockup");
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /b64_json/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeImage resets a JSON response after partial bytes were forwarded", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return new Response(
      new ReadableStream({
        start(controller) {
          // A partial image JSON body, then the upstream connection dies.
          controller.enqueue(Buffer.from('{"data":[{"b64_json":"'));
          setTimeout(() => controller.error(new Error("image burst Bearer sk-abc123456")), 20);
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await relayNativeImage(
      { model: "gpt-image-2", prompt: "boom", size: "1024x1024" },
      res,
      { incomingHeaders: {}, requestUrl: "/c/key123/v1/images/generations" },
    );
    assert.equal(result.ok, false);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.equal(sink.destroyed, true, "a partial JSON response must be reset");
    assert.equal(forwarded, '{"data":[{"b64_json":"', "no synthetic payload may be appended to partial JSON");
    assert.doesNotMatch(forwarded, /response\.failed|upstream_failed|sk-abc123456/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayNativeImage emits a valid JSON error when upstream fails before body bytes", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    new ReadableStream({ start(controller) { controller.error(new Error("empty burst Bearer sk-abc123456")); } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
  try {
    const result = await relayNativeImage(
      { model: "gpt-image-2", prompt: "boom", size: "1024x1024" },
      res,
      { incomingHeaders: {}, requestUrl: "/c/key123/v1/images/generations" },
    );
    assert.equal(result.ok, false);
    const parsed = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.equal(parsed.error.type, "upstream_failed");
    assert.match(parsed.error.message, /empty burst/);
    assert.doesNotMatch(parsed.error.message, /sk-abc123456/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy provider/model slugs route to us instead of the native backend", async () => {
  const { normalizeLegacySlug } = await import("../src/gateway.mjs");
  const known = new Set(["deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go", "deepseek-v4-flash@deepseek-official"]);
  // codex-router era merged-catalog ids persisted in old threads:
  assert.equal(normalizeLegacySlug("opencode-go/deepseek-v4-flash", known), "deepseek-v4-flash@opencode-go");
  assert.equal(normalizeLegacySlug("opencode-go/gpt-5.6-luna", known), "gpt-5.6-luna@opencode-go");
  assert.equal(normalizeLegacySlug("deepseek-official/deepseek-v4-flash", known), "deepseek-v4-flash@deepseek-official");
  // Unknown stays untouched (genuinely native or garbage - upstream decides):
  assert.equal(normalizeLegacySlug("gpt-5.6-sol", known), "gpt-5.6-sol");
  assert.equal(normalizeLegacySlug("weird/unknown-model", known), "weird/unknown-model");
  assert.equal(isNativeModel(normalizeLegacySlug("opencode-go/deepseek-v4-flash", known), known), false, "legacy slug must not be treated as native");
});

test("unpaired tool calls and outputs are dropped before the upstream sees them", async () => {
  const { dropUnpairedToolItems } = await import("../src/gateway.mjs");
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "function_call", call_id: "call_ok", name: "ls", arguments: "{}" },
    { type: "function_call_output", call_id: "call_ok", output: "done" },
    // A compact-task slice severed this call from its output (Go 400s on it):
    { type: "function_call", call_id: "call_00_zViPA3xCB2wYsU7H6dZW5091", name: "ls", arguments: "{}" },
    // ...and this output from its call:
    { type: "custom_tool_call_output", call_id: "call_gone", output: "orphan" },
  ];
  const kept = dropUnpairedToolItems(input);
  assert.deepEqual(kept.map((item) => item.call_id ?? item.type), ["message", "call_ok", "call_ok"]);
  // And the full pipeline applies it:
  const normalized = normalizeGatewayInput(input);
  assert.ok(!normalized.some((item) => item.call_id === "call_00_zViPA3xCB2wYsU7H6dZW5091"));
});

function compactServices() {
  return {
    recordUsage: () => {},
    config: configStub(),
    metrics: { begin: () => () => {}, recordResponseUsage: () => {} },
    mediaStore: undefined,
    routeAffinity: new RouteAffinity(),
    knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    nativeSlugs: new Set(),
  };
}

function summaryResponse(text) {
  return new Response(JSON.stringify({
    id: "resp_summary",
    object: "response",
    model: "deepseek-v4-flash",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("relayResponses intercepts a v2 compact request and synthesizes a compaction output item", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return summaryResponse("compact summary");
  };
  try {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "compaction_trigger" },
    ];
    const result = await relayResponses(
      { model: "deepseek-v4-flash", stream: false, input },
      res,
      { ...compactServices(), requestUrl: "/v1/responses" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.model, "deepseek-v4-flash");
    assert.equal(calls.length, 1, "the compact request is synthesized, not forwarded raw");
    const sent = calls[0];
    assert.equal(sent.url, "https://opencode.ai/zen/go/v1/responses");
    assert.equal(sent.headers.Authorization, "Bearer go-token");
    assert.equal(sent.body.stream, false, "the summarize call is non-streaming");
    assert.deepEqual(sent.body.tools, [], "no tools ride on the summarize call");
    assert.equal(sent.body.tool_choice, "none");
    assert.equal(sent.body.previous_response_id, undefined);
    assert.ok(!sent.body.input.some((item) => item.type === "compaction_trigger"), "the trigger never reaches the upstream");
    assert.equal(sent.body.input.at(-1).role, "user");
    assert.match(sent.body.input.at(-1).content[0].text, /CONTEXT CHECKPOINT COMPACTION/);
    const body = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.equal(body.object, "response");
    assert.equal(body.output[0].type, "compaction");
    assert.match(body.output[0].encrypted_content, /^kcr1:/);
    assert.equal(decodeCompactionSummary(body.output[0].encrypted_content), "compact summary");
    assert.equal(body.model, "deepseek-v4-flash");
    assert.equal(body.usage.input_tokens, 10, "the summarize call's usage rides on the snapshot");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayCompaction applies the Pro duplicate-call repair before summarizing", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return summaryResponse("compact summary");
  };
  try {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "long task" }] },
      { type: "function_call", id: "fc_compact_duplicate", call_id: "call_compact_duplicate", name: "probe", arguments: "{}" },
      { type: "function_call", id: "fc_compact_duplicate", call_id: "call_compact_duplicate", name: "probe", arguments: "{}" },
      { type: "function_call_output", call_id: "call_compact_duplicate", output: "first" },
      { type: "function_call_output", call_id: "call_compact_duplicate", output: "duplicate" },
      { type: "compaction_trigger" },
    ];
    const config = { ...configStub(), mainModel: "deepseek-v4-pro@opencode-go" };
    const result = await relayResponses(
      { model: "deepseek-v4-pro@opencode-go", stream: false, input },
      res,
      {
        ...compactServices(),
        config,
        mainModel: "deepseek-v4-pro@opencode-go",
        visionModel: "none",
        knownModels: new Set(["deepseek-v4-pro@opencode-go"]),
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const sent = calls[0].body.input;
    assert.equal(sent.filter((item) => item.type === "function_call").length, 1);
    assert.equal(sent.filter((item) => item.type === "function_call_output").length, 1);
    assert.deepEqual(
      sent.filter((item) => item.call_id === "call_compact_duplicate").map((item) => item.type),
      ["function_call", "function_call_output"],
    );
    assert.ok(!sent.some((item) => item.type === "compaction_trigger"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pipeNormalizedStream does not duplicate lifecycle events from a hybrid sparse Pro stream", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"id":"resp_hybrid","type":"response.output_item.added","output_index":0,"item":{"id":"fc_hybrid","type":"function_call","name":"shell_command","call_id":"call_hybrid","arguments":""}}\n\n'));
      controller.enqueue(Buffer.from('data: {"id":"resp_hybrid","type":"response.output_item.added","output_index":0,"item":{"id":"fc_hybrid","type":"function_call","name":"shell_command","call_id":"call_hybrid","arguments":""}}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"command\\":\\"dir\\"}"}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.function_call_arguments.done","item_id":"fc_hybrid","output_index":0,"arguments":"{\\"command\\":\\"dir\\"}"}\n\n'));
      controller.enqueue(Buffer.from('data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_hybrid","type":"function_call","name":"shell_command","call_id":"call_hybrid","arguments":"{\\"command\\":\\"dir\\"}"}}\n\n'));
      controller.enqueue(Buffer.from('data: {"id":"resp_hybrid","type":"response.completed","response":{"id":"resp_hybrid","model":"deepseek-v4-pro","output":[{"id":"fc_hybrid","type":"function_call","name":"shell_command","call_id":"call_hybrid","arguments":"{\\"command\\":\\"dir\\"}"}]}}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const events = Buffer.concat(sink.chunks).toString("utf8")
    .split(/\r?\n\r?\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
  assert.equal(result.rewrote, true);
  assert.equal(events.filter((event) => event.type === "response.output_item.added").length, 1);
  assert.equal(events.filter((event) => event.type === "response.function_call_arguments.done").length, 1);
  assert.equal(events.filter((event) => event.type === "response.output_item.done").length, 1);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output.length, 1);
  assert.equal(completed.response.output[0].call_id, "call_hybrid");
});

test("relayCompaction hands the CPU extract straight back for a local backend (no upstream call)", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return summaryResponse("compact summary");
  };
  try {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first user turn" }] },
      { type: "message", role: "system", content: [{ type: "input_text", text: "mid-history system guidance" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "later user turn" }] },
      { type: "compaction_trigger" },
    ];
    const services = {
      ...compactServices(),
      mainModel: "qwen3.8:27b@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "qwen3.8:27b@custom",
        customBaseUrl: "http://127.0.0.1:11435/v1",
        customModel: "qwen3.8:27b",
        profile: { availableModels: [{ id: "qwen3.8:27b", contextWindow: 26214 }] },
        tokens: { ...configStub().tokens, custom: "local-key" },
      },
      knownModels: new Set(["qwen3.8:27b@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const result = await relayResponses(
      { model: "qwen3.8:27b@custom", stream: false, input },
      res,
      services,
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, "a local backend compact never calls the upstream summarize model");
    const body = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.equal(body.output[0].type, "compaction");
    const summary = decodeCompactionSummary(body.output[0].encrypted_content);
    assert.ok(summary.includes("USER: first user turn"), "the extract keeps the user asks");
    assert.ok(summary.includes("USER: later user turn"), "the extract keeps later user asks");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayCompaction applies local normalization on a large-context custom model too (matches the main relay path)", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return summaryResponse("compact summary");
  };
  try {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "first user turn" }] },
      { type: "message", role: "system", content: [{ type: "input_text", text: "mid-history system guidance" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "later user turn" }] },
      { type: "compaction_trigger" },
    ];
    const services = {
      ...compactServices(),
      mainModel: "big-model@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "big-model@custom",
        customBaseUrl: "https://api.example.com/v1",
        customModel: "big-model",
        profile: { availableModels: [{ id: "big-model", contextWindow: 128000 }] },
        tokens: { ...configStub().tokens, custom: "big-key" },
      },
      knownModels: new Set(["big-model@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const result = await relayResponses(
      { model: "big-model@custom", stream: false, input },
      res,
      services,
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1, "the compact request is synthesized, not forwarded raw");
    const sent = calls[0].body;
    // Context size must not disable the adaptation: a qwen3.8 server can
    // advertise 128K and still reject a mid-history system item, so the compact
    // path behaves like the main relay path and hoists system first regardless
    // of the advertised window.
    const roles = sent.input.map((item) => item.role);
    assert.equal(roles[0], "system", "system is hoisted to the very first position for a large-context custom model");
    assert.equal(roles.filter((r) => r === "system").length, 1, "exactly one system item reaches the upstream");
    assert.ok(!sent.input.some((item) => item.type === "compaction_trigger"), "the trigger never reaches the upstream");
    assert.match(sent.input.at(-1).content[0].text, /CONTEXT CHECKPOINT COMPACTION/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayCompaction streams a v2 compaction item over SSE when stream is not false", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => summaryResponse("stream summary");
  try {
    const result = await relayCompaction(
      {
        model: "deepseek-v4-flash",
        stream: true,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "compaction_trigger" },
        ],
      },
      res,
      compactServices(),
      {},
      true,
    );
    assert.equal(result.ok, true);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /event: response\.created/);
    assert.match(forwarded, /event: response\.output_item\.done/);
    assert.match(forwarded, /event: response\.completed/);
    assert.match(forwarded, /"type":"compaction"/);
    assert.match(forwarded, /kcr1:/);
    assert.match(forwarded, /data: \[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayCompaction returns the CPU-compressed extract directly for a large local history", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const usageEvents = [];
  const metrics = new (await import("../src/metrics.mjs")).Metrics({ recentLimit: 10 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ body: JSON.parse(options.body) });
    return summaryResponse("handoff summary");
  };
  try {
    const input = [];
    for (let i = 0; i < 60; i++) {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: `User request ${i} about the widget` }] });
      input.push({ type: "reasoning", content: [{ type: "reasoning_text", text: `thinking hard about step ${i} of the widget subsystem` }] });
      input.push({ type: "function_call", name: "exec_command", input: JSON.stringify({ cmd: `probe ${i}` }) });
      input.push({ type: "function_call_output", output: `result line ${i}\n${"x".repeat(300)}` });
      input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: `Handled ${i} by probing the widget.` }] });
    }
    input.push({ type: "compaction_trigger" });
    const services = {
      ...compactServices(),
      metrics,
      recordUsage: (event) => usageEvents.push(event),
      mainModel: "qwen3.8:27b@custom",
      visionModel: "gpt-5.6-luna",
      config: {
        ...configStub(),
        mainModel: "qwen3.8:27b@custom",
        customBaseUrl: "http://127.0.0.1:11435/v1",
        customModel: "qwen3.8:27b",
        profile: { availableModels: [{ id: "qwen3.8:27b", contextWindow: 81920 }] },
        tokens: { ...configStub().tokens, custom: "local-key" },
      },
      knownModels: new Set(["qwen3.8:27b@custom", "deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
      requestUrl: "/v1/responses",
    };
    const result = await relayCompaction(
      { model: "qwen3.8:27b@custom", stream: false, input },
      res,
      services,
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, "a large local history is compacted on the CPU with no upstream call");
    const body = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.equal(body.output[0].type, "compaction");
    const summary = decodeCompactionSummary(body.output[0].encrypted_content);
    assert.ok(summary.includes("User request 0"), "the extract keeps the early task definition");
    assert.ok(summary.includes("User request 59"), "the extract keeps the tail verbatim");
    assert.ok(summary.includes("TOOLS_AGGREGATED"), "older tool calls are aggregated in the extract");
    // The trace records the compression so it is visible in the dashboard.
    // The exact ratio is content-dependent, so only the field's presence is
    // asserted - the structural content checks above are the real contract.
    const trace = metrics.recent.find((r) => r.operation === "compact_v2");
    assert.ok(trace?.compression, "the compact trace records the compression");
    // No inputTokens: this path makes no upstream call, so it consumes none.
    // inputTokens means "tokens the upstream billed" everywhere it is read - the
    // context column, the context waveform, the cache-rate denominator - and an
    // estimate of the pre-compression history (fromChars/3, so ~460K for a 1.4M
    // char history) would land in that series as its peak, with no way to tell
    // estimate from measurement afterwards. The size is reported as measured
    // characters in `compression` instead.
    assert.equal(trace.inputTokens, undefined, "a compact with no upstream call reports no upstream tokens");
    assert.ok(trace.compression.fromChars > trace.compression.toChars, "the history size is still reported, in characters");
    const event = usageEvents.find((e) => e.route === "compact_v2");
    assert.ok(event?.compression, "the usage event records the compression");
    assert.equal(event.compression.fromChars, trace.compression.fromChars);
    assert.equal(event.compression.toChars, trace.compression.toChars);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses synthesizes v1 replacement history on the compact path", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return summaryResponse("compact summary");
  };
  try {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "recent message" }] },
    ];
    const result = await relayResponses(
      { model: "deepseek-v4-flash", input },
      res,
      { ...compactServices(), requestUrl: "/v1/responses/compact" },
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    const body = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.ok(Array.isArray(body.output));
    assert.equal(body.output.at(-1).role, "user");
    assert.match(body.output.at(-1).content[0].text, /compact summary/);
    assert.equal(body.output[0].content[0].text, "recent message", "recent user messages are kept in replacement history");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses counts the request body bytes as transfer-in", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const transformOptions = [];
  const metrics = {
    begin: () => () => {},
    recordResponseTransform: (_report, options) => transformOptions.push(options),
    recordResponseUsage: () => {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => summaryResponse("ok");
  try {
    const payload = {
      model: "deepseek-v4-flash",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    };
    const result = await relayResponses(payload, res, { ...compactServices(), metrics, requestUrl: "/v1/responses" });
    assert.equal(result.ok, true);
    assert.equal(transformOptions.length, 1);
    assert.equal(transformOptions[0].bytesIn, Buffer.byteLength(JSON.stringify(payload)), "the request body size rides as transfer-in");
    assert.equal(transformOptions[0].streaming, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayCompaction reports the failure telemetry when the upstream rejects the summarize call", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const finishes = [];
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-compact-state-"));
  const previousStateDir = process.env.MODELDOCK_STATE_DIR;
  process.env.MODELDOCK_STATE_DIR = stateDir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "invalid_api_key", type: "invalid_request_error" } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
  try {
    const result = await relayCompaction(
      {
        model: "deepseek-v4-flash",
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "compaction_trigger" },
        ],
      },
      res,
      {
        ...compactServices(),
        metrics: {
          begin: () => (telemetry) => finishes.push(telemetry),
          recordResponseUsage: () => {},
        },
      },
      {},
      true,
    );
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401, "the upstream 401 is reported, not a swallowed 502");
    assert.equal(finishes.length, 1, "the failure finish fires exactly once");
    assert.equal(finishes[0].httpStatus, 401);
    assert.deepEqual(
      finishes[0].requestShape.itemTypes,
      { message: 1, compaction_trigger: 1 },
      "the request shape rides the failure telemetry",
    );
    const body = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.equal(body.error.type, "auth_failed", "the 401 is translated into the auth_failed class");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousStateDir === undefined) delete process.env.MODELDOCK_STATE_DIR;
    else process.env.MODELDOCK_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("compactFailureReport names unpaired tool items and any server-side state keys", () => {
  const report = compactFailureReport(
    {
      model: "deepseek-v4-flash",
      conversation: "conv_123",
      input: [
        { type: "function_call", call_id: "call_paired", name: "shell_command", arguments: "{}" },
        { type: "function_call_output", call_id: "call_paired", output: "secret output" },
        { type: "function_call", call_id: "call_orphan", name: "shell_command", arguments: "{}" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "secret prompt" }] },
      ],
    },
    { status: 400, upstreamError: "No tool output found for tool call call_orphan." },
  );
  assert.equal(report.inputItems, 4);
  assert.deepEqual(report.unpairedToolItems, [{ id: "call_orphan", call: "function_call" }]);
  assert.deepEqual(report.stateKeys, ["conversation"], "server-side continuation keys are the prime suspect");
  assert.equal(report.itemTypes.function_call, 2);
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes("secret output"), "tool output text must never be recorded");
  assert.ok(!serialized.includes("secret prompt"), "prompt text must never be recorded");
});

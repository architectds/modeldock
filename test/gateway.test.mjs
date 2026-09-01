import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { MediaStore, describeImageUrl } from "../src/media-store.mjs";
import { CodexAttachmentIndex } from "../src/codex-attachment-index.mjs";
import { baseInstructionsFor } from "../src/catalog.mjs";
import { applyLocalEngineProfile } from "../src/profiles.mjs";
import { currentTurnStartIndex } from "../src/router.mjs";
import {
  RouteAffinity,
  adaptImageUrlShape,
  applyToolPolicy,
  compactFailureReport,
  collaborationRelayCacheSnapshot,
  constrainImagesForTransport,
  createUsageTee,
  decodeCompactionSummary,
  describeInputShape,
  dropUnpairedToolItems,
  encodeCompactionSummary,
  freeResponseFailure,
  hiddenToolNamesForModel,
  hydrateImageRefsForVision,
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
  LOCAL_TOOL_ALLOWLIST,
  flattenNamespaceCalls,
  pipeNormalizedStream,
  promoteToolOutputImages,
  RECENT_IMAGE_WINDOW,
  restoreNamespaceCall,
  redactBearer,
  relayCompaction,
  relayNativeImage,
  relayNativeResponses,
  relayOpaqueCollaboration,
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

test("normalizeGatewayInput promotes collaboration NEW_TASK out of reasoning", () => {
  const payload = "read changes-audit.md and revert A4/A5/A7 only";
  const normalized = normalizeGatewayInput([
    {
      type: "reasoning",
      content: [{ type: "reasoning_text", text: `Message Type: NEW_TASK\nTask name: /root/revert_herdr\nPayload:\n${payload}` }],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\nCanva\n" }] },
  ]);
  assert.equal(normalized.at(-1).role, "user");
  assert.equal(normalized.at(-1).content[0].text, payload);
});

test("normalizeGatewayInput promotes the live split NEW_TASK agent_message shape", () => {
  const payload = "Write the exact token VERIFIED-SUBAGENT-TASK-9de2 into RESULT.txt";
  const normalized = normalizeGatewayInput([
    {
      type: "agent_message",
      content: [
        {
          type: "input_text",
          text: "Message Type: NEW_TASK\nTask name: /root/verify_subagent_delivery\nSender: /root\nPayload:\n",
        },
        { type: "encrypted_content", encrypted_content: payload },
      ],
    },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\nCanva\n" }] },
  ]);
  assert.equal(normalized.at(-1).role, "user");
  assert.equal(normalized.at(-1).content[0].text, payload);
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

test("normalizeGatewayInput keeps one complete pair for a repeated call id", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
    { type: "function_call", id: "fc_first", call_id: "call_duplicate", name: "shell_command", arguments: "{\"command\":\"dir\"}" },
    { type: "function_call", id: "fc_repeated", call_id: "call_duplicate", name: "shell_command", arguments: "{\"command\":\"dir\"}" },
    { type: "function_call_output", id: "fco_first", call_id: "call_duplicate", output: "first result" },
    { type: "function_call_output", id: "fco_repeated", call_id: "call_duplicate", output: "repeated result" },
  ];
  const normalized = normalizeGatewayInput(input);
  assert.deepEqual(
    normalized.filter((item) => item.call_id === "call_duplicate").map((item) => [item.type, item.id]),
    [["function_call", "fc_first"], ["function_call_output", "fco_first"]],
  );
});

test("normalizeOpenCodeFlashInput inherits duplicate call-id repair", () => {
  const normalized = normalizeOpenCodeFlashInput([
    { type: "function_call", id: "fc_first", call_id: "call_duplicate", name: "shell_command", arguments: "{}" },
    { type: "function_call", id: "fc_repeated", call_id: "call_duplicate", name: "shell_command", arguments: "{}" },
    { type: "function_call_output", id: "fco_first", call_id: "call_duplicate", output: "first result" },
    { type: "function_call_output", id: "fco_repeated", call_id: "call_duplicate", output: "repeated result" },
  ]);
  assert.deepEqual(
    normalized.filter((item) => item.call_id === "call_duplicate").map((item) => [item.type, item.id]),
    [["function_call", "fc_first"], ["function_call_output", "fco_first"]],
  );
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
  assert.match(rewritten[0].content[1].text, /\[Image attachment img_\d+: if visual evidence is needed, call vision_inspect\(image_ref=/);
  assert.equal(rewritten[0].content[1].type, "input_text");
  assert.equal(rewritten[2].content[1].type, "input_text", "current-turn image is also replaced by default");
  assert.equal(rewritten[1], input[1], "assistant history is untouched");
  assert.match(rewritten[0].content[1].text, /vision_inspect\(image_ref=/);
  assert.match(rewritten[0].content[1].text, /specific visual question/);
});

test("rewriteHistoricalImages preserves all image bytes for a vision-capable target", () => {
  const mediaStore = {
    put: (url) => `img_${url.length}`,
  };
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "handled" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "current" }, { type: "input_image", image_url: "data:image/png;base64,BBBB" }] },
  ];
  const rewritten = rewriteHistoricalImages(input, mediaStore, { preserveImages: true });
  assert.equal(rewritten, input, "the complete visual history reaches a vision-capable target");
  assert.equal(rewritten[0].content[0].type, "input_image", "an image before an assistant turn stays readable");
  assert.equal(rewritten[2].content[1].type, "input_image", "a newer image also stays readable");
});

test("hydrateImageRefsForVision restores a stored image only for a visual route", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const input = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: '[Image attachment img_visual_ref: use vision_inspect with image_ref "img_visual_ref" if visual evidence is needed.]' }],
  }];
  const output = hydrateImageRefsForVision(input, {
    get: (ref) => {
      assert.equal(ref, "img_visual_ref");
      return { imageUrl: dataUrl };
    },
  });
  assert.notEqual(output, input);
  assert.equal(output[0].content.at(-1).type, "input_image");
  assert.equal(output[0].content.at(-1).image_url, dataUrl);
  assert.equal(hydrateImageRefsForVision(input, undefined), input, "a text route leaves references as text");

  const legacy = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "[Image attachment img_legacy_ref. Its visual contents were handled earlier.]" }],
  }];
  const restoredLegacy = hydrateImageRefsForVision(legacy, { get: () => ({ imageUrl: dataUrl }) });
  assert.equal(restoredLegacy[0].content.at(-1).image_url, dataUrl, "pre-upgrade compaction hints also recover their image");
});

test("rewriteHistoricalImages degrades to a plain placeholder without a media store", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.com/x.png" }] },
    { type: "message", role: "assistant", content: [] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
  ];
  const rewritten = rewriteHistoricalImages(input, null);
  assert.equal(rewritten[0].content[0].type, "input_text");
  assert.match(rewritten[0].content[0].text, /unavailable by reference/);
});

test("visual routes keep the current images plus only the newest bounded history", () => {
  const refs = new Map();
  const mediaStore = {
    put: (url) => {
      if (!refs.has(url)) refs.set(url, `img_${refs.size}`);
      return refs.get(url);
    },
  };
  const image = (label) => `data:image/png;base64,${Buffer.from(label).toString("base64")}`;
  const input = [];
  for (let index = 0; index < RECENT_IMAGE_WINDOW + 5; index += 1) {
    input.push({ type: "message", role: "user", content: [{ type: "input_image", image_url: image(`old-${index}`) }] });
    input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: "handled" }] });
  }
  input.push({ type: "message", role: "user", content: [
    { type: "input_image", image_url: image("current-a") },
    { type: "input_image", image_url: image("current-b") },
  ] });

  const output = rewriteHistoricalImages(input, mediaStore, {
    preserveImages: true,
    keepRecentImages: RECENT_IMAGE_WINDOW,
    keepCurrentImages: true,
  });
  const historical = output.slice(0, -1).flatMap((item) => item.content || []);
  assert.equal(historical.filter((part) => part.type === "input_image").length, RECENT_IMAGE_WINDOW);
  assert.equal(historical.filter((part) => part.type === "input_text" && /Image attachment img_/.test(part.text)).length, 5);
  assert.equal(output.at(-1).content.filter((part) => part.type === "input_image").length, 2, "a multi-image current turn is never clipped by the history window");
});

test("visual ref hydration is limited to the requested window", () => {
  const input = Array.from({ length: RECENT_IMAGE_WINDOW + 5 }, (_, index) => ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `[Image attachment img_${index}: use vision_inspect with image_ref "img_${index}" if visual evidence is needed.]` }],
  }));
  const allowed = new Set(Array.from({ length: RECENT_IMAGE_WINDOW }, (_, index) => `img_${index + 5}`));
  const output = hydrateImageRefsForVision(input, {
    get: (ref) => ({ imageUrl: `data:image/png;base64,${Buffer.from(ref).toString("base64")}` }),
  }, { refs: allowed });
  assert.equal(output.flatMap((item) => item.content).filter((part) => part.type === "input_image").length, RECENT_IMAGE_WINDOW);
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

test("visual tool policy separates direct inspection from delegated inspection", () => {
  const tools = [
    { type: "function", name: "view_image", parameters: {} },
    { type: "function", name: "mcp__modeldock__vision_inspect", parameters: {} },
    {
      type: "namespace",
      name: "mcp__modeldock__",
      tools: [
        { name: "preview_images", inputSchema: { type: "object" } },
        { name: "vision_inspect", inputSchema: { type: "object" } },
      ],
    },
  ];
  const text = applyToolPolicy(tools, {
    hiddenToolNames: hiddenToolNamesForModel({ supportsVision: false }),
  });
  assert.deepEqual(text.tools.map((tool) => tool.name), [
    "mcp__modeldock__vision_inspect",
    "mcp__modeldock__preview_images",
    "mcp__modeldock__vision_inspect",
  ]);
  assert.equal(text.stripped.hidden, 1);

  const vision = applyToolPolicy(tools, {
    hiddenToolNames: hiddenToolNamesForModel({ supportsVision: true }),
  });
  assert.deepEqual(vision.tools.map((tool) => tool.name), [
    "view_image",
    "mcp__modeldock__preview_images",
  ]);
  assert.equal(vision.stripped.hidden, 2);
});

test("applyToolPolicy reuses an already-valid ordinary function descriptor", () => {
  const tool = {
    type: "function",
    name: "read_file",
    description: "Read one file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };
  const { tools } = applyToolPolicy([tool]);
  assert.equal(tools[0], tool, "a provider-ready descriptor is not deep-cloned just to serialize it again");
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
  assert.deepEqual(kept[0].parameters, { type: "object", properties: {}, additionalProperties: false });
  assert.equal(stripped.namespaceChildren, 1);
  assert.equal(stripped.hidden, 1);
});

test("promoteToolOutputImages keeps tool text and moves visual bytes into a real image message", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const input = [{
    type: "custom_tool_call_output",
    call_id: "call_emit",
    output: [
      { type: "input_text", text: "rendered" },
      { type: "input_image", image_url: dataUrl },
    ],
  }];
  const promoted = promoteToolOutputImages(input);
  assert.deepEqual(promoted.map((item) => item.type), ["custom_tool_call_output", "message"]);
  assert.deepEqual(promoted[0].output, [{ type: "input_text", text: "rendered" }]);
  assert.equal(promoted[1].role, "user");
  assert.equal(promoted[1].content[1].image_url, dataUrl);
  assert.doesNotMatch(JSON.stringify(promoted[0]), /data:image/, "the tool text no longer carries base64 pixels");
});

test("tool outputs are ordered before their images are promoted so old visual batches become refs", () => {
  const oldImage = "data:image/png;base64,OLD";
  const currentImage = "data:image/png;base64,CURRENT";
  const meta = (turn_id) => ({ internal_chat_message_metadata_passthrough: { turn_id } });
  const interleavedCodexOrder = [
    { ...meta("turn_old"), type: "message", role: "user", content: [{ type: "input_text", text: "render" }] },
    { ...meta("turn_old"), type: "function_call", call_id: "call_old", name: "node_repl", arguments: "{}" },
    { ...meta("turn_current"), type: "message", role: "user", content: [{ type: "input_text", text: "iterate" }] },
    { ...meta("turn_current"), type: "function_call", call_id: "call_current", name: "node_repl", arguments: "{}" },
    { ...meta("turn_old"), type: "function_call_output", call_id: "call_old", output: [{ type: "input_image", image_url: oldImage }] },
    { ...meta("turn_current"), type: "function_call_output", call_id: "call_current", output: [{ type: "input_image", image_url: currentImage }] },
  ];
  const normalized = promoteToolOutputImages(normalizeOpenCodeFlashInput(interleavedCodexOrder));
  const rewritten = rewriteHistoricalImages(normalized, {
    put: (url) => url === oldImage ? "img_old" : "img_current",
    associateMany: () => {},
  }, {
    preserveImages: true,
    keepRecentImages: 0,
    keepCurrentImages: true,
    currentStartIndex: currentTurnStartIndex(normalized),
  });
  const parts = rewritten.flatMap((item) => Array.isArray(item.content) ? item.content : []);
  assert.equal(parts.filter((part) => part.type === "input_image").length, 1);
  assert.equal(parts.find((part) => part.type === "input_image")?.image_url, currentImage);
  assert.match(parts.find((part) => part.type === "input_text" && /img_old/.test(part.text))?.text || "", /img_old/);
});

test("constrainImagesForTransport shares one total wire budget without changing the source input", () => {
  const first = `data:image/png;base64,${"A".repeat(80 * 1024)}`;
  const second = `data:image/png;base64,${"B".repeat(80 * 1024)}`;
  const limits = [];
  const mediaStore = {
    put: (url) => url === first ? "img_first" : "img_second",
    getTransportVariant: (ref, { maxWireBytes }) => {
      limits.push(maxWireBytes);
      return { imageUrl: `data:image/jpeg;base64,${ref === "img_first" ? "CCCC" : "DDDD"}` };
    },
  };
  const input = [{ type: "message", role: "user", content: [
    { type: "input_image", image_url: first, detail: "high" },
    { type: "input_image", image_url: second },
  ] }];
  const constrained = constrainImagesForTransport(input, mediaStore, { maxTotalWireBytes: 128 * 1024 });
  assert.deepEqual(limits, [64 * 1024, 64 * 1024]);
  assert.equal(constrained[0].content[0].detail, "high");
  assert.match(constrained[0].content[0].image_url, /^data:image\/jpeg/);
  assert.equal(input[0].content[0].image_url, first, "the incoming Codex envelope stays immutable");
});

test("constrainImagesForTransport keeps a crowded turn usable by spilling older images to refs", () => {
  const urls = Array.from({ length: 12 }, (_, index) => `data:image/png;base64,${String(index).padStart(2, "0")}${"A".repeat(40 * 1024)}`);
  const refs = new Map(urls.map((url, index) => [url, `img_${index}`]));
  const limits = [];
  const mediaStore = {
    put: (url) => refs.get(url),
    getTransportVariant: (ref, { maxWireBytes }) => {
      limits.push(maxWireBytes);
      return { imageUrl: `data:image/jpeg;base64,${ref}_${"B".repeat(100)}` };
    },
  };
  const input = [{ type: "message", role: "user", content: urls.map((image_url) => ({ type: "input_image", image_url })) }];
  const constrained = constrainImagesForTransport(input, mediaStore, { maxTotalWireBytes: 320 * 1024 });
  const parts = constrained[0].content;

  assert.equal(parts.filter((part) => part.type === "input_image").length, 10);
  assert.equal(parts.filter((part) => part.type === "input_text").length, 2);
  assert.deepEqual(limits, Array(10).fill(32 * 1024));
  assert.match(parts[0].text, /img_0/);
  assert.match(parts[1].text, /img_1/);
  assert.equal(input[0].content.filter((part) => part.type === "input_image").length, 12, "the source envelope remains intact");
});

test("constrainImagesForTransport deduplicates pixels without hiding many small images", () => {
  const smallUrls = Array.from({ length: 12 }, (_, index) => `data:image/png;base64,${index}_${"A".repeat(1024)}`);
  const refs = new Map(smallUrls.map((url, index) => [url, `img_small_${index}`]));
  const mediaStore = {
    put: (url) => refs.get(url) || "img_duplicate",
    getTransportVariant: () => { throw new Error("small images must not be recompressed"); },
  };
  const smallInput = [{ type: "message", role: "user", content: smallUrls.map((image_url) => ({ type: "input_image", image_url })) }];
  assert.equal(
    constrainImagesForTransport(smallInput, mediaStore, { maxTotalWireBytes: 320 * 1024 }),
    smallInput,
    "small images that already fit the total budget remain byte-identical",
  );

  const duplicate = `data:image/png;base64,${"C".repeat(40 * 1024)}`;
  const duplicateInput = [{ type: "message", role: "user", content: [
    { type: "input_image", image_url: duplicate },
    { type: "input_image", image_url: duplicate },
  ] }];
  const deduplicated = constrainImagesForTransport(duplicateInput, mediaStore, { maxTotalWireBytes: 320 * 1024 });
  assert.equal(deduplicated[0].content.filter((part) => part.type === "input_image").length, 1);
  assert.equal(deduplicated[0].content.filter((part) => part.type === "input_text").length, 1);
});

test("constrainImagesForTransport spills one uncompressible image instead of rejecting the turn", () => {
  const first = `data:image/png;base64,first_${"A".repeat(100 * 1024)}`;
  const second = `data:image/png;base64,second_${"B".repeat(100 * 1024)}`;
  const mediaStore = {
    put: (url) => url === first ? "img_first" : "img_second",
    getTransportVariant: (ref) => {
      if (ref === "img_first") throw new Error("high entropy fixture");
      return { imageUrl: "data:image/jpeg;base64,small" };
    },
  };
  const input = [{ type: "message", role: "user", content: [
    { type: "input_image", image_url: first },
    { type: "input_image", image_url: second },
  ] }];
  const constrained = constrainImagesForTransport(input, mediaStore, { maxTotalWireBytes: 128 * 1024 });
  assert.equal(constrained[0].content[0].type, "input_text");
  assert.match(constrained[0].content[0].text, /img_first/);
  assert.equal(constrained[0].content[1].type, "input_image");
});

test("applyToolPolicy maps MCP inputSchema onto a type:object parameters schema", () => {
  const tools = [{
    type: "namespace",
    name: "mcp__example",
    tools: [{
      type: "function",
      name: "lookup",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }],
  }];
  const { tools: kept } = applyToolPolicy(tools);
  assert.equal(kept[0].name, "mcp__example__lookup");
  assert.deepEqual(kept[0].parameters, { type: "object", properties: { q: { type: "string" } } });
  assert.equal(kept[0].inputSchema, undefined);
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
  // A namespace child is whitelisted by the flat name the model sees, not by
  // its bare name: two servers can both expose "deploy", and the bare spelling
  // would silently enable each of them.
  const { tools: kept, stripped } = applyToolPolicy(tools, {
    allowToolNames: new Set(["exec_command", "apply_patch", "mcp__modeldock__recall_memory", "mcp__modeldock__web_search_exa", "mcp__sites__deploy"]),
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
    'Restarting the gateway: if you need to restart the ModelDock service (e.g. after config or model changes), run: powershell -ExecutionPolicy Bypass -File "D:\\projects\\modeldock\\scripts\\restart.ps1". It stops the process on the configured port, starts a fresh detached instance, verifies its local status API, then prints \'verified gateway\'; wait for that line before continuing.',
  ].join("\n");
  const out = stripLocalInstructions(instructions);
  assert.ok(out.includes("You are Codex, a coding agent."), "the platform identity is untouched");
  assert.ok(out.includes("emitting a function_call"), "the action rule essence survives");
  assert.ok(!out.includes("Never say 'let me read X'"), "redundant action-rule reinforcement dropped");
  assert.ok(out.includes('"D:\\projects\\modeldock\\scripts\\restart.ps1"'), "the restart command survives");
  assert.ok(!out.includes("starts a fresh detached instance"), "restart explanation dropped");
  assert.ok(out.includes("wait for the \"verified gateway\" line"), "the verification marker instruction survives");
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
    assert.match(sent.instructions, /LOCAL HOST RULE:.*Never stop, restart, unload, or reconfigure/i,
      "a local model is told not to stop the server that generates its next turn");
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

test("managed llama dispatch pins the selected hot slot on the real upstream wire", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "qwen3.8:27b", contextWindow: 200_000 }],
  });
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("ok");
  };
  try {
    const model = "qwen3.8:27b@llamacpp";
    const dispatched = [];
    const services = {
      ...compactServices(),
      mainModel: model,
      config: { ...configStub(), mainModel: model, profileId: "llamacpp" },
      knownModels: new Set([model]),
      incomingHeaders: { "x-codex-session-id": "session-managed" },
      requestUrl: "/v1/responses",
      localHostRuntime: {
        async run({ sessionId, run }) {
          dispatched.push(sessionId);
          return run({ slot: 1, cache: { tier: "ssd" } });
        },
      },
    };
    const result = await relayResponses({
      model,
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }, res, services);
    assert.equal(result.ok, true);
    assert.deepEqual(dispatched, ["session-managed"]);
    assert.equal(calls[0].id_slot, 1);
    assert.equal(calls[0].model, "qwen3.8:27b");
  } finally {
    globalThis.fetch = originalFetch;
    applyLocalEngineProfile("llamacpp", null);
  }
});

test("managed llama creates a completed bootstrap turn, then appends the real tool-capable Codex request", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:11435/v1",
    models: [{ id: "qwen3.8:27b", contextWindow: 200_000 }],
  });
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (calls.length === 1) {
      return new Response(JSON.stringify({
        id: "chat_bootstrap",
        model: "qwen3.8:27b",
        choices: [{ message: { role: "assistant", content: "BOOTSTRAP_READY" }, finish_reason: "stop" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      id: "chat_tool",
      model: "qwen3.8:27b",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_warm", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"echo WARM_KV\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 5_180, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 5_154 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const model = "qwen3.8:27b@llamacpp";
    const services = {
      ...compactServices(),
      mainModel: model,
      config: { ...configStub(), mainModel: model, profileId: "llamacpp" },
      knownModels: new Set([model]),
      incomingHeaders: { "x-codex-session-id": "session-warm" },
      requestUrl: "/v1/responses",
      localHostRuntime: {
        async run({ sessionId, warmBase, run }) {
          assert.equal(sessionId, "session-warm");
          assert.ok(warmBase, "managed Chat routing derives a cache-safe warm base");
          const transcript = await warmBase.create({ slot: 0 });
          assert.deepEqual(transcript, { assistantContent: "BOOTSTRAP_READY" });
          const activeWarmBase = {
            ...warmBase,
            messages: [...warmBase.messages, { role: "assistant", content: transcript.assistantContent }],
          };
          return run({ slot: 0, cache: { tier: "warm" }, warmBase: activeWarmBase });
        },
      },
    };
    const result = await relayResponses({
      model,
      stream: false,
      instructions: "You are the local coding assistant.",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "run the warm check" }] }],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Run a command.",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"], additionalProperties: false },
      }],
    }, res, services);

    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id_slot, 0);
    assert.deepEqual(calls[0].messages.map((message) => message.role), ["system", "user"]);
    assert.equal(calls[0].messages[1].content, "Reply with exactly BOOTSTRAP_READY. Do not call a tool.");
    assert.equal(calls[0].tools[0].function.name, "exec_command");
    assert.equal(calls[1].id_slot, 0);
    assert.deepEqual(calls[1].messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
    assert.equal(calls[1].messages[1].content, calls[0].messages[1].content);
    assert.equal(calls[1].messages[2].content, "BOOTSTRAP_READY");
    assert.equal(calls[1].messages[3].content, "run the warm check");
    assert.equal(calls[1].tools[0].function.name, "exec_command", "the injected prefix keeps the real tool schema");
    const bridged = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.equal(bridged.output[0].type, "function_call");
    assert.equal(bridged.output[0].name, "exec_command");
    assert.equal(bridged.usage.input_tokens_details.cached_tokens, 5_154);
  } finally {
    globalThis.fetch = originalFetch;
    applyLocalEngineProfile("llamacpp", null);
  }
});

test("a llama.cpp wire-id rescan does not create a second otherwise-identical warm base", async () => {
  const originalFetch = globalThis.fetch;
  const keys = [];
  const model = "qwen3.8:27b@llamacpp";
  globalThis.fetch = async () => summaryResponse("ok");
  const services = {
    ...compactServices(),
    mainModel: model,
    config: { ...configStub(), mainModel: model, profileId: "llamacpp" },
    knownModels: new Set([model]),
    incomingHeaders: { "x-codex-session-id": "stable-warm-base" },
    requestUrl: "/v1/responses",
    localHostRuntime: {
      async run({ warmBase, run }) {
        keys.push(warmBase?.sessionKey || "");
        return run({ slot: 0, cache: { tier: "cold" } });
      },
    },
  };
  const payload = {
    model,
    stream: false,
    instructions: "You are the local coding assistant.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
  };
  try {
    applyLocalEngineProfile("llamacpp", {
      baseUrl: "http://127.0.0.1:11435/v1",
      models: [{ id: "qwen3.8:27b", upstreamId: "qwen3.8:27b", contextWindow: 200_000 }],
    });
    await relayResponses(payload, responseStub(collectStream()), services);
    // The current llama.cpp build advertises the GGUF path after a rescan.
    // That is a wire spelling change, not a new loaded model.
    applyLocalEngineProfile("llamacpp", {
      baseUrl: "http://127.0.0.1:11435/v1",
      models: [{ id: "qwen3.8:27b", upstreamId: "D:/models/Qwen3.8-27B-UD-Q4_K_XL.gguf", contextWindow: 200_000 }],
    });
    await relayResponses(payload, responseStub(collectStream()), services);
    assert.equal(keys.length, 2);
    assert.ok(keys[0]);
    assert.equal(keys[1], keys[0]);
  } finally {
    globalThis.fetch = originalFetch;
    applyLocalEngineProfile("llamacpp", null);
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

test("upstreamTargetFor routes a verified OpenCode chat model through the Chat bridge", () => {
  const target = upstreamTargetFor(configStub(), "qwen3.8-flash@opencode-go");
  assert.equal(target.transport, "chat");
  assert.equal(target.url, "https://opencode.ai/zen/go/v1/chat/completions");
  assert.equal(target.cachePrompt, undefined, "remote Chat must not inherit llama KV cache settings");
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

test("createUsageTee preserves UTF-8 characters split across upstream chunks", () => {
  const events = [];
  const tee = createUsageTee((event) => events.push(event));
  const accentChar = String.fromCharCode(0x00e9);
  const encoded = Buffer.from('data: {"type":"response.completed","response":{"id":"resp_utf8","output":[{"type":"message","content":[{"type":"output_text","text":"caf' + accentChar + '"}]}]}}\n\n');
  const accent = encoded.indexOf(Buffer.from([0xc3, 0xa9]));
  assert.ok(accent > 0, "fixture contains the UTF-8 character to split");
  tee.push(encoded.subarray(0, accent + 1));
  tee.push(encoded.subarray(accent + 1));
  tee.end();
  assert.equal(events[0].response.output[0].content[0].text, `caf${accentChar}`);
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

test("pipeNormalizedStream preserves UTF-8 characters split across upstream chunks", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const accentChar = String.fromCharCode(0x00e9);
  const full = Buffer.from('data: {"type":"response.completed","response":{"id":"resp_utf8","model":"deepseek-v4-flash","output":[{"id":"msg_utf8","type":"message","role":"assistant","content":[{"type":"output_text","text":"caf' + accentChar + '"}]}]}}\n\n');
  const accent = full.indexOf(Buffer.from([0xc3, 0xa9]));
  assert.ok(accent > 0, "fixture contains the UTF-8 character to split");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(full.subarray(0, accent + 1));
      controller.enqueue(full.subarray(accent + 1));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const forwarded = Buffer.concat(sink.chunks);
  assert.equal(result.failure, "");
  assert.equal(forwarded.toString("utf8"), full.toString("utf8"));
  assert.equal(result.bytes, forwarded.byteLength, "the client-byte counter measures what was actually emitted");
  assert.equal(result.upstreamBytes, full.byteLength, "the upstream-byte counter remains separately observable");
});

test("pipeNormalizedStream waits for downstream drain before reading beyond the source prefetch", async () => {
  let pulls = 0;
  let pullsBeforeDrain = 0;
  let drained = false;
  let sent = 0;
  const events = [
    'data: {"type":"response.output_text.delta","delta":"a","response":{"id":"resp_drain"}}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_drain"}}\n\n',
  ];
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (!drained) pullsBeforeDrain += 1;
      if (sent < events.length) controller.enqueue(Buffer.from(events[sent++]));
      else controller.close();
    },
  });
  const sink = responseStub(new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setTimeout(callback, 5);
    },
  }));
  sink.on("drain", () => { drained = true; });
  await pipeNormalizedStream(body, sink, null, () => {});
  assert.equal(pulls, 3, "two source chunks plus the terminal pull are consumed");
  assert.ok(drained, "the low-water sink exercised backpressure");
  assert.equal(pullsBeforeDrain, 2, "only the web stream's one-chunk prefetch occurs before drain");
});

test("pipeNormalizedStream never drops a legal SSE event split past one megabyte", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const delta = "x".repeat(1_100_000);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(`data: {"type":"response.output_text.delta","delta":"${delta}"}`));
      controller.enqueue(Buffer.from("\n\n"));
      controller.enqueue(Buffer.from('data: {"type":"response.completed","response":{"id":"resp_large","model":"deepseek-v4-pro"}}\n\n'));
      controller.close();
    },
  });
  const result = await pipeNormalizedStream(body, res, null, () => {});
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.equal(result.failure, "");
  assert.ok(forwarded.includes(delta), "the full original delta reaches Codex");
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
  const transformReports = [];
  const finishResults = [];
  const usageEvents = [];
  const metrics = {
    begin: () => (result) => finishResults.push(result),
    recordResponseTransform: (report, transfer) => transformReports.push({ report, transfer }),
    recordResponseUsage: () => {},
  };
  const affinity = new RouteAffinity();
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
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
        instructions: baseInstructionsFor(configStub()),
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
    assert.doesNotMatch(calls[0].body.instructions, /Vision guidance \(MANDATORY\)/, "a fresh visual turn must not send the Flash text-only contract to the selected vision model");
    assert.doesNotMatch(calls[0].body.instructions, /TEXT-ONLY model/, "the vision route receives no contradictory image instruction");
    assert.equal(calls[0].body.input[0].content[0].type, "input_image", "the selected vision model receives the actual attachment");
    const sentHeaders = Object.keys(calls[0].headers || {});
    assert.ok(!sentHeaders.some((name) => name.startsWith("x-opencode-")), "no opencode session spoofing headers are sent");
    assert.equal(affinity.snapshot().activeCallIds, 1);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.completed/);
    const transformed = transformReports.at(-1);
    const blocked = transformed.report.blocked;
    assert.deepEqual(blocked, { tool_search: 0, web_search: 1 }, "web_search is counted separately from tool_search");
    // The dashboard's context-token waveform reads recent[].inputTokens, which
    // comes from the finish() payload - regression guard for the flat-line bug.
    const finished = finishResults[finishResults.length - 1];
    assert.equal(finished.inputTokens, 4, "finish must carry input tokens onto the trace record");
    assert.equal(finished.outputTokens, 2, "finish must carry output tokens onto the trace record");
    assert.ok(finished.upstreamRequestBytes > 0, "the trace records the exact JSON body sent to the provider");
    assert.ok(finished.upstreamResponseBytes > 0, "the trace records provider response bytes separately");
    assert.equal(finished.clientResponseBytes, Buffer.byteLength(forwarded), "the trace records the bytes Codex actually received");
    assert.equal(transformed.report.imageTransfer.received.images, 1, "the trace records incoming image count without image content");
    assert.equal(transformed.report.imageTransfer.forwarded.images, 1, "the trace records the visual payload that still reached the selected vision route");
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

test("relayResponses rejects a current image when a text-only tool loop has Vision=None", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return summaryResponse("must not be called");
  };
  try {
    const result = await relayResponses(
      {
        model: "deepseek-v4-flash@opencode-go",
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "start" }] },
          { type: "function_call", call_id: "call_text", name: "shell_command", arguments: "{}" },
          { type: "function_call_output", call_id: "call_text", output: "ready" },
          { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
        ],
      },
      res,
      {
        ...compactServices(),
        mainModel: "deepseek-v4-flash@opencode-go",
        visionModel: "",
        config: { ...configStub(), mainModel: "deepseek-v4-flash@opencode-go", visionModel: "" },
        knownModels: new Set(["deepseek-v4-flash@opencode-go"]),
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 503);
    assert.equal(result.route.model, "deepseek-v4-flash@opencode-go");
    assert.equal(fetchCalls, 0, "an image is never forwarded to the text-only upstream");
    assert.match(Buffer.concat(sink.chunks).toString("utf8"), /no vision model is configured/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("normalizeNativeInput keeps replayable reasoning content on ordinary native turns", () => {
  const reasoning = {
    type: "reasoning",
    id: "reasoning_routed_turn",
    summary: [],
    content: [{ type: "reasoning_text", text: "Inspect the current state." }],
  };
  assert.equal(normalizeNativeInput([reasoning])[0], reasoning);
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
  const finished = [];
  const transforms = [];
  const usages = [];
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
          {
            type: "additional_tools",
            tools: [{
              type: "namespace",
              name: "mcp__modeldock__",
              tools: [{ name: "web_search_exa" }, { name: "vision_inspect" }, { name: "image_gen" }],
            }],
          },
        ],
        previous_response_id: "resp_old",
        tools: [
          { type: "web_search" },
          { type: "function", name: "mcp__modeldock__web_search_exa" },
          { type: "function", name: "mcp__modeldock__vision_inspect" },
          { type: "function", name: "mcp__modeldock__recall_memory" },
          { type: "function", name: "mcp__modeldock__image_gen" },
          { type: "function", name: "mcp__modeldock__preview_images" },
          {
            type: "namespace",
            name: "mcp__modeldock__",
            tools: [{ name: "web_search_exa" }, { name: "vision_inspect" }, { name: "hear" }],
          },
        ],
      },
      res,
      {
        recordUsage: () => {},
        metrics: {
          begin: () => (result) => finished.push(result),
          recordResponseTransform: (report, transfer) => transforms.push({ report, transfer }),
          recordResponseUsage: (usage) => usages.push(usage),
        },
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
    assert.deepEqual(calls[0].body.tools, [
      { type: "web_search" },
      { type: "function", name: "mcp__modeldock__recall_memory" },
      { type: "function", name: "mcp__modeldock__image_gen" },
      { type: "function", name: "mcp__modeldock__preview_images" },
      { type: "namespace", name: "mcp__modeldock__", tools: [{ name: "hear" }] },
    ], "native keeps its hosted search and complementary ModelDock tools, but not Exa or delegated vision");
    assert.equal(calls[0].body.input[0].encrypted_content, undefined, "non-opaque reasoning is stripped");
    assert.equal(calls[0].body.input[1].content[0].text, "hi");
    assert.deepEqual(calls[0].body.input[2].content[0], {
      type: "input_text",
      text: "Run the probe and report back.",
    }, "malformed encrypted agent content is repaired before the native fetch");
    assert.deepEqual(calls[0].body.input[3].tools, [{
      type: "namespace",
      name: "mcp__modeldock__",
      tools: [{ name: "image_gen" }],
    }], "native additional_tools removes Exa without dropping other ModelDock capabilities");
    assert.equal(result.usage.input_tokens, 9);
    const forwarded = Buffer.concat(sink.chunks).toString("utf8");
    assert.match(forwarded, /response\.completed/);
    assert.equal(finished.at(-1).upstreamResponseBytes, Buffer.byteLength(forwarded), "native trace keeps the provider response leg separate");
    assert.equal(finished.at(-1).clientResponseBytes, Buffer.byteLength(forwarded), "native trace records the bytes Codex received");
    assert.ok(finished.at(-1).upstreamRequestBytes > 0, "native trace records its serialized upstream request");
    assert.equal(transforms.at(-1).report.imageTransfer.received.images, 0);
    assert.equal(usages.at(-1).upstreamBytes, Buffer.byteLength(forwarded));
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

for (const slug of ["deepseek-v4-flash@opencode-go", "deepseek-v4-flash@deepseek-official"]) {
  test(`relayResponses frames sparse parallel send_message calls for ${slug}`, async () => {
    const sink = collectStream();
    const res = responseStub(sink);
    const originalFetch = globalThis.fetch;
    const bare = slug.split("@")[0];
    globalThis.fetch = async () => new Response(
      [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_1","type":"function_call","name":"send_message","call_id":"call_1","arguments":""}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"message\\":\\"verify herdr\\"}"}\n\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"call_2","type":"function_call","name":"send_message","call_id":"call_2","arguments":""}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"message\\":\\"verify db.sqlite\\"}"}\n\n',
        `data: {"type":"response.completed","response":{"id":"resp_go","model":"${bare}"}}\n\n`,
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    try {
      const config = configStub();
      config.mainModel = slug;
      const result = await relayResponses(
        {
          model: slug,
          stream: true,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "verify in parallel" }] }],
          tools: [{ type: "function", name: "send_message", parameters: { type: "object", properties: { message: { type: "string" } } } }],
        },
        res,
        {
          recordUsage: () => {},
          config,
          metrics: { begin: () => () => {}, recordResponseTransform: () => {}, recordResponseUsage: () => {} },
          knownModels: new Set([slug]),
          mainModel: slug,
          visionModel: "none",
        },
      );
      assert.equal(result.ok, true);
      const events = Buffer.concat(sink.chunks).toString("utf8")
        .split(/\r?\n\r?\n/)
        .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
      const completed = events.find((event) => event.type === "response.completed");
      assert.deepEqual(completed.response.output.map((item) => item.name), ["send_message", "send_message"]);
      assert.deepEqual(
        completed.response.output.map((item) => item.arguments),
        ['{"message":"verify herdr"}', '{"message":"verify db.sqlite"}'],
        "parallel send_message bodies stay on their own items instead of concatenating",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test("relayResponses sends summary-only Flash reasoning to Console Go as reasoning_text", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(
      'data: {"type":"response.output_text.delta","delta":"done","response":{"id":"resp_flash_compact","model":"deepseek-v4-flash"}}\n\n' +
      'data: {"type":"response.completed","response":{"id":"resp_flash_compact","model":"deepseek-v4-flash"}}\n\n',
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

test("relayCompaction keeps the main model when recent history still carries an image", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("compact ok");
  };
  try {
    const result = await relayCompaction(
      {
        model: "deepseek-v4-flash@opencode-go",
        stream: false,
        input: [
          { type: "message", role: "user", content: [
            { type: "input_text", text: "see screenshot" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ] },
          { type: "compaction_trigger" },
        ],
      },
      res,
      {
        ...compactServices(),
        knownModels: new Set(["deepseek-v4-flash@opencode-go", "gpt-5.6-luna@opencode-go"]),
        mainModel: "deepseek-v4-flash@opencode-go",
        visionModel: "gpt-5.6-luna@opencode-go",
      },
      {},
      true,
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.model, "deepseek-v4-flash@opencode-go", "compact must not escalate to the vision model");
    assert.equal(result.route.reason, "compact_summarize");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "deepseek-v4-flash", "the upstream summarize call stays on the main model");
    assert.ok(
      calls[0].input.every((item) => !item.content?.some?.((part) => part.type === "input_image")),
      "compact summarize rewrites images to text refs instead of shipping pixels",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayCompaction keeps a picked vision model and its image evidence", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  let imagePuts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("compact visual evidence");
  };
  try {
    const selected = "mimo-v2.5@opencode-go";
    const result = await relayCompaction(
      {
        model: selected,
        stream: false,
        input: [
          { type: "message", role: "user", content: [
            { type: "input_text", text: "review this chart" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          ] },
          { type: "compaction_trigger" },
        ],
      },
      res,
      {
        ...compactServices(),
        mediaStore: { put: () => { imagePuts += 1; return "img_compact_visual"; } },
        mainModel: "deepseek-v4-flash@opencode-go",
        visionModel: "gpt-5.6-luna@opencode-go",
        config: { ...configStub(), mainModel: "deepseek-v4-flash@opencode-go" },
        knownModels: new Set(["deepseek-v4-flash@opencode-go", selected, "gpt-5.6-luna@opencode-go"]),
      },
      {},
      true,
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.model, selected, "compact stays with the picked visual model");
    assert.equal(calls[0].model, "mimo-v2.5");
    const image = calls[0].input.flatMap((item) => item.content || []).find((part) => part.type === "input_image");
    assert.ok(image, "the compact model receives the image it must summarize");
    assert.deepEqual(image.image_url, { url: "data:image/png;base64,AAAA" }, "MiMo's image wire shape still applies on compact");
    assert.equal(imagePuts, 1, "compaction derives the image reference once instead of decoding and hashing the same pixels again");
    const compacted = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.match(decodeCompactionSummary(compacted.output[0].encrypted_content), /Image attachment img_compact_visual/, "the compaction handoff keeps a durable image ref");
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

test("local CPU compaction preserves image refs instead of silently dropping visual evidence", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return summaryResponse("compact summary");
  };
  try {
    const imageUrl = "data:image/png;base64,AAAA";
    const services = {
      ...compactServices(),
      mainModel: "qwen-vl@custom",
      config: {
        ...configStub(),
        mainModel: "qwen-vl@custom",
        customBaseUrl: "http://127.0.0.1:11435/v1",
        customModel: "qwen-vl",
        profile: { availableModels: [{ id: "qwen-vl", supportsVision: true }] },
        tokens: { ...configStub().tokens, custom: "local-key" },
      },
      knownModels: new Set(["qwen-vl@custom"]),
      mediaStore: {
        put: (url) => {
          assert.equal(url, imageUrl, "the original attachment is saved before CPU compression");
          return "img_local_visual";
        },
      },
      requestUrl: "/v1/responses",
    };
    const result = await relayResponses(
      {
        model: "qwen-vl@custom",
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "review this chart" }, { type: "input_image", image_url: imageUrl }] },
          { type: "compaction_trigger" },
        ],
      },
      res,
      services,
    );
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, "the compact path remains CPU-only for a local model");
    const body = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    const summary = decodeCompactionSummary(body.output[0].encrypted_content);
    assert.match(summary, /Image attachment img_local_visual: if visual evidence is needed, call vision_inspect\(image_ref=/);
    assert.match(summary, /image_ref="img_local_visual"/);
    assert.doesNotMatch(summary, /data:image\/png;base64,AAAA/, "raw image bytes cannot fit in the text compaction contract");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a local visual model receives its compacted image again on the next turn", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  const dataUrl = "data:image/png;base64,AAAA";
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("continued visual review");
  };
  try {
    const result = await relayResponses(
      {
        model: "qwen-vl@custom",
        stream: false,
        input: [
          { type: "compaction", encrypted_content: encodeCompactionSummary('[Image attachment img_local_visual: use vision_inspect with image_ref "img_local_visual" if visual evidence is needed.]') },
          { type: "message", role: "user", content: [{ type: "input_text", text: "continue the chart review" }] },
        ],
      },
      res,
      {
        ...compactServices(),
        mainModel: "qwen-vl@custom",
        config: {
          ...configStub(),
          mainModel: "qwen-vl@custom",
          customBaseUrl: "http://127.0.0.1:11435/v1",
          customModel: "qwen-vl",
          profile: { availableModels: [{ id: "qwen-vl", supportsVision: true }] },
          tokens: { ...configStub().tokens, custom: "local-key" },
        },
        knownModels: new Set(["qwen-vl@custom"]),
        mediaStore: { get: (ref) => (ref === "img_local_visual" ? { imageUrl: dataUrl } : undefined) },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, true);
    const image = calls[0].input.flatMap((item) => item.content || []).find((part) => part.type === "input_image");
    assert.ok(image, "the visual model receives the attachment that compact_v2 represented by reference");
    assert.equal(image.image_url, dataUrl);
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

test("relayResponses does not reserialize a chunked request solely to fill a metric", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const transformOptions = [];
  const metrics = {
    begin: () => () => {},
    recordResponseTransform: (_report, options) => transformOptions.push(options),
    recordResponseUsage: () => {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"type":"response.output_text.delta","delta":"ok","response":{"id":"resp_summary","model":"deepseek-v4-flash"}}\n\n' +
    'data: {"type":"response.completed","response":{"id":"resp_summary","model":"deepseek-v4-flash"}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  try {
    const payload = {
      model: "deepseek-v4-flash",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    };
    const result = await relayResponses(payload, res, { ...compactServices(), metrics, requestUrl: "/v1/responses" });
    assert.equal(result.ok, true);
    assert.equal(transformOptions.length, 1);
    assert.equal(transformOptions[0].bytesIn, 0, "unknown chunked ingress stays unknown instead of allocating a second full JSON string");
    assert.equal(transformOptions[0].logicalBytes, null);
    assert.equal(transformOptions[0].streaming, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// One relay, three questions about bytes. Codex re-sends the whole
// conversation every turn - previous_response_id is dropped on purpose - so on
// a large session the payload IS the history, and anything that serializes it
// a second time allocates a second copy of the conversation per turn.
async function relayBytes({ headers, sentBodies = [], model = "deepseek-v4-flash" } = {}) {
  const sink = collectStream();
  const res = responseStub(sink);
  const transformOptions = [];
  const metrics = {
    begin: () => () => {},
    recordResponseTransform: (_report, options) => transformOptions.push(options),
    recordResponseUsage: () => {},
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sentBodies.push(init?.body);
    return new Response(
      'data: {"type":"response.completed","response":{"id":"resp_1","model":"deepseek-v4-flash"}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const payload = {
    model,
    stream: true,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  };
  try {
    const services = compactServices();
    const result = await relayResponses(payload, res, {
      ...services,
      // The router only relays a model it knows; a published slug has to be
      // declared here the way the real gateway declares its catalog.
      knownModels: new Set([...services.knownModels, model]),
      metrics,
      requestUrl: "/v1/responses",
      ...(headers ? { incomingHeaders: headers } : {}),
    });
    return { result, payload, transfer: transformOptions[0] };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("transfer-in is the length the transport counted, not a second serialization", async () => {
  // A length that cannot have come from measuring this payload: if the number
  // reported is 4242, nobody re-serialized the conversation to get it.
  const { transfer, payload } = await relayBytes({ headers: { "content-length": "4242" } });
  assert.notEqual(4242, Buffer.byteLength(JSON.stringify(payload)), "fixture check: the two disagree");
  assert.equal(transfer.bytesIn, 4242, "read from content-length");
  assert.equal(transfer.logicalBytes, 4242, "an identity content-length is both wire and logical JSON bytes");
});

test("transfer-in is measured when the counted length is not the body we parsed", async () => {
  // gzip: the JSON parser inflated it, so content-length still describes the
  // compressed bytes and cannot stand in for the parsed size. Same for a
  // chunked upload that declared no length at all.
  const gzipped = await relayBytes({ headers: { "content-length": "4242", "content-encoding": "gzip" } });
  assert.equal(gzipped.transfer.bytesIn, 4242, "compressed ingress keeps its actual wire count");
  assert.equal(gzipped.transfer.logicalBytes, null, "the gateway does not reserialize a large inflated body merely to estimate logical bytes");

  const chunked = await relayBytes({ headers: { "content-type": "application/json" } });
  assert.equal(chunked.transfer.bytesIn, 0, "an uncounted chunked body remains unknown");
  assert.equal(chunked.transfer.logicalBytes, null);
});

test("transfer-out counts the bytes that were actually sent upstream", async () => {
  // These used to be two different serializations, and they had drifted: the
  // body carried the upstream model override and the measurement did not.
  const sentBodies = [];
  // A published slug, so the body that goes out ("deepseek-v4-flash") and the
  // payload it was built from ("deepseek-v4-flash@opencode-go") do not
  // serialize to the same length. With a bare model name the two are identical
  // and this test cannot tell a single serialization from two.
  const { result } = await relayBytes({ sentBodies, model: "deepseek-v4-flash@opencode-go" });
  assert.equal(sentBodies.length, 1, "fixture check: one upstream call");
  assert.ok(
    !sentBodies[0].includes("@opencode-go"),
    "fixture check: the sent body carries the upstream model, not the published slug",
  );
  assert.equal(typeof sentBodies[0], "string", "fetch is handed the string, so it does not serialize again");
  assert.equal(result.upstreamBytes, Buffer.byteLength(sentBodies[0]), "measured what went on the wire");
});

test("relayCompaction falls back once to native Luna when the routed provider rejects compaction", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const finishes = [];
  const calls = [];
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-compact-state-"));
  const previousStateDir = process.env.MODELDOCK_STATE_DIR;
  process.env.MODELDOCK_STATE_DIR = stateDir;
  const fallbackInput = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    {
      type: "reasoning",
      id: "reasoning_from_routed_chat",
      summary: [],
      content: [{ type: "reasoning_text", text: "Inspect the repository before continuing." }],
      encrypted_content: null,
      internal_chat_message_metadata_passthrough: { source: "routed-chat" },
    },
    { type: "function_call", id: "fc_compact", call_id: "call_compact", name: "exec_command", arguments: "{\"cmd\":\"git status --short\"}" },
    { type: "function_call_output", id: "fco_compact", call_id: "call_compact", output: "" },
    { type: "compaction_trigger" },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (calls.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: "Insufficient balance", type: "invalid_request_error" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    const invalidReasoningIndex = calls[1].body.input.findIndex((item) =>
      item?.type === "reasoning" && Array.isArray(item.content) && item.content.length > 0);
    if (invalidReasoningIndex >= 0) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Invalid 'input[${invalidReasoningIndex}].content': array too long. Expected an array with maximum length 0, but got an array with length 1 instead.`,
            type: "invalid_request_error",
            param: `input[${invalidReasoningIndex}].content`,
            code: "array_above_max_length",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "resp_native_compact",
        object: "response",
        status: "completed",
        model: "gpt-5.6-luna",
        output: [{ type: "compaction", id: "cmp_native", encrypted_content: "native-token" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const result = await relayCompaction(
      {
        model: "deepseek-v4-flash",
        stream: false,
        input: fallbackInput,
      },
      res,
      {
        ...compactServices(),
        metrics: {
          begin: () => (telemetry) => finishes.push(telemetry),
          recordResponseUsage: () => {},
        },
        requestUrl: "/v1/responses",
        incomingHeaders: { authorization: "Bearer native-session" },
      },
      {},
      true,
    );
    assert.equal(result.ok, true);
    assert.equal(result.httpStatus, 200);
    assert.equal(calls.length, 2, "one routed attempt and one native fallback are made");
    assert.equal(calls[0].body.model, "deepseek-v4-flash");
    assert.equal(calls[1].body.model, "gpt-5.6-luna", "the fallback is native Luna, never Luna or Qwen at OpenCode Go");
    const nativeReasoning = calls[1].body.input.find((item) => item.type === "reasoning");
    assert.equal(nativeReasoning.content, undefined, "routed reasoning_text is removed from the native compact request");
    assert.equal(nativeReasoning.encrypted_content, undefined, "the existing native sanitizer also removes the null routed blob");
    assert.equal(nativeReasoning.id, "reasoning_from_routed_chat", "reasoning identity survives the fallback rewrite");
    assert.deepEqual(
      nativeReasoning.internal_chat_message_metadata_passthrough,
      { source: "routed-chat" },
      "reasoning metadata survives the fallback rewrite",
    );
    assert.ok(calls[1].body.input.some((item) => item.type === "function_call" && item.call_id === "call_compact"));
    assert.ok(calls[1].body.input.some((item) => item.type === "function_call_output" && item.call_id === "call_compact"));
    assert.ok(calls[1].body.input.some((item) => item.type === "compaction_trigger"), "native Luna receives the real compact request");
    assert.match(calls[1].url, /chatgpt\.com\/backend-api\/codex\/responses$/);
    assert.equal(finishes.length, 2, "the routed failure and native success each close their trace");
    assert.equal(finishes[0].httpStatus, 401);
    assert.equal(finishes[0].fallbackModel, "gpt-5.6-luna");
    assert.deepEqual(
      finishes[0].requestShape.itemTypes,
      { message: 1, reasoning: 1, function_call: 1, function_call_output: 1, compaction_trigger: 1 },
      "the request shape rides the failure telemetry",
    );
    const body = JSON.parse(Buffer.concat(sink.chunks).toString("utf8"));
    assert.equal(body.model, "gpt-5.6-luna");
    assert.equal(body.output[0].type, "compaction");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousStateDir === undefined) delete process.env.MODELDOCK_STATE_DIR;
    else process.env.MODELDOCK_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("relayCompaction never loops when native Luna also rejects the fallback", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    const message = calls.length === 1 ? "Insufficient balance" : "native session unavailable";
    return new Response(JSON.stringify({ error: { message } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
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
        requestUrl: "/v1/responses",
        incomingHeaders: { authorization: "Bearer expired-native-session" },
      },
      {},
      true,
    );
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
    assert.equal(calls.length, 2, "one routed attempt plus one native attempt is the hard limit");
    assert.equal(calls[1].body.model, "gpt-5.6-luna");
    assert.match(Buffer.concat(sink.chunks).toString("utf8"), /native session unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
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

test("relayResponses sends MiMo an object-shaped image_url", async () => {
  // MiMo's Responses endpoint rejects the string form Codex sends. Measured
  // against opencode.ai/zen/go/v1 with mimo-v2.5 and a 1x1 PNG data URL:
  //   image_url: "data:image/png;base64,..."          -> 400 Param Incorrect
  //   image_url: { url: "data:image/png;base64,..." } -> 200
  // MiMo is selectable as the vision model (supportsVision: true), so without
  // this every image sent to it fails.
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("ok");
  };
  try {
    const dataUrl = "data:image/png;base64,AAAA";
    await relayResponses(
      {
        model: "mimo-v2.5@opencode-go",
        stream: false,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url: dataUrl }],
        }],
      },
      res,
      {
        ...compactServices(),
        mainModel: "mimo-v2.5@opencode-go",
        visionModel: "mimo-v2.5@opencode-go",
        config: { ...configStub(), mainModel: "mimo-v2.5@opencode-go", visionModel: "mimo-v2.5@opencode-go" },
        knownModels: new Set(["mimo-v2.5@opencode-go", "deepseek-v4-flash@opencode-go"]),
        requestUrl: "/v1/responses",
      },
    );
    const parts = calls[0].input.flatMap((item) => item.content || []);
    const image = parts.find((part) => part.type === "input_image");
    assert.ok(image, "the image reaches the upstream");
    assert.deepEqual(image.image_url, { url: dataUrl }, "MiMo needs the object form");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses leaves the string image_url alone for models that want it", async () => {
  // gpt-5.6-luna is the exact opposite: it takes the string and 400s on the
  // object. The adaptation must be opt-in per model, not a blanket rewrite.
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("ok");
  };
  try {
    const dataUrl = "data:image/png;base64,AAAA";
    await relayResponses(
      {
        model: "gpt-5.6-luna@opencode-go",
        stream: false,
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url: dataUrl }],
        }],
      },
      res,
      {
        ...compactServices(),
        mainModel: "gpt-5.6-luna@opencode-go",
        visionModel: "gpt-5.6-luna@opencode-go",
        config: { ...configStub(), mainModel: "gpt-5.6-luna@opencode-go" },
        knownModels: new Set(["gpt-5.6-luna@opencode-go", "deepseek-v4-flash@opencode-go"]),
        requestUrl: "/v1/responses",
      },
    );
    const parts = calls[0].input.flatMap((item) => item.content || []);
    const image = parts.find((part) => part.type === "input_image");
    assert.ok(image, "the image reaches the upstream");
    assert.equal(image.image_url, dataUrl, "the string form is untouched");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a routed vision request reuses Codex's byte-identical attachment without a second blob", async () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "modeldock-codex-home-"));
  const mediaDir = mkdtempSync(path.join(os.tmpdir(), "modeldock-media-"));
  const sessionId = "019fe9b0-f0b5-7e00-8703-862bf7c16a6d";
  const attachment = path.join(codexHome, "codex-remote-attachments", sessionId, "attachment", "1-Photo-1.png");
  const bytes = Buffer.from("the same screenshot that Codex put on the wire");
  const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const sink = collectStream();
  const res = responseStub(sink);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("visual answer");
  };
  try {
    mkdirSync(path.dirname(attachment), { recursive: true });
    writeFileSync(attachment, bytes);
    const attachmentIndex = new CodexAttachmentIndex({ codexHome });
    const mediaStore = new MediaStore({
      ttlMs: 60_000,
      maxBytes: 10 * 1024 * 1024,
      maxEntries: 64,
      stateDir: mediaDir,
      externalRoots: attachmentIndex.roots,
    });
    await relayResponses(
      {
        model: "gpt-5.6-luna@opencode-go",
        stream: false,
        input: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: dataUrl }] }],
      },
      res,
      {
        ...compactServices(),
        mainModel: "gpt-5.6-luna@opencode-go",
        visionModel: "gpt-5.6-luna@opencode-go",
        config: { ...configStub(), mainModel: "gpt-5.6-luna@opencode-go", visionModel: "gpt-5.6-luna@opencode-go" },
        knownModels: new Set(["gpt-5.6-luna@opencode-go"]),
        mediaStore,
        attachmentIndex,
        incomingHeaders: { "x-codex-session-id": sessionId },
        requestUrl: "/v1/responses",
      },
    );
    const ref = describeImageUrl(dataUrl).ref;
    assert.equal(mediaStore.get(ref).storage, "external");
    assert.equal(existsSync(path.join(mediaDir, `${ref}.bin`)), false, "no fallback blob was written");
    assert.equal(calls[0].input.flatMap((item) => item.content || []).find((part) => part.type === "input_image")?.image_url, dataUrl);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(mediaDir, { recursive: true, force: true });
  }
});

test("relayResponses keeps text-only guidance and image refs inside an agentic Flash turn", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("continue from the visual description");
  };
  try {
    const result = await relayResponses(
      {
        model: "deepseek-v4-flash",
        stream: false,
        instructions: baseInstructionsFor(configStub()),
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "Start the task." }] },
          { type: "function_call", call_id: "call_vision_loop", name: "shell_command", arguments: "{}" },
          { type: "function_call_output", call_id: "call_vision_loop", output: "done" },
          { type: "message", role: "user", content: [{ type: "input_text", text: "Now inspect this screenshot." }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
        ],
      },
      res,
      {
        recordUsage: () => {},
        config: configStub(),
        metrics: { begin: () => () => {}, recordResponseTransform: () => {}, recordResponseUsage: () => {} },
        mediaStore: { put: () => "img_agentic_turn" },
        routeAffinity: new RouteAffinity(),
        knownModels: new Set(["deepseek-v4-flash", "gpt-5.6-luna"]),
        mainModel: "deepseek-v4-flash",
        visionModel: "gpt-5.6-luna",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.model, "deepseek-v4-flash");
    assert.equal(result.route.directVision, false);
    assert.match(calls[0].instructions, /TEXT-ONLY model/, "the text model keeps its vision_inspect contract inside an agentic loop");
    const sentParts = calls[0].input.flatMap((item) => item.content || []);
    assert.equal(sentParts.some((part) => part.type === "input_image"), false, "the text model never receives the newly pasted image bytes");
    assert.ok(sentParts.some((part) => part.type === "input_text" && part.text.includes('vision_inspect(image_ref="img_agentic_turn"')), "the text model receives the exact vision_inspect reference instead");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses keeps an original image through a vision model tool continuation", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("continued visual work");
  };
  try {
    const selected = "gpt-5.6-luna@opencode-go";
    const affinity = new RouteAffinity();
    affinity.register("call_visual", selected);
    const result = await relayResponses(
      {
        model: selected,
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
          { type: "function_call", call_id: "call_visual", name: "recall_memory", arguments: "{}" },
          { type: "function_call_output", call_id: "call_visual", output: "memory result" },
        ],
      },
      res,
      {
        ...compactServices(),
        routeAffinity: affinity,
        mainModel: selected,
        visionModel: "mimo-v2.5@opencode-go",
        config: { ...configStub(), mainModel: selected, visionModel: "mimo-v2.5@opencode-go" },
        knownModels: new Set([selected, "mimo-v2.5@opencode-go", "deepseek-v4-flash@opencode-go"]),
        mediaStore: { put: () => "img_should_not_be_used" },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.reason, "tool_continuation");
    const image = calls[0].input[0].content.find((part) => part.type === "input_image");
    assert.ok(image, "an image before the tool marker remains visible to the continuation");
    assert.equal(image.image_url, "data:image/png;base64,AAAA");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayResponses keeps a new image for a picked vision model during an agentic loop", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return summaryResponse("picked visual model");
  };
  try {
    const selected = "mimo-v2.5@opencode-go";
    const result = await relayResponses(
      {
        model: selected,
        stream: false,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "start the review" }] },
          { type: "function_call", call_id: "call_shell", name: "shell_command", arguments: "{}" },
          { type: "function_call_output", call_id: "call_shell", output: "ready" },
          { type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
        ],
      },
      res,
      {
        ...compactServices(),
        mainModel: "deepseek-v4-flash@opencode-go",
        visionModel: "gpt-5.6-luna@opencode-go",
        config: { ...configStub(), mainModel: "deepseek-v4-flash@opencode-go" },
        knownModels: new Set(["deepseek-v4-flash@opencode-go", selected, "gpt-5.6-luna@opencode-go"]),
        mediaStore: { put: () => "img_should_not_be_used" },
        requestUrl: "/v1/responses",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.route.reason, "client_selected");
    assert.equal(result.route.directVision, false, "agentic history intentionally skips image escalation");
    const image = calls[0].input.at(-1).content.find((part) => part.type === "input_image");
    assert.ok(image, "target capability, not directVision telemetry, preserves image bytes");
    assert.deepEqual(image.image_url, { url: "data:image/png;base64,AAAA" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// adaptImageUrlShape is not about which models can see images - that is
// supportsVision. Both MiMo and Luna are vision models; they disagree on the
// wire format of the same Responses field, and only the declared side gets
// rewritten. These cover the branches the relay tests cannot reach: the relay
// only ever hands it well-formed Codex input with one string image.
const SHAPE_IMAGE = "data:image/png;base64,AAAA";

function imageInput(image_url) {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url, detail: "high" }],
  }];
}

test("adaptImageUrlShape wraps a string image_url and keeps the other part fields", () => {
  const [item] = adaptImageUrlShape(imageInput(SHAPE_IMAGE), "object");
  const image = item.content.find((part) => part.type === "input_image");
  assert.deepEqual(image.image_url, { url: SHAPE_IMAGE });
  assert.equal(image.detail, "high", "sibling fields on the part survive the rewrite");
  assert.equal(item.content[0].text, "what is this", "non-image parts are untouched");
});

test("adaptImageUrlShape is identity for every model that did not declare the shape", () => {
  // The overwhelming majority of models want the string form, so an undeclared
  // shape must not even copy the input: same reference in, same reference out.
  const input = imageInput(SHAPE_IMAGE);
  for (const shape of [undefined, "", "string"]) {
    assert.equal(adaptImageUrlShape(input, shape), input, `shape ${JSON.stringify(shape)} must pass the input straight through`);
  }
});

test("adaptImageUrlShape passes through anything that is not a content array", () => {
  // normalizeInputForRoute can hand back a non-array for the local/native paths,
  // and Codex sends items with no content of their own (reasoning, tool calls).
  for (const input of [undefined, null, "", { input: [] }]) {
    assert.equal(adaptImageUrlShape(input, "object"), input, "a non-array input is returned as-is");
  }
  const items = [null, { type: "reasoning" }, { type: "message", content: "plain text" }];
  assert.deepEqual(adaptImageUrlShape(items, "object"), items, "items without a content array are left alone");
});

test("adaptImageUrlShape never double-wraps an image_url that is already an object", () => {
  const already = { url: SHAPE_IMAGE };
  const input = imageInput(already);
  const [item] = adaptImageUrlShape(input, "object");
  const image = item.content.find((part) => part.type === "input_image");
  assert.deepEqual(image.image_url, already, "an object image_url is not wrapped again");
  assert.equal(item, input[0], "an item with nothing to change keeps its identity");
});

test("adaptImageUrlShape leaves an image-free item as the same object", () => {
  // rewriteHistoricalImages runs first and turns older images into image_ref
  // text, so most items reaching this function have no image left to convert.
  const input = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "image_ref: img_1" }],
  }];
  const output = adaptImageUrlShape(input, "object");
  assert.equal(output[0], input[0], "an untouched item is not needlessly copied");
});

test("relayOpaqueCollaboration relays an opaque payload through a native model and promotes it", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(
      [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"c1","type":"function_call","name":"relay_external_agent_payload","call_id":"c1","arguments":""}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"payload\\":\\"Write the exact token VERIFIED into RESULT.txt\\"}"}\n\n',
        'data: {"type":"response.completed","response":{"id":"r1","model":"gpt-5.6-luna"}}\n\n',
      ].join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const input = [
      { type: "agent_message", content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/verify\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAAopaque_cipher_blob" },
      ]},
    ];
    const services = {
      subagentModel: "gpt-5.6-luna",
      nativeSlugs: new Set(["gpt-5.6-luna", "gpt-5.6-sol"]),
      incomingHeaders: {},
    };
    const out = await relayOpaqueCollaboration(input, services);
    assert.equal(out[0].content[1].type, "input_text", "the opaque part becomes plaintext");
    assert.ok(out[0].content[1].text.includes("VERIFIED"), "plaintext payload survives the relay");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, "gpt-5.6-luna", "the relay uses the native subagent model");
    assert.equal(calls[0].tools[0].name, "relay_external_agent_payload");
    assert.equal(calls[0].tool_choice.name, "relay_external_agent_payload");
    assert.equal(calls[0].stream, true);
    assert.equal(calls[0].store, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayOpaqueCollaboration caches the decrypted payload per encrypted blob", async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"c1","type":"function_call","name":"relay_external_agent_payload","call_id":"c1","arguments":""}}\n\n' +
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"payload\\":\\"cached task\\"}"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const services = { subagentModel: "gpt-5.6-luna", nativeSlugs: new Set(["gpt-5.6-luna"]), incomingHeaders: {} };
    const item = { type: "agent_message", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAAsame_blob" },
    ]};
    await relayOpaqueCollaboration([item], services);
    await relayOpaqueCollaboration([item], services);
    assert.equal(fetches, 1, "a repeated opaque blob relays once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayOpaqueCollaboration keeps decrypted plaintext in a bounded short-lived cache", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"c1","type":"function_call","name":"relay_external_agent_payload","call_id":"c1","arguments":""}}\n\n' +
    'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"payload\\":\\"bounded task\\"}"}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  try {
    const services = {
      subagentModel: "gpt-5.6-luna",
      nativeSlugs: new Set(["gpt-5.6-luna"]),
      incomingHeaders: { "x-codex-session-id": "019fe9b0-f0b5-7e00-8703-862bf7c16a6d" },
    };
    for (let index = 0; index < 40; index += 1) {
      await relayOpaqueCollaboration([{
        type: "agent_message",
        content: [
          { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
          { type: "encrypted_content", encrypted_content: `gAAAAAbounded_${index}` },
        ],
      }], services);
    }
    const snapshot = collaborationRelayCacheSnapshot();
    assert.ok(snapshot.entries <= snapshot.maxEntries);
    assert.ok(snapshot.bytes <= snapshot.maxBytes);
    assert.equal(snapshot.ttlMs, 30 * 60 * 1_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayOpaqueCollaboration fails closed without a native model", async () => {
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetches += 1; return new Response("{}", { status: 200 }); };
  try {
    const input = [{ type: "agent_message", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAAnative_gone" },
    ]}];
    const out = await relayOpaqueCollaboration(input, { subagentModel: "", nativeSlugs: new Set(), incomingHeaders: {} });
    assert.equal(out, input, "with no native model the item stays opaque and no relay is attempted");
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayOpaqueCollaboration rejects when the native relay fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("no", { status: 401 });
  try {
    const input = [{ type: "agent_message", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAAnative_fail" },
    ]}];
    await assert.rejects(
      relayOpaqueCollaboration(input, { subagentModel: "gpt-5.6-luna", nativeSlugs: new Set(["gpt-5.6-luna"]), incomingHeaders: {} }),
      /Collaboration relay failed: HTTP 401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relayOpaqueCollaboration falls back past a routed subagent model to a native slug", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(
      'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"c1","type":"function_call","name":"relay_external_agent_payload","call_id":"c1","arguments":""}}\n\n' +
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"payload\\":\\"fallback task\\"}"}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    // The subagent is a routed alias (not in nativeSlugs) - never a relay target.
    const input = [{ type: "agent_message", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAArouted_subagent" },
    ]}];
    const services = {
      subagentModel: "gpt-5.6-luna@opencode-go",
      nativeSlugs: new Set(["gpt-5.6-sol", "gpt-5.6-terra"]),
      incomingHeaders: {},
    };
    await relayOpaqueCollaboration(input, services);
    assert.equal(calls[0].model, "gpt-5.6-terra", "a routed subagent alias is never used; the last native slug is");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applyToolPolicy reports the namespace split for each flattened tool", () => {
  const tools = [
    // The live desktop CLI declares the namespace with its trailing separator
    // ("mcp__modeldock__"); older transcripts carry the bare spelling. Both must
    // flatten to the same two-separator name, never "mcp__modeldock____...".
    { type: "namespace", name: "mcp__modeldock__", tools: [{ name: "web_search_exa", inputSchema: { type: "object", properties: {} } }] },
    { type: "namespace", name: "mcp__codex_apps__github", tools: [{ name: "_search_repositories", inputSchema: { type: "object", properties: {} } }] },
  ];
  const { tools: kept, namespaces } = applyToolPolicy(tools);
  assert.deepEqual(kept.map((tool) => tool.name), [
    "mcp__modeldock__web_search_exa",
    "mcp__codex_apps__github___search_repositories",
  ]);
  assert.deepEqual(namespaces.get("mcp__modeldock__web_search_exa"), { name: "web_search_exa", namespace: "mcp__modeldock__" });
  assert.deepEqual(
    applyToolPolicy([{ type: "namespace", name: "mcp__modeldock", tools: [{ name: "web_search_exa" }] }]).tools.map((t) => t.name),
    ["mcp__modeldock__web_search_exa"],
    "the bare namespace spelling produces the identical flat name",
  );
  // The tool name's own leading underscore is why the flat name cannot simply
  // be split on "__" to recover the pair.
  assert.deepEqual(namespaces.get("mcp__codex_apps__github___search_repositories"), {
    name: "_search_repositories",
    namespace: "mcp__codex_apps__github",
  });
});

test("applyToolPolicy matches the local allowlist against the flat MCP name", () => {
  // LOCAL_TOOL_ALLOWLIST is written in flat names; the namespace child carries
  // only "recall_memory". Testing the bare name stripped every MCP tool from
  // local backends even though the list explicitly whitelists them.
  const tools = [{
    type: "namespace",
    name: "mcp__modeldock__",
    tools: [{ name: "recall_memory" }, { name: "speak" }],
  }];
  const { tools: kept, stripped } = applyToolPolicy(tools, {
    allowToolNames: new Set(["mcp__modeldock__recall_memory"]),
  });
  assert.deepEqual(kept.map((tool) => tool.name), ["mcp__modeldock__recall_memory"]);
  assert.equal(stripped.allowlist, 1, "only the un-whitelisted sibling is dropped");
});

test("flattenNamespaceCalls collapses replayed Codex tool calls onto the declared name", () => {
  // Declared as namespace "mcp__node_repl"; Codex replays the call with the
  // trailing-separator spelling "mcp__node_repl__". Both must resolve to the
  // one flat name the upstream was actually given.
  const namespaces = new Map([["mcp__node_repl__js", { name: "js", namespace: "mcp__node_repl" }]]);
  const input = [
    { type: "function_call", name: "js", namespace: "mcp__node_repl__", call_id: "call_1", arguments: "{}" },
    { type: "function_call", name: "js", namespace: "mcp__node_repl", call_id: "call_2", arguments: "{}" },
    { type: "function_call", name: "exec_command", call_id: "call_3", arguments: "{}" },
  ];
  const out = flattenNamespaceCalls(input, namespaces);
  assert.equal(out[0].name, "mcp__node_repl__js");
  assert.equal(out[0].namespace, undefined);
  assert.equal(out[1].name, "mcp__node_repl__js", "both spellings land on the same declared tool");
  assert.equal(out[2], input[2], "a namespace-less builtin call is untouched");
  assert.equal(flattenNamespaceCalls([{ type: "message", role: "user" }], namespaces).length, 1);
});

test("flattenNamespaceCalls falls back to concatenation for an undeclared tool", () => {
  const input = [{ type: "function_call", name: "gone", namespace: "mcp__stale__", call_id: "call_1", arguments: "{}" }];
  const out = flattenNamespaceCalls(input, new Map());
  assert.equal(out[0].name, "mcp__stale__gone");
  assert.equal(out[0].namespace, undefined);
});

test("restoreNamespaceCall splits a flattened call back into name and namespace", () => {
  const namespaces = new Map([["mcp__modeldock__web_search_exa", { name: "web_search_exa", namespace: "mcp__modeldock" }]]);
  const call = { type: "function_call", name: "mcp__modeldock__web_search_exa", call_id: "call_1", arguments: "{}" };
  assert.deepEqual(restoreNamespaceCall(call, namespaces), {
    type: "function_call",
    name: "web_search_exa",
    namespace: "mcp__modeldock",
    call_id: "call_1",
    arguments: "{}",
  });
  const builtin = { type: "function_call", name: "exec_command", call_id: "call_2", arguments: "{}" };
  assert.equal(restoreNamespaceCall(builtin, namespaces), builtin, "unknown names pass through untouched");
  assert.equal(restoreNamespaceCall(call, new Map()), call, "no namespaces means no rewrite");
});

test("pipeNormalizedStream restores the namespace on a full-lifecycle tool call", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const namespaces = new Map([["mcp__modeldock__web_search_exa", { name: "web_search_exa", namespace: "mcp__modeldock" }]]);
  const call = { id: "item_1", type: "function_call", name: "mcp__modeldock__web_search_exa", call_id: "call_1", arguments: "{\"query\":\"x\"}" };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"id":"resp_1","type":"response.created","response":{"id":"resp_1","model":"deepseek-v4-flash"}}\n\n'));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_1", type: "response.output_item.added", item: call })}\n\n`));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_1", type: "response.output_item.done", item: { ...call, status: "completed" } })}\n\n`));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_1", type: "response.completed", response: { id: "resp_1", model: "deepseek-v4-flash", output: [call] } })}\n\n`));
      controller.close();
    },
  });
  await pipeNormalizedStream(body, res, null, () => {}, namespaces);
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  const events = forwarded
    .split(/\r\n\r\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
  const added = events.find((event) => event.type === "response.output_item.added");
  assert.equal(added.item.name, "web_search_exa");
  assert.equal(added.item.namespace, "mcp__modeldock");
  const done = events.find((event) => event.type === "response.output_item.done");
  assert.equal(done.item.name, "web_search_exa");
  assert.equal(done.item.namespace, "mcp__modeldock");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].name, "web_search_exa");
  assert.equal(completed.response.output[0].namespace, "mcp__modeldock");
  assert.ok(!forwarded.includes("mcp__modeldock__web_search_exa"), "the flattened name never reaches Codex");
});

test("pipeNormalizedStream restores xAI's bridged patch call to Codex custom-tool events", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const call = { id: "item_patch", type: "function_call", name: "apply_patch", call_id: "call_patch", arguments: "{\"input\":\"*** Begin Patch\"}" };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"id":"resp_patch","type":"response.created","response":{"id":"resp_patch","model":"grok-4.5"}}\n\n'));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_patch", type: "response.output_item.added", item: { ...call, arguments: "" } })}\n\n`));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_patch", type: "response.function_call_arguments.delta", item_id: "item_patch", call_id: "call_patch", delta: "*** Begin Patch" })}\n\n`));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_patch", type: "response.function_call_arguments.done", item_id: "item_patch", call_id: "call_patch", arguments: call.arguments })}\n\n`));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_patch", type: "response.output_item.done", item: { ...call, status: "completed" } })}\n\n`));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_patch", type: "response.completed", response: { id: "resp_patch", model: "grok-4.5", output: [call] } })}\n\n`));
      controller.close();
    },
  });
  await pipeNormalizedStream(body, res, null, () => {}, null, new Set(["apply_patch"]));
  const events = Buffer.concat(sink.chunks).toString("utf8")
    .split(/\r\n\r\n/)
    .flatMap((block) => block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))));
  const added = events.find((event) => event.type === "response.output_item.added");
  assert.equal(added.item.type, "custom_tool_call");
  assert.equal(added.item.input, "");
  assert.ok(events.some((event) => event.type === "response.custom_tool_call_input.delta"));
  const done = events.find((event) => event.type === "response.custom_tool_call_input.done");
  assert.equal(done.input, "*** Begin Patch");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output[0].type, "custom_tool_call");
  assert.equal(completed.response.output[0].input, "*** Begin Patch");
});

test("pipeNormalizedStream forwards a stream with no namespaced call untouched", async () => {
  const sink = collectStream();
  const res = responseStub(sink);
  const namespaces = new Map([["mcp__modeldock__web_search_exa", { name: "web_search_exa", namespace: "mcp__modeldock" }]]);
  const call = { id: "item_1", type: "function_call", name: "exec_command", call_id: "call_1", arguments: "{}" };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('data: {"id":"resp_1","type":"response.created","response":{"id":"resp_1","model":"deepseek-v4-flash"}}\n\n'));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_1", type: "response.output_item.added", item: call })}\n\n`));
      controller.enqueue(Buffer.from(`data: ${JSON.stringify({ id: "resp_1", type: "response.completed", response: { id: "resp_1", model: "deepseek-v4-flash", output: [call] } })}\n\n`));
      controller.close();
    },
  });
  await pipeNormalizedStream(body, res, null, () => {}, namespaces);
  const forwarded = Buffer.concat(sink.chunks).toString("utf8");
  assert.match(forwarded, /"name":"exec_command"/);
  assert.ok(!forwarded.includes('"namespace"'), "builtin calls gain no namespace field");
});

test("the local slim tool set keeps the shell Codex actually sends", () => {
  // Codex renamed the shell exec_command -> shell_command; the allowlist still
  // named only the old spelling, so slim mode handed local models a tool set
  // with no shell in it at all.
  // Codex uses three interchangeable spellings depending on config and on the
  // model's catalog declaration. "shell" is what a local custom model actually
  // receives, and it was the spelling still missing after the first fix.
  for (const shell of ["shell", "shell_command", "exec_command"]) {
    const { tools: kept } = applyToolPolicy(
      [{ type: "function", name: shell }],
      { allowToolNames: LOCAL_TOOL_ALLOWLIST },
    );
    assert.deepEqual(kept.map((tool) => tool.name), [shell], `${shell} must survive slim mode`);
  }
  const tools = [
    { type: "function", name: "write_stdin" },
    { type: "function", name: "wait" },
    { type: "function", name: "apply_patch" },
    { type: "function", name: "spawn_agent" },
  ];
  const { tools: kept } = applyToolPolicy(tools, { allowToolNames: LOCAL_TOOL_ALLOWLIST });
  const names = kept.map((tool) => tool.name);
  assert.ok(names.includes("write_stdin") && names.includes("wait"), "the tools that pair with the shell survive");
  assert.ok(!names.includes("spawn_agent"), "but not the multi-agent surface");
});

// What xAI accepts on the wire, measured against api.x.ai/v1/responses on
// 2026-08-21 with a live subscription token. Each case below is one request
// that was actually sent; the numbers and error strings are quoted from what
// came back, so this file is the record of that session as much as it is a
// test.
//
// The defect that prompted it: a Grok turn died on
//   422 "tools[8].type: unknown variant `custom`, expected one of `function`,
//   `web_search`, `x_search`, `image_generation`, ..."
// Codex emits apply_patch as a `custom` tool whenever the catalog says
// freeform, applyToolPolicy passed unknown types straight through, and the
// profile field that should have caught it - blockedToolTypes - was declared
// on every profile and read by nothing.
test("a tool type the upstream refuses never reaches it", () => {
  const codexTools = [
    { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
    { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
  ];
  const { tools, stripped } = applyToolPolicy(codexTools, { blockedToolTypes: new Set(["custom"]) });
  assert.deepEqual(tools.map((tool) => tool.type), ["function"]);
  assert.equal(stripped.blockedType, 1);
  // Measured: sending both returns 422 and the whole turn is lost, not just the
  // tool. Sending only the function tool returns 200.
  assert.equal(tools.some((tool) => tool.type === "custom"), false, "one unknown variant costs the entire request");
});

test("a hosted tool the upstream runs itself is kept, not stripped", () => {
  const codexTools = [
    { type: "function", name: "shell", parameters: { type: "object", properties: {} } },
    { type: "web_search" },
    { type: "tool_search" },
  ];
  // Measured: xAI answers 200 to a request carrying { type: "web_search" } and
  // 200 to one carrying { type: "x_search" }. Stripping them made the gate pay
  // Exa to redo a search the subscription already covers.
  const xai = applyToolPolicy(codexTools, { hostedToolTypes: new Set(["web_search", "x_search"]) });
  assert.deepEqual(xai.tools.map((tool) => tool.type), ["function", "web_search"]);
  assert.equal(xai.stripped.webSearch, 0);
  assert.equal(xai.stripped.toolSearch, 1, "tool_search is still ours to answer, not theirs");

  // Everyone else is unchanged: the default is to strip every hosted tool.
  const other = applyToolPolicy(codexTools, {});
  assert.deepEqual(other.tools.map((tool) => tool.type), ["function"]);
  assert.equal(other.stripped.webSearch, 1);
});

test("a profile's blocked list does not swallow the hosted counters", () => {
  // opencode-go declares tool_search and web_search in blockedToolTypes, and
  // both are also hosted types. Deciding blocked first moved them into
  // blockedType, so the metrics that report stripped hosted tooling read zero
  // while nothing had changed on the wire.
  const { tools, stripped } = applyToolPolicy(
    [{ type: "web_search" }, { type: "tool_search" }],
    { blockedToolTypes: new Set(["tool_search", "web_search"]) },
  );
  assert.deepEqual(tools, []);
  assert.equal(stripped.webSearch, 1);
  assert.equal(stripped.toolSearch, 1);
  assert.equal(stripped.blockedType, 0, "a hosted tool is accounted as hosted");
});

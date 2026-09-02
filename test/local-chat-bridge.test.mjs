import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Readable } from "node:stream";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { chatChunksToResponseEvents, chatCompletionToResponse, pipeChatCompletionStream, responsesToChat } from "../src/local-chat-bridge.mjs";
import { localWarmBaseFromSessionOpening, relayResponses } from "../src/gateway.mjs";
import { applyLocalEngineProfile } from "../src/profiles.mjs";

const fullCodexFixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));

function gatewayResponse() {
  const chunks = [];
  const res = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  }), {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    getHeader(name) { return this.headers[name]; },
    flushHeaders() { this.headersSent = true; },
  });
  res.chunks = chunks;
  return res;
}

test("Responses payload becomes a cacheable Chat request without dropping tool history", () => {
  const bridged = responsesToChat({
    model: "Qwen3.8-27B",
    stream: true,
    id_slot: 0,
    max_output_tokens: 64,
    instructions: [{ type: "input_text", text: "Use tools when needed." }],
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect this." }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "I should inspect it through the tool." }] },
      { type: "function_call", call_id: "call_a", name: "exec_command", arguments: "{\"cmd\":\"dir\"}" },
      { type: "function_call_output", call_id: "call_a", output: "file.txt" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Continue." }] },
    ],
    tools: [
      { type: "function", name: "exec_command", description: "Run a command.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
      { type: "custom", name: "apply_patch", description: "Apply a patch." },
    ],
  });
  assert.equal(bridged.payload.cache_prompt, true);
  assert.equal(bridged.payload.id_slot, 0, "managed llama slot affinity survives the dialect bridge");
  assert.deepEqual(bridged.payload.stream_options, { include_usage: true });
  assert.equal(bridged.payload.messages[0].role, "system");
  assert.equal(bridged.payload.messages[1].content[1].type, "image_url");
  assert.equal(bridged.payload.messages[2].tool_calls[0].id, "call_a");
  assert.equal(bridged.payload.messages[2].reasoning_content, "I should inspect it through the tool.");
  assert.equal(bridged.payload.messages[3].role, "tool");
  assert.equal(bridged.payload.tools[1].function.name, "apply_patch");
  assert.equal(bridged.payload.tools[1].function.parameters.properties.input.type, "string");
  assert.equal(bridged.customToolNames.has("apply_patch"), true);
});

test("a remote Chat bridge does not send llama-specific cache_prompt", () => {
  const bridged = responsesToChat({
    model: "qwen3.8-flash",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
  }, { cachePrompt: false });
  assert.equal(bridged.payload.cache_prompt, undefined);
});

test("a Qwen Chat template receives historical tool arguments as an object", () => {
  const bridged = responsesToChat({
    model: "Qwen3.8-27B",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Run it." }] },
      { type: "function_call", call_id: "call_qwen", name: "exec_command", arguments: "{\"cmd\":\"dir\"}" },
      { type: "function_call_output", call_id: "call_qwen", output: "ok" },
    ],
    tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
  }, { toolArgumentsAsObjects: true });
  assert.deepEqual(bridged.payload.messages[1].tool_calls[0].function.arguments, { cmd: "dir" });
  assert.equal(bridged.payload.messages[2].role, "tool");
});

test("Codex custom tool history becomes the same Chat function contract in both dialects", () => {
  const input = [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Apply it." }] },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "I should apply the patch." }] },
    { type: "custom_tool_call", call_id: "call_patch", name: "apply_patch", input: "*** Begin Patch\n*** End Patch" },
    { type: "custom_tool_call_output", call_id: "call_patch", output: "Done!" },
  ];
  const tools = [{ type: "custom", name: "apply_patch", description: "Apply a patch." }];
  const remote = responsesToChat({ model: "qwen3.8-flash", input, tools }, { cachePrompt: false });
  assert.equal(remote.payload.messages[1].reasoning_content, "I should apply the patch.");
  assert.deepEqual(JSON.parse(remote.payload.messages[1].tool_calls[0].function.arguments), { input: "*** Begin Patch\n*** End Patch" });
  assert.equal(remote.payload.messages[2].role, "tool");
  assert.equal(remote.payload.messages[2].tool_call_id, "call_patch");
  assert.equal(remote.payload.messages[2].content, "Done!");

  const local = responsesToChat({ model: "Qwen3.8-27B", input, tools }, { toolArgumentsAsObjects: true });
  assert.deepEqual(local.payload.messages[1].tool_calls[0].function.arguments, { input: "*** Begin Patch\n*** End Patch" });
});

test("llama media sentinels in text history are escaped without touching real images", () => {
  const marker = "<__media_runtime_marker__>";
  const escaped = "<\u200b__media_runtime_marker__>";
  const bridged = responsesToChat({
    model: "Qwen3.8-27B",
    instructions: `Inspect ${marker} as plain text.`,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: `Literal ${marker}` },
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      },
      { type: "function_call", call_id: "call_marker", name: "exec_command", arguments: JSON.stringify({ cmd: `echo ${marker}` }) },
      { type: "function_call_output", call_id: "call_marker", output: `props media_marker=${marker}` },
    ],
    tools: [{ type: "function", name: "exec_command", description: `Run ${marker}.`, parameters: { type: "object", properties: { cmd: { type: "string", description: marker } } } }],
  }, { toolArgumentsAsObjects: true, mediaMarker: marker });
  const [system, user, assistant, tool] = bridged.payload.messages;
  assert.equal(system.content.includes(marker), false);
  assert.equal(user.content[0].text, `Literal ${escaped}`);
  assert.equal(user.content[1].image_url.url, "data:image/png;base64,AA==", "real image data is untouched");
  assert.equal(assistant.tool_calls[0].function.arguments.cmd, `echo ${escaped}`);
  assert.equal(tool.content, `props media_marker=${escaped}`);
  assert.equal(bridged.payload.tools[0].function.description.includes(marker), false);
  assert.equal(bridged.payload.tools[0].function.parameters.properties.cmd.description, escaped);
});

test("the local Chat relay uses the active llama media sentinel for tool output", async (t) => {
  const marker = "<__media_runtime_marker__>";
  const escaped = "<\u200b__media_runtime_marker__>";
  const id = "Qwen3.8-27B";
  const selectedModel = `${id}@llamacpp`;
  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:11436/v1",
    models: [{ id, upstreamId: id, label: id, supportsVision: true, mediaMarker: marker, contextWindow: 16_384 }],
  });
  t.after(() => applyLocalEngineProfile("llamacpp", null));
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    return new Response(JSON.stringify({
      id: "chatcmpl_marker",
      model: id,
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const res = gatewayResponse();
    const result = await relayResponses({
      model: selectedModel,
      stream: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect llama props." }] },
        { type: "function_call", call_id: "call_props", name: "exec_command", arguments: "{\"cmd\":\"props\"}" },
        { type: "function_call_output", call_id: "call_props", output: `media_marker=${marker}` },
      ],
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }],
    }, res, {
      config: { mainModel: selectedModel, profileId: "llamacpp", tokens: {} },
      mainModel: selectedModel,
      visionModel: "",
      knownModels: new Set([selectedModel]),
      incomingHeaders: { "x-codex-session-id": "marker-relay-session" },
      requestUrl: "/v1/responses",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].messages.find((message) => message.role === "tool")?.content, `media_marker=${escaped}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("managed-session opening derives the identical warm-base key as the first local Codex request", async (t) => {
  const id = "Qwen3.8-27B";
  const selectedModel = `${id}@llamacpp`;
  const opening = {
    instructions: "GLOBAL CODEx INSTRUCTIONS",
    developerMessages: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "WORKSPACE RULE" }] }],
    tools: [{
      type: "namespace",
      name: "codex_app",
      tools: [{ type: "function", name: "exec_command", description: "Run a command.", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }],
    }],
  };
  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:11436/v1",
    models: [{ id, upstreamId: id, label: id, supportsVision: false, contextWindow: 16_384 }],
  });
  t.after(() => applyLocalEngineProfile("llamacpp", null));
  const config = { mainModel: selectedModel, profileId: "llamacpp", tokens: {} };
  const expected = localWarmBaseFromSessionOpening({ config, model: selectedModel, opening });
  assert.ok(expected, "the active opening has a local warm-base representation");
  const originalFetch = globalThis.fetch;
  let actual = null;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "chatcmpl_prefix", model: id, choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await relayResponses({
      model: selectedModel,
      stream: false,
      instructions: opening.instructions,
      input: [...opening.developerMessages, { type: "message", role: "user", content: [{ type: "input_text", text: "REAL USER MESSAGE" }] }],
      tools: opening.tools,
    }, gatewayResponse(), {
      config,
      mainModel: selectedModel,
      visionModel: "",
      knownModels: new Set([selectedModel]),
      incomingHeaders: { "x-codex-session-id": "opening-match" },
      requestUrl: "/v1/responses",
      localHostRuntime: {
        async run({ warmBase, run }) {
          actual = warmBase;
          return run({ slot: 0, cache: { tier: "cold" } });
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(actual?.sessionKey, expected.sessionKey);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Chat completion becomes a Codex Responses completion with cached-token usage", () => {
  const response = chatCompletionToResponse({
    id: "chatcmpl_1",
    created: 17,
    model: "Qwen3.8-27B",
    choices: [{ message: { content: "Working.", tool_calls: [{ id: "call_a", type: "function", function: { name: "apply_patch", arguments: "{\"input\":\"*** Begin Patch\"}" } }] } }],
    usage: { prompt_tokens: 8308, completion_tokens: 41, prompt_tokens_details: { cached_tokens: 8304 } },
  }, {
    restoreCall: (item) => item.name === "apply_patch" ? { ...item, type: "custom_tool_call", input: JSON.parse(item.arguments).input } : item,
  });
  assert.equal(response.id, "chatcmpl_1");
  assert.match(response.output[0].id, /^msg_/);
  assert.equal(response.output[0].content[0].text, "Working.");
  assert.equal(response.output[1].type, "custom_tool_call");
  assert.match(response.output[1].id, /^ctc_/);
  assert.equal(response.output[1].call_id, "call_a", "the provider call id remains the tool-output join key");
  assert.equal(response.output[1].input, "*** Begin Patch");
  assert.equal(response.usage.input_tokens_details.cached_tokens, 8304);
});

test("non-stream Chat reasoning dialects become replayable Responses items", () => {
  for (const field of ["reasoning_content", "reasoning", "reasoning_text"]) {
    const response = chatCompletionToResponse({
      id: `chatcmpl_${field}`,
      model: "Qwen3.8-27B",
      choices: [{ message: { [field]: `think:${field}`, content: "Done." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 5 } },
    });
    assert.equal(response.output[0].type, "reasoning");
    assert.match(response.output[0].id, /^rs_/);
    assert.equal(response.output[0].content[0].text, `think:${field}`);
    assert.deepEqual(response.output[0].summary, []);
    assert.equal(response.output[0].encrypted_content, "");
    assert.equal(response.output[1].content[0].text, "Done.");
    assert.equal(response.usage.output_tokens_details.reasoning_tokens, 5);
  }
});

test("a Chat length stop remains incomplete instead of masquerading as a completed response", () => {
  const response = chatCompletionToResponse({
    id: "chatcmpl_limited",
    model: "Qwen3.8-27B",
    choices: [{ finish_reason: "length", message: { content: "Partial answer" } }],
  });
  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
});

test("Chat stream produces complete Responses function-call lifecycle with cache usage", () => {
  const events = chatChunksToResponseEvents([
    {
      id: "chatcmpl_tool",
      created: 18,
      model: "Qwen3.8-27B",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_echo", type: "function", function: { name: "echo", arguments: "{\"value\":\"" } }] } }],
    },
    {
      id: "chatcmpl_tool",
      model: "Qwen3.8-27B",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "second\"}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 8363, completion_tokens: 41, prompt_tokens_details: { cached_tokens: 8304 } },
    },
  ]);
  const added = events.find((event) => event.type === "response.output_item.added" && event.item?.type === "function_call");
  const done = events.find((event) => event.type === "response.function_call_arguments.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(added.item.name, "echo");
  assert.match(added.item.id, /^fc_/);
  assert.equal(added.item.call_id, "call_echo");
  assert.equal(done.item_id, added.item.id);
  assert.equal(done.call_id, "call_echo");
  assert.equal(done.arguments, "{\"value\":\"second\"}");
  assert.equal(completed.response.output[0].name, "echo");
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 8304);
});

test("streamed Chat custom tools use native-compatible item ids without changing call ids", () => {
  const events = chatChunksToResponseEvents([{
    id: "chatcmpl_patch",
    model: "Qwen3.8-27B",
    choices: [{ index: 0, delta: {
      tool_calls: [{ index: 0, id: "call_patch", type: "function", function: { name: "apply_patch", arguments: "{\"input\":\"*** Begin" } }],
    } }],
  }, {
    id: "chatcmpl_patch",
    model: "Qwen3.8-27B",
    choices: [{ index: 0, delta: {
      tool_calls: [{ index: 0, function: { arguments: " Patch\"}" } }],
    }, finish_reason: "tool_calls" }],
  }], {
    restoreCall: (item) => item.name === "apply_patch"
      ? { ...item, type: "custom_tool_call", input: item.arguments }
      : item,
  });
  const added = events.find((event) => event.type === "response.output_item.added");
  const delta = events.find((event) => event.type === "response.custom_tool_call_input.delta");
  const done = events.find((event) => event.type === "response.custom_tool_call_input.done");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(added.item.type, "custom_tool_call");
  assert.match(added.item.id, /^ctc_/);
  assert.equal(added.item.call_id, "call_patch");
  assert.equal(delta.item_id, added.item.id);
  assert.equal(delta.call_id, "call_patch");
  assert.equal(done.item_id, added.item.id);
  assert.equal(done.call_id, "call_patch");
  assert.match(completed.response.output[0].id, /^ctc_/);
  assert.equal(completed.response.output[0].call_id, "call_patch");
});

test("streamed Chat reasoning survives a complete Responses tool round trip", () => {
  const events = chatChunksToResponseEvents([
    {
      id: "chatcmpl_reasoning_tool",
      created: 19,
      model: "Qwen3.8-27B",
      choices: [{ index: 0, delta: { role: "assistant", reasoning: "Inspect " } }],
    },
    {
      id: "chatcmpl_reasoning_tool",
      model: "Qwen3.8-27B",
      choices: [{ index: 0, delta: {
        reasoning_text: "the file.",
        content: "Checking.",
        tool_calls: [{ index: 0, id: "call_reasoning", type: "function", function: { name: "exec_command", arguments: "{\"cmd\":\"dir\"}" } }],
      }, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
    },
  ]);
  const reasoningDelta = events.find((event) => event.type === "response.reasoning_text.delta");
  const textDelta = events.find((event) => event.type === "response.output_text.delta");
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(reasoningDelta.output_index, 0);
  assert.equal(textDelta.output_index, 1, "visible text follows the reasoning item instead of colliding at output index zero");
  assert.deepEqual(completed.response.output.map((item) => item.type), ["reasoning", "message", "function_call"]);
  assert.equal(completed.response.output[0].content[0].text, "Inspect the file.");
  assert.equal(completed.response.output[0].encrypted_content, "");
  assert.equal(completed.response.usage.output_tokens_details.reasoning_tokens, 12);

  const replay = responsesToChat({
    model: "Qwen3.8-27B",
    input: [
      ...completed.response.output,
      { type: "function_call_output", call_id: "call_reasoning", output: "file.txt" },
    ],
  });
  assert.equal(replay.payload.messages[0].role, "assistant");
  assert.equal(replay.payload.messages[0].reasoning_content, "Inspect the file.");
  assert.equal(replay.payload.messages[0].content, "Checking.");
  assert.equal(replay.payload.messages[0].tool_calls[0].id, "call_reasoning");
  assert.equal(replay.payload.messages[1].role, "tool");
});

test("a streamed Chat length stop emits a Responses incomplete terminal event", () => {
  const events = chatChunksToResponseEvents([{
    id: "chatcmpl_limited_stream",
    model: "Qwen3.8-27B",
    choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: "length" }],
  }]);
  const incomplete = events.find((event) => event.type === "response.incomplete");
  assert.ok(incomplete);
  assert.equal(incomplete.response.status, "incomplete");
  assert.deepEqual(incomplete.response.incomplete_details, { reason: "max_output_tokens" });
});

test("Chat stream pipe emits only Responses events and completes", async () => {
  const raw = [
    'data: {"id":"chatcmpl_text","created":19,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","content":"LOCAL"}}]}\n\n',
    'data: {"id":"chatcmpl_text","model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"content":"_OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8}}}\n\n',
    "data: [DONE]\n\n",
  ];
  const res = new EventEmitter();
  res.writableFinished = false;
  res.writes = [];
  res.write = (value) => { res.writes.push(value); return true; };
  res.end = () => { res.writableFinished = true; res.emit("finish"); };
  const observed = [];
  const result = await pipeChatCompletionStream(Readable.toWeb(Readable.from(raw)), res, { onEvent: (event) => observed.push(event) });
  assert.equal(result.interrupted, false);
  assert.ok(res.writableFinished);
  assert.ok(res.writes.every((value) => value.startsWith("data: {")));
  const complete = observed.find((event) => event.type === "response.completed");
  assert.equal(complete.response.output[0].content[0].text, "LOCAL_OK");
  assert.equal(complete.response.usage.input_tokens_details.cached_tokens, 8);
});

test("full original Codex package reaches local Chat as functions and returns a Codex tool lifecycle", async (t) => {
  assert.equal(fullCodexFixture.capture.kind, "full_original_codex_request");
  assert.equal(fullCodexFixture.request.tools.length, 164);
  const id = "Qwen3.8-27B";
  const selectedModel = `${id}@llamacpp`;
  applyLocalEngineProfile("llamacpp", {
    baseUrl: "http://127.0.0.1:11436/v1",
    models: [{ id, upstreamId: id, label: id, supportsVision: true, contextWindow: 16_384 }],
  });
  t.after(() => applyLocalEngineProfile("llamacpp", null));
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(Readable.toWeb(Readable.from([
      'data: {"id":"chatcmpl_full","created":20,"model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_local","type":"function","function":{"name":"exec_command","arguments":"{\\"cmd\\":\\""}}]}}]}\n\n',
      'data: {"id":"chatcmpl_full","model":"Qwen3.8-27B","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"echo LOCAL_OK\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8308,"completion_tokens":9,"prompt_tokens_details":{"cached_tokens":8304}}}\n\n',
      "data: [DONE]\n\n",
    ])), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const payload = { ...fullCodexFixture.request, model: selectedModel };
    const res = gatewayResponse();
    const result = await relayResponses(payload, res, {
      config: { mainModel: selectedModel, profileId: "llamacpp", tokens: {} },
      mainModel: selectedModel,
      visionModel: "",
      knownModels: new Set([selectedModel]),
      incomingHeaders: { "x-codex-session-id": "fixture-local-session" },
      requestUrl: "/v1/responses",
    });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "http://127.0.0.1:11436/v1/chat/completions");
    assert.equal(seen[0].body.input, undefined, "the local upstream must receive Chat, not Responses");
    assert.ok(Array.isArray(seen[0].body.messages));
    assert.ok(seen[0].body.tools.every((tool) => tool.type === "function"));
    assert.ok(seen[0].body.tools.some((tool) => tool.function.name === "exec_command"), "the complete fixture retains the local shell tool");
    assert.equal(seen[0].body.cache_prompt, true);
    const events = Buffer.concat(res.chunks).toString("utf8");
    assert.match(events, /response\.function_call_arguments\.done/);
    assert.match(events, /exec_command/);
    assert.match(events, /cached_tokens":8304/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteAffinity, currentTurnHasImage, currentTurnStartIndex, routeResponsesRequest } from "../src/router.mjs";

const models = { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna" };

test("routes a current-turn image directly to Luna", () => {
  const route = routeResponsesRequest({
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  }, models);
  assert.deepEqual(route, { model: "gpt-5.6-luna", reason: "current_turn_image", directVision: true });
});

test("a vision-capable main model reads the image itself instead of escalating to the vision model", () => {
  const route = routeResponsesRequest({
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  }, { mainModel: "gpt-5.6-luna", visionModel: "mimo-v2.5", mainModelSupportsVision: true });
  assert.deepEqual(route, { model: "gpt-5.6-luna", reason: "current_turn_image", directVision: true });
});

test("a text-only model with Vision=None reports unavailable instead of routing an empty model", () => {
  const route = routeResponsesRequest({
    model: "deepseek-v4-flash",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  }, {
    mainModel: "deepseek-v4-flash",
    visionModel: "",
    knownModels: new Set(["deepseek-v4-flash"]),
  });
  assert.deepEqual(route, { model: "deepseek-v4-flash", reason: "vision_unavailable", directVision: false });
});

test("a picked vision-capable model reads a new image itself", () => {
  const route = routeResponsesRequest({
    model: "grok-4.5",
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  }, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    knownModels: new Set(["deepseek-v4-flash", "grok-4.5", "gpt-5.6-luna"]),
    modelSupportsVision: (model) => model === "grok-4.5" || model === "gpt-5.6-luna",
  });
  assert.deepEqual(route, { model: "grok-4.5", reason: "current_turn_image", directVision: true });
});

test("text-only requests never route to Luna, even with visual wording", () => {
  for (const input of ["Inspect this screenshot carefully", "\u770B\u4E00\u4E0B\u8FD9\u4E2A\u6309\u94AE\u4E3A\u4EC0\u4E48\u88AB\u906E\u6321", "\u8FD9\u5F20\u622A\u56FE\u91CC\u663E\u793A\u4EC0\u4E48", "\u7528\u6D4F\u89C8\u5668\u622A\u56FE\u770B\u524D\u7AEF"]) {
    const route = routeResponsesRequest({ input }, models);
    assert.equal(route.model, "deepseek-v4-flash", `"${input}" must stay on the main model`);
    assert.equal(route.reason, "default_main");
  }
});

test("an image in a later message still routes the current turn to Luna", () => {
  const route = routeResponsesRequest({
    input: [
      { role: "user", content: [{ type: "input_text", text: "first" }] },
      { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { role: "user", content: [{ type: "input_text", text: "look at this" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    ],
  }, models);
  assert.equal(route.model, "gpt-5.6-luna");
  assert.equal(route.reason, "current_turn_image");
});

test("returns to DeepSeek on the next independent nonvisual turn", () => {
  const route = routeResponsesRequest({
    input: [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
      { role: "assistant", content: [{ type: "output_text", text: "The button is hidden by the modal." }] },
      { role: "user", content: [{ type: "input_text", text: "Now update the implementation." }] },
    ],
  }, models);
  assert.deepEqual(route, { model: "deepseek-v4-flash", reason: "default_main", directVision: false });
});

test("a tool-call-only assistant turn ends the turn; a stale image behind it does not re-trigger vision", () => {
  // The assistant turn is a bare function_call (no role:assistant message), as in
  // an agentic coding loop. The current turn is only the tool output, so the image
  // from the earlier user turn must NOT keep routing every continuation to vision.
  const route = routeResponsesRequest({
    model: "deepseek-v4-flash",
    input: [
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "done" },
    ],
  }, { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: new Set(["deepseek-v4-flash"]) });
  assert.notEqual(route.reason, "current_turn_image", "a stale image behind a tool-call turn must not re-trigger vision");
  assert.equal(route.model, "deepseek-v4-flash");
});

test("Codex turn ids keep an interrupted prior tool image out of the next user turn", () => {
  const meta = (turn_id) => ({ internal_chat_message_metadata_passthrough: { turn_id } });
  const input = [
    { ...meta("turn_old"), type: "message", role: "user", content: [{ type: "input_text", text: "render" }] },
    { ...meta("turn_old"), type: "function_call", call_id: "old", name: "node_repl", arguments: "{}" },
    { ...meta("turn_old"), type: "function_call_output", call_id: "old", output: [{ type: "input_image", image_url: "data:image/png;base64,OLD" }] },
    { ...meta("turn_new"), type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
  ];
  assert.equal(currentTurnStartIndex(input), 3);
  assert.equal(currentTurnHasImage(input), false);
});

test("a compaction item ends the turn; a stale image behind it does not re-trigger vision", () => {
  const route = routeResponsesRequest({
    model: "deepseek-v4-flash",
    input: [
      { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/jpeg;base64,AA==" }] },
      { type: "compaction", id: "cmp_1", encrypted_content: "kcr1:e30=" },
      { role: "user", content: [{ type: "input_text", text: "continue" }] },
    ],
  }, { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: new Set(["deepseek-v4-flash"]) });
  assert.notEqual(route.reason, "current_turn_image", "a stale image behind compaction must not re-trigger vision");
  assert.equal(route.model, "deepseek-v4-flash");
});

test("a genuinely new image after compaction still routes to vision", () => {
  const route = routeResponsesRequest({
    model: "deepseek-v4-flash",
    input: [
      { role: "user", content: [{ type: "input_text", text: "start" }] },
      { type: "compaction", id: "cmp_1", encrypted_content: "kcr1:e30=" },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,BB==" }] },
    ],
  }, { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: new Set(["deepseek-v4-flash"]) });
  assert.equal(route.reason, "current_turn_image");
  assert.equal(route.model, "gpt-5.6-luna");
});

test("a new image during an agentic tool loop stays on the text model", () => {
  // Pasted-image escalation is for ordinary chat. Once the payload already has
  // tool/reasoning items, the coding model stays in charge and inspects via
  // vision_inspect instead of shipping the whole history to the vision model.
  const route = routeResponsesRequest({
    model: "deepseek-v4-flash",
    input: [
      { role: "user", content: [{ type: "input_text", text: "start" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "done" },
      { role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,BB==" }] },
    ],
  }, { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: new Set(["deepseek-v4-flash"]) });
  assert.notEqual(route.reason, "current_turn_image");
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.directVision, false);
});

test("the router sees an image inside an unpromoted Codex tool output", () => {
  const input = [
    { role: "user", content: [{ type: "input_text", text: "render it" }] },
    { type: "function_call", call_id: "c1", name: "node_repl", arguments: "{}" },
    {
      type: "function_call_output",
      call_id: "c1",
      output: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    },
  ];
  assert.equal(currentTurnHasImage(input), true);
});

test("does not treat Codex developer instructions about image support as user visual intent", () => {
  const route = routeResponsesRequest({ input: [
    { role: "developer", content: [{ type: "input_text", text: "When users attach an image, inspect it carefully." }] },
    { role: "user", content: [{ type: "input_text", text: "Run the unit tests." }] },
  ] }, models);
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.reason, "default_main");
});

test("keeps an abstract discussion about vision routing on the main model", () => {
  const route = routeResponsesRequest({ input: "Discuss the architecture of image and vision routing." }, models);
  assert.equal(route.model, "deepseek-v4-flash");
});

test("pins a Luna tool continuation by call_id and consumes the pin", () => {
  const affinity = new RouteAffinity();
  affinity.register("call_luna", "gpt-5.6-luna");
  const source = { input: [{ type: "custom_tool_call_output", call_id: "call_luna", output: "done" }] };
  const pinned = routeResponsesRequest(source, { ...models, affinity });
  assert.equal(pinned.model, "gpt-5.6-luna");
  assert.equal(pinned.reason, "tool_continuation");
  assert.equal(pinned.pinnedCallId, "call_luna");
  assert.deepEqual(routeResponsesRequest(source, { ...models, affinity }), {
    model: "deepseek-v4-flash",
    reason: "default_main",
    directVision: false,
  });
});

test("an explicit client model overrides a stale cross-model pin (the stuck-on-Luna fix)", () => {
  const known = new Set(["deepseek-v4-flash", "gpt-5.6-luna"]);
  const affinity = new RouteAffinity();
  affinity.register("call_luna", "gpt-5.6-luna");
  // Codex sends its picker model (deepseek) on the continuation. It must win over
  // the stale Luna pin so a single visual turn cannot cascade the whole session
  // onto Luna and never return to the model the user selected.
  const source = { model: "deepseek-v4-flash", input: [{ type: "function_call_output", call_id: "call_luna", output: "done" }] };
  const route = routeResponsesRequest(source, { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: known, affinity });
  assert.equal(route.model, "deepseek-v4-flash", "the user's explicit selection reclaims the wheel");
  assert.notEqual(route.reason, "tool_continuation");
});

test("a same-model tool continuation still pins so the tool loop stays coherent", () => {
  const known = new Set(["deepseek-v4-flash"]);
  const affinity = new RouteAffinity();
  affinity.register("call_ds", "deepseek-v4-flash");
  const source = { model: "deepseek-v4-flash", input: [{ type: "function_call_output", call_id: "call_ds", output: "done" }] };
  const route = routeResponsesRequest(source, { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: known, affinity });
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.reason, "tool_continuation", "same-model pin still applies");
});

test("a picked vision-capable model keeps visual affinity through a tool continuation", () => {
  const affinity = new RouteAffinity();
  affinity.register("call_visual", "grok-4.5");
  const route = routeResponsesRequest({
    model: "grok-4.5",
    input: [{ type: "function_call_output", call_id: "call_visual", output: "done" }],
  }, {
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
    knownModels: new Set(["deepseek-v4-flash", "grok-4.5", "gpt-5.6-luna"]),
    affinity,
    modelSupportsVision: (model) => model === "grok-4.5" || model === "gpt-5.6-luna",
  });
  assert.equal(route.model, "grok-4.5");
  assert.equal(route.reason, "tool_continuation");
  assert.equal(route.directVision, true);
});

test("a pin with no client model still holds (continuation without a picker model)", () => {
  const affinity = new RouteAffinity();
  affinity.register("call_luna", "gpt-5.6-luna");
  const source = { input: [{ type: "function_call_output", call_id: "call_luna", output: "done" }] };
  const route = routeResponsesRequest(source, { ...models, affinity });
  assert.equal(route.model, "gpt-5.6-luna", "no explicit client signal -> the pin decides");
  assert.equal(route.reason, "tool_continuation");
});

test("old completed Luna call output does not pin a later independent turn", () => {
  const affinity = new RouteAffinity();
  affinity.register("call_old", "gpt-5.6-luna");
  const route = routeResponsesRequest({ input: [
    { type: "function_call_output", call_id: "call_old", output: "done" },
    { role: "assistant", content: "Tool work finished." },
    { role: "user", content: "continue" },
  ] }, { ...models, affinity });
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(affinity.snapshot().activeCallIds, 1, "the historical call does not consume or activate affinity");
});

test("registerResponse records standard and custom tool calls", () => {
  const affinity = new RouteAffinity();
  affinity.registerResponse({ output: [
    { type: "function_call", call_id: "call_1" },
    { type: "custom_tool_call", call_id: "call_2" },
    { type: "message", id: "msg_1" },
  ] }, "gpt-5.6-luna");
  assert.equal(affinity.snapshot().activeCallIds, 2);
});

test("a model the client picked from our catalog is honoured and reported as such", () => {
  const known = new Set(["deepseek-v4-flash", "glm-5.2", "kimi-k2.6"]);
  const route = routeResponsesRequest(
    { model: "glm-5.2", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: known },
  );
  assert.equal(route.model, "glm-5.2", "Codex's picker selection wins on the main road");
  assert.equal(route.reason, "client_selected");
  assert.equal(route.directVision, false);
});

test("an unknown client model falls back to the dashboard selection", () => {
  const known = new Set(["deepseek-v4-flash", "glm-5.2"]);
  const route = routeResponsesRequest(
    { model: "gpt-5.6-sol", input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
    { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: known },
  );
  assert.equal(route.model, "deepseek-v4-flash", "a model we cannot serve never reaches an upstream");
  assert.equal(route.reason, "default_main");
});

test("a picked model still yields to an image in the current turn", () => {
  const known = new Set(["deepseek-v4-flash", "glm-5.2"]);
  const route = routeResponsesRequest(
    { model: "glm-5.2", input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] },
    { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: known },
  );
  assert.equal(route.model, "gpt-5.6-luna", "vision routing outranks the picker");
  assert.equal(route.reason, "current_turn_image");
});

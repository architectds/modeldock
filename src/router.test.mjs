import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteAffinity, routeResponsesRequest } from "./router.mjs";

const models = { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna" };

test("routes a current-turn image directly to Luna", () => {
  const route = routeResponsesRequest({
    input: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }] }],
  }, models);
  assert.deepEqual(route, { model: "gpt-5.6-luna", reason: "current_turn_image", directVision: true });
});

test("text-only requests never route to Luna, even with visual wording", () => {
  for (const input of ["Inspect this screenshot carefully", "看一下这个按钮为什么被遮挡", "这张截图里显示什么", "用浏览器截图看前端"]) {
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
  assert.equal(pinned.reason, "luna_tool_continuation");
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
  assert.notEqual(route.reason, "luna_tool_continuation");
});

test("a same-model tool continuation still pins so the tool loop stays coherent", () => {
  const known = new Set(["deepseek-v4-flash"]);
  const affinity = new RouteAffinity();
  affinity.register("call_ds", "deepseek-v4-flash");
  const source = { model: "deepseek-v4-flash", input: [{ type: "function_call_output", call_id: "call_ds", output: "done" }] };
  const route = routeResponsesRequest(source, { mainModel: "deepseek-v4-flash", visionModel: "gpt-5.6-luna", knownModels: known, affinity });
  assert.equal(route.model, "deepseek-v4-flash");
  assert.equal(route.reason, "luna_tool_continuation", "same-model pin still applies");
});

test("a pin with no client model still holds (continuation without a picker model)", () => {
  const affinity = new RouteAffinity();
  affinity.register("call_luna", "gpt-5.6-luna");
  const source = { input: [{ type: "function_call_output", call_id: "call_luna", output: "done" }] };
  const route = routeResponsesRequest(source, { ...models, affinity });
  assert.equal(route.model, "gpt-5.6-luna", "no explicit client signal -> the pin decides");
  assert.equal(route.reason, "luna_tool_continuation");
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

// Focused xAI adapter regressions over more than one turn.
//
// These deliberately small inputs validate named transforms only. They are not
// a complete Codex package fixture and must never be used to claim Codex
// compatibility. The provider behaviors below were measured against
// api.x.ai/v1/responses on 2026-08-21 after a real session failed with:
//   422 "tools[8].type: unknown variant `custom`, expected one of `function`,
//   `web_search`, `x_search`, ..."
// xAI refuses the WHOLE request on an unknown tool variant, so one bad entry in
// tools[] costs the turn - which is why this drives a tool round trip rather
// than a single call. A first turn that passes proves nothing about the second,
// where the history carries function_call and function_call_output items and
// the tool list is sent again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { normalizeXaiInput } from "../src/gateway.mjs";
import { createApp, createServices } from "../src/server.mjs";
import { XAI_PROFILE, applyXaiProfile } from "../src/profiles.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

// Focused tool declarations for the adapter transforms exercised below. This
// is intentionally not a complete Codex tool package.
function focusedTools() {
  return [
    { type: "function", name: "shell", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
    { type: "function", name: "view_image", description: "inspect a local image", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
    {
      type: "namespace",
      name: "computer",
      tools: [{ type: "function", name: "click", description: "click a point", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } }],
    },
    // The incoming client may attach this OpenAI-only hosted-web option here.
    // xAI supports the tool itself but rejects this descriptor field.
    { type: "web_search", external_web_access: true },
    // xAI runs this server-side and returns an image_generation_call on the
    // Responses stream. It must not be mistaken for Codex's native image route.
    { type: "image_generation", action: "generate" },
    { type: "tool_search" },
  ];
}

const answer = (text) => ({
  id: "resp_1",
  object: "response",
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 10, output_tokens: 3 },
});

const callsTool = (name = "shell", argumentsValue = JSON.stringify({ cmd: "ls" })) => ({
  id: "resp_0",
  object: "response",
  status: "completed",
  output: [{ type: "function_call", name, arguments: argumentsValue, call_id: "call_1" }],
  usage: { input_tokens: 8, output_tokens: 5 },
});

// A stand-in for api.x.ai that records every body it is handed and answers
// with whatever the test queued. It also enforces the one rule the real
// endpoint enforces, so a regression fails here the way it failed in
// production rather than passing quietly.
function fakeXai(queue) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push(body);
    if (body.external_web_access !== undefined || (body.tools || []).some((tool) => tool?.external_web_access !== undefined)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Argument not supported: external_web_access" }));
      return;
    }
    const bad = (body.tools || []).find((tool) => !XAI_TOOL_TYPES.has(tool?.type));
    if (bad) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to deserialize the JSON body into the target type: tools[].type: unknown variant \`${bad.type}\`` }));
      return;
    }
    const response = queue.shift() || answer("ok");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  return { server, seen };
}

// Quoted from the 422 the live endpoint returned.
const XAI_TOOL_TYPES = new Set([
  "function", "web_search", "x_search", "image_generation", "collections_search",
  "file_search", "code_execution", "code_interpreter", "mcp", "shell",
]);

async function startGrokApp(t, queue) {
  const upstream = fakeXai(queue);
  await new Promise((resolve) => upstream.server.listen(0, "127.0.0.1", resolve));
  const port = upstream.server.address().port;
  t.after(() => new Promise((resolve) => upstream.server.close(resolve)));

  // Point the profile at the stand-in. baseUrlFor reads this field, so the
  // whole routing path is the real one.
  const realBase = XAI_PROFILE.baseUrl;
  XAI_PROFILE.baseUrl = `http://127.0.0.1:${port}/v1`;
  t.after(() => { XAI_PROFILE.baseUrl = realBase; });
  applyXaiProfile(["grok-4.5", "grok-4.6"]);

  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-xai-wire-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const services = createServices({
    host: "127.0.0.1",
    port: 0,
    profile: XAI_PROFILE,
    profileId: "xai",
    tokens: { xai: "grok-subscription-token" },
    mainModel: "grok-4.5@xai",
    visionModel: "",
    mediaTtlMs: 60_000,
    mediaMaxBytes: 1024 * 1024,
    mediaMaxEntries: 8,
    recentLimit: 10,
    debug: { noSessionCheck: true },
    refreshNativeCatalog: false,
    autostartDefault: false,
    summariesFile: path.join(dir, "summaries.json"),
    codexCatalogFile: path.join(dir, "codex-model-catalog.json"),
    nativeCatalogFile: path.join(dir, "native-catalog.json"),
    codexHome: dir,
  });
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, seen: upstream.seen, services };
}

test("the xAI adapter round trip bridges namespace and freeform patch tools", async (t) => {
  const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch";
  const { base, seen } = await startGrokApp(t, [callsTool("apply_patch", JSON.stringify({ input: patch })), answer("done")]);
  const post = (input) => fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5@xai", stream: false, tools: focusedTools(), input }),
  });

  // --- turn 1: the model asks for a tool -------------------------------
  const first = await post([
    { role: "user", content: [{ type: "input_text", text: "list the files" }] },
  ]);
  assert.equal(first.status, 200, "the turn that used to die on 422");
  const firstOut = await first.json();
  assert.equal(firstOut.output[0].type, "custom_tool_call", "the caller receives its original freeform tool dialect");
  assert.equal(firstOut.output[0].input, patch, "the patch payload is restored from xAI function arguments");

  // --- turn 2: the caller sends the result back ------------------------
  const second = await post([
    { role: "user", content: [{ type: "input_text", text: "list the files" }] },
    { type: "custom_tool_call", name: "apply_patch", input: patch, call_id: "call_1" },
    { type: "custom_tool_call_output", call_id: "call_1", output: "Done" },
  ]);
  assert.equal(second.status, 200, "the continuation carries the tool list again, and it must still be accepted");

  assert.equal(seen.length, 2, "both turns reached the upstream");
  for (const [index, body] of seen.entries()) {
    const types = (body.tools || []).map((tool) => tool.type);
    assert.equal(types.includes("custom"), false, `turn ${index + 1}: the variant xAI has no name for`);
    assert.equal(types.includes("namespace"), false, `turn ${index + 1}: the namespace wrapper xAI rejects`);
    assert.ok(types.includes("function"), `turn ${index + 1}: the ordinary tools survive`);
    assert.ok((body.tools || []).some((tool) => tool.name === "apply_patch" && tool.type === "function"), `turn ${index + 1}: apply_patch is bridged instead of removed`);
    assert.ok((body.tools || []).some((tool) => tool.name === "computer__click" && tool.type === "function"), `turn ${index + 1}: a generic namespace is flattened safely`);
    assert.ok((body.tools || []).some((tool) => tool.name === "view_image"), `turn ${index + 1}: visual Grok keeps its image tool`);
    // Grok runs this one itself; stripping it made the gate pay Exa to redo a
    // search the subscription already covers.
    assert.ok(types.includes("web_search"), `turn ${index + 1}: hosted search is left for Grok`);
    assert.ok(types.includes("image_generation"), `turn ${index + 1}: hosted image generation is left for Grok`);
    assert.equal((body.tools || []).some((tool) => tool?.external_web_access !== undefined), false, `turn ${index + 1}: xAI receives no OpenAI-only hosted-web option`);
    // tool_search is answered by this gate, not by xAI.
    assert.equal(types.includes("tool_search"), false, `turn ${index + 1}: tool_search is ours`);
    assert.equal(body.model, "grok-4.5", "the upstream sees the bare id, not the routing suffix");
  }

  // The history the second turn carried is the tool round trip itself.
  const items = (seen[1].input || []).map((item) => item.type || item.role);
  assert.ok(items.includes("function_call"), "the call is replayed");
  assert.ok(items.includes("function_call_output"), "and so is its result");
  assert.equal(items.includes("custom_tool_call"), false, "xAI never receives the caller's custom item type");
  assert.equal(JSON.parse(seen[1].input.find((item) => item.type === "function_call").arguments).input, patch);
});

test("the xAI adapter preserves a namespace call across a tool continuation", async (t) => {
  const { base, seen } = await startGrokApp(t, [callsTool("computer__click", JSON.stringify({ x: 12, y: 34 })), answer("clicked")]);
  const post = (input) => fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5@xai", stream: false, tools: focusedTools(), input }),
  });

  const first = await post([{ role: "user", content: [{ type: "input_text", text: "click the button" }] }]);
  assert.equal(first.status, 200);
  const call = (await first.json()).output[0];
  assert.equal(call.type, "function_call");
  assert.equal(call.name, "click");
  assert.equal(call.namespace, "computer", "the caller gets the namespace it declared, not the xAI-safe flattened name");

  const second = await post([
    { role: "user", content: [{ type: "input_text", text: "click the button" }] },
    call,
    { type: "function_call_output", call_id: call.call_id, output: "clicked" },
  ]);
  assert.equal(second.status, 200);
  const replay = seen[1].input.find((item) => item.type === "function_call");
  assert.equal(replay.name, "computer__click");
  assert.equal(replay.namespace, undefined, "xAI receives only the flattened function form");
  assert.deepEqual(JSON.parse(replay.arguments), { x: 12, y: 34 });
});

test("an xAI request drops the OpenAI-only external web access flag", async (t) => {
  const { base, seen } = await startGrokApp(t, [answer("ok")]);
  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5@xai",
      stream: false,
      external_web_access: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    }),
  });

  assert.equal(response.status, 200, "xAI rejects the unfiltered flag with HTTP 400");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].external_web_access, undefined, "the xAI wire contains no OpenAI-only transport flag");
});

test("a visual xAI compaction keeps image evidence and returns a handoff", async (t) => {
  const { base, seen } = await startGrokApp(t, [answer("The attached image is red.")]);
  const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5@xai",
      stream: false,
      external_web_access: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Remember the image." },
            { type: "input_image", image_url: imageUrl },
          ],
        },
        { type: "compaction_trigger" },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const compacted = await response.json();
  assert.equal(compacted.output[0].type, "compaction");
  assert.match(compacted.output[0].encrypted_content, /^kcr1:/);

  assert.equal(seen.length, 1, "compaction sends one summarize request to Grok");
  const outbound = seen[0];
  assert.equal(outbound.model, "grok-4.5");
  assert.equal(outbound.external_web_access, undefined, "the compaction wire also excludes the OpenAI-only flag");
  assert.deepEqual(outbound.tools, []);
  assert.equal(outbound.tool_choice, "none");
  assert.ok(
    outbound.input.some((item) => item.content?.some?.((part) => part.type === "input_image" && part.image_url === imageUrl)),
    "the visual Grok summarize call receives the original image rather than a text placeholder",
  );
});

// The reasoning item Codex replays carries `content: null`, and xAI reads a
// null there as a different item shape: it decodes the item as a compaction
// blob and answers 400 "Could not decode the compaction blob. Ensure it is
// unmodified from the compact response" - a message about a feature the turn
// never used.
//
// Isolated on 2026-08-21 against the live endpoint by replaying a real
// thirteen-item history from a session that died on it. As captured: 400. The
// same history with this item's content set to []: 200. With content deleted:
// 200. With Codex's private passthrough field removed but the null kept: 400
// again, so the null is the whole of it.
//
// The blob is left alone. Dropping it was considered and is wrong twice over:
// xAI replays its own reasoning statelessly without complaint (five replay
// shapes, all 200) and DeepSeek's thinking routes require reasoning to come
// back at all.
test("a replayed reasoning item with content:null is normalised for xAI", () => {
  const replayed = {
    type: "reasoning",
    id: "rs_7f0f56b4-4e21-9bf9-a0f9-cf790a1195be",
    summary: [{ type: "summary_text", text: "The user is asking what model I am." }],
    content: null,
    internal_chat_message_metadata_passthrough: { turn_id: "01a02676-a577-74b0-ba60-ebdc8d64c48b" },
    encrypted_content: "4vChAfX7TXvTu7z2n6OvKVU3hqohpC9uhzAEJjQYIB2KBnD1bozXvKujEEcq",
  };
  const [, item] = normalizeXaiInput([
    { role: "user", content: [{ type: "input_text", text: "what model are you?" }] },
    replayed,
  ]);
  assert.deepEqual(item.content, [], "null becomes the empty list xAI expects");
  assert.equal(item.encrypted_content, replayed.encrypted_content, "the chain of thought rides along untouched");
  assert.deepEqual(item.summary, replayed.summary);
  assert.deepEqual(
    item.internal_chat_message_metadata_passthrough,
    replayed.internal_chat_message_metadata_passthrough,
    "removing this while keeping the null still failed, so it is not the cause and is left alone",
  );
});

test("a reasoning item that already has content is passed through unchanged", () => {
  // Byte-stability: the history must serialise the same way as turns advance or
  // the upstream prefix cache is invalidated, so only the null is rewritten.
  const withList = { type: "reasoning", id: "rs_1", summary: [], content: [], encrypted_content: "abc" };
  const withNone = { type: "reasoning", id: "rs_2", summary: [], encrypted_content: "def" };
  const [a, b] = normalizeXaiInput([withList, withNone]);
  assert.equal(a, withList, "an empty list is already what xAI wants");
  assert.equal(b, withNone, "an absent content field is fine too");
});

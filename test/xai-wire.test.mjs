// The Grok wire, end to end, over more than one turn.
//
// Every shape asserted here was measured against api.x.ai/v1/responses on
// 2026-08-21 with a live subscription token, and the defect that prompted it
// killed a real session:
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
import { createApp, createServices } from "../src/server.mjs";
import { XAI_PROFILE, applyXaiProfile } from "../src/profiles.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

// What Codex sends when the catalog says apply_patch is freeform, plus the
// hosted tools it offers. tools[1] is the one xAI rejects.
function codexTools() {
  return [
    { type: "function", name: "shell", description: "run a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
    { type: "function", name: "view_image", description: "inspect a local image", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
    { type: "web_search" },
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

const callsTool = () => ({
  id: "resp_0",
  object: "response",
  status: "completed",
  output: [{ type: "function_call", name: "shell", arguments: JSON.stringify({ cmd: "ls" }), call_id: "call_1" }],
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
    const bad = (body.tools || []).find((tool) => !XAI_TOOL_TYPES.has(tool?.type));
    if (bad) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Failed to deserialize the JSON body into the target type: tools[].type: unknown variant \`${bad.type}\`` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(queue.shift() || answer("ok")));
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

test("a Grok tool round trip keeps every turn's tool list on the wire xAI accepts", async (t) => {
  const { base, seen } = await startGrokApp(t, [callsTool(), answer("done")]);
  const post = (input) => fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "grok-4.5@xai", stream: false, tools: codexTools(), input }),
  });

  // --- turn 1: the model asks for a tool -------------------------------
  const first = await post([
    { role: "user", content: [{ type: "input_text", text: "list the files" }] },
  ]);
  assert.equal(first.status, 200, "the turn that used to die on 422");
  const firstOut = await first.json();
  assert.equal(firstOut.output[0].type, "function_call");

  // --- turn 2: Codex sends the result back -----------------------------
  const second = await post([
    { role: "user", content: [{ type: "input_text", text: "list the files" }] },
    { type: "function_call", name: "shell", arguments: JSON.stringify({ cmd: "ls" }), call_id: "call_1" },
    { type: "function_call_output", call_id: "call_1", output: "a.txt\nb.txt" },
  ]);
  assert.equal(second.status, 200, "the continuation carries the tool list again, and it must still be accepted");

  assert.equal(seen.length, 2, "both turns reached the upstream");
  for (const [index, body] of seen.entries()) {
    const types = (body.tools || []).map((tool) => tool.type);
    assert.equal(types.includes("custom"), false, `turn ${index + 1}: the variant xAI has no name for`);
    assert.ok(types.includes("function"), `turn ${index + 1}: the ordinary tools survive`);
    assert.ok((body.tools || []).some((tool) => tool.name === "view_image"), `turn ${index + 1}: visual Grok keeps its image tool`);
    // Grok runs this one itself; stripping it made the gate pay Exa to redo a
    // search the subscription already covers.
    assert.ok(types.includes("web_search"), `turn ${index + 1}: hosted search is left for Grok`);
    // tool_search is answered by this gate, not by xAI.
    assert.equal(types.includes("tool_search"), false, `turn ${index + 1}: tool_search is ours`);
    assert.equal(body.model, "grok-4.5", "the upstream sees the bare id, not the routing suffix");
  }

  // The history the second turn carried is the tool round trip itself.
  const items = (seen[1].input || []).map((item) => item.type || item.role);
  assert.ok(items.includes("function_call"), "the call is replayed");
  assert.ok(items.includes("function_call_output"), "and so is its result");
});

test("a visual Grok compaction keeps image evidence and returns a Codex handoff", async (t) => {
  const { base, seen } = await startGrokApp(t, [answer("The attached image is red.")]);
  const imageUrl = "data:image/png;base64,iVBORw0KGgo=";
  const response = await fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5@xai",
      stream: false,
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
  assert.deepEqual(outbound.tools, []);
  assert.equal(outbound.tool_choice, "none");
  assert.ok(
    outbound.input.some((item) => item.content?.some?.((part) => part.type === "input_image" && part.image_url === imageUrl)),
    "the visual Grok summarize call receives the original image rather than a text placeholder",
  );
});

// Replay the observed collaboration__spawn_agent failure through the shipped
// bundle. The caller below is a strict dispatch fixture; no real agent starts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))));
const names = ["spawn_agent", "list_agents", "interrupt_agent"];
const collaboration = { type: "namespace", name: "collaboration", tools: names.map((name) => ({
  type: "function", name, parameters: { type: "object", properties: {} },
})) };
const sse = (events) => [...events.map((event) => `data: ${JSON.stringify(event)}`), "data: [DONE]", ""].join("\n\n");

function completed(text) {
  return text.split(/\r?\n/).filter((line) => line.startsWith("data: ") && !line.endsWith("[DONE]"))
    .map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "response.completed")?.response;
}

test("built OpenCode Responses restores collaboration aliases in full/sparse streams, JSON and deferred tools", { timeout: 30_000 }, async (t) => {
  assert.equal(fixture.request.tools.length, 164);
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-collab-alias-"));
  const requests = [];
  let mode = "full";
  let expectedName = names[0];
  let deferred = false;
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    try {
      assert.equal(req.url, "/go/v1/responses");
      assert.equal(req.headers.authorization, "Bearer fixture-go-token");
      const input = Array.isArray(body.input) ? body.input : [];
      const declarations = [...body.tools, ...input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools)];
      assert.deepEqual(declarations.find((tool) => tool.name === "collaboration"), collaboration,
        "Responses keeps the original namespace descriptor byte-for-byte");
      const previous = input.find((item) => item.call_id === "fixture_alias_call" && item.type === "function_call");
      if (previous) {
        assert.equal(previous.name, `collaboration__${expectedName}`, "history keeps the existing upstream replay dialect");
        assert.ok(input.some((item) => item.type === "function_call_output" && item.call_id === previous.call_id && item.output === "STRICT_DISPATCH_OK"));
      }
      const output = previous ? [{ type: "message", id: "msg_ok", role: "assistant", content: [{ type: "output_text", text: "ROUND_TRIP_OK" }] }]
        : [{ type: "function_call", id: "fc_alias", call_id: "fixture_alias_call", name: `collaboration__${expectedName}`, arguments: "{}" }];
      const response = { id: "resp_alias", status: "completed", output };
      if (mode === "json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(response));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(mode === "sparse" && !previous ? [
          { type: "response.output_item.added", output_index: 0, item: { ...output[0], arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: "{}" },
          { type: "response.completed", response: { id: "resp_alias", status: "completed" } },
        ] : [
          { type: "response.created", response: { id: "resp_alias", status: "in_progress", output: [] } },
          { type: "response.output_item.added", output_index: 0, item: output[0] },
          { type: "response.output_item.done", output_index: 0, item: output[0] },
          { type: "response.completed", response },
        ]));
      }
    } catch (error) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let instance;
  t.after(async () => {
    await instance?.stop();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  const { startServer } = await import(pathToFileURL(path.resolve(process.env.MODELDOCK_TEST_BUNDLE || "dist/modeldock.mjs")).href);
  instance = await startServer({
    host: "127.0.0.1", port: 0, profileId: "opencode-go",
    opencodeBaseUrl: `http://127.0.0.1:${upstream.address().port}/go/v1`,
    tokens: { "opencode-go": "fixture-go-token" }, mainModel: "deepseek-v4.1-flash@opencode-go", visionModel: "none",
    codexHome: root, codexCatalogFile: path.join(root, "catalog.json"), nativeMerge: false,
    refreshNativeCatalog: false, modelDiscoveryEnabled: false, memoryEnabled: false, autostartDefault: false,
    debug: { noSessionCheck: true }, callerKey: "fixture-collab-alias-0123456789abcdef",
  });
  const api = `http://127.0.0.1:${instance.server.address().port}/c/${instance.services.callerKey}/v1/responses`;
  for (mode of ["full", "sparse", "json"]) for (deferred of [false, true]) for (expectedName of names) {
    await t.test(`${mode}/${deferred ? "deferred" : "initial"}/${expectedName}`, async () => {
      const baseInput = [...fixture.request.input, ...(deferred ? [{ type: "additional_tools", tools: [collaboration] }] : [])];
      const payload = { ...fixture.request, model: "deepseek-v4.1-flash@opencode-go", stream: mode !== "json",
        tools: [...fixture.request.tools, ...(deferred ? [] : [collaboration])], input: baseInput };
      const send = async (body) => {
        const res = await fetch(api, { method: "POST", headers: { "content-type": "application/json", session_id: `alias-${mode}-${deferred}-${expectedName}` }, body: JSON.stringify(body) });
        const text = await res.text();
        assert.equal(res.status, 200, text);
        return mode === "json" ? JSON.parse(text) : completed(text);
      };
      const first = await send(payload);
      const call = first.output.find((item) => item.type === "function_call");
      assert.equal(call?.name, expectedName, "Codex must see the registered bare tool name, not an unsupported prefixed name");
      assert.equal(call.namespace, "collaboration");
      assert.equal(call.arguments, "{}");
      const second = await send({ ...payload, input: [...baseInput, call,
        { type: "function_call_output", call_id: call.call_id, output: "STRICT_DISPATCH_OK" }] });
      assert.equal(second.output[0].content[0].text, "ROUND_TRIP_OK");
    });
  }
  await t.test("plain string input remains supported", async () => {
    mode = "json";
    expectedName = "spawn_agent";
    const res = await fetch(api, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fixture.request, model: "deepseek-v4.1-flash@opencode-go", stream: false,
        tools: [...fixture.request.tools, collaboration], input: "hi" }) });
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.output[0].name, "spawn_agent");
    assert.equal(body.output[0].namespace, "collaboration");
  });
  assert.equal(requests.length, 37);
});

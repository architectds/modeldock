import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import nodePath from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";

// End-to-end for native vision, with only the ChatGPT backend faked.
//
// The unit tests in test/upstreams.test.mjs inject getNativeSlugs by hand, so
// they prove visionEndpointFor's branch but say nothing about the wiring that
// feeds it: createServices builds the native slug set from the catalog file at
// boot and hands upstreams a getter for it. That ordering is the part that can
// silently break (the set is built once; a catalog written after boot is not in
// it), so this test drives the real createServices/createUpstreams path and
// asserts what actually arrived at the backend.
test("a native vision model reaches the ChatGPT backend through the real service wiring", async (t) => {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), "modeldock-native-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // The native catalog must exist before createServices: nativeModelSlugs reads
  // it once at boot. gpt-5.6-terra is in no curated catalog, so reaching the
  // stub at all can only be the native path.
  writeFileSync(
    nodePath.join(dir, "native-catalog.json"),
    JSON.stringify({ models: [{ slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", input_modalities: ["text", "image"] }] }),
    "utf8",
  );
  writeFileSync(
    nodePath.join(dir, "auth.json"),
    JSON.stringify({ tokens: { access_token: "chatgpt-e2e-token", account_id: "acct-e2e" } }),
    "utf8",
  );
  const pngPath = nodePath.join(dir, "shot.png");
  writeFileSync(pngPath, Buffer.from("89504e470d0a1a0a", "hex"));

  const received = [];
  const stub = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        url: req.url,
        auth: req.headers.authorization,
        account: req.headers["chatgpt-account-id"],
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      // The real backend streams, and puts the words only in the deltas: its
      // response.completed carries an empty output array.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        'data: {"type":"response.output_text.delta","delta":"a red bar chart"}',
        'data: {"type":"response.completed","response":{"id":"resp_e2e","output":[]}}',
        "data: [DONE]",
        "",
      ].join("\n"));
    });
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => stub.close(resolve)));
  const stubBase = `http://127.0.0.1:${stub.address().port}`;

  // NATIVE_BASE is read at module load, so the redirect must be in place before
  // src/server.mjs (and through it src/upstreams.mjs) is first evaluated.
  process.env.CODEX_NATIVE_BASE_URL = stubBase;
  const { createServices } = await import("../src/server.mjs");

  const services = createServices({
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    opencodeBaseUrl: "https://go.example.com/v1",
    deepseekBaseUrl: "https://ds.example.com",
    // The only provider credential configured. If the native leg ever falls back
    // to the routed path this is what it would spend, so its absence from the
    // captured request is the assertion that matters.
    tokens: { "opencode-go": "go-token" },
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-terra",
    visionFallbackModel: "kimi-k2.5",
    visionTimeoutMs: 90_000,
    mediaTtlMs: 60_000,
    mediaMaxBytes: 10 * 1024 * 1024,
    mediaMaxEntries: 64,
    exaMcpUrl: "https://mcp.exa.ai/mcp",
    exaApiKey: "",
    recentLimit: 50,
    debug: { noSessionCheck: true },
    callerKey: "test-caller-key-0123456789abcdefghij",
    refreshNativeCatalog: false,
    modelRefreshHours: 0,
    codexHome: dir,
    nativeCatalogFile: nodePath.join(dir, "native-catalog.json"),
    codexCatalogFile: nodePath.join(dir, "codex-model-catalog.json"),
    summariesFile: nodePath.join(dir, "summaries.json"),
  });
  t.after(() => services.mediaStore.cleanup());

  const result = await services.upstreams.inspectVision({ path: pngPath, question: "What does it show?" });

  assert.equal(received.length, 1, "the native backend was called exactly once");
  const call = received[0];
  assert.equal(call.url, "/responses", "native vision posts to the Responses path");
  assert.equal(call.auth, "Bearer chatgpt-e2e-token", "the Codex sign-in pays for it, not the OpenCode Go token");
  assert.equal(call.account, "acct-e2e", "the native account header survives the real wiring");
  assert.equal(call.body.model, "gpt-5.6-terra");
  assert.equal(call.body.input[0].content[1].type, "input_image", "the image rides the Responses wire");
  assert.ok(String(call.body.input[0].content[1].image_url).startsWith("data:image/png;base64,"));
  assert.equal(result.answer, "a red bar chart", "the backend's answer comes back through inspectVision");
});

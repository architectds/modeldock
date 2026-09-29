// Local Hosts should be one scan-and-attach flow for a keyless local
// OpenAI-compatible origin. Two routes carry it end to end against the built
// bundle:
//
//   POST /api/local/probe  - read the models and discover which protocol the
//                            origin speaks, and save NOTHING.
//   POST /api/local/attach - persist one endpoint whose published identity is
//                            "provider/model@local", while the real upstream
//                            model id travels on the wire.
//
// The published identity is the readable address; Codex only ever receives the
// reversible "mdr." slug derived from it. This test proves the whole chain from
// the HTTP call, through the persisted endpoint file and the published catalog,
// to the model id the upstream mock actually received - and that an existing
// Custom endpoint is left exactly as it was.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = process.env.MODELDOCK_TEST_BUNDLE || path.join(repoRoot, "dist", "modeldock.mjs");
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/codex-xai-full-2026-08-21.json.gz", import.meta.url))).toString("utf8"));

// The endpoint advertises a raw model id that is not a safe slug and not the
// name the user wants to see; the published identity is built from the names.
const UPSTREAM_ID = "qwen3.8-flash-next-iq3_xxs";
const PROVIDER_NAME = "strata";
const MODEL_NAME = "flash-next";
const MODEL_ID = `${PROVIDER_NAME}/${MODEL_NAME}`;
const EXPECTED_INTERNAL_ID = `${MODEL_ID}@local`;
const LEGACY_MODEL = "legacy-model";

const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64url");
const codexSlugFor = (provider, modelId) => `mdr.${b64(provider)}.${b64(modelId)}`;

function decodeSlug(slug) {
  assert.ok(slug.startsWith("mdr."), `unexpected Codex slug ${slug}`);
  const [provider, model] = slug.slice("mdr.".length).split(".");
  return `${Buffer.from(model, "base64url").toString("utf8")}@${Buffer.from(provider, "base64url").toString("utf8")}`;
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await closeServer(probe);
  return port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function waitForStatus(port) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) return;
    } catch { /* bundle is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("built bundle did not start");
}

const modelIdOf = (entry) => (typeof entry === "string" ? entry : entry?.id);

// A keyless, Chat-only OpenAI-compatible mock. It answers /v1/models and the
// Chat dialect, and deliberately 404s the Responses dialect so the probe has to
// fall through to Chat. Everything it receives is recorded so the test can
// assert what the gateway actually sent upstream.
function createUpstream() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    received.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });

    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: UPSTREAM_ID, meta: { n_ctx: 262144 } }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/props") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        modalities: { vision: true },
        chat_template_caps: { supports_object_arguments: true },
        media_marker: "<__local_media__>",
      }));
      return;
    }
    if (req.url === "/v1/responses") {
      // No Responses protocol here: the probe must discover that by trying and
      // falling back, not by being told.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no Responses protocol here" }));
      return;
    }
    if (req.url.endsWith("/chat/completions")) {
      if (body?.stream !== true) {
        // The probe's bounded turn: plain JSON.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl_local_probe",
          model: body?.model || UPSTREAM_ID,
          choices: [{ index: 0, message: { role: "assistant", content: "CUSTOM_OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end([
        `data: ${JSON.stringify({ id: "chatcmpl_local_relay", created: 21, model: body?.model || UPSTREAM_ID, choices: [{ index: 0, delta: { role: "assistant", content: "LOCAL_OK" } }] })}`,
        `data: ${JSON.stringify({ id: "chatcmpl_local_relay", created: 21, model: body?.model || UPSTREAM_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8308, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return { server, received };
}

test("built bundle probes a keyless local origin without saving, then attaches one stable slug that relays", async (t) => {
  assert.equal(fixture.capture.kind, "full_original_codex_request");
  assert.equal(fixture.request.tools.length, 164);

  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const endpointFile = path.join(stateDir, "custom-endpoints.json");
  await mkdir(stateDir, { recursive: true });

  const { server: upstream, received } = createUpstream();
  const upstreamPort = await listen(upstream);
  let upstreamClosed = false;
  t.after(() => upstreamClosed ? undefined : closeServer(upstream));
  const origin = `http://127.0.0.1:${upstreamPort}`;

  // An unrelated Custom endpoint that predates the attach. It sits on its own
  // path so a relay for it can be told apart from the attached one, and it must
  // come through the attach byte for byte.
  const seeded = {
    modelId: LEGACY_MODEL,
    baseUrl: `${origin}/legacy/v1`,
    apiKey: "fixture-legacy-key",
    label: "legacy",
    contextWindow: 0,
    supportsVision: false,
    transport: "chat",
    addedAt: "2026-01-01T00:00:00.000Z",
  };
  const previousLocal = {
    modelId: UPSTREAM_ID,
    baseUrl: `${origin}/v1`,
    apiKey: "",
    label: "Previous keyless Custom name",
    contextWindow: 262144,
    supportsVision: true,
    transport: "chat",
    addedAt: "2026-01-02T00:00:00.000Z",
  };
  const remoteSameName = {
    modelId: MODEL_ID,
    baseUrl: `${origin}/other/v1`,
    apiKey: "fixture-same-name-key",
    label: "Remote model with the same chosen name",
    contextWindow: 0,
    supportsVision: false,
    transport: "chat",
    addedAt: "2026-01-03T00:00:00.000Z",
  };
  await writeFile(endpointFile, JSON.stringify([seeded, previousLocal, remoteSameName]));

  const gatewayPort = await freePort();
  const autostartKey = `HKCU\\Software\\ModelDockTests\\local-scan-${process.pid}`;
  const gatewayEnv = {
    ...process.env,
    MODELDOCK_PORT: String(gatewayPort),
    MODELDOCK_PROFILE: "opencode-go",
    OPENCODE_GO_TOKEN: "fixture-go-key",
    MODELDOCK_STATE_DIR: stateDir,
    MODELDOCK_CUSTOM_ENDPOINTS_FILE: endpointFile,
    MODELDOCK_CODEX_HOME: path.join(root, "codex-home"),
    MODELDOCK_REQUIRE_CALLER_KEY: "0",
    MODELDOCK_MEMORY: "0",
    MODELDOCK_MODEL_DISCOVERY: "0",
    MODELDOCK_NATIVE_MERGE: "0",
    MODELDOCK_REFRESH_NATIVE_CATALOG: "0",
    MODELDOCK_AUTOSTART_KEY: autostartKey,
    MODELDOCK_AUTOSTART_NAME: `ModelDockLocalScan${process.pid}`,
  };
  const launchGateway = () => spawn(process.execPath, [bundle], {
    cwd: repoRoot,
    env: gatewayEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let child = launchGateway();
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  t.after(() => stop(child));
  if (process.platform === "win32") {
    t.after(() => {
      try { execFileSync("reg.exe", ["delete", autostartKey, "/f"], { stdio: "ignore" }); } catch { /* test key may not exist */ }
    });
  }
  await waitForStatus(gatewayPort);
  const api = `http://127.0.0.1:${gatewayPort}`;
  const savedEndpoints = () => JSON.parse(readFileSync(endpointFile, "utf8"));
  const catalogSlug = async (modelId) => {
    const catalog = await (await fetch(`${api}/v1/models`)).json();
    return catalog.models.find((item) => item.slug === codexSlugFor("local", modelId));
  };

  // 1. The probe reads the models and the protocol, and touches no state.
  const before = savedEndpoints();
  const probeResponse = await fetch(`${api}/api/local/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: origin }),
  });
  const probeText = await probeResponse.text();
  assert.equal(probeResponse.status, 200, `probe failed: ${probeText}\n${stderr}`);
  const probe = JSON.parse(probeText);
  assert.equal(probe.transport, "chat", "a Chat-only origin must be discovered as chat");
  assert.ok(Array.isArray(probe.models), "the probe must report the models it found");
  assert.ok(
    probe.models.some((entry) => modelIdOf(entry) === UPSTREAM_ID),
    `the probe must return ${UPSTREAM_ID}, got ${JSON.stringify(probe.models)}`,
  );
  assert.deepEqual(savedEndpoints(), before, "a probe must never save an endpoint");
  const probeModelsIndex = received.findIndex((entry) => entry.method === "GET" && entry.path === "/v1/models");
  const probeChatIndex = received.findIndex((entry) => entry.method === "POST" && entry.path === "/v1/chat/completions");
  assert.ok(probeModelsIndex >= 0, "the probe must list models from /v1/models");
  assert.ok(probeChatIndex > probeModelsIndex, "the local probe must choose the Chat dialect when it answers");

  // 2. A probe that cannot connect fails generically and saves nothing.
  const deadPort = await freePort();
  const failedProbe = await fetch(`${api}/api/local/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${deadPort}` }),
  });
  assert.ok(failedProbe.status >= 400, "an unreachable origin is not a successful probe");
  const failure = await failedProbe.json();
  assert.equal(failure.error?.type, "connect_failed", `expected a generic connect_failed, got ${JSON.stringify(failure)}`);
  assert.deepEqual(savedEndpoints(), before, "a failed probe must not save an endpoint");

  // 3. The attach adds one Local entry. An existing Custom entry for the same
  // upstream service is the user's independent choice and remains untouched.
  const attachResponse = await fetch(`${api}/api/local/attach`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      baseUrl: origin,
      upstreamId: UPSTREAM_ID,
      providerName: PROVIDER_NAME,
      modelName: MODEL_NAME,
    }),
  });
  const attachText = await attachResponse.text();
  assert.equal(attachResponse.status, 200, `attach failed: ${attachText}\n${stderr}`);
  const afterAttach = savedEndpoints();
  assert.equal(afterAttach.length, before.length + 1, `attach must add exactly one endpoint: ${JSON.stringify(afterAttach)}`);
  const attached = afterAttach.find((entry) => entry.local === true && entry.modelId === MODEL_ID);
  assert.ok(attached, `the endpoint must persist under ${MODEL_ID}, got ${JSON.stringify(afterAttach.map((entry) => entry.modelId))}`);
  assert.deepEqual(afterAttach.find((entry) => entry.modelId === UPSTREAM_ID), previousLocal,
    "a separately configured Custom entry for this service remains the user's choice");
  assert.equal(attached.transport, "chat", "the persisted transport is what the probe discovered");
  assert.equal(attached.local, true, "the endpoint belongs to the Local provider");
  assert.equal(attached.supportsVision, true, "the scanner's live vision capability is retained");
  assert.equal(attached.chatTemplateSupportsObjectArguments, true,
    "the scanner's tool-argument capability is retained for the Chat bridge");
  assert.equal(attached.completeOnFinishReason, true,
    "llama.cpp's finish-reason stream boundary is retained without changing other Local servers");
  assert.equal(attached.mediaMarker, "<__local_media__>",
    "the scanner's media sentinel is retained for safe tool-history replay");
  assert.equal(attached.baseUrl.replace(/\/+$/, ""), `${origin}/v1`, "the endpoint keeps the origin with its /v1 tree");
  assert.ok(
    JSON.stringify(attached).includes(UPSTREAM_ID),
    `the real upstream id must be persisted for the wire: ${JSON.stringify(attached)}`,
  );
  const legacyAfter = afterAttach.find((entry) => entry.modelId === LEGACY_MODEL);
  assert.ok(legacyAfter, "an existing Custom endpoint must survive the attach");
  for (const field of ["modelId", "baseUrl", "label", "contextWindow", "supportsVision", "transport", "addedAt"]) {
    assert.equal(legacyAfter[field], seeded[field], `the attach must preserve the existing endpoint's ${field}`);
  }
  assert.ok(legacyAfter.apiKey, "the attach must preserve the existing endpoint's credential");
  assert.ok(afterAttach.some((entry) => !entry.local && entry.modelId === MODEL_ID),
    "the same chosen model name can coexist under the independent Custom provider");
  const customPage = await (await fetch(`${api}/api/custom/endpoints`)).json();
  assert.deepEqual(customPage.endpoints.map((entry) => entry.modelId), [LEGACY_MODEL, UPSTREAM_ID, MODEL_ID],
    "the API page lists only remote Custom entries, not Local registrations");
  const settings = await (await fetch(`${api}/api/settings`)).json();
  assert.deepEqual(settings.custom.endpoints.map((entry) => entry.modelId), customPage.endpoints.map((entry) => entry.modelId),
    "Settings and the Custom page must project the same remote endpoint list");

  // 4. Codex sees only the encoded slug, and it decodes back to the identity.
  const attachedRow = await catalogSlug(MODEL_ID);
  assert.ok(attachedRow, `the catalog must publish a Codex-safe slug for ${MODEL_ID}`);
  assert.equal(decodeSlug(attachedRow.slug), EXPECTED_INTERNAL_ID, "the slug must decode to the published identity");
  assert.ok(
    attachedRow.display_name?.includes(PROVIDER_NAME) && attachedRow.display_name?.includes(MODEL_NAME),
    `the picker label must name the provider and model, got ${attachedRow.display_name}`,
  );

  // 5. A full Codex-shaped tool turn reaches the real upstream id over Chat.
  const relay = (slug) => fetch(`${api}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...fixture.request, model: slug }),
  });
  const attachedRelay = await relay(attachedRow.slug);
  const attachedRelayText = await attachedRelay.text();
  assert.equal(attachedRelay.status, 200, `the attached model did not relay: ${attachedRelayText}\n${stderr}`);
  assert.match(attachedRelayText, /"type":"response.completed"/);
  const attachedTurns = received.filter((entry) => entry.method === "POST" && entry.path === "/v1/chat/completions" && entry.body?.stream === true);
  assert.equal(attachedTurns.length, 1, "the Codex turn must reach the attached Chat endpoint exactly once");
  assert.equal(attachedTurns[0].body.model, UPSTREAM_ID, "the REAL upstream id must travel on the wire, not the slug");
  assert.ok(Array.isArray(attachedTurns[0].body.tools) && attachedTurns[0].body.tools.length > 150,
    "the full Codex tool catalog must reach the attached endpoint");

  // The pre-existing endpoint still routes to its own host and model.
  const legacyRelay = await relay(codexSlugFor("custom", LEGACY_MODEL));
  const legacyRelayText = await legacyRelay.text();
  assert.equal(legacyRelay.status, 200, `the pre-existing endpoint did not relay: ${legacyRelayText}\n${stderr}`);
  const legacyTurns = received.filter((entry) => entry.method === "POST" && entry.path === "/legacy/v1/chat/completions" && entry.body?.stream === true);
  assert.equal(legacyTurns.length, 1, "the pre-existing endpoint must keep its own address");
  assert.equal(legacyTurns[0].authorization, "Bearer fixture-legacy-key");
  assert.equal(legacyTurns[0].body.model, LEGACY_MODEL, "the pre-existing endpoint must keep its own model id");
  const sameNameRemoteRelay = await relay(codexSlugFor("custom", MODEL_ID));
  assert.equal(sameNameRemoteRelay.status, 200, "the same-named Custom route remains independently usable");
  await sameNameRemoteRelay.text();
  const sameNameRemote = received.find((entry) => entry.path === "/other/v1/chat/completions" && entry.body?.stream === true);
  assert.equal(sameNameRemote?.authorization, "Bearer fixture-same-name-key");
  assert.equal(sameNameRemote?.body.model, MODEL_ID);

  // 6. A restart from the same state keeps the slug and the routing.
  await stop(child);
  child = launchGateway();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitForStatus(gatewayPort);
  const restoredRow = await catalogSlug(MODEL_ID);
  assert.ok(restoredRow, "the published slug must survive a restart");
  const restoredRelay = await relay(restoredRow.slug);
  const restoredText = await restoredRelay.text();
  assert.equal(restoredRelay.status, 200, `the attached model did not relay after restart: ${restoredText}\n${stderr}`);
  const restoredTurns = received.filter((entry) => entry.method === "POST" && entry.path === "/v1/chat/completions" && entry.body?.stream === true);
  assert.equal(restoredTurns.length, attachedTurns.length + 1, "the restarted gateway must relay again");
  assert.equal(restoredTurns.at(-1).body.model, UPSTREAM_ID, "the restarted routing still sends the real upstream id");

  // An offline endpoint stays registered and selectable; only its health changes.
  await closeServer(upstream);
  upstreamClosed = true;
  const discovery = await (await fetch(`${api}/api/local/discover`)).json();
  const registration = discovery.registrations?.find((entry) => entry.modelId === MODEL_ID);
  assert.ok(registration, "the saved model must remain in the Local scan after its server stops");
  assert.equal(registration.offline, true, "a stopped upstream must be marked offline, not deleted");
  assert.ok(await catalogSlug(MODEL_ID), "an offline model keeps its published Codex slug");

  const detach = await fetch(`${api}/api/custom/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ modelId: MODEL_ID, local: true }),
  });
  assert.equal(detach.status, 200, "Disconnect removes the Local route");
  assert.ok(!savedEndpoints().some((entry) => entry.local && entry.modelId === MODEL_ID),
    "the Local route is gone after Disconnect");
  const remoteAfterDetach = savedEndpoints().find((entry) => !entry.local && entry.modelId === MODEL_ID);
  assert.ok(remoteAfterDetach, "Disconnect cannot delete the same-named Custom route");
  for (const field of ["modelId", "baseUrl", "label", "contextWindow", "supportsVision", "transport", "addedAt"]) {
    assert.equal(remoteAfterDetach[field], remoteSameName[field], `Disconnect preserves the Custom route's ${field}`);
  }
  assert.ok(remoteAfterDetach.apiKey, "Disconnect preserves the Custom route's encrypted credential");
});

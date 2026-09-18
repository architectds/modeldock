// The local model management drawer gained a "Restart service" action for the one
// situation where every other control had already failed: a managed host whose
// request never settled, so the release and checkpoint routes were stuck waiting
// on the KV coordinator and the operator had no way left to recover the service.
// These tests own the two properties that make it an escape hatch rather than a
// sixth button that also hangs: it must answer while a config mutation is held,
// and it must never ask the KV layer for permission.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { createApp, createServices } from "../src/server.mjs";
import { OPENCODE_GO_PROFILE } from "../src/profiles.mjs";

process.env.MODELDOCK_REQUIRE_CALLER_KEY = "0";

async function appFixture(t, { localHostRuntime, restartService }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-service-restart-"));
  const config = {
    host: "127.0.0.1",
    port: 0,
    profile: { ...OPENCODE_GO_PROFILE },
    profileId: OPENCODE_GO_PROFILE.id,
    opencodeBaseUrl: "https://go.example.com/v1",
    tokens: { "opencode-go": "test-token" },
    mainModel: "deepseek-v4-flash",
    visionModel: "gpt-5.6-luna",
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
    codexHome: path.join(dir, "codex"),
    localHostRegistryFile: path.join(dir, "local-hosts.json"),
    usageEventsFile: path.join(dir, "usage-events.jsonl"),
  };
  const services = createServices(config);
  services.localEnginesFile = path.join(dir, "local-engines.json");
  services.engineLogDir = path.join(dir, "engine-logs");
  services.localHostRuntime = localHostRuntime;
  services.restartService = restartService;
  const { app } = createApp(services);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await services.mediaStore.cleanup();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { base: `http://127.0.0.1:${server.address().port}` };
}

// The wedge itself, reproduced at the seam that mattered: a KV handoff that never
// returns. It holds the config mutation queue, which is why "Leave management" and
// every other mutating control stopped answering. The restart must clear anyway.
test("the service restart answers while a config mutation is held and never asks the KV layer", async (t) => {
  let handoffCalls = 0;
  let releaseHandoff;
  const localHostRuntime = {
    prepareGatewayRestart() {
      handoffCalls += 1;
      return new Promise((resolve) => { releaseHandoff = resolve; });
    },
    releaseGatewayRestartPreparation() { return false; },
    snapshot() { return { managed: true, activeCount: 1, pendingCount: 1, lanes: [], counters: {}, lease: { active: [], pending: [] } }; },
  };
  let restartCalls = 0;
  const { base } = await appFixture(t, {
    localHostRuntime,
    restartService: async () => { restartCalls += 1; return true; },
  });

  // Occupy the mutation queue with a KV handoff that does not come back.
  const held = fetch(`${base}/api/local/restart-checkpoint`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(handoffCalls, 1, "the held request is sitting in the KV handoff");

  // The escape hatch has a short deadline on purpose: anything that has to wait
  // behind the wedge is not an escape hatch.
  const restarted = await fetch(`${base}/api/local/service/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(3_000),
  });
  const body = await restarted.json();
  assert.equal(restarted.status, 200, JSON.stringify(body));
  assert.equal(body.scheduled, true);
  assert.equal(body.kvHandoff, false, "the answer must say plainly that no KV unload was attempted");
  assert.equal(restartCalls, 1, "the restart was actually scheduled");
  assert.equal(handoffCalls, 1, "the restart must not add a second KV handoff");

  releaseHandoff({ managed: true, saved: 0, failed: 0, interrupted: 0, idle: false, holdMs: 0 });
  assert.equal((await held).status, 200, "the queued mutation still completes afterwards");
});

// Nothing about this depends on a host being managed, reachable, or even present:
// the service has to be restartable when the whole local layer is missing.
test("the service restart works with no local host at all", async (t) => {
  let restartCalls = 0;
  const { base } = await appFixture(t, {
    localHostRuntime: undefined,
    restartService: async () => { restartCalls += 1; return true; },
  });
  const response = await fetch(`${base}/api/local/service/restart`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(restartCalls, 1);
});

// A restart that could not be scheduled must not be reported as one that was: the
// page reloads on the strength of this answer.
test("the service restart reports a failed schedule instead of claiming success", async (t) => {
  const { base } = await appFixture(t, {
    localHostRuntime: undefined,
    restartService: async () => false,
  });
  const response = await fetch(`${base}/api/local/service/restart`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error?.type, "service_restart_failed");
});

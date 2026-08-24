import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { reconcileLocalHostsOnBoot } from "../src/server.mjs";
import {
  beginHostApply,
  createObservedHost,
  markHostApplying,
  markHostVerified,
  markHostVerifying,
  takeOverHost,
} from "../src/local-hosts.mjs";
import { createLocalHostRegistry, upsertLocalHost, writeLocalHostRegistry } from "../src/local-host-registry.mjs";
import { readLocalEnginesSnapshot, writeLocalEngineSnapshot } from "../src/local-engines.mjs";
import { applyLocalEngineProfile } from "../src/profiles.mjs";

test("a ready managed host corrects stale visual Catalog state during gateway boot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-boot-"));
  const registryFile = path.join(root, "local-hosts.json");
  const enginesFile = path.join(root, "local-engines.json");
  const endpoint = "http://127.0.0.1:11435/v1";
  const model = "D:/models/Qwen3.8-27B-Q4.gguf";
  const launch = {
    binary: "D:/llama/llama-server.exe",
    args: ["-m", model, "-c", "262144", "--parallel", "1", "--slot-save-path", "D:/kv", "--no-kv-unified"],
  };
  let record = takeOverHost(createObservedHost({
    id: "llamacpp-11435",
    adapterId: "llamacpp-nvidia",
    endpoint,
    launch,
    capabilities: { model },
  }), { kvState: { directory: "D:/kv", budgetBytes: 8 * 1024 ** 3 } });
  const profile = {
    adapterId: "llamacpp-nvidia",
    modelId: model,
    profileId: "static-p1-c262144",
    laneCount: 1,
    laneContextTokens: 262_144,
    totalContextTokens: 262_144,
  };
  record = markHostVerified(record);
  record = beginHostApply(record, { desiredSpec: launch, desiredProfile: profile });
  record = markHostApplying(record);
  record = markHostVerifying(record);
  record = markHostVerified(record);
  await writeLocalHostRegistry(registryFile, upsertLocalHost(createLocalHostRegistry(), record));
  writeLocalEngineSnapshot(enginesFile, "llamacpp", {
    baseUrl: endpoint,
    models: [{
      id: "Qwen3.8-27B",
      upstreamId: model,
      label: "Qwen3.8-27B",
      supportsVision: true,
      contextWindow: 262_144,
    }],
  });
  let catalogWrites = 0;
  let restartMarks = 0;
  t.after(async () => {
    applyLocalEngineProfile("llamacpp", null);
    await rm(root, { recursive: true, force: true });
  });

  await reconcileLocalHostsOnBoot({
    localHostRegistryFile: registryFile,
    localEnginesFile: enginesFile,
    discoverEngines: async () => [{
      engine: "llamacpp",
      baseUrl: "http://127.0.0.1:11435",
      models: [model],
      supportsVision: false,
      modelFacts: { modelName: "Qwen3.8-27B", modelSlug: "Qwen3.8-27B" },
    }],
    configSwitcher: { markRestartRequired: async () => { restartMarks += 1; } },
    writeCatalogFile: () => { catalogWrites += 1; },
    localHostRuntime: { refresh: async () => {} },
  });

  const snapshot = readLocalEnginesSnapshot(enginesFile);
  assert.equal(snapshot.llamacpp.models[0].supportsVision, false);
  assert.equal(catalogWrites, 1);
  assert.equal(restartMarks, 1, "Codex is told to reload the corrected Catalog after the gateway comes up");
});

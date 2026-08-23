import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createObservedHost, markHostVerified, takeOverHost } from "../src/local-hosts.mjs";
import {
  createLocalHostRegistry,
  readLocalHostRegistry,
  removeLocalHost,
  upsertLocalHost,
  writeLocalHostRegistry,
} from "../src/local-host-registry.mjs";

const OBSERVED = {
  id: "host-qwen",
  adapterId: "llamacpp-nvidia",
  endpoint: "http://127.0.0.1:11435/v1",
  launch: { binary: "D:/llama-cpp/llama-server.exe", args: ["-m", "D:/models/qwen.gguf", "-c", "262144"] },
  observedAt: "2026-08-23T00:00:00.000Z",
};

function readyHost() {
  return markHostVerified(takeOverHost(createObservedHost(OBSERVED), { at: "2026-08-23T00:01:00.000Z" }), {
    at: "2026-08-23T00:02:00.000Z",
  });
}

test("the registry round-trips managed host facts with an atomic replacement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-host-registry-"));
  const file = path.join(dir, "hosts.json");
  try {
    const initial = upsertLocalHost(createLocalHostRegistry(), readyHost());
    await writeLocalHostRegistry(file, initial);
    const source = await readFile(file, "utf8");
    assert.match(source, /"host-qwen"/);
    assert.equal((await readLocalHostRegistry(file)).hosts["host-qwen"].state, "ready");

    const removed = removeLocalHost(initial, "host-qwen");
    await writeLocalHostRegistry(file, removed);
    assert.deepEqual(await readLocalHostRegistry(file), removed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing registry starts empty while corrupt or mismatched records fail closed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modeldock-local-host-registry-"));
  const file = path.join(dir, "hosts.json");
  try {
    assert.deepEqual(await readLocalHostRegistry(file), createLocalHostRegistry());
    await writeFile(file, "not json", "utf8");
    await assert.rejects(() => readLocalHostRegistry(file), /not valid JSON/);
    await writeFile(file, JSON.stringify({ version: 1, hosts: { wrong: readyHost() } }), "utf8");
    await assert.rejects(() => readLocalHostRegistry(file), /key does not match/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

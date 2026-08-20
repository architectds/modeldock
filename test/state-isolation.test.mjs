// A test process must not write the running gateway's state.
//
// The redirect used to live only in the npm script's --import, so
// `node --test test/one.test.mjs` wrote into the real ~/.modeldock. Nine days of
// production metering ended up carrying 897 events that never happened,
// including a fixture named stub-model@custom, and the roster reported a model
// at 1,214 tokens per second on the strength of them.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { stateDir, stateFile } from "../src/state-dir.mjs";

test("a test process resolves its state somewhere disposable", () => {
  // node --test sets this in every test process, which is what makes the
  // redirect a property of being a test rather than of the launch command.
  assert.ok(process.env.NODE_TEST_CONTEXT, "node --test no longer marks its processes");
  const dir = stateDir();
  assert.ok(!dir.startsWith(path.join(os.homedir(), ".modeldock")), `state resolved to ${dir}`);
  assert.ok(dir.startsWith(os.tmpdir()), "and it resolves under the temp directory");
});

test("an explicit override still wins, so the install tests keep their own root", () => {
  const previous = process.env.MODELDOCK_STATE_DIR;
  const explicit = path.join(os.tmpdir(), "modeldock-explicit-root");
  process.env.MODELDOCK_STATE_DIR = explicit;
  try {
    assert.equal(stateDir(), path.resolve(explicit));
  } finally {
    if (previous === undefined) delete process.env.MODELDOCK_STATE_DIR;
    else process.env.MODELDOCK_STATE_DIR = previous;
  }
});

test("an explicit home still wins, so unit tests stay hermetic", () => {
  const home = path.join(os.tmpdir(), "some-home");
  assert.equal(stateDir({ home }), path.join(home, ".modeldock"));
  assert.equal(stateFile("x.json", { home }), path.join(home, ".modeldock", "x.json"));
});

// A gateway whose state directory has been redirected is a throwaway - a test
// run, a mock install, a second instance. Rewriting the real ~/.codex/config.toml
// points the user's editor at that throwaway, which then exits. This happened
// while testing: a gateway started with only MODELDOCK_STATE_DIR isolated took
// over the live config.
test("a redirected gateway refuses to rewrite the real Codex config", async (t) => {
  const { CodexConfigSwitcher } = await import("../src/config-switcher.mjs");
  const realCodexHome = path.join(os.homedir(), ".codex");
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-foreign-codex-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const saved = { ...process.env };
  const restore = () => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  };
  t.after(restore);

  process.env.MODELDOCK_STATE_DIR = dir;
  delete process.env.MODELDOCK_ALLOW_FOREIGN_CODEX_HOME;

  const guarded = new CodexConfigSwitcher({
    codexHome: realCodexHome,
    baseUrl: "http://127.0.0.1:4093/v1",
    model: "gpt-5.6-sol",
  });
  assert.ok(guarded.foreignCodexHome, "the mismatch is recognised");
  await assert.rejects(() => guarded.enable(), (error) => error.code === "FOREIGN_CODEX_HOME");
  await assert.rejects(() => guarded.disable(), (error) => error.code === "FOREIGN_CODEX_HOME");

  // The ordinary test setup - throwaway state, throwaway Codex home - is not
  // what this guards against and must keep working.
  const throwaway = new CodexConfigSwitcher({
    codexHome: path.join(dir, "codex-home"),
    baseUrl: "http://127.0.0.1:4093/v1",
    model: "gpt-5.6-sol",
  });
  assert.equal(throwaway.foreignCodexHome, "", "a throwaway Codex home is nobody else's");

  // And a deliberate operator can still say so.
  process.env.MODELDOCK_ALLOW_FOREIGN_CODEX_HOME = "1";
  const allowed = new CodexConfigSwitcher({
    codexHome: realCodexHome,
    baseUrl: "http://127.0.0.1:4093/v1",
    model: "gpt-5.6-sol",
  });
  assert.equal(allowed.foreignCodexHome, "", "the opt-out is respected");
});

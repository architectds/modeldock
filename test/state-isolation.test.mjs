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

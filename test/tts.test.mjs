import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { ttsOutputPath } from "../src/tts.mjs";

test("ttsOutputPath preserves the documented absolute destination", () => {
  const output = path.resolve(tmpdir(), "modeldock-explicit", "speech.webm");
  assert.equal(ttsOutputPath(output), path.normalize(output));
});

test("ttsOutputPath confines relative values to a temp filename", () => {
  assert.equal(ttsOutputPath("../../speech.webm"), path.join(tmpdir(), "speech.webm"));
  assert.equal(ttsOutputPath(""), path.join(tmpdir(), "tts-output.webm"));
});

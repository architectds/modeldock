import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(repoRoot, "dist", "modeldock-stt-helper");

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

test("macOS STT helper is universal and starts its real compiled binary", { skip: process.platform !== "darwin" }, async () => {
  assert.ok(existsSync(helper), "npm run build must emit the native STT helper on macOS");
  const architectures = await run("lipo", ["-archs", helper]);
  assert.equal(architectures.error, null, architectures.stderr);
  assert.match(architectures.stdout, /\barm64\b/, "release helper needs an Apple Silicon slice");
  assert.match(architectures.stdout, /\bx86_64\b/, "release helper needs an Intel slice");

  // No audio file is intentional. Reaching the helper's own usage error proves
  // the Swift binary was linked and launched, without downloading a speech asset
  // or making a microphone/speech-recognition request in CI.
  const started = await run(helper, []);
  assert.notEqual(started.error, null, "the no-argument helper should reject its input");
  assert.match(started.stderr, /usage: modeldock-stt-helper/, "the compiled helper should produce its own usage error");
});

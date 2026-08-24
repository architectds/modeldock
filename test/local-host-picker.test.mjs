import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalHostPickerError,
  nativeLocalHostPickerAvailable,
  pickLocalHostPath,
} from "../src/local-host-picker.mjs";

test("the Windows model picker runs a fixed native dialog and returns its selected path", async () => {
  let call;
  const selected = await pickLocalHostPath("model", {
    platform: "win32",
    run: async (file, args) => {
      call = { file, args };
      return JSON.stringify({ accepted: true, path: "D:/models/Qwen3-VL.gguf" });
    },
  });
  assert.equal(selected, "D:/models/Qwen3-VL.gguf");
  assert.equal(call.file, "powershell.exe");
  assert.deepEqual(call.args.slice(0, 3), ["-NoProfile", "-STA", "-Command"]);
  assert.match(call.args[3], /OpenFileDialog/);
  assert.match(call.args[3], /GGUF model files/);
});

test("the Windows KV picker is a folder dialog and cancellation is harmless", async () => {
  let script = "";
  const selected = await pickLocalHostPath("kv_directory", {
    platform: "win32",
    run: async (_file, args) => {
      script = args[3];
      return JSON.stringify({ accepted: false, path: "" });
    },
  });
  assert.equal(selected, "");
  assert.match(script, /FolderBrowserDialog/);
  assert.equal(nativeLocalHostPickerAvailable("win32"), true);
  assert.equal(nativeLocalHostPickerAvailable("linux"), false);
});

test("the picker rejects unknown kinds and non-Windows requests without opening a command", async () => {
  await assert.rejects(
    pickLocalHostPath("command", { platform: "win32", run: async () => { throw new Error("must not run"); } }),
    (error) => error instanceof LocalHostPickerError && error.code === "picker_kind",
  );
  await assert.rejects(
    pickLocalHostPath("model", { platform: "linux", run: async () => { throw new Error("must not run"); } }),
    (error) => error instanceof LocalHostPickerError && error.code === "picker_unsupported",
  );
});

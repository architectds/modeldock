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
  assert.match(call.args[3], /TopMost/);
  assert.match(call.args[3], /ShowDialog\(\$owner\)/);
  assert.match(call.args[3], /Dispose/);
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
  assert.match(script, /ShowDialog\(\$owner\)/);
  assert.equal(nativeLocalHostPickerAvailable("win32"), true);
  assert.equal(nativeLocalHostPickerAvailable("linux"), false);
});

test("only one native picker can wait for a selection at a time", async () => {
  let finish;
  const first = pickLocalHostPath("model", {
    platform: "win32",
    run: async () => new Promise((resolve) => { finish = resolve; }),
  });
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    pickLocalHostPath("kv_directory", {
      platform: "win32",
      run: async () => { throw new Error("must not run"); },
    }),
    (error) => error instanceof LocalHostPickerError && error.code === "picker_busy",
  );

  finish(JSON.stringify({ accepted: false, path: "" }));
  assert.equal(await first, "");
  assert.equal(await pickLocalHostPath("kv_directory", {
    platform: "win32",
    run: async () => JSON.stringify({ accepted: false, path: "" }),
  }), "", "the guard releases after the first picker closes");
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

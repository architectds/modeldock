// Native path selection for the managed local-host drawer.
//
// A browser file input deliberately withholds the real Windows path, which is
// the right web security rule but cannot configure a local llama-server argv.
// This adapter is therefore intentionally narrow: the browser chooses only a
// fixed picker kind, while this process owns the static PowerShell dialog code.

import { execFile } from "node:child_process";

const PICKER_TIMEOUT_MS = 5 * 60_000;
let pickerActive = false;

export const LOCAL_HOST_PICKER_KINDS = Object.freeze([
  "model",
  "vision_projector",
  "kv_directory",
]);

export class LocalHostPickerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalHostPickerError";
    this.code = code;
  }
}

function pickerScript(kind) {
  const owner = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    "$owner = New-Object System.Windows.Forms.Form;",
    "$owner.Text = 'ModelDock path picker';",
    "$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None;",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen;",
    "$owner.Size = New-Object System.Drawing.Size(1, 1);",
    "$owner.ShowInTaskbar = $false;",
    "$owner.TopMost = $true;",
    "$owner.Opacity = 0;",
    "$owner.Show();",
    "$owner.Activate();",
  ];
  if (kind === "kv_directory") {
    return [
      ...owner,
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
      "$dialog.Description = 'Choose the ModelDock SSD KV folder';",
      "try {",
      "$accepted = $dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK;",
      "$selectedPath = if ($accepted) { $dialog.SelectedPath } else { '' };",
      "} finally {",
      "$dialog.Dispose(); $owner.Close(); $owner.Dispose();",
      "}",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
      "@{ accepted = $accepted; path = $selectedPath } | ConvertTo-Json -Compress",
    ].join(" ");
  }
  const projector = kind === "vision_projector";
  const title = projector ? "Choose a matching llama.cpp vision projector" : "Choose a GGUF model file";
  const filter = projector
    ? "Projector files (*.gguf;*.mmproj)|*.gguf;*.mmproj|All files (*.*)|*.*"
    : "GGUF model files (*.gguf)|*.gguf|All files (*.*)|*.*";
  return [
    ...owner,
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog;",
    `$dialog.Title = '${title}';`,
    `$dialog.Filter = '${filter}';`,
    "$dialog.Multiselect = $false;",
    "$dialog.RestoreDirectory = $true;",
    "try {",
    "$accepted = $dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK;",
    "$selectedPath = if ($accepted) { $dialog.FileName } else { '' };",
    "} finally {",
    "$dialog.Dispose(); $owner.Close(); $owner.Dispose();",
    "}",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    "@{ accepted = $accepted; path = $selectedPath } | ConvertTo-Json -Compress",
  ].join(" ");
}

function runPowerShell(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: PICKER_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = Boolean(error.killed || error.signal);
        reject(new LocalHostPickerError(
          timedOut ? "picker_timeout" : "picker_failed",
          timedOut
            ? "The Windows picker timed out. Open it again when you are ready to choose a path."
            : String(stderr || error.message || "Windows picker failed."),
        ));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

export function nativeLocalHostPickerAvailable(platform = process.platform) {
  return platform === "win32";
}

export async function pickLocalHostPath(kind, {
  platform = process.platform,
  run = runPowerShell,
} = {}) {
  if (!LOCAL_HOST_PICKER_KINDS.includes(kind)) {
    throw new LocalHostPickerError("picker_kind", "Choose a supported local-host picker.");
  }
  if (!nativeLocalHostPickerAvailable(platform)) {
    throw new LocalHostPickerError("picker_unsupported", "Native file selection is available on Windows. Enter an absolute path manually on this platform.");
  }
  if (pickerActive) {
    throw new LocalHostPickerError("picker_busy", "A ModelDock path picker is already open.");
  }
  pickerActive = true;
  let parsed;
  try {
    parsed = JSON.parse(await run("powershell.exe", ["-NoProfile", "-STA", "-Command", pickerScript(kind)]));
  } catch (error) {
    if (error instanceof LocalHostPickerError) throw error;
    throw new LocalHostPickerError("picker_failed", "Windows picker returned an unreadable result.");
  } finally {
    pickerActive = false;
  }
  if (!parsed?.accepted) return "";
  const selected = String(parsed.path || "").trim();
  if (!selected) throw new LocalHostPickerError("picker_failed", "Windows picker returned no path.");
  return selected;
}

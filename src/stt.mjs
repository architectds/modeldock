// Local STT (WINDOWS ONLY): transcribe an audio file using the Windows SAPI dictation
// engine (System.Speech, ships with Windows; no install needed). The audio must be converted
// to 16kHz mono PCM WAV first; ffmpeg is used when present, otherwise the tool reports
// that transcription needs ffmpeg. Chinese and English are the primary targets; any
// installed SAPI recognizer culture works. Non-Windows platforms get available:false.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);

const CHECK_TTL_MS = 10_000;
let sapiCache = null;
let sapiCheckedAt = 0;

async function probeSapi() {
  if (process.platform !== "win32") return [];
  const now = Date.now();
  if (sapiCache !== null && now - sapiCheckedAt < CHECK_TTL_MS) return sapiCache;
  const script = "Add-Type -AssemblyName System.Speech; [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }";
  try {
    const raw = await runPowerShell(script);
    sapiCache = String(raw || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    sapiCache = [];
  }
  sapiCheckedAt = now;
  return sapiCache;
}

export async function sttStatus() {
  const cultures = await probeSapi();
  const ffmpeg = await findFfmpeg();
  return {
    available: cultures.length > 0,
    cultures,
    ffmpeg,
  };
}

// ffmpeg availability probe is cached (TTL 10s) the same way the SAPI probe
// is, so the dashboard's per-SSE-event /api/speech call stops spawning
// `where.exe` on every hit.
const FFMPEG_TTL_MS = 10_000;
let ffmpegCache = null;
let ffmpegCheckedAt = 0;

async function findFfmpeg() {
  const now = Date.now();
  if (ffmpegCache !== null && now - ffmpegCheckedAt < FFMPEG_TTL_MS) return ffmpegCache;
  try {
    await run(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"], { timeout: 10_000, windowsHide: true });
    ffmpegCache = true;
  } catch {
    ffmpegCache = false;
  }
  ffmpegCheckedAt = now;
  return ffmpegCache;
}

// Values that come from the model (culture, file paths) are passed as environment
// variables and read inside the script, never interpolated into it: string-built
// PowerShell is a command-injection hole the moment a value contains a quote or $(...).
async function runPowerShell(script, vars = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...vars },
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message} | stderr: ${(stderr || "").slice(0, 200)}`));
      resolve(String(stdout || "").trim());
    });
  });
}

export async function sttTranscribe({ file = "", language = "auto", output = "" } = {}) {
  if (!file) throw new Error("hear requires a file path");
  if (!existsSync(file)) throw new Error(`audio file not found: ${file}`);
  const cultures = await probeSapi();
  if (!cultures.length) throw new Error("no Windows SAPI recognizer available");
  // Only ever hand PowerShell a culture we actually resolved, or a well-formed BCP-47
  // tag - never an arbitrary model-supplied string.
  const requested = String(language || "auto");
  const matched = requested !== "auto"
    ? cultures.find((c) => c.toLowerCase().startsWith(requested.toLowerCase()))
    : null;
  const culture = matched
    || (requested !== "auto" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(requested) ? requested : null)
    || (cultures.includes("zh-CN") ? "zh-CN" : cultures[0]);
  const hasFfmpeg = await findFfmpeg();
  const wav = output || path.join(tmpdir(), `stt-input-${Date.now()}.wav`);
  if (!hasFfmpeg) {
    // SAPI needs PCM WAV; without ffmpeg we can only try direct (rarely works for mp3/webm).
  } else {
    const ffmpeg = (await findFfmpegPath()) || "ffmpeg";
    await run(ffmpeg, ["-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], { timeout: 120_000, windowsHide: true });
  }
  const script = [
    // PowerShell 5.1 pipes text out in the console OEM codepage (GBK on a Chinese
    // system); node decodes child stdout as UTF-8, so force UTF-8 here or Chinese
    // recognition results come back as mojibake.
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Speech",
    "$ci = [System.Globalization.CultureInfo]::GetCultureInfo($env:MODELDOCK_STT_CULTURE)",
    "$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($ci)",
    '$grammar = New-Object System.Speech.Recognition.DictationGrammar("grammar:dictation")',
    "$engine.LoadGrammar($grammar)",
    "$engine.SetInputToWaveFile($env:MODELDOCK_STT_WAV)",
    "$result = $engine.Recognize()",
    'if ($result) { Write-Output ("TEXT:" + $result.Text); Write-Output ("CONF:" + $result.Confidence) } else { Write-Output "TEXT:" }',
    "$engine.Dispose()",
  ].join("; ");
  const out = await runPowerShell(script, {
    MODELDOCK_STT_CULTURE: culture,
    MODELDOCK_STT_WAV: path.resolve(wav),
  });
  const text = (out.match(/TEXT:(.*)/) || [])[1]?.trim() || "";
  const conf = parseFloat((out.match(/CONF:(.*)/) || [])[1] || "0");
  return { text, confidence: conf, language: culture };
}

async function findFfmpegPath() {
  try {
    const { stdout } = await run("where.exe", ["ffmpeg"], { timeout: 10_000, windowsHide: true });
    return stdout.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

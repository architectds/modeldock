import { spawn } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCREENSHOT_PREVIEW_HARD_MAX_BYTES,
  SCREENSHOT_PREVIEW_SOURCE_MAX_BYTES,
  SCREENSHOT_PREVIEW_TARGET_BYTES,
} from "./image-transport.mjs";
import { describeImageUrl } from "./media-store.mjs";

const MIME_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
]);
const PREVIEW_WORKER = fileURLToPath(new URL("./mcp-standalone.mjs", import.meta.url));
const MAX_BATCH_SOURCE_BYTES = 64 * 1024 * 1024;

function detectedMime(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return "";
}

function createPreviewOffThread(imageUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PREVIEW_WORKER, "--image-preview-worker"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Screenshot preview worker timed out after 60 seconds"));
    }, 60_000);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 2 * 1024 * 1024) {
        child.kill();
        finish(new Error("Screenshot preview worker returned too much data"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (Buffer.concat(stderr).byteLength < 8 * 1024) stderr.push(chunk);
    });
    // If the worker rejects the request, wait for close so its actual stderr
    // wins over the generic pipe error from writing the remaining input.
    child.stdin.on("error", (error) => {
      if (error?.code !== "EPIPE") finish(error);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(new Error(`Screenshot preview worker failed: ${Buffer.concat(stderr).toString("utf8").trim() || `exit ${code}`}`));
        return;
      }
      try {
        finish(null, JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        finish(new Error("Screenshot preview worker returned invalid JSON"));
      }
    });
    child.stdin.end(JSON.stringify({
      imageUrl,
      targetBytes: SCREENSHOT_PREVIEW_TARGET_BYTES,
      hardMaxBytes: SCREENSHOT_PREVIEW_HARD_MAX_BYTES,
    }));
  });
}

function imageBlock(imageUrl) {
  const image = describeImageUrl(imageUrl);
  if (!image.isDataUrl || !image.bytes) throw new Error("Screenshot preview did not produce inline image bytes");
  return { type: "image", data: image.bytes.toString("base64"), mimeType: image.mime };
}

export async function previewLocalImages({ paths }, { mediaStore }) {
  const sources = [];
  const skipped = [];
  const seen = new Set();
  let batchBytes = 0;
  for (const value of paths) {
    try {
      if (!path.isAbsolute(value)) throw new Error(`Screenshot preview path must be absolute: ${value}`);
      const absolute = await realpath(value);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const sourceStat = await stat(absolute);
      if (!sourceStat.isFile()) throw new Error(`Image path is not a file: ${absolute}`);
      const mime = MIME_BY_EXTENSION.get(path.extname(absolute).toLowerCase());
      if (!mime) throw new Error(`Unsupported preview image type: ${absolute} (allowed: png, jpg, jpeg)`);
      const sourceLimit = Math.min(mediaStore.maxBytes, SCREENSHOT_PREVIEW_SOURCE_MAX_BYTES);
      if (sourceStat.size > sourceLimit) {
        throw new Error(`Image exceeds the ${sourceLimit}-byte source limit: ${absolute}`);
      }
      if (batchBytes + sourceStat.size > MAX_BATCH_SOURCE_BYTES) {
        throw new Error("Screenshot preview batch exceeds the 64 MiB source budget");
      }
      batchBytes += sourceStat.size;
      sources.push({ absolute, extensionMime: mime });
    } catch (error) {
      skipped.push({ file: path.basename(value), error: error instanceof Error ? error.message : String(error) });
    }
  }
  const previews = [];
  let readBatchBytes = 0;

  for (const { absolute, extensionMime } of sources) {
    try {
      const bytes = await readFile(absolute);
      const sourceLimit = Math.min(mediaStore.maxBytes, SCREENSHOT_PREVIEW_SOURCE_MAX_BYTES);
      if (bytes.byteLength > sourceLimit) {
        throw new Error(`Image exceeds the ${sourceLimit}-byte source limit: ${absolute}`);
      }
      if (readBatchBytes + bytes.byteLength > MAX_BATCH_SOURCE_BYTES) {
        throw new Error("Screenshot preview batch exceeds the 64 MiB source budget");
      }
      readBatchBytes += bytes.byteLength;
      const mime = detectedMime(bytes);
      if (!mime) throw new Error(`File is not a valid PNG or JPEG image: ${absolute}`);
      if (mime !== extensionMime) {
        throw new Error(`Image contents do not match the file extension: ${absolute}`);
      }

      const imageUrl = `data:${mime};base64,${bytes.toString("base64")}`;
      const ref = mediaStore.put(imageUrl, {
        // MediaStore accepts this source only when it is already inside an
        // approved Codex attachment root. Project screenshots keep the normal
        // bounded fallback copy so the ref remains valid after the tool exits.
        resolveExternalSource: (image) => ({ path: absolute, digest: image.digest, size: image.size }),
      });
      let preview = mediaStore.getCachedScreenshotPreview(ref, {
        targetBytes: SCREENSHOT_PREVIEW_TARGET_BYTES,
        hardMaxBytes: SCREENSHOT_PREVIEW_HARD_MAX_BYTES,
      });
      if (!preview) {
        const converted = await createPreviewOffThread(imageUrl);
        preview = mediaStore.storeScreenshotPreview(ref, converted, {
          targetBytes: SCREENSHOT_PREVIEW_TARGET_BYTES,
          hardMaxBytes: SCREENSHOT_PREVIEW_HARD_MAX_BYTES,
        });
      }
      if (!preview) throw new Error(`Screenshot preview source expired unexpectedly: ${ref}`);
      if (preview.previewBytes > SCREENSHOT_PREVIEW_HARD_MAX_BYTES) {
        throw new Error(`Screenshot preview exceeds the ${SCREENSHOT_PREVIEW_HARD_MAX_BYTES}-byte hard limit`);
      }
      previews.push({ absolute, ref, preview });
    } catch (error) {
      skipped.push({ file: path.basename(absolute), error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (!previews.length) {
    throw new Error(`preview_images: every image failed - ${skipped.map((item) => item.error).join(" | ")}`);
  }

  const manifest = previews.map(({ absolute, ref, preview }, index) => ({
    index: index + 1,
    file: path.basename(absolute),
    original_ref: ref,
    original_bytes: preview.originalBytes,
    preview_bytes: preview.previewBytes,
    preview_mime: describeImageUrl(preview.imageUrl).mime,
    transformed: preview.transformed,
    cached: preview.cached,
  }));
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: "screenshot_previews",
          note: "Image blocks are bounded conversation previews. Use original_ref with vision_inspect when full pixels are needed.",
          images: manifest,
          ...(skipped.length ? { skipped } : {}),
        }),
      },
      ...previews.map(({ preview }) => imageBlock(preview.imageUrl)),
    ],
  };
}

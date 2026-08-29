import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i;
const MAX_PIXELS = 40_000_000;
const MAX_DECODE_MEMORY_MB = 256;

function wireBytes(mime, bytes) {
  return Buffer.byteLength(`data:${mime};base64,`) + Math.ceil(bytes.byteLength / 3) * 4;
}

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

function pngDimensions(bytes) {
  if (bytes.byteLength < 24) return null;
  const signature = "89504e470d0a1a0a";
  if (Buffer.from(bytes.subarray(0, 8)).toString("hex") !== signature) return null;
  return { width: Buffer.from(bytes).readUInt32BE(16), height: Buffer.from(bytes).readUInt32BE(20) };
}

function assertSafeDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Image dimensions are invalid");
  }
  if (width * height > MAX_PIXELS) throw new Error(`Image exceeds the ${MAX_PIXELS}-pixel transport limit`);
}

function decodedRgba(mime, bytes) {
  if (mime === "image/png") {
    const dimensions = pngDimensions(bytes);
    if (!dimensions) throw new Error("PNG signature or dimensions are invalid");
    assertSafeDimensions(dimensions.width, dimensions.height);
    const decoded = decodePng(bytes);
    assertSafeDimensions(decoded.width, decoded.height);
    const channels = decoded.channels || 4;
    const depth = decoded.depth || 8;
    const rgba = new Uint8Array(decoded.width * decoded.height * 4);
    const sample = (index) => depth === 16 ? decoded.data[index] >>> 8 : decoded.data[index];
    for (let source = 0, target = 0; target < rgba.length; source += channels, target += 4) {
      const gray = sample(source);
      const red = channels <= 2 ? gray : sample(source);
      const green = channels <= 2 ? gray : sample(source + 1);
      const blue = channels <= 2 ? gray : sample(source + 2);
      const alpha = channels === 2 ? sample(source + 1) : channels === 4 ? sample(source + 3) : 255;
      // JPEG has no alpha. Composite transparent pixels onto white so UI
      // screenshots keep their expected light background instead of turning black.
      rgba[target] = Math.round((red * alpha + 255 * (255 - alpha)) / 255);
      rgba[target + 1] = Math.round((green * alpha + 255 * (255 - alpha)) / 255);
      rgba[target + 2] = Math.round((blue * alpha + 255 * (255 - alpha)) / 255);
      rgba[target + 3] = 255;
    }
    return { width: decoded.width, height: decoded.height, data: rgba };
  }
  if (mime === "image/jpeg") {
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_PIXELS / 1_000_000,
      maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
    });
    assertSafeDimensions(decoded.width, decoded.height);
    return decoded;
  }
  throw new Error(`Image transport compression does not support ${mime}`);
}

function resizeRgba(image, width, height) {
  if (width === image.width && height === image.height) return image;
  const output = new Uint8Array(width * height * 4);
  const xScale = image.width / width;
  const yScale = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(image.height - 1, (y + 0.5) * yScale - 0.5);
    const y0 = Math.max(0, Math.floor(sourceY));
    const y1 = Math.min(image.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, (x + 0.5) * xScale - 0.5);
      const x0 = Math.max(0, Math.floor(sourceX));
      const x1 = Math.min(image.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const target = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const top = image.data[(y0 * image.width + x0) * 4 + channel] * (1 - xWeight)
          + image.data[(y0 * image.width + x1) * 4 + channel] * xWeight;
        const bottom = image.data[(y1 * image.width + x0) * 4 + channel] * (1 - xWeight)
          + image.data[(y1 * image.width + x1) * 4 + channel] * xWeight;
        output[target + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
      output[target + 3] = 255;
    }
  }
  return { width, height, data: output };
}

export const MIN_IMAGE_TRANSPORT_WIRE_BYTES = 32 * 1024;

export const SCREENSHOT_PREVIEW_PREFERRED_MIN_BYTES = 200 * 1024;
export const SCREENSHOT_PREVIEW_TARGET_BYTES = 600 * 1024;
export const SCREENSHOT_PREVIEW_HARD_MAX_BYTES = 1024 * 1024;
export const SCREENSHOT_PREVIEW_SOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_PREVIEW_WORKER_INPUT_MAX_BYTES = 16 * 1024 * 1024;

function encodeScreenshotJpeg(image, maxBytes) {
  let working = image;
  let highQuality = 94;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    let encoded = jpeg.encode(working, highQuality).data;
    if (encoded.byteLength <= maxBytes) {
      return { encoded, image: working, quality: highQuality };
    }

    // Prefer keeping screenshot dimensions and reducing JPEG quality before
    // resizing. Text and thin UI lines survive this substantially better than
    // an early spatial downscale.
    const floorQuality = 72;
    const floorEncoded = jpeg.encode(working, floorQuality).data;
    if (floorEncoded.byteLength <= maxBytes) {
      let low = floorQuality;
      let high = highQuality;
      let best = { encoded: floorEncoded, quality: floorQuality };
      while (low <= high) {
        const quality = Math.floor((low + high) / 2);
        encoded = jpeg.encode(working, quality).data;
        if (encoded.byteLength <= maxBytes) {
          best = { encoded, quality };
          low = quality + 1;
        } else {
          high = quality - 1;
        }
      }
      return { ...best, image: working };
    }

    // At the quality floor the only remaining lever is resolution. Preserve
    // the aspect ratio exactly; unlike the provider transport path, very thin
    // screenshots must not be stretched merely to enforce a minimum edge.
    const scale = Math.min(0.9, Math.sqrt(maxBytes / floorEncoded.byteLength) * 0.94);
    const width = Math.max(1, Math.floor(working.width * scale));
    const height = Math.max(1, Math.floor(working.height * scale));
    if (width === working.width && height === working.height) break;
    working = resizeRgba(working, width, height);
    highQuality = 92;
  }

  // The 600 KiB preferred target is intentionally stricter than the absolute
  // 1 MiB contract. If a pathological image cannot reach the preferred target,
  // one final lower-quality pass still has to respect the hard limit.
  for (const quality of [64, 56, 48, 40]) {
    const encoded = jpeg.encode(working, quality).data;
    if (encoded.byteLength <= maxBytes) return { encoded, image: working, quality };
  }
  throw new Error(`Screenshot preview could not be reduced below ${maxBytes} bytes`);
}

export function createScreenshotPreview(imageUrl, {
  targetBytes = SCREENSHOT_PREVIEW_TARGET_BYTES,
  hardMaxBytes = SCREENSHOT_PREVIEW_HARD_MAX_BYTES,
} = {}) {
  const target = Math.floor(Number(targetBytes));
  const hardMax = Math.floor(Number(hardMaxBytes));
  if (!Number.isSafeInteger(target) || target < SCREENSHOT_PREVIEW_PREFERRED_MIN_BYTES) {
    throw new Error(`Screenshot preview target must be at least ${SCREENSHOT_PREVIEW_PREFERRED_MIN_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(hardMax) || hardMax < target) {
    throw new Error("Screenshot preview hard limit must be at least the preferred target");
  }

  const match = DATA_URL.exec(String(imageUrl || ""));
  if (!match) throw new Error("Screenshot preview requires a PNG or JPEG data URL");
  const mime = match[1].toLowerCase();
  const original = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (original.byteLength <= target) {
    return {
      imageUrl,
      mime,
      transformed: false,
      originalBytes: original.byteLength,
      previewBytes: original.byteLength,
    };
  }

  const image = decodedRgba(mime, original);
  let converted;
  try {
    converted = encodeScreenshotJpeg(image, target);
  } catch (error) {
    if (hardMax === target) throw error;
    converted = encodeScreenshotJpeg(image, hardMax);
  }
  if (converted.encoded.byteLength > hardMax) {
    throw new Error(`Screenshot preview exceeds the ${hardMax}-byte hard limit`);
  }
  return {
    imageUrl: dataUrl("image/jpeg", converted.encoded),
    mime: "image/jpeg",
    transformed: true,
    originalBytes: original.byteLength,
    previewBytes: converted.encoded.byteLength,
    width: converted.image.width,
    height: converted.image.height,
    quality: converted.quality,
  };
}

export function createTransportImage(imageUrl, { maxWireBytes }) {
  const limit = Math.floor(Number(maxWireBytes));
  if (!Number.isSafeInteger(limit) || limit < MIN_IMAGE_TRANSPORT_WIRE_BYTES) {
    throw new Error(`Image transport limit must be at least ${MIN_IMAGE_TRANSPORT_WIRE_BYTES} bytes`);
  }
  const originalWireBytes = Buffer.byteLength(imageUrl || "");
  if (originalWireBytes <= limit) {
    return { imageUrl, transformed: false, originalWireBytes, wireBytes: originalWireBytes };
  }
  const match = DATA_URL.exec(String(imageUrl || ""));
  if (!match) throw new Error("Only oversized PNG or JPEG data URLs can be compressed for transport");
  const mime = match[1].toLowerCase();
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  let image = decodedRgba(mime, bytes);
  let quality = 85;
  let encoded = jpeg.encode(image, quality).data;
  for (let attempt = 0; wireBytes("image/jpeg", encoded) > limit && attempt < 5; attempt += 1) {
    const binaryLimit = Math.max(1, Math.floor((limit - 32) * 3 / 4));
    const scale = Math.min(0.9, Math.sqrt(binaryLimit / encoded.byteLength) * 0.92);
    const width = Math.max(256, Math.floor(image.width * scale));
    const height = Math.max(256, Math.floor(image.height * scale));
    if (width === image.width && height === image.height) {
      quality = Math.max(45, quality - 12);
    } else {
      image = resizeRgba(image, width, height);
      quality = 82;
    }
    encoded = jpeg.encode(image, quality).data;
  }
  const finalWireBytes = wireBytes("image/jpeg", encoded);
  if (finalWireBytes > limit) throw new Error(`Image could not be reduced below the ${limit}-byte transport limit`);
  return {
    imageUrl: dataUrl("image/jpeg", encoded),
    transformed: true,
    originalWireBytes,
    wireBytes: finalWireBytes,
    width: image.width,
    height: image.height,
    quality,
  };
}

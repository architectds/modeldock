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

export function createTransportImage(imageUrl, { maxWireBytes }) {
  const limit = Math.floor(Number(maxWireBytes));
  if (!Number.isSafeInteger(limit) || limit < 32 * 1024) throw new Error("Image transport limit must be at least 32768 bytes");
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

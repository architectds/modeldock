import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { isLoopbackHost } from "./loopback.mjs";

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i;

export class MediaStore {
  #items = new Map();
  #stateDir;
  #indexPath;

  constructor({ ttlMs, maxBytes, maxEntries, stateDir = null }) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.#stateDir = stateDir ? path.resolve(stateDir) : null;
    this.#indexPath = this.#stateDir ? path.join(this.#stateDir, "index.json") : null;
    this.#load();
  }

  put(imageUrl) {
    if (typeof imageUrl !== "string" || imageUrl.length === 0) {
      throw new Error("input_image.image_url must be a non-empty string");
    }

    let size = 0;
    let mime = "remote";
    let digestInput = imageUrl;
    const dataMatch = DATA_URL.exec(imageUrl);
    if (dataMatch) {
      const bytes = Buffer.from(dataMatch[2].replace(/\s/g, ""), "base64");
      size = bytes.byteLength;
      mime = dataMatch[1].toLowerCase();
      digestInput = bytes;
    } else {
      const url = new URL(imageUrl);
      if (url.protocol !== "https:") throw new Error("Only image data URLs and public HTTPS URLs are supported");
      if (isLoopbackHost(url.hostname)) {
        throw new Error("Local image URLs are not accepted");
      }
      size = Buffer.byteLength(imageUrl);
    }

    if (size > this.maxBytes) {
      throw new Error(`Image exceeds the ${this.maxBytes}-byte limit`);
    }

    const ref = `img_${createHash("sha256").update(digestInput).digest("hex").slice(0, 20)}`;
    const now = Date.now();
    const item = {
      ref,
      imageUrl: dataMatch && this.#stateDir ? null : imageUrl,
      mime,
      size,
      createdAt: now,
      lastAccessAt: now,
      storage: dataMatch ? (this.#stateDir ? "file" : "memory") : "remote",
    };
    if (this.#stateDir && dataMatch) {
      this.#ensureStateDir();
      writeFileSync(this.#filePath(ref), bytesForDataUrl(dataMatch), { flag: "w" });
    }
    this.#items.set(ref, item);
    this.#persist();
    this.cleanup(now);
    return ref;
  }

  get(ref) {
    this.cleanup();
    const item = this.#items.get(ref);
    if (!item) return undefined;
    if (item.storage === "file") {
      const file = this.#filePath(item.ref);
      if (!existsSync(file)) {
        this.#items.delete(item.ref);
        this.#persist();
        return undefined;
      }
      item.imageUrl = `data:${item.mime};base64,${readFileSync(file).toString("base64")}`;
    }
    item.lastAccessAt = Date.now();
    this.#persist();
    return { ...item };
  }

  cleanup(now = Date.now()) {
    let changed = false;
    for (const [ref, item] of this.#items) {
      if (now - item.lastAccessAt > this.ttlMs) {
        this.#items.delete(ref);
        this.#removeFile(item);
        changed = true;
      }
    }
    while (this.#items.size > this.maxEntries) {
      const oldest = [...this.#items.values()].sort((a, b) => a.lastAccessAt - b.lastAccessAt)[0];
      if (!oldest) break;
      this.#items.delete(oldest.ref);
      this.#removeFile(oldest);
      changed = true;
    }
    if (changed) this.#persist();
  }

  snapshot() {
    this.cleanup();
    let bytes = 0;
    for (const item of this.#items.values()) bytes += item.size;
    return { entries: this.#items.size, bytes, ttlMs: this.ttlMs, maxBytesPerImage: this.maxBytes };
  }

  #filePath(ref) {
    return path.join(this.#stateDir, `${ref}.bin`);
  }

  #ensureStateDir() {
    mkdirSync(this.#stateDir, { recursive: true });
  }

  #removeFile(item) {
    if (!this.#stateDir || item.storage !== "file") return;
    try {
      unlinkSync(this.#filePath(item.ref));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  #persist() {
    if (!this.#stateDir) return;
    this.#ensureStateDir();
    const entries = [...this.#items.values()].map((item) => (
      item.storage === "file" ? { ...item, imageUrl: undefined } : { ...item }
    ));
    const temp = `${this.#indexPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(entries), "utf8");
    try {
      if (existsSync(this.#indexPath)) unlinkSync(this.#indexPath);
      renameSync(temp, this.#indexPath);
    } finally {
      try {
        if (existsSync(temp)) unlinkSync(temp);
      } catch {
        // Best effort cleanup; the next write replaces the temporary index.
      }
    }
  }

  #load() {
    if (!this.#stateDir || !existsSync(this.#indexPath)) return;
    let entries;
    try {
      entries = JSON.parse(readFileSync(this.#indexPath, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || !/^img_[0-9a-f]{20}$/.test(entry.ref)) continue;
      if (!Number.isFinite(entry.lastAccessAt) || !Number.isFinite(entry.createdAt)) continue;
      if (entry.storage === "file") {
        if (!existsSync(this.#filePath(entry.ref))) continue;
        if (!/^image\/[a-z0-9.+-]+$/i.test(entry.mime) || !Number.isFinite(entry.size)) continue;
      } else if (entry.storage === "remote" && typeof entry.imageUrl !== "string") {
        continue;
      }
      this.#items.set(entry.ref, { ...entry, imageUrl: entry.storage === "remote" ? entry.imageUrl : null });
    }
    this.cleanup();
  }
}

function bytesForDataUrl(match) {
  return Buffer.from(match[2].replace(/\s/g, ""), "base64");
}

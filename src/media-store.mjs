import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { isLoopbackHost } from "./loopback.mjs";

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i;
const ACCESS_PERSIST_INTERVAL_MS = 60_000;

function validSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 128;
}

export function describeImageUrl(imageUrl) {
  if (typeof imageUrl !== "string" || imageUrl.length === 0) {
    throw new Error("input_image.image_url must be a non-empty string");
  }
  const dataMatch = DATA_URL.exec(imageUrl);
  if (dataMatch) {
    const bytes = Buffer.from(dataMatch[2].replace(/\s/g, ""), "base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    return {
      imageUrl,
      bytes,
      size: bytes.byteLength,
      mime: dataMatch[1].toLowerCase(),
      digest,
      ref: `img_${digest.slice(0, 20)}`,
      isDataUrl: true,
    };
  }
  const url = new URL(imageUrl);
  if (url.protocol !== "https:") throw new Error("Only image data URLs and public HTTPS URLs are supported");
  if (isLoopbackHost(url.hostname)) throw new Error("Local image URLs are not accepted");
  const digest = createHash("sha256").update(imageUrl).digest("hex");
  return {
    imageUrl,
    bytes: null,
    size: Buffer.byteLength(imageUrl),
    mime: "remote",
    digest,
    ref: `img_${digest.slice(0, 20)}`,
    isDataUrl: false,
  };
}

export class MediaStore {
  #items = new Map();
  #sessions = new Map();
  #stateDir;
  #indexPath;
  #batchDepth = 0;
  #dirty = false;

  constructor({ ttlMs, maxBytes, maxEntries, maxStoredBytes = 256 * 1024 * 1024, stateDir = null, externalRoots = [] }) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.maxStoredBytes = maxStoredBytes;
    this.#stateDir = stateDir ? path.resolve(stateDir) : null;
    this.#indexPath = this.#stateDir ? path.join(this.#stateDir, "index.json") : null;
    this.externalRoots = externalRoots.map((root) => path.resolve(root));
    this.#load();
  }

  touchSession(sessionId) {
    if (!validSessionId(sessionId)) return;
    const now = Date.now();
    if ((this.#sessions.get(sessionId) || 0) >= now - 60_000) return;
    this.#sessions.set(sessionId, now);
    this.#persist();
  }

  associate(ref, sessionId) {
    this.associateMany([ref], sessionId);
  }

  associateMany(refs, sessionId) {
    if (!validSessionId(sessionId)) return;
    let changed = false;
    for (const ref of new Set(refs)) {
      const item = this.#items.get(ref);
      if (!item || (item.sessionIds || []).includes(sessionId)) continue;
      item.sessionIds = [...new Set([...(item.sessionIds || []), sessionId])];
      changed = true;
    }
    if (changed) {
      this.#sessions.set(sessionId, Date.now());
      this.#markDirty();
    }
  }

  batch(callback) {
    this.#batchDepth += 1;
    try {
      return callback();
    } finally {
      this.#batchDepth -= 1;
      if (this.#batchDepth === 0 && this.#dirty) this.#persist();
    }
  }

  put(imageUrl, { resolveExternalSource, sessionId } = {}) {
    const image = describeImageUrl(imageUrl);
    if (image.size > this.maxBytes) {
      throw new Error(`Image exceeds the ${this.maxBytes}-byte limit`);
    }
    const external = image.isDataUrl && typeof resolveExternalSource === "function"
      ? resolveExternalSource(image)
      : null;
    const sourcePath = external && external.digest === image.digest && external.size === image.size && this.#allowedExternalPath(external.path)
      ? path.resolve(external.path)
      : "";
    const now = Date.now();
    const existing = this.#items.get(image.ref);
    if (existing) {
      let changed = false;
      existing.lastAccessAt = now;
      if (validSessionId(sessionId) && !(existing.sessionIds || []).includes(sessionId)) {
        existing.sessionIds = [...new Set([...(existing.sessionIds || []), sessionId])];
        this.#sessions.set(sessionId, now);
        changed = true;
      }
      // Prefer the source already owned by Codex when the same pixels are
      // observed again. This also replaces a previous fallback copy.
      if (sourcePath && (existing.storage !== "external" || existing.sourcePath !== sourcePath)) {
        this.#removeFile(existing);
        existing.storage = "external";
        existing.sourcePath = sourcePath;
        existing.imageUrl = null;
        changed = true;
      }
      if (changed) this.#markDirty();
      this.cleanup(now);
      return image.ref;
    }
    const sessions = new Set(existing?.sessionIds || []);
    if (validSessionId(sessionId)) {
      sessions.add(sessionId);
      this.#sessions.set(sessionId, now);
    }
    const item = {
      ref: image.ref,
      imageUrl: image.isDataUrl && this.#stateDir ? null : imageUrl,
      mime: image.mime,
      size: image.size,
      digest: image.digest,
      createdAt: existing?.createdAt || now,
      lastAccessAt: now,
      storage: sourcePath ? "external" : image.isDataUrl ? (this.#stateDir ? "file" : "memory") : "remote",
      ...(sourcePath ? { sourcePath } : {}),
      ...(sessions.size ? { sessionIds: [...sessions] } : {}),
    };
    if (this.#stateDir && image.isDataUrl && !sourcePath) {
      this.#ensureStateDir();
      if (!existsSync(this.#filePath(image.ref))) writeFileSync(this.#filePath(image.ref), image.bytes, { flag: "w" });
    }
    this.#items.set(image.ref, item);
    this.#markDirty();
    this.cleanup(now);
    return image.ref;
  }

  get(ref) {
    this.cleanup();
    const item = this.#items.get(ref);
    if (!item) return undefined;
    let imageUrl = item.imageUrl;
    if (item.storage === "file") {
      const file = this.#filePath(item.ref);
      if (!existsSync(file)) {
        this.#items.delete(item.ref);
        this.#markDirty();
        return undefined;
      }
      imageUrl = `data:${item.mime};base64,${readFileSync(file).toString("base64")}`;
    }
    if (item.storage === "external") {
      try {
        const bytes = readFileSync(item.sourcePath);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (bytes.byteLength !== item.size || digest !== item.digest) throw new Error("source changed");
        imageUrl = `data:${item.mime};base64,${bytes.toString("base64")}`;
      } catch {
        this.#items.delete(ref);
        this.#markDirty();
        return undefined;
      }
    }
    const now = Date.now();
    const persistAccess = now - item.lastAccessAt >= ACCESS_PERSIST_INTERVAL_MS;
    item.lastAccessAt = now;
    // Hydrating the 20-image visual window must not rewrite index.json once
    // per ref on every turn. In-memory LRU remains exact; persisted access is
    // sampled at the same one-minute cadence as touchSession, which is safely
    // below the minimum media TTL and avoids turning a read into disk churn.
    if (persistAccess) this.#markDirty();
    // File-backed and Codex-owned records deliberately keep only metadata in
    // the store. The data URL exists for this return value and the one
    // provider request that consumes it; retaining it on `item` would turn a
    // reference cache into an unbounded second in-memory image archive.
    return { ...item, imageUrl };
  }

  cleanup(now = Date.now()) {
    let changed = false;
    for (const [sessionId, lastSeenAt] of this.#sessions) {
      if (now - lastSeenAt > this.ttlMs) {
        this.#sessions.delete(sessionId);
        changed = true;
      }
    }
    for (const [ref, item] of this.#items) {
      const sessionIds = Array.isArray(item.sessionIds) ? item.sessionIds.filter((sessionId) => this.#sessions.has(sessionId)) : [];
      if (sessionIds.length !== (item.sessionIds || []).length) {
        item.sessionIds = sessionIds;
        changed = true;
      }
      const activeSessionKeepsItem = sessionIds.length > 0;
      if (!activeSessionKeepsItem && now - item.lastAccessAt > this.ttlMs) {
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
    let storedBytes = [...this.#items.values()]
      .filter((item) => item.storage === "file")
      .reduce((total, item) => total + item.size, 0);
    while (storedBytes > this.maxStoredBytes) {
      const oldest = [...this.#items.values()]
        .filter((item) => item.storage === "file")
        .sort((left, right) => left.lastAccessAt - right.lastAccessAt)[0];
      if (!oldest) break;
      this.#items.delete(oldest.ref);
      this.#removeFile(oldest);
      storedBytes -= oldest.size;
      changed = true;
    }
    if (changed) this.#markDirty();
  }

  snapshot() {
    this.cleanup();
    let bytes = 0;
    let storedBytes = 0;
    let externalEntries = 0;
    let residentImageBytes = 0;
    for (const item of this.#items.values()) {
      bytes += item.size;
      if (item.storage === "file") storedBytes += item.size;
      if (item.storage === "external") externalEntries += 1;
      if (item.storage === "memory") residentImageBytes += item.size;
    }
    return {
      entries: this.#items.size,
      bytes,
      storedBytes,
      externalEntries,
      residentImageBytes,
      directory: this.#stateDir,
      ttlMs: this.ttlMs,
      maxBytesPerImage: this.maxBytes,
      maxStoredBytes: this.maxStoredBytes,
    };
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

  #allowedExternalPath(filePath) {
    if (typeof filePath !== "string" || !filePath || !this.externalRoots.length) return false;
    const resolved = path.resolve(filePath);
    return this.externalRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  }

  #persist() {
    if (!this.#stateDir) return;
    this.#ensureStateDir();
    const entries = [...this.#items.values()].map((item) => (
      item.storage === "file" || item.storage === "external" ? { ...item, imageUrl: undefined } : { ...item }
    ));
    const temp = `${this.#indexPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 2, sessions: Object.fromEntries(this.#sessions), items: entries }), "utf8");
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
    this.#dirty = false;
  }

  #markDirty() {
    if (!this.#stateDir) return;
    if (this.#batchDepth > 0) {
      this.#dirty = true;
      return;
    }
    this.#persist();
  }

  #load() {
    if (!this.#stateDir || !existsSync(this.#indexPath)) return;
    let entries;
    try {
      entries = JSON.parse(readFileSync(this.#indexPath, "utf8"));
    } catch {
      return;
    }
    const records = Array.isArray(entries) ? entries : entries?.items;
    if (!Array.isArray(records)) return;
    if (!Array.isArray(entries)) {
      for (const [sessionId, lastSeenAt] of Object.entries(entries.sessions || {})) {
        if (validSessionId(sessionId) && Number.isFinite(lastSeenAt)) this.#sessions.set(sessionId, lastSeenAt);
      }
    }
    for (const entry of records) {
      if (!entry || !/^img_[0-9a-f]{20}$/.test(entry.ref)) continue;
      if (!Number.isFinite(entry.lastAccessAt) || !Number.isFinite(entry.createdAt)) continue;
      if (entry.storage === "file") {
        if (!existsSync(this.#filePath(entry.ref))) continue;
        if (!/^image\/[a-z0-9.+-]+$/i.test(entry.mime) || !Number.isFinite(entry.size)) continue;
      } else if (entry.storage === "external") {
        if (!this.#allowedExternalPath(entry.sourcePath) || !/^[0-9a-f]{64}$/i.test(entry.digest || "") || !Number.isFinite(entry.size)) continue;
      } else if (entry.storage === "remote" && typeof entry.imageUrl !== "string") {
        continue;
      }
      this.#items.set(entry.ref, {
        ...entry,
        sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds.filter(validSessionId) : [],
        imageUrl: entry.storage === "remote" ? entry.imageUrl : null,
      });
    }
    this.cleanup();
  }
}

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const IMAGE_MIME_BY_EXTENSION = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
]);

function validSessionId(sessionId) {
  return typeof sessionId === "string" && /^[0-9a-f-]{20,64}$/i.test(sessionId);
}

function fileDigest(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function filesUnder(root, visit) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) filesUnder(filePath, visit);
    else if (entry.isFile()) visit(filePath);
  }
}

// Codex Desktop keeps user attachments and generated images in its own local
// stores. The Responses wire still embeds the same bytes as a data URL, so a
// gateway that copies them again becomes an unnecessary second image archive.
// This is deliberately read-only: ModelDock never creates, moves, or deletes
// anything under Codex's directories.
export class CodexAttachmentIndex {
  #roots;
  #sessions = new Map();

  constructor({ codexHome }) {
    const home = path.resolve(codexHome || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".codex"));
    this.#roots = [
      path.join(home, "codex-remote-attachments"),
      path.join(home, "generated_images"),
    ];
  }

  get roots() {
    return [...this.#roots];
  }

  // `image` is the digest/size descriptor MediaStore already derived from the
  // inbound data URL. A matching file is safe to reference because both the
  // byte size and SHA-256 agree; a same-name attachment cannot be substituted.
  resolve(sessionId, image) {
    if (!validSessionId(sessionId) || !image?.digest || !Number.isFinite(image.size)) return null;
    const indexed = this.#index(sessionId);
    const match = indexed.get(image.digest);
    if (!match || match.size !== image.size) return null;
    return { path: match.path, digest: image.digest, size: image.size, mime: match.mime };
  }

  #index(sessionId) {
    const roots = this.#roots.map((root) => path.join(root, sessionId));
    const fingerprint = roots.map((root) => {
      try { return statSync(root).mtimeMs; } catch { return 0; }
    }).join(":");
    const cached = this.#sessions.get(sessionId);
    if (cached?.fingerprint === fingerprint) return cached.entries;

    const entries = new Map();
    for (const root of roots) {
      if (!existsSync(root)) continue;
      filesUnder(root, (filePath) => {
        const mime = IMAGE_MIME_BY_EXTENSION.get(path.extname(filePath).toLowerCase());
        if (!mime) return;
        try {
          const size = statSync(filePath).size;
          const digest = fileDigest(filePath);
          entries.set(digest, { path: filePath, size, mime });
        } catch {
          // A concurrent Codex cleanup is a cache miss, not a failed request.
        }
      });
    }
    this.#sessions.set(sessionId, { fingerprint, entries });
    return entries;
  }
}

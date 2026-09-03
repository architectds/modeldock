import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// One crash-safe replacement primitive for small synchronous state files.
// Callers own serialization and any post-write ACL policy; this module owns the
// durability invariant so each store cannot quietly invent a weaker variant.
export function atomicWriteTextSync(file, content, { mode } = {}) {
  const raw = String(file || "").trim();
  if (!raw) throw new TypeError("An atomic write target is required.");
  const target = path.resolve(raw);
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const options = mode === undefined ? "utf8" : { encoding: "utf8", mode };
    writeFileSync(temporary, String(content), options);
    renameSync(temporary, target);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
  return target;
}

export function atomicWriteJsonSync(file, value, { space = 2, newline = false, mode } = {}) {
  const suffix = newline ? "\n" : "";
  return atomicWriteTextSync(file, `${JSON.stringify(value, null, space)}${suffix}`, { mode });
}

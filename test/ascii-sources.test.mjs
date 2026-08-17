// AGENTS.md rule one, enforced.
//
// "All code, comments, identifiers... must be written in English (ASCII)."
// The reason is not style: a non-ASCII source file combined with a PowerShell
// write (Set-Content, >, a pipeline default) silently becomes UTF-16 or ANSI,
// which corrupts the file and, for public/, breaks the browser frontend. The
// rule had no enforcement, so 53 violations accumulated across src, scripts and
// test - including Chinese comments inside a .ps1, the exact file type the
// corruption path runs through.
//
// Nothing here forbids matching CJK or symbols. Escape them - a backslash-u
// sequence for the codepoint rather than the character itself - and the runtime
// bytes are identical while the source stays ASCII.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = ["src", "scripts", "test"];
const EXTENSIONS = /\.(mjs|js|ps1|sh)$/;

// public/i18n.js is the single sanctioned exception: it holds the interface
// translations, and its own header explains that they are stored as text rather
// than escapes so translators can read them. It is not scanned here.
function sources(dir, out = []) {
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sources(rel, out);
    else if (EXTENSIONS.test(entry.name)) out.push(rel);
  }
  return out;
}

test("every source file is pure ASCII", () => {
  const offenders = [];
  for (const file of SCANNED.flatMap((dir) => sources(dir))) {
    const lines = readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      const bad = [...line].filter((ch) => ch.codePointAt(0) > 127);
      if (!bad.length) return;
      const points = [...new Set(bad)].map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
      offenders.push(`${file}:${index + 1} ${points.join(" ")}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "non-ASCII in a source file: escape the character (\\u3002) if it is data, or write the comment in English",
  );
});

test("the frontend assets are valid UTF-8", () => {
  // The corruption this guards against turns a file into UTF-16 or ANSI, which
  // decodes as invalid UTF-8. i18n.js is exempt from the ASCII rule but not
  // from this one - it is the file the corruption would hurt most.
  for (const file of readdirSync(path.join(root, "public")).filter((f) => /\.(js|css|html)$/.test(f))) {
    const bytes = readFileSync(path.join(root, "public", file));
    assert.doesNotThrow(
      () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      `public/${file} is not valid UTF-8`,
    );
  }
});

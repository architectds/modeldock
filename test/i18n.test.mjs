import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// public/i18n.js is a browser script, not a module: read and parse it as text
// rather than importing it.
const source = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "i18n.js"),
  "utf8",
);

const LOCALES = ["I18N_EN", "I18N_ZH", "I18N_JA"];

function keysOf(locale) {
  const start = source.indexOf(`const ${locale} = {`);
  assert.ok(start >= 0, `${locale} is missing from public/i18n.js`);
  let depth = 0;
  let end = source.indexOf("{", start);
  for (let i = end; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  return new Set([...source.slice(start, end).matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]));
}

test("every locale carries the full English key set", () => {
  // A missing key falls back to English silently (i18n.js: table[key] ?? I18N_EN[key]),
  // so an untranslated string reaches the user as English with nothing failing.
  // models.none and runtime.migration were missing from all two non-English
  // locales this way. Compare the sets instead of trusting the fallback.
  const english = keysOf("I18N_EN");
  assert.ok(english.size > 100, "the English table should be populated");
  for (const locale of LOCALES.slice(1)) {
    const keys = keysOf(locale);
    const missing = [...english].filter((key) => !keys.has(key));
    const extra = [...keys].filter((key) => !english.has(key));
    assert.deepEqual(missing, [], `${locale} is missing keys`);
    assert.deepEqual(extra, [], `${locale} has keys English does not`);
  }
});

test("i18n.js is valid UTF-8", () => {
  // The translations are the one place non-ASCII text belongs, and a bad write
  // (PowerShell redirection, a UTF-16 checkout) corrupts the whole dashboard.
  const bytes = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "i18n.js"),
  );
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
});

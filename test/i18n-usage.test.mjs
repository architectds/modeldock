// Every translation key has to be reachable from the dashboard.
//
// The parity test next door asserts all three locales carry the same key set, so
// a key added in English is translated everywhere. Nothing asserted a key was
// still *used*, so removals left their translations behind: warn.noToken and
// warn.noTokenHint outlived the code that read them by long enough that deleting
// the trial flow looked like it was taking the no-token warning with it. A sweep
// found 22 of 175 keys (12.6%) with no reference at all - eleven of them the
// whole ollama.* block. Dead translations are worse than dead code: they read as
// live UI copy, so the next person has to prove a negative before touching them.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

// public/i18n.js is a browser script, not a module: parse it as text.
function englishKeys() {
  const source = read("public/i18n.js");
  const start = source.indexOf("const I18N_EN = {");
  assert.ok(start >= 0, "I18N_EN is missing from public/i18n.js");
  let depth = 0;
  let end = source.indexOf("{", start);
  for (let i = end; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  return [...source.slice(start, end).matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
}

// Keys the dashboard builds at runtime, so no literal spelling exists to find.
// Each entry is the concatenated prefix plus the values that complete it - the
// values are asserted below, so a new mode cannot quietly widen the allowance.
// app.js: `${t("switch.mode")} - ${t("switch." + mode)}`
const DYNAMIC = [
  { prefix: "switch.", suffixes: ["off", "on"], site: 'app.js: t("switch." + mode)' },
  // The roster header row is built from ROSTER_COLUMNS, so no literal key exists.
  // app.js: t(`roster.context.${entry.contextSource}`)
  { prefix: "roster.context.", suffixes: ["vendor", "measured", "user", "native"], site: "app.js: t(`roster.context.${entry.contextSource}`)" },
  { prefix: "roster.", suffixes: ["model", "provider", "context", "vision", "requests", "tps", "cache"], site: "app.js: t(`roster.${column}`)" },
];

test("every English translation key is referenced by the dashboard", () => {
  const consumers = ["public/app.js", "public/wizard.js", "public/index.html"].map(read).join("\n");
  const allowed = new Set(DYNAMIC.flatMap((d) => d.suffixes.map((s) => d.prefix + s)));

  const unused = englishKeys().filter((key) => {
    if (allowed.has(key)) return false;
    const quoted = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`["'\`]${quoted}["'\`]`).test(consumers);
  });

  assert.deepEqual(
    unused,
    [],
    "these keys have no reference in app.js, wizard.js or index.html - delete them from all three locales, "
    + "or add the runtime-built ones to DYNAMIC above",
  );
});

test("the runtime-built keys still exist and their call sites still build them", () => {
  // The allowance above hides these from the usage sweep, so it has to be proven
  // rather than trusted: the concatenation must still be in the source, and each
  // completed key must still be translated.
  const app = read("public/app.js");
  const keys = new Set(englishKeys());
  for (const { prefix, suffixes, site } of DYNAMIC) {
    assert.ok(
      app.includes(`"${prefix}" +`) || app.includes(`\`${prefix}\${`),
      `${site}: the concatenation is gone, so this allowance now hides dead keys`,
    );
    for (const suffix of suffixes) {
      assert.ok(keys.has(prefix + suffix), `${prefix}${suffix} is built at runtime but no longer translated`);
    }
  }
});

test("the dashboard never asks for a key that is not translated", () => {
  // The other direction: a t("...") whose key was renamed in i18n.js falls back
  // to the raw key string and ships as UI text.
  const consumers = ["public/app.js", "public/wizard.js"].map(read).join("\n");
  const keys = new Set(englishKeys());
  const allowed = new Set(DYNAMIC.map((d) => d.prefix));
  // wizard.js carries its own inline locale tables; only t(...) calls count.
  const requested = [...consumers.matchAll(/\bt\(\s*"([^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(requested)].filter((key) => !keys.has(key) && !allowed.has(key));
  assert.deepEqual(missing, [], "t() asks for keys that public/i18n.js does not define");
});

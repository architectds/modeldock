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
import { execFileSync } from "node:child_process";

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
  // The server sends a warning code and no prose, so the text is looked up by
  // that code. app.js: t(`warn.${warning.code}`)
  {
    prefix: "warn.",
    suffixes: ["context_shift_ineffective", "context_shift_refused", "kv_quant_unsupported", "mtp_ignored"],
    site: "app.js: t(`warn.${warning.code}`)",
  },
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

// The wizard's own inline dictionary gets the same two-way sweep as i18n.js:
// its keys were invisible to every test above (they live in wizard.js, not
// i18n.js), which is how seven dead wizard.* / reco.paid* keys and five
// untranslated ones accumulated unnoticed.
function wizardEnglishKeys() {
  const source = read("public/wizard.js");
  const start = source.indexOf("    en: {");
  assert.ok(start >= 0, "the wizard English table is missing");
  let depth = 0;
  let end = source.indexOf("{", start);
  for (let i = end; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  return { keys: [...source.slice(start, end).matchAll(/^ {6}"([^"]+)":/gm)].map((m) => m[1]), body: source.slice(end) };
}

test("every wizard translation key is referenced by wizard.js", () => {
  const { keys, body } = wizardEnglishKeys();
  const unused = keys.filter((key) => {
    const quoted = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return !new RegExp(`["'\`]${quoted}["'\`]`).test(body);
  });
  assert.deepEqual(unused, [], "these wizard keys have no reference outside the dictionaries - delete them from every locale");
});

test("the wizard never asks for a key its dictionary does not define", () => {
  const source = read("public/wizard.js");
  const keys = new Set(wizardEnglishKeys().keys);
  const requested = [...source.matchAll(/\bL\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(requested.length > 40, "the L() sweep found suspiciously few calls");
  const missing = [...new Set(requested)].filter((key) => !keys.has(key));
  assert.deepEqual(missing, [], "L() asks for keys the wizard English table does not define");
});

test("the browser scripts are syntactically valid JavaScript", () => {
  // These tests read i18n.js as text, so a stray bracket in a translation
  // passed every one of them - a mistyped closing quote in the Japanese block
  // was caught 500 lines into an esbuild plugin error, and would otherwise
  // have shipped a dashboard that renders nothing at all. Parsing is cheap and
  // names the file and line.
  // node's own parser rather than vm.Script: these carry module syntax, and a
  // classic-script parse would reject every one of them for the wrong reason.
  for (const file of ["public/i18n.js", "public/app.js", "public/wizard.js"]) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "pipe" }),
      `${file} does not parse`,
    );
  }
});

test("every data-i18n in the markup resolves to a key", () => {
  // The other tests read t("...") calls out of the scripts, so a label that
  // lives only in markup was invisible to all of them. When the xAI sign-in's
  // ten keys were dropped from every locale, the suite stayed green and the
  // settings panel shipped reading "xai.title" and "xai.signIn" - t() falls
  // back to the key itself and applyStaticI18n writes it straight into
  // textContent, so a missing key is not a blank label, it is the key on
  // screen.
  const markup = read("public/index.html");
  const keys = new Set(englishKeys());
  const asked = [...markup.matchAll(/data-i18n(?:-title)?="([^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(asked)].filter((key) => !keys.has(key));
  assert.deepEqual(missing, [], "public/index.html asks for keys public/i18n.js does not define");
  assert.ok(asked.length > 40, "the sweep found suspiciously few attributes to check");
});

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The Codex App picker filters model_catalog_json entries against a native GPT
// slug allowlist (captured from `codex debug models --bundled`): external slugs
// like "deepseek-v4-flash" never appear in the picker for API-key providers.
// Same mechanism codex-router documents in native-alias.mjs: "Signed-out Codex
// surfaces only display models whose slugs pass a server-delivered allowlist of
// native GPT slugs." To make external models selectable while signed out, the
// catalog republishes them under those native slugs (each carrying the external
// model's own display name, description, and reasoning levels) while a hidden
// canonical entry keeps routing, doctor checks, and saved configs resolving.
// This module owns the slug mapping and its on-disk alias file.

export function nativeAliasesPath(config) {
  return (config && config.nativeAliasesFile)
    || path.join(os.homedir(), ".modeldock", "native-aliases.json");
}

// Pair external models onto the captured native slug slots. Every captured
// native slug admits the allowlist - verified live: picker-hidden native slugs
// (gpt-5.4-mini) pass too, while look-alike shapes (gpt-5.6-fake) do not. The
// auto-review model is a system slot the App manages itself, so it is kept
// free. Slots are ordered by native picker priority so the surfaces the App
// shows first are used first. A missing native capture yields no slots:
// external models then stay on their canonical slugs (today's behavior for CLI
// users, who never needed aliases).
const RESERVED_NATIVE_SLOTS = new Set(["codex-auto-review"]);

export function buildNativeAliasAssignments(nativeModels, externalModels) {
  const slots = (Array.isArray(nativeModels) ? nativeModels : [])
    .filter((model) => (
      typeof model?.slug === "string"
      && !RESERVED_NATIVE_SLOTS.has(model.slug)
    ))
    .sort((left, right) => {
      const priority = Number(left.priority ?? 999) - Number(right.priority ?? 999);
      return priority || String(left.slug).localeCompare(String(right.slug));
    });
  return (Array.isArray(externalModels) ? externalModels : [])
    .slice(0, slots.length)
    .map((model, index) => ({ nativeModel: slots[index], model }));
}

// The alias file is tiny and rewritten whenever the catalog changes, so it is
// read fresh on every lookup (an mtime-keyed cache is not worth the staleness
// risk on Windows coarse timestamps - same lesson codex-router records).
export function readNativeAliases(config) {
  const file = nativeAliasesPath(config);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version !== 1 || !parsed.aliases || typeof parsed.aliases !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.aliases).filter(
        ([nativeSlug, target]) => typeof nativeSlug === "string" && typeof target === "string",
      ),
    );
  } catch {
    return {};
  }
}

export function writeNativeAliases(aliases, config) {
  const file = nativeAliasesPath(config);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, aliases }, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

// Resolve a native-slug alias back to the external model it fronts. The
// gateway consults this before the native leg so aliased slots keep routing
// externally; an unaliased native slug falls through to the native backend.
export function externalModelForAlias(aliasSlug, aliases) {
  if (typeof aliasSlug !== "string" || !aliasSlug) return undefined;
  const target = aliases?.[aliasSlug];
  return typeof target === "string" && target ? target : undefined;
}

// The native slug a published external model occupies, if any. Used by the
// config builder so the picker highlights the active model under its alias.
export function nativeSlugForExternal(externalSlug, aliases) {
  if (typeof externalSlug !== "string" || !externalSlug) return undefined;
  return Object.keys(aliases || {}).find((nativeSlug) => aliases[nativeSlug] === externalSlug);
}

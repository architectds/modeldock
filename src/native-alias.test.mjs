import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildNativeAliasAssignments,
  externalModelForAlias,
  nativeAliasesPath,
  nativeSlugForExternal,
  readNativeAliases,
  writeNativeAliases,
} from "./native-alias.mjs";

const NATIVE = [
  { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1 },
  { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 2 },
  { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 },
  { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list", priority: 7 },
  { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "hide", priority: 23 },
  { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
];

const EXTERNAL = [
  { slug: "deepseek-v4-flash", display_name: "OpenCode Go - DeepSeek V4 Flash", priority: 1 },
  { slug: "glm-5", display_name: "OpenCode Go - GLM 5", priority: 9 },
  { slug: "kimi-k3", display_name: "OpenCode Go - Kimi K3", priority: 18 },
];

test("buildNativeAliasAssignments pairs external models onto native slots in priority order", () => {
  const assignments = buildNativeAliasAssignments(NATIVE, EXTERNAL);
  assert.equal(assignments.length, 3, "only as many aliases as external models");
  assert.equal(assignments[0].nativeModel.slug, "gpt-5.6-sol", "the top native slot goes to the top external model");
  assert.equal(assignments[0].model.slug, "deepseek-v4-flash");
  assert.equal(assignments[1].nativeModel.slug, "gpt-5.6-terra");
  assert.equal(assignments[2].nativeModel.slug, "gpt-5.6-luna");
});

test("buildNativeAliasAssignments never assigns the reserved auto-review slot", () => {
  const many = [
    ...EXTERNAL,
    { slug: "grok-4.5", display_name: "OpenCode Go - Grok 4.5", priority: 13 },
    { slug: "kimi-k2.7-code", display_name: "OpenCode Go - Kimi K2.7 Code", priority: 17 },
    { slug: "mimo-v2.5", display_name: "OpenCode Go - MiniMax M2.5", priority: 19 },
  ];
  const assignments = buildNativeAliasAssignments(NATIVE, many);
  const used = new Set(assignments.map(({ nativeModel }) => nativeModel.slug));
  assert.ok(!used.has("codex-auto-review"), "codex-auto-review stays free");
  assert.equal(assignments.length, 5, "every other captured native slug is a usable slot");
});

test("buildNativeAliasAssignments handles empty inputs", () => {
  assert.deepEqual(buildNativeAliasAssignments([], EXTERNAL), []);
  assert.deepEqual(buildNativeAliasAssignments(NATIVE, []), []);
  assert.deepEqual(buildNativeAliasAssignments(null, EXTERNAL), []);
});

test("alias file round-trips versioned mappings", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-alias-file-"));
  try {
    const config = { nativeAliasesFile: path.join(dir, "native-aliases.json") };
    writeNativeAliases({ "gpt-5.6-sol": "deepseek-v4-flash" }, config);
    assert.deepEqual(readNativeAliases(config), { "gpt-5.6-sol": "deepseek-v4-flash" });
    assert.ok(nativeAliasesPath(config).endsWith("native-aliases.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readNativeAliases tolerates corrupt or missing files", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-alias-corrupt-"));
  try {
    const config = { nativeAliasesFile: path.join(dir, "native-aliases.json") };
    assert.deepEqual(readNativeAliases(config), {});
    writeFileSync(path.join(dir, "native-aliases.json"), "not json", "utf8");
    assert.deepEqual(readNativeAliases(config), {});
    writeFileSync(path.join(dir, "native-aliases.json"), JSON.stringify({ version: 2, aliases: {} }), "utf8");
    assert.deepEqual(readNativeAliases(config), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("externalModelForAlias resolves only string mappings", () => {
  const aliases = { "gpt-5.6-sol": "deepseek-v4-flash" };
  assert.equal(externalModelForAlias("gpt-5.6-sol", aliases), "deepseek-v4-flash");
  assert.equal(externalModelForAlias("gpt-5.6-terra", aliases), undefined);
  assert.equal(externalModelForAlias("", aliases), undefined);
  assert.equal(externalModelForAlias("gpt-5.6-sol", null), undefined);
  assert.equal(externalModelForAlias("gpt-5.6-sol", {}), undefined);
});

test("nativeSlugForExternal finds the slot a canonical slug occupies", () => {
  const aliases = { "gpt-5.6-sol": "deepseek-v4-flash", "gpt-5.6-terra": "glm-5" };
  assert.equal(nativeSlugForExternal("deepseek-v4-flash", aliases), "gpt-5.6-sol");
  assert.equal(nativeSlugForExternal("glm-5", aliases), "gpt-5.6-terra");
  assert.equal(nativeSlugForExternal("kimi-k3", aliases), undefined);
  assert.equal(nativeSlugForExternal("", aliases), undefined);
});

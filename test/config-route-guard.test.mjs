// Guards the false-Off chain: ModelDock used to decide "is Codex routed through
// me" from the sentinel comments alone, so any tool that re-serializes
// config.toml (Codex persisting a picker choice, a dotfiles sync, a script that
// adds models by hand) could leave every managed key in place and still make the
// dashboard read Off - after which enable() restored a stale backup over the
// user's current config, turning a wrong label into a real outage. These cases
// pin the value-based detection, the merge-on-restore semantics, and the
// symlinked config.toml that only breaks on POSIX hosts.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { CodexConfigSwitcher } from "../src/config-switcher.mjs";

const BASE_URL = "http://127.0.0.1:4097/c/0123456789abcdef0123456789abcdef/v1";
const ORIGINAL = `model = "gpt-5.6-sol"\napproval_policy = "on-request"\n\n[features]\nmulti_agent = true\n`;

async function fixture(t) {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "modeldock-route-guard-"));
  t.after(() => rm(codexHome, { recursive: true, force: true }));
  const configPath = path.join(codexHome, "config.toml");
  await writeFile(configPath, ORIGINAL, "utf8");
  const switcher = new CodexConfigSwitcher({ codexHome, baseUrl: BASE_URL, model: () => "gpt-5.6-sol" });
  return { codexHome, configPath, switcher };
}

// What a re-serializing writer produces: every key kept, our two fence comments
// gone. Applied to an already-managed file.
async function stripSentinels(configPath) {
  const managed = await readFile(configPath, "utf8");
  const rewritten = managed
    .split("\n")
    .filter((line) => !/^\s*#\s*(BEGIN|END)\s+modeldock-managed/.test(line))
    .join("\n");
  assert.ok(!/modeldock-managed/.test(rewritten), "the fixture really lost the comments");
  assert.match(rewritten, /openai_base_url/, "but it kept the managed route");
  await writeFile(configPath, rewritten, "utf8");
  return rewritten;
}

test("a rewrite that drops the sentinel comments is still detected as managed", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await stripSentinels(configPath);

  const status = await switcher.status();
  assert.equal(status.enabled, true, "the base URL is the fact, so the dashboard must not read Off");
  assert.equal(status.externallyRestored, false, "nothing was restored behind our back");
});

test("a foreign base URL with no comments is genuinely unmanaged", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await writeFile(configPath, 'model = "gpt-5.6-sol"\nopenai_base_url = "https://api.openai.com/v1"\n', "utf8");

  const status = await switcher.status();
  assert.equal(status.enabled, false, "someone else owns the route now");
  assert.equal(status.externallyRestored, true, "and the user is told so instead of it being silently rewritten");
});

test("disable() after a comment-dropping rewrite merges rather than restoring a stale backup", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await stripSentinels(configPath);
  // Codex adds its own key in the same rewrite. A wholesale restore of the
  // pre-ModelDock backup would silently delete it.
  await writeFile(configPath, `${await readFile(configPath, "utf8")}notify = true\n`, "utf8");

  await switcher.disable();
  const after = await readFile(configPath, "utf8");
  assert.match(after, /^notify = true$/m, "the key Codex added survives the switch off");
  assert.ok(!after.includes(BASE_URL), "the managed route is still fully removed");
  assert.doesNotMatch(after, /openai_base_url/, "no base URL is left pointing at a dead gateway");
});

test("a config truncated mid-write is not rescued by value detection and still restores exactly", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  const managed = await readFile(configPath, "utf8");
  // Cut where a half-written file would realistically stop: the base URL is
  // complete, and nothing after it made it to disk. The route value alone would
  // call that managed; it is garbage, and the restore guarantee below is what
  // protects a user from a truncated write.
  const lines = managed.split("\n");
  const cut = lines.findIndex((line) => /^\s*experimental_realtime_/.test(line));
  assert.ok(cut > 0, "the managed block writes the realtime endpoints after the base URL");
  const truncated = `${lines.slice(0, cut).join("\n")}\n`;
  assert.match(truncated, new RegExp(`openai_base_url = "${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), "the fixture keeps a complete base URL");
  assert.doesNotMatch(truncated, /experimental_realtime_ws_base_url/, "and loses the rest of the block");
  await writeFile(configPath, truncated, "utf8");

  assert.equal((await switcher.status()).enabled, false, "a truncated file is not mistaken for an intact route");
  await switcher.disable();
  assert.equal(await readFile(configPath, "utf8"), ORIGINAL, "off restores the original after a corrupt write");
});

test("enable() leaves an intact-but-unfenced route alone instead of rewriting over the user", async (t) => {
  const { configPath, switcher } = await fixture(t);
  await switcher.enable();
  await stripSentinels(configPath);
  await writeFile(configPath, `${await readFile(configPath, "utf8")}notify = true\n`, "utf8");

  const status = await switcher.enable();
  assert.equal(status.enabled, true);
  const after = await readFile(configPath, "utf8");
  // The fence is cosmetic, so a healthy route is not rewritten just to get it
  // back: that is the write that used to cost people their config.
  assert.doesNotMatch(after, /# BEGIN modeldock-managed/, "enable() did not churn a working file");
  const occurrences = (after.match(/^\s*openai_base_url\s*=/gm) || []).length;
  assert.equal(occurrences, 1, "the route is never duplicated into an unstartable config");
  assert.match(after, /^notify = true$/m, "the key Codex added is still there");

  // A real rewrite does restore the fence, so comment-based readers recover.
  await switcher.disable();
  await switcher.enable();
  assert.match(await readFile(configPath, "utf8"), /# BEGIN modeldock-managed/, "the fence comes back on the next write");
});

test("a symlinked config.toml keeps pointing at its target after a managed write", async (t) => {
  // The Mac-only half of the bug: rename() replaces the final component instead
  // of following it, so writing through a dotfiles link turned config.toml into
  // a regular file and let the next sync restore the pre-ModelDock content.
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-symlink-home-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realDir = path.join(root, "dotfiles", "codex");
  await mkdir(realDir, { recursive: true });
  const realFile = path.join(realDir, "config.toml");
  await writeFile(realFile, ORIGINAL, "utf8");
  const codexHome = path.join(root, "home");
  await mkdir(codexHome, { recursive: true });
  const linkedFile = path.join(codexHome, "config.toml");
  try {
    await symlink(realFile, linkedFile);
  } catch (error) {
    t.skip(`symlinks are unavailable here: ${error.code || error.message}`);
    return;
  }

  const switcher = new CodexConfigSwitcher({ codexHome, baseUrl: BASE_URL, model: () => "gpt-5.6-sol" });
  await switcher.enable();

  assert.equal((await lstat(linkedFile)).isSymbolicLink(), true, "the link is not replaced by a regular file");
  const written = await readFile(realFile, "utf8");
  assert.match(written, /# BEGIN modeldock-managed/, "the target file carries the managed route");
  assert.match(written, new RegExp(`openai_base_url = "${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
});

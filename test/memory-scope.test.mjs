import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  bindMemoryScope,
  callerKeyFromGatewayUrl,
  canonicalMemoryScope,
  memoryScopeHeaders,
  sameMemoryScope,
  verifiedMemoryScope,
  withoutMemoryMutations,
} from "../src/memory-scope.mjs";

const CALLER_KEY = "test-caller-key-0123456789-abcdef";

test("memory scope proof authenticates one canonical absolute directory", () => {
  const scope = canonicalMemoryScope(process.cwd());
  const headers = memoryScopeHeaders(scope, CALLER_KEY);
  assert.equal(verifiedMemoryScope(headers, CALLER_KEY), scope);
  assert.equal(verifiedMemoryScope(headers, `${CALLER_KEY}-wrong`), "");
  assert.equal(callerKeyFromGatewayUrl(`http://127.0.0.1:4097/c/${CALLER_KEY}`), CALLER_KEY);
});

test("memory scopes canonicalize aliases and Windows path case", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-memory-scope-"));
  const target = path.join(root, "Project");
  const alias = path.join(root, "project-link");
  mkdirSync(target);
  try {
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    assert.equal(canonicalMemoryScope(alias), canonicalMemoryScope(target));
    if (process.platform === "win32") {
      assert.equal(sameMemoryScope(target.toUpperCase(), target.toLowerCase()), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bound memory mutations always use their trusted project scope", async () => {
  const calls = [];
  const project = canonicalMemoryScope(process.cwd());
  const other = path.resolve(process.cwd(), "..", "another-project");
  const bound = bindMemoryScope({
    recallMemory: async (args) => (calls.push(["recall", args]), args),
    storeMemory: async (args) => (calls.push(["store", args]), args),
    learnMemory: async (args) => (calls.push(["learn", args]), args),
  }, project);

  await bound.storeMemory({ content: "fact" });
  await bound.learnMemory({ path: path.join(project, "notes.md") });
  await bound.recallMemory({ query: "fact" });
  await bound.recallMemory({ query: "other", scope_dir: other });

  assert.equal(calls[0][1].scope_dir, project);
  assert.equal(calls[1][1].scope_dir, project);
  assert.equal(calls[2][1].scope_dir, project);
  assert.equal(calls[3][1].scope_dir, other, "read-only recall may name another project");
  assert.throws(
    () => bound.storeMemory({ content: "poison", scope_dir: other }),
    /cannot target a scope outside the current project/,
  );
  assert.throws(
    () => bound.learnMemory({ path: path.join(project, "notes.md"), scope_dir: other }),
    /cannot target a scope outside the current project/,
  );
});

test("strict memory scope cannot be overridden for reads or writes", async () => {
  const project = canonicalMemoryScope(process.cwd());
  const other = path.resolve(process.cwd(), "..", "another-project");
  const bound = bindMemoryScope({
    recallMemory: async (args) => args,
    storeMemory: async (args) => args,
  }, project, { strictRecall: true });

  assert.deepEqual(await bound.recallMemory({ query: "fact" }), {
    query: "fact",
    scope_dir: project,
    scope_only: true,
  });
  assert.throws(
    () => bound.recallMemory({ query: "fact", scope_dir: other }),
    /cannot target a scope outside the configured project/,
  );
  assert.throws(
    () => bound.storeMemory({ content: "fact", scope_dir: other }),
    /cannot target a scope outside the current project/,
  );
});

test("unscoped gateway surface removes every memory mutation", () => {
  const readOnly = withoutMemoryMutations({
    recallMemory() {},
    storeMemory() {},
    learnMemory() {},
  });
  assert.equal(typeof readOnly.recallMemory, "function");
  assert.equal(readOnly.storeMemory, undefined);
  assert.equal(readOnly.learnMemory, undefined);
});

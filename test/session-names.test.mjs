import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionNames, sessionInfoFromFile } from "../src/session-names.mjs";

const REAL_ID = "019fdd19-4321-7490-ab24-d6f657c9e532";
const TREE = "2026/08/16";

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "modeldock-sessions-"));
  const file = path.join(dir, TREE, `rollout-2026-08-16T10-00-00-${REAL_ID}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { session_id: REAL_ID, cwd: "D:\\projects\\modeldock", originator: "Codex Desktop" },
  });
  const turn = JSON.stringify({
    type: "turn_context",
    payload: {
      messages: [
        { role: "system", content: [{ type: "text", text: "You are Codex." }] },
        { role: "user", content: [{ type: "text", text: "\u719F\u6089\u4E00\u4E0B\u8FD9\u4E2A\u4EE3\u7801\u5E93" }] },
      ],
    },
  });
  writeFileSync(file, `${meta}\n${turn}\n`, "utf8");
  return { dir, file };
}

test("sessionInfoFromFile reads the project cwd from the head", () => {
  const { dir, file } = fixture();
  try {
    const info = sessionInfoFromFile(file);
    assert.equal(info.cwd, "D:\\projects\\modeldock");
    assert.equal(info.label, "modeldock");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rollout with no readable session_meta falls back to null", () => {
  const { dir, file } = fixture();
  try {
    writeFileSync(file, `${JSON.stringify({ type: "turn_context", payload: {} })}\n`, "utf8");
    const info = sessionInfoFromFile(file);
    assert.equal(info.label, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionNames resolves indexed sessions and rejects one-shot ids", () => {
  const { dir } = fixture();
  try {
    const names = new SessionNames({ sessionsRoot: dir, dateDir: () => TREE });
    assert.equal(names.labelFor(REAL_ID).label, "modeldock");
    // Same id again comes from the cache and is identical.
    assert.equal(names.labelFor(REAL_ID), names.labelFor(REAL_ID));
    assert.equal(names.labelFor("01a00973-b5f8-71e2-b282-ed8155de561e"), null);
    assert.equal(names.labelFor(""), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionNames picks up a session created after the index", () => {
  const { dir } = fixture();
  try {
    const names = new SessionNames({ sessionsRoot: dir, dateDir: () => TREE });
    assert.equal(names.labelFor(REAL_ID).label, "modeldock");
    const freshId = "01a01000-0000-4000-8000-000000000000";
    const fresh = path.join(dir, TREE, `rollout-2026-08-16T11-00-00-${freshId}.jsonl`);
    writeFileSync(fresh, `${JSON.stringify({ type: "session_meta", payload: { cwd: "C:\\tmp\\fresh" } })}\n`, "utf8");
    assert.equal(names.labelFor(freshId).label, "fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

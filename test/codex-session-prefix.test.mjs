import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { latestCodexSessionOpening } from "../src/codex-session-prefix.mjs";

function line(type, payload) {
  return `${JSON.stringify({ type, payload })}\n`;
}

test("managed setup reads the newest complete Codex opening without retaining its first user message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-session-prefix-"));
  try {
    const oldFile = path.join(root, "old.jsonl");
    const current = path.join(root, "2026", "08", "current.jsonl");
    await mkdir(path.dirname(current), { recursive: true });
    await writeFile(oldFile, line("session_meta", { base_instructions: { text: "old" }, dynamic_tools: [{ type: "function", name: "old" }] }), "utf8");
    await writeFile(current, [
      line("session_meta", {
        session_id: "session-current",
        base_instructions: { text: "GLOBAL BASE" },
        dynamic_tools: [{ type: "namespace", name: "codex_app", tools: [{ type: "function", name: "exec_command" }] }],
      }),
      line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "WORKSPACE RULE" }] }),
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE USER REQUEST" }] }),
      line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "TOO LATE" }] }),
    ].join(""), "utf8");
    await utimes(oldFile, new Date(1), new Date(1));
    const opening = await latestCodexSessionOpening({ sessionsRoot: root });
    assert.equal(opening.sessionId, "session-current");
    assert.equal(opening.instructions, "GLOBAL BASE");
    assert.equal(opening.tools.length, 1);
    assert.equal(opening.developerMessages.length, 1);
    assert.equal(opening.developerMessages[0].content[0].text, "WORKSPACE RULE");
    assert.equal(JSON.stringify(opening).includes("PRIVATE USER REQUEST"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

function envelope(sessionId, label) {
  return [
    line("session_meta", {
      session_id: sessionId,
      base_instructions: { text: `BASE ${label}` },
      dynamic_tools: [{ type: "function", name: `tool_${label}` }],
    }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `REQUEST ${label}` }] }),
  ].join("");
}

// Codex names each rollout after the session that wrote it, so a preferred
// conversation is found by name even when other tasks have been touched since.
async function sessionsFixture(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "modeldock-session-preference-"));
  const created = [];
  // Sample the clock once. The ages below are spaced by single milliseconds, so
  // taking `Date.now()` per file let the fixture's own write cost (a millisecond
  // per file under load) outweigh the intended spacing and reorder the mtimes -
  // which made "the newest rollout" mean whichever file the machine wrote last.
  const now = Date.now();
  for (const [name, text, ageMs] of files) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, "utf8");
    const when = new Date(now - ageMs);
    await utimes(file, when, when);
    created.push(file);
  }
  return { root, created };
}

test("a conversation that used the local host beats the newest unrelated task", async () => {
  // A resumed thread is written to a fresh log, so the preferred id can only be
  // found inside `session_meta`: matching file names alone would miss it.
  const { root } = await sessionsFixture([
    [path.join("2026", "09", "rollout-local.jsonl"), envelope("01a0local", "LOCAL"), 60_000],
    [path.join("2026", "09", "rollout-newer.jsonl"), envelope("01a0other", "NEWER"), 1_000],
  ]);
  try {
    const opening = await latestCodexSessionOpening({ sessionsRoot: root, preferredSessionIds: ["01a0local"] });
    assert.equal(opening.instructions, "BASE LOCAL", "the base is primed for the conversation that will ask for it");
    assert.equal(opening.sessionId, "01a0local");
    // Without a preference the newest file still wins, exactly as before.
    assert.equal((await latestCodexSessionOpening({ sessionsRoot: root })).instructions, "BASE NEWER");
    // An id that is not on disk falls back to the same newest-first rule.
    assert.equal((await latestCodexSessionOpening({ sessionsRoot: root, preferredSessionIds: ["gone"] })).instructions, "BASE NEWER");
    assert.equal((await latestCodexSessionOpening({ sessionsRoot: root, preferredSessionIds: [] })).instructions, "BASE NEWER");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex-named local rollout is still chosen after newer tasks filled the window", async () => {
  // Codex names each rollout after the session that wrote it. The name filter is
  // what keeps a week-old local conversation reachable once the newest-candidate
  // window is full of unrelated tasks.
  const busy = Array.from({ length: 40 }, (unused, index) => [
    path.join("2026", "09", `rollout-2026-09-17T00-00-${String(index).padStart(2, "0")}-01a0busy${index}.jsonl`),
    envelope(`01a0busy${index}`, `BUSY${index}`),
    index + 1,
  ]);
  const { root } = await sessionsFixture([
    ...busy,
    [path.join("2026", "09", "rollout-2026-09-12T20-42-32-01a09347.jsonl"), envelope("01a09347", "LOCAL"), 40_000],
  ]);
  try {
    const opening = await latestCodexSessionOpening({ sessionsRoot: root, preferredSessionIds: ["01a09347"] });
    assert.equal(opening.instructions, "BASE LOCAL");
    assert.equal((await latestCodexSessionOpening({ sessionsRoot: root })).instructions, "BASE BUSY0",
      "the plain newest-first rule is untouched when nothing is preferred");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable preferred rollout falls back instead of failing the prime", async () => {
  const { root } = await sessionsFixture([
    [path.join("2026", "09", "rollout-local.jsonl"), "not json at all\n", 60_000],
    [path.join("2026", "09", "rollout-newer.jsonl"), envelope("01a0other", "NEWER"), 1_000],
  ]);
  try {
    const opening = await latestCodexSessionOpening({ sessionsRoot: root, preferredSessionIds: ["01a0local"] });
    assert.equal(opening.instructions, "BASE NEWER", "a corrupt log is skipped, not fatal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

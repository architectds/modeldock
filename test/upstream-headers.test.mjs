import assert from "node:assert/strict";
import test from "node:test";
import { conversationIdFrom, sessionIdsFrom, upstreamHeaders } from "../src/upstream-headers.mjs";

test("Go uses the same session identity for all header aliases and header containers", () => {
  for (const name of ["session_id", "session-id", "x-codex-session-id", "x-codex-thread-id", "thread-id", "thread_id", "x-opencode-session"]) {
    for (const incomingHeaders of [{ [name]: " task-a " }, new Headers({ [name]: "task-a" })]) {
      assert.equal(upstreamHeaders({ provider: "opencode-go", token: "fixture" }, { incomingHeaders })["x-opencode-session"], "task-a");
    }
  }
  assert.deepEqual(sessionIdsFrom({ session_id: [" task-a ", "ignored"], "x-codex-parent-thread-id": "parent" }), { sessionId: "task-a", threadId: "parent" });
});

test("MCP uses per-call thread metadata, never its connection or parent identity", () => {
  assert.equal(conversationIdFrom(undefined, { threadId: "task-a" }), "task-a");
  assert.equal(conversationIdFrom({ "session_id": "child", "x-codex-parent-thread-id": "parent" }, { threadId: "child" }), "child");
  assert.equal(conversationIdFrom({ "x-codex-parent-thread-id": "parent", "mcp-session-id": "connection" }), "");
  assert.equal(conversationIdFrom(undefined, { threadId: {} }), "");
});

test("Go headers do not share mutable state between tasks or invent missing identity", () => {
  const target = { provider: "opencode-go", token: "fixture" };
  const make = (sessionId) => upstreamHeaders(target, { sessionId });
  assert.equal(make("task-a")["x-opencode-session"], "task-a");
  assert.equal(make("task-b")["x-opencode-session"], "task-b");
  assert.equal(make("task-a")["x-opencode-session"], "task-a");
  assert.equal(make("")["x-opencode-session"], undefined);
  for (const provider of ["openai", "deepseek-official", "commandcode", "llamacpp", "xai", "custom"]) {
    assert.equal(upstreamHeaders({ provider, token: "fixture" }, { sessionId: "task-a" })["x-opencode-session"], undefined);
  }
});

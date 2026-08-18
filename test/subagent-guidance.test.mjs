import assert from "node:assert/strict";
import test from "node:test";
import { promoteCollaborationNewTask, SUBAGENT_SPAWN_RULE } from "../src/subagent-guidance.mjs";

test("SUBAGENT_SPAWN_RULE names the real v2 args and forbids analysis-only none-forks", () => {
  assert.match(SUBAGENT_SPAWN_RULE, /spawn_agent's `message`/);
  assert.match(SUBAGENT_SPAWN_RULE, /followup_task/);
  assert.match(SUBAGENT_SPAWN_RULE, /omit fork_turns or use "all"/i);
  assert.doesNotMatch(SUBAGENT_SPAWN_RULE, /spawn_agent's prompt/);
});

test("promoteCollaborationNewTask copies analysis-channel NEW_TASK into a user message", () => {
  const payload = "\u64A4\u9500 A1\uFF1A\u5220\u6389\u6CE8\u5165\u7684 TUI \u76EE\u5F55\u3002\u5DE5\u4F5C\u76EE\u5F55 /Users/me/projects/zcode-mobile\u3002";
  const input = [
    {
      type: "reasoning",
      content: [{
        type: "reasoning_text",
        text: `Message Type: NEW_TASK\nTask name: /root/revert_zcode_system\nSender: /root\nPayload:\n${payload}`,
      }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<recommended_plugins>\nAirtable\n" }],
    },
  ];
  const out = promoteCollaborationNewTask(input);
  const users = out.filter((item) => item.type === "message" && item.role === "user");
  assert.equal(users.at(-1).content[0].text, payload, "the child model sees the spawn message as user text");
});

test("promoteCollaborationNewTask is a no-op when the user turn already has the task", () => {
  const payload = "verify bun install date; do not delete anything";
  const input = [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: payload }],
    },
  ];
  assert.equal(promoteCollaborationNewTask(input), input);
});

// Live Codex 0.148 spawn: the NEW_TASK header is plaintext, the spawn
// `message` is a sibling encrypted_content part. Native GPT decrypts that
// channel; DeepSeek only reads part.text, so the promoter used to no-op.
test("promoteCollaborationNewTask joins a split NEW_TASK header and encrypted payload", () => {
  const payload = "Write the exact token VERIFIED-SUBAGENT-TASK-9de2 into RESULT.txt";
  const input = [
    {
      type: "agent_message",
      author: "/root",
      recipient: "/root/verify_subagent_delivery",
      content: [
        {
          type: "input_text",
          text: "Message Type: NEW_TASK\nTask name: /root/verify_subagent_delivery\nSender: /root\nPayload:\n",
        },
        { type: "encrypted_content", encrypted_content: payload },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<recommended_plugins>\nAirtable\n" }],
    },
  ];
  const out = promoteCollaborationNewTask(input);
  const users = out.filter((item) => item.type === "message" && item.role === "user");
  assert.equal(users.at(-1).content[0].text, payload);
});

test("promoteCollaborationNewTask does not treat opaque Fernet blobs as a task", () => {
  const input = [
    {
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAABopaque_native_cipher_token" },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<recommended_plugins>\nAirtable\n" }],
    },
  ];
  assert.equal(promoteCollaborationNewTask(input), input);
});

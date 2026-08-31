import assert from "node:assert/strict";
import test from "node:test";
import { agentMessageToUserMessage, promoteCollaborationNewTask, SUBAGENT_SPAWN_RULE, hasOpaqueCollaboration } from "../src/subagent-guidance.mjs";

test("agentMessageToUserMessage drops opaque-only agent_message items", () => {
  assert.equal(agentMessageToUserMessage({
    type: "agent_message",
    content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAABopaque_native_cipher_token" },
    ],
  }), null);
});

test("SUBAGENT_SPAWN_RULE uses the managed role without an incompatible full-history fork", () => {
  assert.match(SUBAGENT_SPAWN_RULE, /agent_type="modeldock_subagent"/);
  assert.match(SUBAGENT_SPAWN_RULE, /other named agent_type only when the user explicitly requests/i);
  assert.match(SUBAGENT_SPAWN_RULE, /spawn_agent's `message`/);
  assert.match(SUBAGENT_SPAWN_RULE, /followup_task/);
  assert.match(SUBAGENT_SPAWN_RULE, /positive recent-turn count/i);
  assert.match(SUBAGENT_SPAWN_RULE, /never omit fork_turns or use "all" with a named role/i);
  assert.match(SUBAGENT_SPAWN_RULE, /full-history forks inherit the parent role and model/i);
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

// Observed Codex 0.148 spawn item fragment: the NEW_TASK header is plaintext, the spawn
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

test("hasOpaqueCollaboration finds Fernet-shaped NEW_TASK payloads", () => {
  const found = hasOpaqueCollaboration([
    { type: "agent_message", content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/x\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAAopaque_blob_9de2" },
    ]},
  ]);
  assert.ok(found, "an opaque collaboration payload is detected");
  assert.equal(found.encrypted, "gAAAAAopaque_blob_9de2");
  assert.equal(found.part.type, "encrypted_content");
});

test("hasOpaqueCollaboration ignores plaintext and non-collaboration items", () => {
  assert.equal(
    hasOpaqueCollaboration([
      { type: "agent_message", content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "plaintext-ish-not-fernet" },
      ]},
    ]),
    null,
    "plaintext encrypted_content is not an opaque relay target",
  );
  assert.equal(
    hasOpaqueCollaboration([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]),
    null,
    "ordinary messages are ignored",
  );
  assert.ok(
    hasOpaqueCollaboration([
      { type: "agent_message", content: [
        { type: "input_text", text: "Message Type: MESSAGE\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "gAAAAAnot_a_task" },
      ]},
    ]),
    "every collaboration message type is a relay candidate, not just NEW_TASK",
  );
});

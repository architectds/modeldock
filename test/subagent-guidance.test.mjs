import assert from "node:assert/strict";
import test from "node:test";
import { collaborationEnvelopeTurn, SUBAGENT_SPAWN_RULE, hasOpaqueCollaboration } from "../src/subagent-guidance.mjs";

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

// The collaboration envelope is the only delivery the gateway renders: an
// agent_message item becomes a labeled user turn where it already sits, carrying
// whatever is readable in it. Nothing is recovered from prose and appended - the
// promoter that did that is deleted, and "a quoted header is not a delivery" below is
// the regression that keeps it gone.
test("collaborationEnvelopeTurn renders an envelope as a labeled user turn in place", () => {
  const payload = "Write the exact token VERIFIED-SUBAGENT-TASK-9de2 into RESULT.txt";
  const item = {
    type: "agent_message",
    id: "amsg_01a0a1ff-36b4",
    author: "/root",
    recipient: "/root/verify_subagent_delivery",
    content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/verify_subagent_delivery\nSender: /root\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: payload },
    ],
    internal_chat_message_metadata_passthrough: { turn_id: "01a0a1ff-3465" },
  };
  const turn = collaborationEnvelopeTurn(item);
  assert.equal(turn.type, "message");
  assert.equal(turn.role, "user");
  assert.equal(turn.id, item.id, "the item id is kept so a replayed history stays byte-identical");
  assert.deepEqual(turn.internal_chat_message_metadata_passthrough, { turn_id: "01a0a1ff-3465" }, "and so is the owning turn");
  assert.ok(turn.content[0].text.startsWith("[agent_message from /root to /root/verify_subagent_delivery]\n"), "the senders stay named");
  assert.ok(turn.content[0].text.includes(payload), "the plaintext sibling reaches the model");
  assert.equal(turn.author, undefined, "author and recipient become text, not fields a provider must ignore");
  assert.equal(turn.recipient, undefined);
});

test("collaborationEnvelopeTurn names the senders even when Codex omits them", () => {
  const turn = collaborationEnvelopeTurn({
    type: "agent_message",
    content: [{ type: "input_text", text: "Message Type: MESSAGE\nPayload:\nstill working" }],
  });
  assert.ok(turn.content[0].text.startsWith("[agent_message from unknown agent to unknown agent]\n"));
  assert.ok(turn.content[0].text.includes("still working"));
});

test("a collaboration header quoted in prose is not a delivery", () => {
  // The deleted promoter mined exactly these items and handed the text back as the
  // newest user message. Model-authored rows are never envelopes.
  const quoted = "Message Type: NEW_TASK\nPayload:\nAudit the duplicate pipelines.";
  assert.equal(collaborationEnvelopeTurn({ type: "message", role: "assistant", content: [{ type: "output_text", text: quoted }] }), null);
  assert.equal(collaborationEnvelopeTurn({ type: "reasoning", content: [{ type: "reasoning_text", text: quoted }] }), null);
  assert.equal(collaborationEnvelopeTurn({ type: "message", role: "user", content: [{ type: "input_text", text: quoted }] }), null);
  assert.equal(collaborationEnvelopeTurn({ type: "function_call", name: "f", arguments: quoted }), null);
});

test("collaborationEnvelopeTurn renders what is readable and never guesses a body", () => {
  const headerOnly = collaborationEnvelopeTurn({
    type: "agent_message",
    author: "/root",
    recipient: "/root/x",
    content: [
      { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
      { type: "encrypted_content", encrypted_content: "gAAAAABopaque_native_cipher_token" },
    ],
  });
  assert.ok(headerOnly, "the arrival of a wake is still visible to the model");
  assert.ok(!headerOnly.content[0].text.includes("gAAAAAB"), "the opaque token is never relayed as if it were the body");
  assert.equal(
    collaborationEnvelopeTurn({
      type: "agent_message",
      author: "/root",
      recipient: "/root/x",
      content: [{ type: "encrypted_content", encrypted_content: "gAAAAQopaque_cipher_token_shape" }],
    }),
    null,
    "an envelope with nothing readable in it renders nothing",
  );
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

// Codex v2 spawn_agent is a local collaboration tool. The task argument is
// `message`. A named custom role is also a model/role override: Codex 0.149
// rejects it with fork_turns="all" because a full-history child must inherit
// the parent's role and model. A positive fork count carries recent context
// without that inheritance; an isolated none-fork is reserved for a complete,
// self-contained message. The promotion helpers below make collaboration task
// payloads visible to routed text models after the child reaches the gateway.
//
// One string, used by the catalog and by image placeholders.

export const SUBAGENT_SPAWN_RULE =
  "For ordinary delegation, set agent_type=\"modeldock_subagent\" whenever that managed role is available; if it is unavailable, omit agent_type so Codex inherits its default. With a named role, set fork_turns to a positive recent-turn count sized to the task (normally \"3\"); use fork_turns=\"none\" only when the message is fully self-contained. Never omit fork_turns or use \"all\" with a named role: full-history forks inherit the parent role and model, so Codex rejects the override. Use any other named agent_type only when the user explicitly requests that role. Put the complete task in spawn_agent's `message` (not prompt). To give more work to an existing child, call followup_task -- send_message only reaches a still-running worker and returns empty once it has finished.";

export function historicalImageSpawnHint(ref) {
  return `[Image attachment ${ref}: if visual evidence is needed, call vision_inspect(image_ref="${ref}", question="your specific visual question") before making visual claims. Pixels are preserved by reference, not embedded in this text history.]`;
}

const NEW_TASK_RE = /Message Type:\s*NEW_TASK\b[\s\S]*?Payload:\s*\n?([\s\S]+)/i;

// Same Fernet-shaped gate as gateway.mjs: whitespace-free gAAAA... tokens stay
// opaque. Codex's collaboration channel puts the spawn `message` in a sibling
// encrypted_content part that is actually plaintext.
function isOpaqueEncryptedContent(value) {
  return typeof value === "string" && /^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(value);
}

function newTaskPayloadFromText(text) {
  const match = String(text || "").match(NEW_TASK_RE);
  return match ? match[1].trim() : "";
}

function partPlainText(part) {
  if (typeof part?.text === "string" && part.text) return part.text;
  const blob = part?.encrypted_content;
  if (typeof blob === "string" && blob && !isOpaqueEncryptedContent(blob)) return blob;
  return "";
}

function itemPlainText(item) {
  if (!item || typeof item !== "object") return "";
  const bits = [];
  const collect = (parts) => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      const text = partPlainText(part);
      if (text) bits.push(text);
    }
  };
  collect(item.content);
  collect(item.summary);
  if (typeof item.text === "string") bits.push(item.text);
  const own = item.encrypted_content;
  if (typeof own === "string" && own && !isOpaqueEncryptedContent(own)) bits.push(own);
  return bits.join("\n");
}

function isPluginWrapperUser(item) {
  if (item?.type !== "message" || item?.role !== "user") return false;
  const text = itemPlainText(item);
  return text.includes("<recommended_plugins>") || text.includes("<app-context>");
}

// A delegated collaboration payload whose body sits in a genuinely opaque
// (Fernet-shaped) part. Only the native backend can open it; the gateway
// relays it through a native model to recover the plaintext before promotion.
export function hasOpaqueCollaboration(input) {
  if (!Array.isArray(input)) return null;
  for (const item of input) {
    if (!Array.isArray(item?.content)) continue;
    const visible = item.content
      .filter((part) => ["input_text", "text"].includes(part?.type) && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    if (!/Message Type:\s*(?:NEW_TASK|MESSAGE|FOLLOWUP_TASK|FINAL_ANSWER)\b[\s\S]*\nPayload:\s*$/i.test(visible)) continue;
    for (const part of item.content) {
      if (part?.type === "encrypted_content" && typeof part.encrypted_content === "string" && isOpaqueEncryptedContent(part.encrypted_content)) {
        return { item, part, encrypted: part.encrypted_content };
      }
    }
  }
  return null;
}

// Kimi and other routed providers reject Codex's agent_message item type.
// Convert readable collaboration-channel content into a plain user message.
export function agentMessageToUserMessage(item) {
  if (item?.type !== "agent_message") return item;
  const text = itemPlainText(item);
  const payload = newTaskPayloadFromText(text);
  if (payload) {
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: payload }],
    };
  }
  if (/Message Type:\s*NEW_TASK\b/i.test(text)) return null;
  if (!text.trim()) return null;
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

export function promoteCollaborationNewTask(input) {
  if (!Array.isArray(input)) return input;
  let payload = "";
  for (const item of input) {
    const found = newTaskPayloadFromText(itemPlainText(item));
    if (found) payload = found;
  }
  if (!payload) return input;
  const already = input.some((item) => (
    item?.type === "message"
    && item?.role === "user"
    && !isPluginWrapperUser(item)
    && itemPlainText(item).includes(payload.slice(0, Math.min(80, payload.length)))
  ));
  if (already) return input;
  return [
    ...input,
    { type: "message", role: "user", content: [{ type: "input_text", text: payload }] },
  ];
}

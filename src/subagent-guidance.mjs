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

// Same Fernet-shaped gate as gateway.mjs: whitespace-free gAAAA... tokens stay
// opaque. Codex's collaboration channel puts the spawn `message` in a sibling
// encrypted_content part that is actually plaintext.
export function isOpaqueEncryptedContent(value) {
  return typeof value === "string" && /^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(value);
}

// The one readable-text rule for a Responses content part: a real text part, or
// a collaboration body that Codex left in a plaintext `encrypted_content` sibling.
// Anything genuinely opaque yields "" so callers can tell "nothing readable" from
// "readable but unusual" instead of guessing per call site.
export function partPlainText(part) {
  if (typeof part?.text === "string" && part.text) return part.text;
  const blob = part?.encrypted_content;
  if (typeof blob === "string" && blob && !isOpaqueEncryptedContent(blob)) return blob;
  return "";
}

export function itemPlainText(item) {
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

// A Codex collaboration envelope (`agent_message`) is an item type no provider
// dialect has, so it joins the transcript as a labeled user turn carrying whatever
// is readable in it. Author and recipient stay named; a body that stayed opaque
// after the relay gate already had its chance drops out instead of being guessed.
//
// This is the only place those words are assembled: the input contract renders every
// route from it, and the Chat bridge renders the callers that hand it items directly.
// The two must never disagree about how one envelope reads.
//
// There used to be a second, much wider mechanism here: a promoter that scanned every
// item for text shaped like `Message Type: NEW_TASK ... Payload:` and appended the
// captured text as a *trailing* user turn. It was invented for children whose task
// arrived only inside an unreadable item, and it worked, but nothing constrained where
// the text came from. Any model that quoted such a header - in an answer, or in a
// reasoning summary, which is exactly what auditing this repository produces - had its
// own prose re-delivered as the newest user message, after the real instruction. The
// loop fed itself: each turn that reported the echo wrote more text matching the
// pattern. Recovering a task from prose is not a gateway job, so the promoter is
// deleted rather than gated; the envelope below is the whole contract.
export function collaborationEnvelopeTurn(item) {
  if (item?.type !== "agent_message") return null;
  const body = itemPlainText(item);
  if (!body.trim()) return null;
  const author = typeof item.author === "string" && item.author ? item.author : "unknown agent";
  const recipient = typeof item.recipient === "string" && item.recipient ? item.recipient : "unknown agent";
  const { author: _author, recipient: _recipient, content: _content, ...rest } = item;
  return {
    ...rest,
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `[agent_message from ${author} to ${recipient}]\n${body}` }],
  };
}

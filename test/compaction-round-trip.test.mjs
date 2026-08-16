// The return leg: what the CPU extract becomes once Codex sends it back.
//
// The compact path now answers a local backend directly - no summarize model -
// so the bytes Codex stores are the extract itself, base64'd into a kcr1:
// compaction item. Two halves were already covered: relayCompaction produces
// that item, and normalizeGatewayInput expands a compaction item. Nothing
// covered them joined, and the expansion test used a hand-written
// encodeCompactionSummary("earlier context") fixture rather than a real extract.
//
// That gap matters here because the extract is not prose: it is multi-line, it
// carries USER:/TOOL_CALL:/TOOLS_AGGREGATED: prefixes, it can run tens of
// thousands of characters, and it may hold any UTF-8 the conversation did. If
// any of that fails to survive the round trip, Codex resumes from a corrupted
// or empty history - and the failure appears one turn later, in a session that
// looks fine until the model has forgotten the task.
import test from "node:test";
import assert from "node:assert/strict";
import { compressConversation } from "../src/compress.mjs";
import { capDirectSummary, encodeCompactionSummary, decodeCompactionSummary, normalizeGatewayInput } from "../src/gateway.mjs";

const msg = (role, text) => ({ type: "message", role, content: [{ type: "input_text", text }] });

// A history with every item class the extract touches, plus content chosen to
// break a naive encoder: CJK, emoji, quotes, backslashes, newlines.
function history() {
  const items = [
    msg("user", 'Fix the restart: it dies on paths like "D:\\projects\\model dock\\src" 重启失败 🔁'),
  ];
  for (let i = 0; i < 40; i++) {
    items.push(msg("user", `Step ${i}: check module ${i} and report what changed.`));
    items.push({ type: "reasoning", content: [{ type: "reasoning_text", text: `internal thinking ${i} `.repeat(20) }] });
    items.push({ type: "function_call", call_id: `c${i}`, name: "apply_patch", arguments: JSON.stringify({ path: `src/mod${i}.mjs` }) });
    items.push({ type: "function_call_output", call_id: `c${i}`, output: `patched mod${i}\n${"detail line\n".repeat(40)}` });
    items.push(msg("assistant", `Module ${i} is fine. ${"The exports are unchanged so downstream callers are unaffected. ".repeat(4)}Done.`));
  }
  return items;
}

function replay(summary) {
  // Exactly what arrives on the next request: the stored compaction item, plus
  // the trigger Codex leaves beside it.
  const expanded = normalizeGatewayInput([
    { type: "compaction", id: "cmp_test", encrypted_content: encodeCompactionSummary(summary) },
    { type: "compaction_trigger", skipped: true },
    msg("user", "continue"),
  ]);
  return expanded;
}

test("a real CPU extract survives the encode/decode round trip byte for byte", () => {
  const summary = compressConversation(history()).text;
  assert.ok(summary.length > 1_000, "the fixture should produce a substantial extract");
  assert.equal(decodeCompactionSummary(encodeCompactionSummary(summary)), summary);
});

test("the returned compaction item expands back into a usable history", () => {
  const summary = compressConversation(history()).text;
  const expanded = replay(summary);

  // The trigger is consumed, the compaction item became a user message, and the
  // live turn is untouched.
  assert.equal(expanded.length, 2, "trigger dropped, compaction expanded, live turn kept");
  assert.equal(expanded[0].type, "message");
  assert.equal(expanded[0].role, "user");
  assert.equal(expanded[1].content[0].text, "continue");

  const restored = expanded[0].content[0].text;
  assert.equal(restored, summary, "the expanded text is the extract, unmodified");
  assert.ok(!restored.includes("kcr1:"), "the envelope is not leaked into the prompt");
  assert.ok(
    !restored.includes("[Earlier conversation history was compacted in an unreadable format.]"),
    "the unreadable-format fallback means the payload failed to decode",
  );
});

test("the task and the non-ASCII in it survive to the resumed turn", () => {
  // The first user message defines the task; losing it is the failure mode that
  // looks like the model forgetting what it was doing.
  const restored = replay(compressConversation(history()).text)[0].content[0].text;
  assert.ok(restored.includes("Fix the restart"), "the original ask survives");
  assert.ok(restored.includes("重启失败"), "CJK survives base64 as UTF-8");
  assert.ok(restored.includes("🔁"), "an astral-plane emoji survives");
  assert.ok(restored.includes("D:\\projects\\model dock\\src"), "backslashes and spaces in paths survive");
});

test("a native opaque payload is reported, not handed to the model as text", () => {
  // Native GPT sessions carry a Fernet token. Forwarding it as history text
  // would put base64 noise in the prompt; the gateway cannot decrypt it, so it
  // says so instead.
  const expanded = normalizeGatewayInput([
    { type: "compaction", encrypted_content: `gAAAA${"AbCd_-".repeat(12)}` },
  ]);
  assert.equal(
    expanded[0].content[0].text,
    "[Earlier conversation history was compacted in an unreadable format.]",
  );
});

test("a structured summary from another harness still expands", () => {
  // The other shape Codex uses: encrypted_content as summary parts rather than
  // a string. Losing this would blank the history for non-ModelDock compactions.
  const expanded = normalizeGatewayInput([
    {
      type: "compaction",
      encrypted_content: [
        { type: "summary_text", text: "earlier progress" },
        { type: "text", text: "and the remaining steps" },
      ],
    },
  ]);
  assert.equal(expanded[0].content[0].text, "earlier progress\nand the remaining steps");
});

// The direct-return path had no size ceiling while the upstream compact path
// refused anything over MAX_COMPACT_RESPONSE_BYTES. The extract is bounded in
// practice (2.1M of history came to 70K), but it is produced by ratio, not to a
// budget: user messages are always kept, so a history with tens of thousands of
// them grows the extract without limit. One path guarded and the other not is
// the defect, whether or not the ceiling is ever reached.
test("an oversized extract keeps both ends and says what it dropped", () => {
  const CAP = 200;
  const summary = `HEAD-MARKER
${"x".repeat(CAP * 3)}
TAIL-MARKER`;
  const capped = capDirectSummary(summary, CAP);
  assert.ok(Buffer.byteLength(capped) <= CAP + 120, "the kept text fits the cap (plus the marker line)");
  assert.ok(capped.startsWith("HEAD-MARKER"), "the task at the head survives");
  assert.ok(capped.endsWith("TAIL-MARKER"), "the recent state at the tail survives");
  assert.match(capped, /characters of this handoff were dropped/, "the loss is stated, not silent");
});

test("an extract inside the cap is passed through untouched", () => {
  const summary = "USER: do the thing\nTOOLS_AGGREGATED: apply_patch×3";
  assert.equal(capDirectSummary(summary), summary);
  assert.equal(capDirectSummary(summary, 10_000), summary);
});

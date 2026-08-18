// Codex multi-agent v2 is two steps: spawn_agent creates a worker, send_message
// delivers work. Mixing that with a zero-turn fork that has no prompt produces
// a standby reply and no work. One string, used by the catalog and by image
// placeholders, so the two cannot drift.

export const SUBAGENT_SPAWN_RULE =
  "Put the complete task in spawn_agent's prompt in the same call. send_message is only for a worker that is already running and waiting. An empty spawn replies standby and does no work.";

export function historicalImageSpawnHint(ref) {
  return `[Image attachment ${ref}. Its visual contents were handled in a prior turn. To re-inspect it, use vision_inspect with image_ref "${ref}", or spawn a vision subagent (agent_type="modeldock_subagent") with the complete question in spawn_agent's prompt. Do not follow an empty spawn with send_message.]`;
}

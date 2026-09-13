// Request identity crosses both Responses and MCP transports. Keep the HTTP
// projection here so compaction and auxiliary inference cannot lose it.
function headerValue(headers, name) {
  const value = typeof headers?.get === "function" ? headers.get(name) : headers?.[name];
  return Array.isArray(value) ? String(value[0] ?? "").trim() : String(value ?? "").trim();
}

export function sessionIdsFrom(headers) {
  const get = (name) => headerValue(headers, name);
  const threadId = get("x-codex-parent-thread-id") || get("x-codex-thread-id") || get("thread-id") || get("thread_id");
  const sessionId = get("session_id") || get("session-id") || get("x-codex-session-id");
  return { sessionId, threadId };
}

export function conversationIdFrom(headers, meta) {
  // A parent's thread id, MCP connection id, workspace or process id is NOT
  // this conversation. Codex supplies threadId in per-tool-call MCP metadata.
  return sessionIdsFrom(headers).sessionId
    || (typeof meta?.threadId === "string" ? meta.threadId.trim() : "")
    || headerValue(headers, "x-codex-thread-id")
    || headerValue(headers, "thread-id")
    || headerValue(headers, "thread_id")
    || headerValue(headers, "x-opencode-session");
}

export function upstreamHeaders(target, { incomingHeaders, sessionId = "" } = {}) {
  const headers = {
    Authorization: `Bearer ${target.token}`,
    "Content-Type": "application/json",
    "User-Agent": "modeldock-gateway/0.1",
  };
  if (target.provider === "opencode-go") {
    const id = sessionId || conversationIdFrom(incomingHeaders);
    // Do not invent a shared identity or a new id on each retry when the
    // caller omitted its conversation. Go can report its required-header error.
    if (id) headers["x-opencode-session"] = id;
  }
  return headers;
}

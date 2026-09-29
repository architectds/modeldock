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

function isOfficialOpenCodeGoUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://opencode.ai"
      && (url.pathname === "/zen/go/v1" || url.pathname.startsWith("/zen/go/v1/"));
  } catch {
    return false;
  }
}

export function opencodeSessionHeaders(target, { incomingHeaders, sessionId = "" } = {}) {
  const isGo = target.provider === "opencode-go"
    || (target.provider === "custom" && isOfficialOpenCodeGoUrl(target.url));
  if (!isGo) return {};
  const id = sessionId || conversationIdFrom(incomingHeaders);
  // Do not invent a shared identity or a new id on each retry when the
  // caller omitted its conversation. Go can report its required-header error.
  return id ? { "x-opencode-session": id } : {};
}

export function upstreamHeaders(target, { incomingHeaders, sessionId = "" } = {}) {
  return {
    ...(target.token ? { Authorization: `Bearer ${target.token}` } : {}),
    "Content-Type": "application/json",
    "User-Agent": "modeldock-gateway/0.1",
    ...opencodeSessionHeaders(target, { incomingHeaders, sessionId }),
  };
}

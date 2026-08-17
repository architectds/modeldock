// Per-session derived fallback for the "main model" concept.
//
// The Codex frontend picker is the single source of truth for which model runs:
// a request that carries a known model id routes by that id (client_selected).
// Requests without a model id need a fallback, and that fallback is derived
// from the last actual main request in the same session rather than a
// user-editable gateway slot. The map is intentionally in-memory only: a new
// session starts from the caller-provided bootstrap (the native config default
// in the final design) and learns the session's model from real traffic.

const DEFAULT_MAX_SESSIONS = 1000;

export function createDerivedFallback({ max = DEFAULT_MAX_SESSIONS } = {}) {
  const fallbacks = new Map();

  return {
    record(sessionKey, model) {
      if (!sessionKey || typeof model !== "string" || !model) return;
      // Move the key to the end so eviction favors the least recently seen.
      fallbacks.delete(sessionKey);
      fallbacks.set(sessionKey, model);
      if (fallbacks.size > max) {
        const oldest = fallbacks.keys().next().value;
        fallbacks.delete(oldest);
      }
    },
    resolve(sessionKey, bootstrap) {
      if (sessionKey && fallbacks.has(sessionKey)) return fallbacks.get(sessionKey);
      return bootstrap;
    },
    snapshot() {
      return { size: fallbacks.size, max };
    },
  };
}

// The signed-in ChatGPT Codex backend. Native Responses, vision, and image
// generation must share this exact base or one native capability can work while
// another is silently sent to a different host.
export const NATIVE_CODEX_BASE = process.env.CODEX_NATIVE_BASE_URL
  || "https://chatgpt.com/backend-api/codex";

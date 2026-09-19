// Rewrites upstream error bodies before they reach Codex. Providers disagree on
// where the human-readable message lives and report exhausted quota under many
// different statuses, so classification has to read the body before mapping the
// status: a quota 429 must not advise "retry shortly", and a no-credits 403 must
// not blame credentials.

const DETAIL_LIMIT = 300;

// Providers disagree on where the message lives: OpenAI-style error.message,
// bare error strings, top-level message (Alibaba), FastAPI detail, or MiniMax's
// base_resp.status_msg (minimax-m3 is our vision fallback, so that shape shows
// up in real traffic).
export function parseUpstreamError(bodyText) {
  if (typeof bodyText !== "string" || !bodyText) return { message: "", type: undefined };
  try {
    const parsed = JSON.parse(bodyText);
    const error = parsed?.error;
    const message =
      (typeof error === "string" && error) ||
      (typeof error?.message === "string" && error.message) ||
      (typeof parsed?.base_resp?.status_msg === "string" && parsed.base_resp.status_msg) ||
      (typeof parsed?.message === "string" && parsed.message) ||
      (typeof parsed?.detail === "string" && parsed.detail) ||
      bodyText;
    const type = [error?.type, error?.code, error?.status].find((value) => typeof value === "string");
    return { message, type };
  } catch {
    // Non-JSON bodies (HTML gateway pages, plain text) pass through as-is.
    return { message: bodyText, type: undefined };
  }
}

// Quota exhaustion appears under 429 (OpenAI insufficient_quota), 402
// (DeepSeek), and 403 (xAI), so patterns run before any status mapping.
const QUOTA_PATTERNS = [
  /insufficient[_\s]quota/i,
  /exceeded your current quota/i,
  /insufficient (?:balance|credits?)/i,
  /credit balance is too low/i,
  /(?:no|any|out of) credits/i,
  /usage limit (?:reached|exceeded)/i,
  /quota (?:reached|exceeded|exhausted)/i,
];

const AUTH_PATTERNS = [
  /invalid (?:api[_\s]?key|token|authentication)/i,
  /incorrect api key/i,
  /authentication(?:_error| failed| required)/i,
  /unauthorized/i,
];

export function classifyUpstreamError(status, message, type) {
  const text = `${type || ""} ${message || ""}`;
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(text))) return "quota_exhausted";
  if (status === 401 || AUTH_PATTERNS.some((pattern) => pattern.test(text))) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_unavailable";
  return "invalid_request";
}

const CLASS_HINTS = {
  quota_exhausted: "The upstream account is out of quota or credits; retrying will not help until it is topped up.",
  auth_failed: "The upstream rejected the API token; check the configured key.",
  rate_limited: "The upstream is rate limiting; retry shortly.",
  upstream_unavailable: "The upstream provider is unavailable; retry shortly.",
};

// Trial-mode guidance appended in place of the generic hint when the request was
// routed to a zen free model. Trial users always have an OpenCode account (the
// gateway needs the token), so the registration link is only the last-resort tail
// of the auth hint; the quota/busy hints point at the rolling window and ON mode.
const FREE_HINTS = {
  quota_exhausted: "The zen free endpoint has no quota left; wait for the 5h rolling window or switch to ON mode for a paid provider.",
  auth_failed: "Check the OpenCode token in Settings; no OpenCode account yet? Register free: https://opencode.ai/go?ref=P2133HRY5J",
  rate_limited: "The zen free endpoint is rate limiting; retry shortly or switch to ON mode for a paid provider.",
  upstream_unavailable: "The zen free endpoint is temporarily unavailable; retry shortly or switch to ON mode for a paid provider.",
};

// Produce the JSON body the gateway forwards to Codex in place of the raw
// upstream body. Codex renders error.message, so the cleaned detail leads and
// the hint (when any) follows. The upstream provider is named because Codex
// only sees "ModelDock" otherwise, and a provider outage reads like a gateway
// bug.
export function translateUpstreamError({ provider, status, bodyText, free = false }) {
  const { message, type } = parseUpstreamError(bodyText);
  const detail = String(message || "").trim().slice(0, DETAIL_LIMIT) || `Upstream returned ${status}`;
  const classification = classifyUpstreamError(status, detail, type);
  const hint = free ? FREE_HINTS[classification] || CLASS_HINTS[classification] : CLASS_HINTS[classification];
  return {
    classification,
    body: {
      error: {
        type: classification,
        message: `[${provider}] ${detail}${hint ? ` - ${hint}` : ""}`,
      },
    },
  };
}

// A local engine that is not answering is the most misleading failure ModelDock
// can report: the raw "fetch failed" reads as "the gateway died", so users
// restart a service that is answering perfectly while nothing is listening on the
// engine port. All relay-facing copy for that condition lives here, so the relay
// and every other relay exit cannot drift into two diagnoses of one failure.
const LOCAL_CONNECTION_FAILURE = /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|Connection refused|unable to connect|other reason|Target is unreachable|FailedToOpenSocket|NetworkError|could not connect|access denied/i;

export function isLocalConnectionFailure(text) {
  return LOCAL_CONNECTION_FAILURE.test(String(text || ""));
}

export function localEngineDownMessage({ label, address = "", action }) {
  const where = address ? ` at ${address}` : "";
  return `${label}${where} is not answering (connection failed). ModelDock itself is up: ${action}.`;
}

// The zen free endpoint intermittently accepts a request, burns the whole
// output budget on reasoning, and answers 200 with no output items: output:[]
// with stop_reason "max_output_tokens" (non-streaming) or a bare
// response.completed event (streaming). There is no upstream error body to
// parse, so synthesize the quota_exhausted guidance in the same shape the relay
// already uses for upstream failures.
export function freeEmptyOutputError({ provider, detail } = {}) {
  const classification = "quota_exhausted";
  const reason = detail || "the zen free endpoint returned an empty response (no output items)";
  return {
    classification,
    body: {
      error: {
        type: classification,
        message: `[${provider}] ${reason} - ${FREE_HINTS[classification]}`,
      },
    },
  };
}

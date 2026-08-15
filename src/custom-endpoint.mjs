// Custom endpoint protocol probe for the dashboard "Custom model" section.
//
// A user-configured endpoint is accepted only when it speaks the Responses
// dialect the gate relays, so the Add flow runs a deliberately near-free probe:
// a single non-streamed turn capped at 16 output tokens. Error codes are
// classified so the dashboard can render localized copy (connect / key / model /
// upstream) instead of a raw fetch message.

export class CustomEndpointError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CustomEndpointError";
    this.code = code;
  }
}

// Strip a trailing slash and land on the v1 tree when the user left it off, so
// both "https://host/v1" and "https://host" resolve to /v1/responses later.
export function normalizeBaseUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) return "";
  return /\/v1$/i.test(value) ? value : `${value}/v1`;
}

// Only https and loopback http are acceptable: the gate is a local service and a
// custom endpoint must never point it at an arbitrary LAN or internet target.
export function validateBaseUrl(raw) {
  const url = normalizeBaseUrl(raw);
  if (!url) throw new CustomEndpointError("connect", "Endpoint must be an http(s) URL.");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CustomEndpointError("connect", "Endpoint must be an http(s) URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new CustomEndpointError("connect", "Only https and loopback http endpoints are allowed.");
  }
  return url;
}

// Scheme/host validation without the /v1 completion. The models endpoint lives
// directly under the base URL the user entered (OpenRouter/DeepSeek keep
// /v1/models at the v1 level), so the list call must not rewrite the path; the
// Responses probe below still completes /v1 before appending /responses.
function validateEndpointBase(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) {
    throw new CustomEndpointError("connect", "Endpoint must be an http(s) URL.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CustomEndpointError("connect", "Endpoint must be an http(s) URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new CustomEndpointError("connect", "Only https and loopback http endpoints are allowed.");
  }
  return value;
}

function connectError(url, error) {
  const reason = error?.message || error?.code || "network error";
  return new CustomEndpointError("connect", `Cannot connect to ${url} (${reason}).`);
}

// GET {base}/models and return the ids the endpoint advertises. Auth is optional:
// some endpoints serve /models without a key, and the dashboard re-lists after a
// key is filled in when it returns 401.
export async function listEndpointModels({ baseUrl, apiKey }) {
  const endpoint = validateEndpointBase(baseUrl);
  const url = `${endpoint}/models`;
  let response;
  try {
    response = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw connectError(url, error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CustomEndpointError("key", "Model list rejected the API key (401/403).");
  }
  if (!response.ok) {
    throw new CustomEndpointError("upstream", `Model list failed with HTTP ${response.status}.`);
  }
  const body = await response.json().catch(() => ({}));
  const models = Array.isArray(body?.data)
    ? body.data
        .map((entry) => {
          const id = String(entry?.id || "").trim();
          if (!id) return null;
          const nCtx = Number(entry?.meta?.n_ctx);
          // llama.cpp advertises its real context in /v1/models meta.n_ctx
          // (e.g. 32768 for a 32K serve). Without it the gate would fall back
          // to CONTEXT_WINDOW (250K) and never auto-compact a 32K model.
          return {
            id,
            label: id,
            ...(Number.isFinite(nCtx) && nCtx > 0 ? { contextWindow: nCtx } : {}),
          };
        })
        .filter(Boolean)
    : [];
  return { models, endpoint, modelsUrl: url, responsesUrl: `${normalizeBaseUrl(endpoint)}/responses` };
}

// POST {base}/responses with a tiny turn to prove the endpoint speaks the
// Responses dialect and the key is accepted. Classified failures:
//   401/403 -> key, 400/404 -> model, anything else non-2xx -> upstream.
export async function probeCustomResponses({ baseUrl, apiKey, modelId }) {
  const model = String(modelId || "").trim();
  if (!model) throw new CustomEndpointError("model", "A model id is required.");
  const endpoint = validateBaseUrl(baseUrl);
  const url = `${endpoint}/responses`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly CUSTOM_OK." }] }],
        max_output_tokens: 16,
        stream: false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw connectError(url, error);
  }
  if (response.status === 401 || response.status === 403) {
    throw new CustomEndpointError("key", "API key rejected by the endpoint (401/403).");
  }
  if (response.status === 400 || response.status === 404) {
    throw new CustomEndpointError("model", "Model not found, or the endpoint does not support the Responses protocol.");
  }
  if (!response.ok) {
    throw new CustomEndpointError("upstream", `Responses probe failed with HTTP ${response.status}.`);
  }
  const body = await response.json().catch(() => ({}));
  return { ok: true, model, usage: body?.usage || null, endpoint, responsesUrl: url };
}

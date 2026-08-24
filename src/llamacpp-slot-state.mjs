// The narrow llama.cpp slot-state wire. Keeping it separate from the manifest
// means the scheduler never guesses an endpoint, filename, or response shape.

function text(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function slotId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("A llama.cpp slot id must be a non-negative integer.");
  return value;
}

export function assertLlamaSlotFilename(value) {
  const filename = text(value, "A llama.cpp slot filename");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}\.bin$/i.test(filename)) {
    throw new TypeError("A llama.cpp slot filename must be one simple .bin filename.");
  }
  return filename;
}

export function llamaServerRoot(baseUrl) {
  let parsed;
  try {
    parsed = new URL(text(baseUrl, "A llama.cpp base URL"));
  } catch {
    throw new TypeError("A llama.cpp base URL must be an absolute URL.");
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/v1\/?$/, "/").replace(/\/+$/, "/");
  return parsed.toString().replace(/\/$/, "");
}

async function jsonResponse(response, action) {
  const body = await response.text();
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new LlamaCppSlotStateError(action, response.status, "llama.cpp returned invalid JSON for a slot operation.");
  }
  if (!response.ok) {
    const message = typeof parsed?.error?.message === "string" ? parsed.error.message : `llama.cpp slot ${action} failed.`;
    throw new LlamaCppSlotStateError(action, response.status, message);
  }
  return parsed;
}

function positiveNumber(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

export class LlamaCppSlotStateError extends Error {
  constructor(action, status, message) {
    super(message);
    this.name = "LlamaCppSlotStateError";
    this.action = action;
    this.status = status;
  }
}

// Multi-GB slot states make SSD save/restore legitimately slow, so the bound
// is generous - but it must exist: every slot call runs inside the
// coordinator's exclusive mutation lock, and one llama.cpp request that never
// returned wedged every later conversation on the host until the gateway was
// restarted. The caller's signal (client disconnect) composes with this
// deadline; erase passes no signal at all and still gets the deadline.
const DEFAULT_SLOT_TIMEOUT_MS = 120_000;

export class LlamaCppSlotStateClient {
  constructor({ baseUrl, fetchImpl = fetch, timeoutMs = DEFAULT_SLOT_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("A llama.cpp slot client needs fetch.");
    this.baseUrl = llamaServerRoot(baseUrl);
    this.fetch = fetchImpl;
    this.timeoutMs = positiveNumber(timeoutMs, "A llama.cpp slot client timeout");
  }

  #boundedSignal(signal) {
    const deadline = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  }

  async #action(action, { slot = 0, filename, signal } = {}) {
    const id = slotId(slot);
    const body = filename === undefined ? {} : { filename: assertLlamaSlotFilename(filename) };
    const response = await this.fetch(`${this.baseUrl}/slots/${id}?action=${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: this.#boundedSignal(signal),
    });
    return jsonResponse(response, action);
  }

  async save(options = {}) {
    const body = await this.#action("save", options);
    const bytes = positiveNumber(body?.n_written, "llama.cpp saved slot bytes");
    return Object.freeze({
      slot: slotId(options.slot ?? 0),
      filename: assertLlamaSlotFilename(options.filename),
      bytes,
      promptTokens: Number.isSafeInteger(body?.n_saved) && body.n_saved >= 0 ? body.n_saved : 0,
      saveMs: Number(body?.timings?.save_ms) || 0,
    });
  }

  async restore(options = {}) {
    const body = await this.#action("restore", options);
    return Object.freeze({
      slot: slotId(options.slot ?? 0),
      filename: assertLlamaSlotFilename(options.filename),
      bytes: Number.isSafeInteger(body?.n_read) && body.n_read > 0 ? body.n_read : 0,
      promptTokens: Number.isSafeInteger(body?.n_restored) && body.n_restored >= 0 ? body.n_restored : 0,
      restoreMs: Number(body?.timings?.restore_ms) || 0,
    });
  }

  async erase({ slot = 0, signal } = {}) {
    const body = await this.#action("erase", { slot, signal });
    return Object.freeze({
      slot: slotId(slot),
      erasedTokens: Number.isSafeInteger(body?.n_erased) && body.n_erased >= 0 ? body.n_erased : 0,
    });
  }
}

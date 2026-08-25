// Per-host admission control. This is intentionally independent of HTTP and
// llama.cpp: callers provide the already-normalized operation, while the
// scheduler owns only fairness, capacity, and waiting cancellation.

function requiredText(value, label) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} is required.`);
  return result;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function conversationKey(principalId, conversationId) {
  return `${principalId.length}:${principalId}${conversationId.length}:${conversationId}`;
}

function abortError() {
  const error = new Error("Local host request was cancelled before admission.");
  error.name = "AbortError";
  return error;
}

function waitForRelease(job, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      detach();
      reject(abortError());
    };
    const detach = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
    job.released.then(() => {
      detach();
      resolve();
    });
  });
}

export class LocalHostScheduler {
  #active = new Map();
  #pending = [];
  #byConversation = new Map();

  constructor({ hostId, maxActiveRequests } = {}) {
    this.hostId = requiredText(hostId, "A local host id");
    this.maxActiveRequests = positiveInteger(maxActiveRequests, "maxActiveRequests");
  }

  snapshot() {
    const identity = (job) => ({ principalId: job.principalId, conversationId: job.conversationId });
    return Object.freeze({
      hostId: this.hostId,
      maxActiveRequests: this.maxActiveRequests,
      activeCount: this.#active.size,
      pendingCount: this.#pending.length,
      activeConversations: Array.from(this.#active.values(), identity),
      pendingConversations: this.#pending.map(identity),
    });
  }

  enqueue({ principalId, conversationId, run, signal } = {}) {
    const normalizedPrincipalId = requiredText(principalId, "A principal id");
    const normalizedConversationId = requiredText(conversationId, "A conversation id");
    if (typeof run !== "function") throw new TypeError("A local host scheduler job needs a run function.");
    if (signal?.aborted) return Promise.reject(abortError());
    const key = conversationKey(normalizedPrincipalId, normalizedConversationId);
    const existing = this.#byConversation.get(key);
    if (existing) {
      // A client disconnect and Codex's retry can cross in either order. In
      // particular, an HTTP client may receive SSE headers, abandon the body,
      // and retry before Node emits the old response's close event. Waiting
      // for every same-conversation job is therefore the only race-free
      // policy: if the old client was abandoned, its abort soon releases the
      // lane; if it was genuine concurrent work, serializing one conversation
      // is still safer than handing the same llama slot two histories.
      return waitForRelease(existing, signal).then(() => this.enqueue({
        principalId: normalizedPrincipalId,
        conversationId: normalizedConversationId,
        run,
        signal,
      }));
    }
    if (existing) {
      return Promise.reject(new Error("This conversation already has an active or waiting local host request."));
    }
    let resolve;
    let reject;
    let release;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const job = {
      key,
      principalId: normalizedPrincipalId,
      conversationId: normalizedConversationId,
      run,
      resolve,
      reject,
      signal,
      released: new Promise((resolveRelease) => { release = resolveRelease; }),
      release,
      detachAbort: () => {},
    };
    if (signal) {
      const onAbort = () => this.cancel({ principalId: normalizedPrincipalId, conversationId: normalizedConversationId });
      signal.addEventListener("abort", onAbort, { once: true });
      job.detachAbort = () => signal.removeEventListener("abort", onAbort);
    }
    this.#byConversation.set(key, job);
    this.#pending.push(job);
    this.#pump();
    return promise;
  }

  cancel({ principalId, conversationId } = {}) {
    const key = conversationKey(requiredText(principalId, "A principal id"), requiredText(conversationId, "A conversation id"));
    const job = this.#byConversation.get(key);
    if (!job || this.#active.has(key)) return false;
    const index = this.#pending.indexOf(job);
    if (index < 0) return false;
    this.#pending.splice(index, 1);
    this.#byConversation.delete(key);
    job.detachAbort();
    job.reject(abortError());
    return true;
  }

  #pump() {
    while (this.#active.size < this.maxActiveRequests && this.#pending.length) {
      const job = this.#pending.shift();
      this.#active.set(job.key, job);
      job.detachAbort();
      void Promise.resolve()
        .then(() => job.run({ hostId: this.hostId, principalId: job.principalId, conversationId: job.conversationId }))
        .then(
          (value) => {
            this.#release(job);
            job.resolve(value);
          },
          (error) => {
            this.#release(job);
            job.reject(error);
          },
        );
    }
  }

  #release(job) {
    this.#active.delete(job.key);
    this.#byConversation.delete(job.key);
    job.release();
    this.#pump();
  }
}

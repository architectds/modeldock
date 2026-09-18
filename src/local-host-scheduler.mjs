// Per-host admission control. This is intentionally independent of HTTP and
// llama.cpp: callers provide the already-normalized operation, while the
// scheduler owns fairness, capacity, waiting cancellation, and the lease an
// admitted request holds.
//
// The lease is why this file exists at all. An admitted request that stops
// making progress without ever settling - a llama.cpp stream whose termination
// is never observed, or a client that neither reads nor closes - held the only
// lane on a machine for seven hours on end. Every later local request on *any*
// conversation waited behind it, the GPUs went idle, and the log contained
// nothing. A request must not be able to own a lane longer than the lease, and
// taking one back has to be loud.

import { positiveInteger, requiredText } from "./local-host-validation.mjs";

// Deliberately generous. A cold prefill of a whole Codex history is minutes of
// legitimate silence, so this is a wall against a lost request, not a budget
// for a slow one. Measured worst case on the reference machine: a 480 s cold
// prefill followed by a few minutes of generation.
const DEFAULT_MAX_LEASE_MS = 30 * 60_000;
// No upstream activity at all for this long means the request is gone, not
// thinking. A request reports progress on every stream event it forwards.
const DEFAULT_STALL_MS = 12 * 60_000;
// How long a cancelled or expired job gets to unwind on its own before the lane
// is taken away while its operation is still running.
const DEFAULT_RECLAIM_GRACE_MS = 5_000;
// The watchdog only has to notice a deadline, so it can be coarse.
const LEASE_TICK_MS = 1_000;

function conversationKey(principalId, conversationId) {
  return `${principalId.length}:${principalId}${conversationId.length}:${conversationId}`;
}

function abortError(detail = "before admission") {
  const error = new Error(`Local host request was cancelled ${detail}.`);
  error.name = "AbortError";
  return error;
}

function leaseLostError(reason, ageMs) {
  const error = new Error(`Local host lane was reclaimed (${reason} after ${Math.round(ageMs / 1000)}s).`);
  error.name = "LocalHostLeaseError";
  return error;
}

function noOp() {}

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
  #timer = null;
  // Reclaim accounting for the local dashboard. `detected` is the number of
  // times a lease was found to be dead and its request was told to stop;
  // `forced` is the smaller number of times the request ignored that order and
  // the lane had to be taken back anyway. Only reporting `forced` would hide
  // every well-behaved stall, which is the case that still cost a user an
  // unexplained dead turn.
  #reclaims = { detected: 0, forced: 0, cancelled: 0, stalled: 0, expired: 0 };

  constructor({
    hostId,
    maxActiveRequests,
    maxLeaseMs = DEFAULT_MAX_LEASE_MS,
    stallMs = DEFAULT_STALL_MS,
    reclaimGraceMs = DEFAULT_RECLAIM_GRACE_MS,
    leaseTickMs = LEASE_TICK_MS,
    onLeaseReclaimed = noOp,
  } = {}) {
    this.hostId = requiredText(hostId, "A local host id");
    this.maxActiveRequests = positiveInteger(maxActiveRequests, "maxActiveRequests");
    this.maxLeaseMs = positiveInteger(maxLeaseMs, "A local host max lease");
    this.stallMs = positiveInteger(stallMs, "A local host stall window");
    this.reclaimGraceMs = positiveInteger(reclaimGraceMs, "A local host reclaim grace");
    this.leaseTickMs = positiveInteger(leaseTickMs, "A local host lease tick");
    if (typeof onLeaseReclaimed !== "function") throw new TypeError("A local host reclaim handler must be a function.");
    this.onLeaseReclaimed = onLeaseReclaimed;
  }

  snapshot() {
    const now = Date.now();
    const identity = (job) => ({ principalId: job.principalId, conversationId: job.conversationId });
    // Ages, not just identities: "one request is queued" and "one request has
    // been queued behind a seven-hour zombie" look identical without them, and
    // finding that out cost a netstat to discover.
    const withAge = (job) => ({
      ...identity(job),
      ageMs: Math.max(0, now - job.startedAt),
      quietMs: Math.max(0, now - job.lastActivityAt),
      // Whether the operation has produced any output yet. Silence before the
      // first byte is a slow prefill, not a stall, so the stall rule only arms
      // once a response has actually started.
      started: Boolean(job.touched),
      reclaiming: Boolean(job.reclaimAt),
      reclaimReason: job.reclaimReason || "",
    });
    return Object.freeze({
      hostId: this.hostId,
      maxActiveRequests: this.maxActiveRequests,
      maxLeaseMs: this.maxLeaseMs,
      stallMs: this.stallMs,
      activeCount: this.#active.size,
      pendingCount: this.#pending.length,
      activeConversations: Array.from(this.#active.values(), identity),
      pendingConversations: this.#pending.map(identity),
      active: Array.from(this.#active.values(), withAge),
      pending: this.#pending.map(withAge),
      reclaims: { ...this.#reclaims },
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
      controller: new AbortController(),
      released: new Promise((resolveRelease) => { release = resolveRelease; }),
      release,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      settled: false,
      releasedLane: false,
      reclaimAt: 0,
      reclaimReason: "",
      detachAbort: () => {},
    };
    // The operation's own liveness signal. Every stream event forwarded to the
    // client counts as progress, so a request that is genuinely working can
    // never be mistaken for a stalled one.
    job.touched = false;
    job.progress = () => {
      job.touched = true;
      job.lastActivityAt = Date.now();
    };
    if (signal) {
      const onAbort = () => this.cancel({ principalId: normalizedPrincipalId, conversationId: normalizedConversationId });
      signal.addEventListener("abort", onAbort, { once: true });
      job.detachAbort = () => signal.removeEventListener("abort", onAbort);
    }
    this.#byConversation.set(key, job);
    this.#pending.push(job);
    // Compose so that losing the lane also aborts the operation: a run that
    // observes its signal unwinds cleanly and never needs a forced reclaim.
    job.runSignal = signal ? AbortSignal.any([signal, job.controller.signal]) : job.controller.signal;
    this.#pump();
    return promise;
  }

  cancel({ principalId, conversationId } = {}) {
    const key = conversationKey(requiredText(principalId, "A principal id"), requiredText(conversationId, "A conversation id"));
    const job = this.#byConversation.get(key);
    if (!job) return false;
    if (this.#active.get(key) === job) {
      // An active job used to be un-cancellable: the abort was dropped on the
      // floor and the lane stayed held until the operation settled by itself.
      // Cancel it through its own controller and start the reclaim clock so a
      // request that ignores the abort cannot park the host.
      this.#beginReclaim(job, "cancelled");
      return true;
    }
    const index = this.#pending.indexOf(job);
    if (index < 0) return false;
    this.#pending.splice(index, 1);
    this.#byConversation.delete(key);
    job.detachAbort();
    job.reject(abortError());
    return true;
  }

  #beginReclaim(job, reason) {
    if (job.settled || job.reclaimAt) return;
    job.reclaimReason = reason;
    job.reclaimAt = Date.now() + this.reclaimGraceMs;
    this.#reclaims.detected += 1;
    if (reason === "cancelled") this.#reclaims.cancelled += 1;
    if (reason === "stalled") this.#reclaims.stalled += 1;
    if (reason === "expired") this.#reclaims.expired += 1;
    // Reported before the grace period so a stall that unwinds cleanly is
    // still visible in the log. `forced: false` means "the lease owner was told
    // to stop"; the residency stays untouched because that owner still has to
    // report its own completion.
    this.#report(job, false);
    job.controller.abort(abortError(`because the local host lane was reclaimed (${reason})`));
    this.#arm();
  }

  #report(job, forced) {
    const ageMs = Math.max(0, Date.now() - job.startedAt);
    try {
      this.onLeaseReclaimed({
        hostId: this.hostId,
        conversationId: job.conversationId,
        reason: job.reclaimReason || "reclaimed",
        ageMs,
        forced,
      });
    } catch {
      // A failing log must not keep the lane hostage.
    }
  }

  #forceRelease(job) {
    if (job.settled || job.releasedLane) return;
    job.releasedLane = true;
    const ageMs = Math.max(0, Date.now() - job.startedAt);
    if (this.#active.get(job.key) === job) this.#active.delete(job.key);
    if (this.#byConversation.get(job.key) === job) this.#byConversation.delete(job.key);
    job.detachAbort();
    // Loud by design: this is the event that used to be invisible.
    this.#reclaims.forced += 1;
    this.#report(job, true);
    job.reject(leaseLostError(job.reclaimReason || "reclaimed", ageMs));
    job.release();
    this.#pump();
  }

  #sweep() {
    const now = Date.now();
    for (const job of [...this.#active.values()]) {
      if (job.settled) continue;
      if (job.reclaimAt) {
        if (now >= job.reclaimAt) this.#forceRelease(job);
        continue;
      }
      if (now - job.startedAt >= this.maxLeaseMs) {
        this.#beginReclaim(job, "expired");
      } else if (job.touched && now - job.lastActivityAt >= this.stallMs) {
        this.#beginReclaim(job, "stalled");
      }
    }
    this.#arm();
  }

  #arm() {
    const armed = this.#active.size > 0;
    if (!armed) {
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = null;
      return;
    }
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#sweep();
    }, this.leaseTickMs);
    // The watchdog must never be the reason a process cannot exit.
    this.#timer.unref?.();
  }

  #pump() {
    while (this.#active.size < this.maxActiveRequests && this.#pending.length) {
      const job = this.#pending.shift();
      this.#active.set(job.key, job);
      // The caller's abort listener stays attached. It used to be removed here,
      // which made an admitted request literally un-cancellable: the disconnect
      // was discarded and the lane stayed held until the operation chose to
      // settle. Keeping it attached lets cancel() start the reclaim clock.
      job.startedAt = Date.now();
      job.lastActivityAt = Date.now();
      this.#arm();
      void Promise.resolve()
        .then(() => job.run({
          hostId: this.hostId,
          principalId: job.principalId,
          conversationId: job.conversationId,
          signal: job.runSignal,
          progress: job.progress,
        }))
        .then(
          (value) => {
            job.settled = true;
            this.#release(job);
            job.resolve(value);
          },
          (error) => {
            job.settled = true;
            this.#release(job);
            job.reject(error);
          },
        );
    }
    this.#arm();
  }

  #release(job) {
    if (job.releasedLane) return;
    job.releasedLane = true;
    this.#active.delete(job.key);
    // Only drop the conversation slot if this job still owns it: a forced
    // reclaim may already have admitted the request that replaced it.
    if (this.#byConversation.get(job.key) === job) this.#byConversation.delete(job.key);
    job.detachAbort();
    job.release();
    this.#pump();
  }
}

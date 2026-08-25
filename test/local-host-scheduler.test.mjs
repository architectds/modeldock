import assert from "node:assert/strict";
import test from "node:test";
import { LocalHostScheduler } from "../src/local-host-scheduler.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("scheduler admits no more than the calibrated host capacity", async () => {
  const scheduler = new LocalHostScheduler({ hostId: "host-qwen", maxActiveRequests: 1 });
  const first = deferred();
  const second = deferred();
  const started = [];
  const one = scheduler.enqueue({ principalId: "local", conversationId: "one", run: () => { started.push("one"); return first.promise; } });
  const two = scheduler.enqueue({ principalId: "local", conversationId: "two", run: () => { started.push("two"); return second.promise; } });
  await waitForTurn();
  assert.deepEqual(started, ["one"]);
  assert.deepEqual(scheduler.snapshot().activeConversations, [{ principalId: "local", conversationId: "one" }]);
  assert.deepEqual(scheduler.snapshot().pendingConversations, [{ principalId: "local", conversationId: "two" }]);
  first.resolve("first");
  assert.equal(await one, "first");
  await waitForTurn();
  assert.deepEqual(started, ["one", "two"]);
  second.resolve("second");
  assert.equal(await two, "second");
});

test("waiting conversations keep FIFO fairness and a conversation cannot reenter", async () => {
  const scheduler = new LocalHostScheduler({ hostId: "host-qwen", maxActiveRequests: 1 });
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const started = [];
  const one = scheduler.enqueue({ principalId: "local", conversationId: "one", run: () => { started.push("one"); return first.promise; } });
  const two = scheduler.enqueue({ principalId: "local", conversationId: "two", run: () => { started.push("two"); return second.promise; } });
  const three = scheduler.enqueue({ principalId: "remote-a", conversationId: "three", run: () => { started.push("three"); return third.promise; } });
  await assert.rejects(
    () => scheduler.enqueue({ principalId: "local", conversationId: "one", run: () => Promise.resolve() }),
    /already has an active or waiting/,
  );
  first.resolve();
  await one;
  await waitForTurn();
  second.resolve();
  await two;
  await waitForTurn();
  third.resolve();
  await three;
  assert.deepEqual(started, ["one", "two", "three"]);
});

test("an aborted waiting job never reaches the model operation", async () => {
  const scheduler = new LocalHostScheduler({ hostId: "host-qwen", maxActiveRequests: 1 });
  const first = deferred();
  let secondRan = false;
  const controller = new AbortController();
  const one = scheduler.enqueue({ principalId: "local", conversationId: "one", run: () => first.promise });
  const two = scheduler.enqueue({ principalId: "local", conversationId: "two", signal: controller.signal, run: () => { secondRan = true; } });
  controller.abort();
  await assert.rejects(two, { name: "AbortError" });
  assert.equal(secondRan, false);
  assert.equal(scheduler.snapshot().pendingCount, 0);
  first.resolve();
  await one;
});

test("a retry waits for an aborted active conversation to release", async () => {
  const scheduler = new LocalHostScheduler({ hostId: "host-qwen", maxActiveRequests: 1 });
  const stale = deferred();
  const controller = new AbortController();
  const first = scheduler.enqueue({
    principalId: "local",
    conversationId: "one",
    signal: controller.signal,
    run: () => stale.promise,
  });
  await waitForTurn();
  controller.abort();
  let retried = false;
  const retry = scheduler.enqueue({
    principalId: "local",
    conversationId: "one",
    run: () => { retried = true; return "retry"; },
  });
  await waitForTurn();
  assert.equal(retried, false, "retry waits for the abandoned active request to release");
  stale.resolve("stale");
  assert.equal(await first, "stale");
  assert.equal(await retry, "retry");
  assert.equal(scheduler.snapshot().activeCount, 0);
});

test("a failed operation releases its lease for the next conversation", async () => {
  const scheduler = new LocalHostScheduler({ hostId: "host-qwen", maxActiveRequests: 1 });
  let secondRan = false;
  const one = scheduler.enqueue({ principalId: "local", conversationId: "one", run: () => { throw new Error("upstream failed"); } });
  const two = scheduler.enqueue({ principalId: "local", conversationId: "two", run: () => { secondRan = true; return "ok"; } });
  await assert.rejects(one, /upstream failed/);
  assert.equal(await two, "ok");
  assert.equal(secondRan, true);
  assert.equal(scheduler.snapshot().activeCount, 0);
});

test("scheduler validates host identity and capacity at construction", () => {
  assert.throws(() => new LocalHostScheduler({ hostId: "", maxActiveRequests: 1 }), /host id/);
  assert.throws(() => new LocalHostScheduler({ hostId: "host", maxActiveRequests: 0 }), /positive integer/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createDerivedFallback } from "../src/derived-fallback.mjs";

test("resolve returns the bootstrap until a session has seen a main request", () => {
  const derived = createDerivedFallback();
  assert.equal(derived.resolve("s1", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(derived.resolve("", "gpt-5.6-sol"), "gpt-5.6-sol");
});

test("record overrides the fallback only for that session", () => {
  const derived = createDerivedFallback();
  derived.record("s1", "deepseek-v4-flash@opencode-go");
  assert.equal(derived.resolve("s1", "gpt-5.6-sol"), "deepseek-v4-flash@opencode-go");
  assert.equal(derived.resolve("s2", "gpt-5.6-sol"), "gpt-5.6-sol");
});

test("a newer main request replaces the derived model for the session", () => {
  const derived = createDerivedFallback();
  derived.record("s1", "deepseek-v4-flash@opencode-go");
  derived.record("s1", "deepseek-v4-pro@opencode-go");
  assert.equal(derived.resolve("s1", "gpt-5.6-sol"), "deepseek-v4-pro@opencode-go");
});

test("empty session keys and model ids are ignored", () => {
  const derived = createDerivedFallback();
  derived.record("", "deepseek-v4-flash@opencode-go");
  derived.record("s1", "");
  assert.equal(derived.resolve("", "gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(derived.resolve("s1", "gpt-5.6-sol"), "gpt-5.6-sol");
});

test("eviction drops the least recently seen session", () => {
  const derived = createDerivedFallback({ max: 2 });
  derived.record("s1", "a@opencode-go");
  derived.record("s2", "b@opencode-go");
  derived.record("s3", "c@opencode-go");
  assert.equal(derived.snapshot().size, 2);
  assert.equal(derived.resolve("s1", "bootstrap"), "bootstrap");
  assert.equal(derived.resolve("s3", "bootstrap"), "c@opencode-go");
});

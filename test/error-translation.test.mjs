import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyUpstreamError,
  freeEmptyOutputError,
  parseUpstreamError,
  translateUpstreamError,
} from "../src/error-translation.mjs";

test("parseUpstreamError reads the message from every known provider shape", () => {
  assert.equal(parseUpstreamError('{"error":{"message":"model not found","type":"invalid_request_error"}}').message, "model not found");
  assert.equal(parseUpstreamError('{"error":"plain string error"}').message, "plain string error");
  assert.equal(parseUpstreamError('{"message":"top level message"}').message, "top level message");
  assert.equal(parseUpstreamError('{"detail":"fastapi detail"}').message, "fastapi detail");
  assert.equal(parseUpstreamError('{"base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}').message, "insufficient balance");
  assert.equal(parseUpstreamError("<html>bad gateway</html>").message, "<html>bad gateway</html>");
});

test("quota exhaustion is classified before the status mapping", () => {
  // DeepSeek reports no credits as 402, xAI as 403, OpenAI as 429 - all quota.
  assert.equal(classifyUpstreamError(402, "Insufficient Balance"), "quota_exhausted");
  assert.equal(classifyUpstreamError(429, "You exceeded your current quota"), "quota_exhausted");
  assert.equal(classifyUpstreamError(403, "Your team is out of credits"), "quota_exhausted");
  // A plain 429 without quota wording stays retryable.
  assert.equal(classifyUpstreamError(429, "Too many requests"), "rate_limited");
});

test("auth and availability classes", () => {
  assert.equal(classifyUpstreamError(401, "whatever"), "auth_failed");
  assert.equal(classifyUpstreamError(400, "Invalid API key provided"), "auth_failed");
  assert.equal(classifyUpstreamError(503, "upstream exploded"), "upstream_unavailable");
  assert.equal(classifyUpstreamError(400, "input too long"), "invalid_request");
});

test("translateUpstreamError names the provider and appends the right hint", () => {
  const quota = translateUpstreamError({ provider: "deepseek-official", status: 402, bodyText: '{"error":{"message":"Insufficient Balance"}}' });
  assert.equal(quota.classification, "quota_exhausted");
  assert.match(quota.body.error.message, /^\[deepseek-official\] Insufficient Balance/);
  assert.match(quota.body.error.message, /will not help/);

  const rate = translateUpstreamError({ provider: "opencode-go", status: 429, bodyText: '{"error":{"message":"Too many requests"}}' });
  assert.match(rate.body.error.message, /retry shortly/i);

  const empty = translateUpstreamError({ provider: "opencode-go", status: 500, bodyText: "" });
  assert.match(empty.body.error.message, /Upstream returned 500/);
});

test("free upstream errors carry trial-mode guidance instead of the generic hint", () => {
  const quota = translateUpstreamError({ provider: "opencode-go", status: 503, bodyText: '{"error":{"message":"free quota exhausted"}}', free: true });
  assert.equal(quota.classification, "quota_exhausted");
  assert.match(quota.body.error.message, /zen free endpoint/);
  assert.match(quota.body.error.message, /5h rolling window/);
  assert.match(quota.body.error.message, /ON mode/);

  const auth = translateUpstreamError({ provider: "opencode-go", status: 401, bodyText: '{"error":{"message":"invalid token"}}', free: true });
  assert.equal(auth.classification, "auth_failed");
  assert.match(auth.body.error.message, /OpenCode token/);
  assert.match(auth.body.error.message, /opencode\.ai\/go\?ref=/);

  // The same provider and status without the free flag keeps the generic hint.
  const plain = translateUpstreamError({ provider: "opencode-go", status: 503, bodyText: '{"error":{"message":"boom"}}' });
  assert.match(plain.body.error.message, /unavailable; retry shortly/);
  assert.doesNotMatch(plain.body.error.message, /zen free endpoint/);
});

test("freeEmptyOutputError reuses the quota_exhausted copy for silent empty outputs", () => {
  const error = freeEmptyOutputError({ provider: "opencode-go" });
  assert.equal(error.classification, "quota_exhausted");
  assert.match(error.body.error.message, /^\[opencode-go\] the zen free endpoint returned an empty response/);
  assert.match(error.body.error.message, /5h rolling window/);
  assert.match(error.body.error.message, /switch to ON mode/);
});

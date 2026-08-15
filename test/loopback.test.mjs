import test from "node:test";
import assert from "node:assert/strict";
import { isLoopbackHost } from "../src/loopback.mjs";

test("both spellings of an IPv6 loopback literal are recognised", () => {
  // URL.hostname keeps the brackets ("[::1]"), a host read from an env var does
  // not. Four of the five copies this replaced compared the bracketed form against
  // a bare "::1" and got false, so http://[::1]:11434 was refused as a remote
  // plaintext endpoint - the drift that motivated collapsing them into one rule.
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost(new URL("http://[::1]:11434").hostname), true);
});

test("the ordinary loopback spellings are recognised, case-insensitively", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("LocalHost"), true);
  assert.equal(isLoopbackHost(" 127.0.0.1 "), true);
});

test("anything that is not this machine is rejected", () => {
  // These decide whether plaintext http is allowed, so a near-miss must not pass:
  // a hostname that merely contains or resembles a loopback name is a remote host.
  for (const host of [
    "",
    undefined,
    null,
    "0.0.0.0",
    "example.com",
    "localhost.example.com",
    "127.0.0.1.example.com",
    "notlocalhost",
    "192.168.1.10",
    "::2",
  ]) {
    assert.equal(isLoopbackHost(host), false, `${JSON.stringify(host)} must not count as loopback`);
  }
});

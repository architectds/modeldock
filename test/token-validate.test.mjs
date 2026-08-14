import test from "node:test";
import assert from "node:assert/strict";
import { validateProviderToken } from "../src/token-validate.mjs";

test("deepseek keys must start with sk-", () => {
  assert.equal(validateProviderToken("deepseek-official", "sk-abc123").ok, true);
  assert.equal(validateProviderToken("deepseek-official", "abc123").ok, false);
  assert.match(validateProviderToken("deepseek-official", "abc123").error, /sk-/);
});

test("quotes are rejected for every provider", () => {
  assert.equal(validateProviderToken("deepseek-official", 'sk-ab"c').ok, false);
  assert.equal(validateProviderToken("opencode-go", "token'withquote").ok, false);
  assert.match(validateProviderToken("opencode-go", "a'b").error, /quotes/);
  assert.equal(validateProviderToken("deepseek-official", "sk-abc def").ok, false);
  assert.match(validateProviderToken("deepseek-official", "sk-abc def").error, /quotes or spaces/);
});

test("empty and whitespace-only values are rejected", () => {
  assert.equal(validateProviderToken("opencode-go", "").ok, false);
  assert.equal(validateProviderToken("deepseek-official", "   ").ok, false);
});

test("values are trimmed before validation", () => {
  const result = validateProviderToken("deepseek-official", "  sk-key-123  ");
  assert.equal(result.ok, true);
  assert.equal(result.value, "sk-key-123");
});

test("exa keys must look like exa_<token>", () => {
  assert.equal(validateProviderToken("exa", "exa_abc123").ok, true);
  assert.equal(validateProviderToken("exa", "exa_abc-def_ghi").ok, true);
  assert.equal(validateProviderToken("exa", "abc123").ok, false);
});

test("opencode-go accepts any non-empty token shape", () => {
  assert.equal(validateProviderToken("opencode-go", "op-whatever-123").ok, true);
});

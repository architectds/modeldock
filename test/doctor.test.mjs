import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { checkDoctor, doctorExitCode, DOCTOR_CHECKS } from "../src/doctor.mjs";

function healthyFetch() {
  return async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}

function makeEnv({ loggedIn = true, keyedRoute = true, plainSecret = false, callerMode = 0o600, fetchImpl = healthyFetch(), configToml = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "modeldock-doctor-"));
  const stateDir = path.join(root, "state");
  const codexHome = path.join(root, "codex");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(path.join(root, "dist"), { recursive: true });
  writeFileSync(path.join(root, "dist", "modeldock.mjs"), "// bundle", "utf8");
  if (loggedIn) {
    writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify({ tokens: { access_token: "sk-test" } }), "utf8");
  }
  if (configToml) {
    const route = keyedRoute
      ? 'openai_base_url = "http://127.0.0.1:4097/c/somekey/v1"'
      : 'openai_base_url = "https://api.openai.com/v1"';
    writeFileSync(path.join(codexHome, "config.toml"), `model = "gpt-5.6-sol"\n${route}\n\n[model_providers.opencode_go]\nexperimental_bearer_token = "go-token"\n`, "utf8");
  }
  const envFile = path.join(root, "modeldock.env");
  const secretLine = plainSecret ? "OPENCODE_GO_TOKEN=plain-token" : "OPENCODE_GO_TOKEN=dpapi:AAAA";
  writeFileSync(envFile, `${secretLine}\nDEEPSEEK_API_KEY=\n`, "utf8");
  const callerKeyFile = path.join(stateDir, "caller-key");
  writeFileSync(callerKeyFile, "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH\n", "utf8");
  chmodSync(callerKeyFile, callerMode);
  return {
    root,
    stateDir,
    codexHome,
    envFile,
    callerKeyFile,
    options: { port: 4097, stateDir, codexHome, envFile, rootDir: root, fetchImpl },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a healthy install passes every check", async () => {
  const env = makeEnv();
  try {
    const checks = await checkDoctor(env.options);
    assert.equal(checks.length, DOCTOR_CHECKS);
    for (const check of checks) {
      assert.equal(check.status, "ok", `${check.name} should be ok: ${check.detail}`);
    }
    assert.equal(doctorExitCode(checks), 0);
  } finally {
    env.cleanup();
  }
});

test("a stopped gateway fails the health check and the run", async () => {
  const env = makeEnv({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  try {
    const checks = await checkDoctor(env.options);
    const health = checks.find((check) => check.name === "Gateway health");
    assert.equal(health.status, "fail");
    assert.match(health.detail, /nothing answers/);
    assert.equal(doctorExitCode(checks), 1);
  } finally {
    env.cleanup();
  }
});

test("a gateway without a provider token is a warning, not a failure", async () => {
  const env = makeEnv({ fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 200, headers: { "content-type": "application/json" } }) });
  try {
    const checks = await checkDoctor(env.options);
    const health = checks.find((check) => check.name === "Gateway health");
    assert.equal(health.status, "warn");
    assert.match(health.detail, /no provider token/);
    assert.equal(doctorExitCode(checks), 0);
  } finally {
    env.cleanup();
  }
});

test("plaintext secrets and a world-readable caller key are flagged", async () => {
  const env = makeEnv({ plainSecret: true, callerMode: 0o644 });
  try {
    const checks = await checkDoctor(env.options);
    const secrets = checks.find((check) => check.name === ".env secret storage");
    assert.equal(secrets.status, "warn");
    assert.match(secrets.detail, /OPENCODE_GO_TOKEN stored in plaintext/);
    const caller = checks.find((check) => check.name === "Caller key file");
    if (process.platform !== "win32") {
      assert.equal(caller.status, "warn");
      assert.match(caller.detail, /world-readable/);
    }
  } finally {
    env.cleanup();
  }
});

test("a config.toml routed elsewhere is flagged", async () => {
  const env = makeEnv({ keyedRoute: false });
  try {
    const checks = await checkDoctor(env.options);
    const route = checks.find((check) => check.name === "Codex route");
    assert.equal(route.status, "warn");
    assert.match(route.detail, /not this gateway's keyed URL/);
  } finally {
    env.cleanup();
  }
});

test("a missing state dir fails the check", async () => {
  const env = makeEnv();
  const options = { ...env.options, stateDir: path.join(env.root, "missing-state") };
  try {
    const checks = await checkDoctor(options);
    const state = checks.find((check) => check.name === "State dir");
    assert.equal(state.status, "fail");
  } finally {
    env.cleanup();
  }
});

test("no auth.json means the sign-in check warns", async () => {
  const env = makeEnv({ loggedIn: false });
  try {
    const checks = await checkDoctor(env.options);
    const signIn = checks.find((check) => check.name === "ChatGPT sign-in");
    assert.equal(signIn.status, "warn");
  } finally {
    env.cleanup();
  }
});



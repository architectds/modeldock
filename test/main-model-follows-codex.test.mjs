// The dashboard does not choose the main model. Codex does.
//
// This was not always true, and the ways it stopped being true were quiet: a
// picker that wrote a value the next turn overwrote, and MODELDOCK_CUSTOM_MAIN,
// a flag that made a connected endpoint the boot default and then persisted in
// .env so it kept doing it on every later restart. Both are gone; these tests
// are what keeps them gone, because nothing else here would notice a picker
// coming back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("the dashboard ships no control that picks a main model", () => {
  const html = read("public/index.html");
  for (const id of ["main-provider-select", "main-model-select"]) {
    assert.ok(!html.includes(id), `${id} is back: the dashboard is choosing a model again`);
  }
  // A read-only display of what Codex is using is the intended replacement.
  assert.ok(html.includes("main-provider-display"), "the active provider is still shown");
  assert.ok(html.includes("main-model-display-name"), "the active model is still shown");
});

test("no script writes a main model to the API", () => {
  // The vision and subagent rows post their own selections; main must not.
  const app = read("public/app.js");
  assert.ok(!app.includes("saveMainModel"), "the save path for a main-model picker is back");
  const posts = [...app.matchAll(/body:\s*JSON\.stringify\(\{([^}]*)\}/g)].map((m) => m[1]);
  const writesMain = posts.filter((body) => /\bmainModel\s*:/.test(body));
  assert.deepEqual(writesMain, [], "a request body carries mainModel; the dashboard is choosing again");
});

test("nothing lets a connected backend become the main model", () => {
  // MODELDOCK_CUSTOM_MAIN is the specific flag that did this. It survived long
  // after the code that honoured it, still stored and still echoed to a
  // checkbox, which is how it read as a working control for months.
  for (const file of ["src/config.mjs", "src/server.mjs", "public/app.js", "public/index.html"]) {
    const text = read(file);
    const live = text
      .split(/\r?\n/)
      .filter((line) => line.includes("MODELDOCK_CUSTOM_MAIN") && !line.trim().startsWith("//"));
    assert.deepEqual(live, [], `${file} acts on MODELDOCK_CUSTOM_MAIN again`);
  }
  const server = read("src/server.mjs");
  assert.ok(!/\basMain\b/.test(server), "the as-main flag is back in the add flow");
});

test("the main model is a catalog default, not a configured slot", async () => {
  const { loadConfig } = await import("../src/config.mjs");
  // MODELDOCK_MAIN_MODEL is no longer read. Setting it must change nothing:
  // the value exists only so the catalog and the header have something to show
  // before Codex has routed anything.
  const before = loadConfig().mainModel;
  process.env.MODELDOCK_MAIN_MODEL = "kimi-k3@opencode-go";
  try {
    assert.equal(loadConfig().mainModel, before, "an env slot decides the main model again");
  } finally {
    delete process.env.MODELDOCK_MAIN_MODEL;
  }
  assert.equal(before, "deepseek-v4-flash@opencode-go", "the default is the catalog's, not a user's");
});

test("the main model records what Codex routed with", () => {
  // relayGatewayRequest is the only writer: when Codex names a model itself
  // (route.reason "client_selected"), that is what the dashboard reports. This
  // is why no cleanup is needed when a model is retired - the next request
  // corrects it, and a restart resets it to the catalog default.
  const server = read("src/server.mjs");
  assert.match(
    server,
    /result\?\.route\?\.reason === "client_selected"[\s\S]{0,200}modelSelection\.mainModel = result\.route\.model/,
    "the relay no longer records the model Codex chose",
  );
  const config = read("src/config.mjs");
  assert.ok(
    !/MODELDOCK_MAIN_MODEL/.test(config.split(/\r?\n/).filter((l) => !l.trim().startsWith("//")).join("\n")),
    "config reads a main-model slot again",
  );
});

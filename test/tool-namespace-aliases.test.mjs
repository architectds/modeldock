import assert from "node:assert/strict";
import test from "node:test";
import { applyToolPolicy, responseNamespacesFor, restoreNamespaceCall } from "../src/gateway.mjs";

const fn = (name) => ({ type: "function", name, parameters: { type: "object", properties: {} } });
const ns = (name, ...names) => ({ type: "namespace", name, tools: names.map(fn) });

test("preserved collaboration declarations restore exact prefixed names without changing the request", () => {
  const original = [ns("collaboration", "spawn_agent", "list_agents", "interrupt_agent")];
  const policy = applyToolPolicy(original);
  assert.deepEqual(policy.tools, original);
  assert.equal(policy.namespaces.size, 0);
  const mappings = responseNamespacesFor(policy.tools, policy.namespaces);
  for (const name of ["spawn_agent", "list_agents", "interrupt_agent"]) {
    const item = { type: "function_call", name: `collaboration__${name}`, call_id: `call_${name}`, arguments: "{}" };
    assert.deepEqual(restoreNamespaceCall(item, mappings), { ...item, name, namespace: "collaboration" });
  }
  assert.equal(policy.namespaces.size, 0, "response-only aliases must not change replay mappings");
});

test("declared flat tools and ambiguous namespace aliases are never hijacked", () => {
  const tools = [ns("collaboration", "spawn_agent"), fn("collaboration__spawn_agent"),
    ns("one", "two__three"), ns("one__two", "three")];
  const mappings = responseNamespacesFor(tools);
  assert.equal(mappings.size, 0);
  for (const name of ["collaboration__spawn_agent", "one__two__three", "unknown__spawn_agent"]) {
    const item = { type: "function_call", name, arguments: "{}" };
    assert.equal(restoreNamespaceCall(item, mappings), item);
  }
});

test("already-qualified calls, custom tools, and undeclared names remain untouched", () => {
  const mappings = responseNamespacesFor([ns("collaboration__", "spawn_agent"), {
    type: "namespace", name: "functions", tools: [{ type: "custom", name: "apply_patch" }],
  }]);
  const flat = { type: "function_call", name: "collaboration__spawn_agent", arguments: "{}" };
  assert.equal(restoreNamespaceCall(flat, mappings).namespace, "collaboration__");
  for (const item of [{ ...flat, namespace: "another_namespace" },
    { ...flat, name: "spawn_agent", namespace: "collaboration__" },
    { ...flat, name: "functions__apply_patch" }, { ...flat, name: "collaboration__delete_everything" }]) {
    assert.equal(restoreNamespaceCall(item, mappings), item);
  }
});

test("explicitly flattened mappings keep their precedence and disabled starters stay disabled", () => {
  const tools = [ns("collaboration", "spawn_agent", "list_agents")];
  const flattened = applyToolPolicy(tools, { flattenAllNamespaces: true });
  assert.deepEqual([...responseNamespacesFor(flattened.tools, flattened.namespaces)], [...flattened.namespaces]);
  const local = applyToolPolicy(tools, { disableSubagentWork: true });
  const mappings = responseNamespacesFor(local.tools, local.namespaces);
  assert.equal(mappings.has("collaboration__spawn_agent"), false);
  assert.equal(mappings.has("collaboration__list_agents"), true);
});

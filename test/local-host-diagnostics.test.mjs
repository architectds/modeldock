import assert from "node:assert/strict";
import test from "node:test";
import { createLocalHostDiagnosticSink } from "../src/local-host-diagnostics.mjs";

const sink = (lines, repeatEvery) => createLocalHostDiagnosticSink({ log: (line) => lines.push(line), repeatEvery });

test("a repeated managed-host failure logs once, then counts", () => {
  const lines = [];
  const report = sink(lines, 3);
  for (let i = 0; i < 7; i += 1) report({ kind: "slot_erase_failed", message: "fetch failed" });
  assert.deepEqual(lines, [
    "[gate] local host slot_erase_failed: fetch failed",
    "[gate] local host slot_erase_failed: fetch failed. Repeated 3 times since it started.",
    "[gate] local host slot_erase_failed: fetch failed. Repeated 6 times since it started.",
  ]);
});

test("a new failure shape starts the count over", () => {
  const lines = [];
  const report = sink(lines, 2);
  report({ kind: "slot_save_failed", message: "disk full" });
  report({ kind: "slot_save_failed", message: "disk full" });
  report({ kind: "slot_save_failed", message: "llama.cpp returned 500" });
  assert.deepEqual(lines, [
    "[gate] local host slot_save_failed: disk full",
    "[gate] local host slot_save_failed: disk full. Repeated 2 times since it started.",
    "[gate] local host slot_save_failed: llama.cpp returned 500",
  ]);
});

test("one failing site does not mute another site's first line", () => {
  const lines = [];
  const report = sink(lines, 10);
  for (let i = 0; i < 5; i += 1) report({ kind: "slot_erase_failed", message: "fetch failed" });
  report({ kind: "state_lookup_failed", message: "manifest unreadable" });
  assert.deepEqual(lines, [
    "[gate] local host slot_erase_failed: fetch failed",
    "[gate] local host state_lookup_failed: manifest unreadable",
  ]);
});

test("a malformed diagnostic still reports", () => {
  const lines = [];
  sink(lines, 2)({});
  assert.deepEqual(lines, ["[gate] local host unknown: "]);
});

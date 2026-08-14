import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearOwnerFile, describeOwnerConflict, ownerFilePath, readOwnerFile, writeOwnerFile } from "../src/instance-owner.mjs";

function tempHome() {
  return mkdtempSync(path.join(os.tmpdir(), "modeldock-owner-"));
}

test("write/read/clear round-trips the owner record", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = writeOwnerFile(4097, { root: "D:/somewhere/checkout", home });
  assert.equal(file, ownerFilePath(4097, home));
  const record = readOwnerFile(4097, { home });
  assert.equal(record.pid, process.pid);
  assert.equal(record.port, 4097);
  assert.equal(clearOwnerFile(4097, { home }), true);
  assert.equal(existsSync(file), false);
});

test("MODELDOCK_STATE_DIR redirects the record, and an explicit home still wins", (t) => {
  const stateDir = tempHome();
  const home = tempHome();
  const previous = process.env.MODELDOCK_STATE_DIR;
  process.env.MODELDOCK_STATE_DIR = stateDir;
  t.after(() => {
    if (previous === undefined) delete process.env.MODELDOCK_STATE_DIR;
    else process.env.MODELDOCK_STATE_DIR = previous;
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // A spawned gateway passes no home, so the redirect keeps its record out of
  // the real ~/.modeldock - that leak was one file per mock-install test run.
  assert.equal(ownerFilePath(4097), path.join(stateDir, "owner-4097.json"));
  assert.equal(writeOwnerFile(4097, { root: "D:/checkout" }), path.join(stateDir, "owner-4097.json"));
  assert.equal(readOwnerFile(4097).root, path.resolve("D:/checkout"));

  // The unit tests here pass home explicitly and must stay hermetic even when
  // the variable is set in the surrounding environment.
  assert.equal(ownerFilePath(4097, home), path.join(home, ".modeldock", "owner-4097.json"));
  assert.equal(readOwnerFile(4097, { home }), undefined, "explicit home sees its own (empty) directory");
});

test("clearOwnerFile leaves another process's record alone", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeOwnerFile(4097, { root: "D:/a", pid: 999999, home });
  assert.equal(clearOwnerFile(4097, { home }), false, "a bystander must not clobber the record");
  assert.equal(readOwnerFile(4097, { home }).pid, 999999);
});

test("describeOwnerConflict flags a live foreign owner and ignores stale/same ones", (t) => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  // Same root: no conflict regardless of pid.
  writeOwnerFile(4097, { root: "D:/repo", pid: process.pid, home });
  assert.equal(describeOwnerConflict(4097, "D:/repo", { home }), undefined);

  // Different root + live pid (ourselves stands in for a live process): conflict.
  writeOwnerFile(4097, { root: "D:/other-checkout", pid: process.pid, home });
  const conflict = describeOwnerConflict(4097, "D:/repo", { home });
  assert.ok(conflict);
  assert.match(conflict.message, /other-checkout/);

  // Different root but dead pid: stale record, not a conflict.
  writeOwnerFile(4097, { root: "D:/other-checkout", pid: 999999, home });
  assert.equal(describeOwnerConflict(4097, "D:/repo", { home }), undefined);

  // No file at all.
  assert.equal(describeOwnerConflict(4200, "D:/repo", { home }), undefined);
});

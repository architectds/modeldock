// Lifecycle orchestration deliberately receives every side effect as an
// injected operation. The first implementation can therefore prove state and
// rollback semantics before it receives authority to control a real process.

import {
  abortHostApply,
  beginHostApply,
  beginHostRecovery,
  markHostApplying,
  markHostDegraded,
  markHostVerified,
  markHostVerifying,
} from "./local-hosts.mjs";

const REQUIRED_OPERATIONS = ["drain", "stop", "start", "verify", "persist"];

function failureText(error) {
  return error instanceof Error && error.message ? error.message : String(error || "Local host lifecycle operation failed.");
}

function assertOperations(operations) {
  for (const name of REQUIRED_OPERATIONS) {
    if (typeof operations?.[name] !== "function") throw new TypeError(`Local host runner needs a ${name} operation.`);
  }
  return operations;
}

function assertVerificationOperations(operations) {
  for (const name of ["verify", "persist"]) {
    if (typeof operations?.[name] !== "function") throw new TypeError(`Local host runner needs a ${name} operation.`);
  }
  return operations;
}

async function persist(operations, record) {
  await operations.persist(record);
  return record;
}

function verified(result) {
  return result === true || result?.ok === true;
}

async function startAndVerify(record, operations) {
  await operations.start(record.desiredSpec, record);
  record = markHostVerifying(record);
  await persist(operations, record);
  const result = await operations.verify(record.desiredSpec, record);
  if (!verified(result)) throw new Error("Local host verification did not report success.");
  record = markHostVerified(record);
  await persist(operations, record);
  return record;
}

// Takeover verification proves that the observed process is actually the host
// ModelDock intends to manage. It does not stop or start anything, so a failed
// first verification never disturbs a manually launched engine.
export async function verifyLocalHost(record, suppliedOperations) {
  const operations = assertVerificationOperations(suppliedOperations);
  if (record?.state !== "verifying") throw new TypeError("Only a verifying local host can be verified.");
  try {
    const result = await operations.verify(record.desiredSpec, record);
    if (!verified(result)) throw new Error("Local host verification did not report success.");
    const ready = markHostVerified(record);
    await persist(operations, ready);
    return { outcome: "verified", record: ready };
  } catch (error) {
    const degraded = markHostDegraded(record, { failure: failureText(error) });
    await persist(operations, degraded);
    return { outcome: "degraded", record: degraded, failure: degraded.failure };
  }
}

// Applies one already-authorized desired specification. It never schedules or
// starts an engine itself. If a replacement was begun but cannot verify, it
// attempts the persisted last-known-good specification exactly once. If drain
// failed before the old host was stopped, it leaves that host alone.
export async function applyLocalHostPlan(record, { desiredSpec, policy } = {}, suppliedOperations) {
  const operations = assertOperations(suppliedOperations);
  let current = beginHostApply(record, { desiredSpec, policy });
  await persist(operations, current);
  let replacementStarted = false;
  try {
    await operations.drain(current);
    current = markHostApplying(current);
    await persist(operations, current);
    replacementStarted = true;
    await operations.stop(current);
    current = await startAndVerify(current, operations);
    return { outcome: "applied", record: current };
  } catch (error) {
    const failure = failureText(error);
    if (!replacementStarted) {
      current = abortHostApply(current, { failure });
      await persist(operations, current);
      return { outcome: "unchanged", record: current, failure };
    }
    if (!current.lastKnownGoodSpec) {
      current = markHostDegraded(current, { failure });
      await persist(operations, current);
      return { outcome: "degraded", record: current, failure };
    }
    try {
      current = beginHostRecovery(current, { reason: failure });
      await persist(operations, current);
      await operations.stop(current);
      current = await startAndVerify(current, operations);
      return { outcome: "recovered", record: current, failure };
    } catch (recoveryError) {
      const recoveryFailure = failureText(recoveryError);
      current = markHostDegraded(current, { failure: recoveryFailure });
      await persist(operations, current);
      return { outcome: "degraded", record: current, failure, recoveryFailure };
    }
  }
}

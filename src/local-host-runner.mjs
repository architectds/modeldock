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
  record = markHostVerified(record, {
    capabilities: result?.capabilities
      ? { ...record.capabilities, ...result.capabilities }
      : record.capabilities,
  });
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
    const ready = markHostVerified(record, {
      capabilities: result?.capabilities
        ? { ...record.capabilities, ...result.capabilities }
        : record.capabilities,
    });
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
// attempts the persisted immutable pre-takeover specification exactly once. If drain
// failed before the old host was stopped, it leaves that host alone.
export async function applyLocalHostPlan(record, { desiredSpec, desiredProfile = null, policy } = {}, suppliedOperations) {
  const operations = assertOperations(suppliedOperations);
  let current = beginHostApply(record, { desiredSpec, desiredProfile, policy });
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
      // A degraded host that never replaced its original process has no
      // activeSpec to abort back to - abortHostApply throws on that record,
      // and before this guard the TypeError escaped unstructured with the
      // record already persisted as "draining", where every later apply and
      // unmanage refused it until a gateway restart (reproduced live).
      // Degraded is the honest resting state: boot reconciliation and the
      // unmanage release path both know what to do with it.
      if (!current.activeSpec) {
        current = markHostDegraded(current, { failure });
        await persist(operations, current);
        return { outcome: "degraded", record: current, failure };
      }
      current = abortHostApply(current, { failure });
      await persist(operations, current);
      return { outcome: "unchanged", record: current, failure };
    }
    if (!current.preTakeoverSpec) {
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

// Resume a transaction whose gateway process exited between durable lifecycle
// boundaries. A verified desired process is promoted; otherwise the exact
// pre-takeover command is restored once. This is intentionally separate from
// normal apply so a boot reconciliation never invents a new profile.
export async function reconcileInterruptedLocalHost(record, suppliedOperations) {
  const operations = assertOperations(suppliedOperations);
  const state = record?.state;
  if (!["draining", "applying", "verifying", "recovering"].includes(state)) {
    return { outcome: "unchanged", record };
  }
  let current = record;
  try {
    if (state === "draining" && current.activeSpec) {
      const activeResult = await operations.verify(current.activeSpec, {
        ...current,
        desiredSpec: current.activeSpec,
        desiredProfile: current.activeProfile,
      });
      if (verified(activeResult)) {
        current = abortHostApply(current, { failure: "Interrupted before the replacement was started." });
        await persist(operations, current);
        return { outcome: "unchanged", record: current };
      }
    } else {
      if (["applying", "recovering"].includes(current.state)) {
        current = markHostVerifying(current);
        await persist(operations, current);
      }
      const desiredResult = await operations.verify(current.desiredSpec, current);
      if (verified(desiredResult)) {
        current = markHostVerified(current, {
          capabilities: desiredResult?.capabilities
            ? { ...current.capabilities, ...desiredResult.capabilities }
            : current.capabilities,
        });
        await persist(operations, current);
        return { outcome: state === "recovering" ? "recovered" : "applied", record: current };
      }
    }
  } catch {
    // The recovery branch below is the only automatic fallback.
  }
  try {
    if (current.state !== "recovering") {
      current = beginHostRecovery(current, { reason: "interrupted_transition" });
      await persist(operations, current);
    }
    await operations.stop(current);
    current = await startAndVerify(current, operations);
    return { outcome: "recovered", record: current };
  } catch (error) {
    current = markHostDegraded(current, { failure: failureText(error) });
    await persist(operations, current);
    return { outcome: "degraded", record: current, failure: current.failure };
  }
}

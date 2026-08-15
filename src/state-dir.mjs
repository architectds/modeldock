import os from "node:os";
import path from "node:path";

// Where ModelDock keeps its per-install state: owner records, the caller key, the
// published catalog, the Ollama snapshot, compaction reports. MODELDOCK_STATE_DIR
// redirects the whole directory so a spawned test gateway (the mock-install test
// runs the real installer, which starts a real gateway) keeps its bookkeeping in
// its own throwaway root instead of littering the user's ~/.modeldock.
//
// This lived as an inline ternary in six modules, and the copies had already
// drifted: every one but the doctor's resolved the override to an absolute path,
// so a relative MODELDOCK_STATE_DIR sent the doctor looking in a different
// directory than the gateway writes to. One definition means the redirect cannot
// mean two things.
//
// `home` is an explicit HOME directory (the state dir is its .modeldock child),
// which keeps unit tests hermetic even when the variable is set around them.
export function stateDir({ home } = {}) {
  if (home !== undefined) return path.join(home, ".modeldock");
  if (process.env.MODELDOCK_STATE_DIR) return path.resolve(process.env.MODELDOCK_STATE_DIR);
  return path.join(os.homedir(), ".modeldock");
}

// A file inside the state directory.
export function stateFile(name, options) {
  return path.join(stateDir(options), name);
}

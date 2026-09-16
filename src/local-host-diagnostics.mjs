// One sink for managed-host diagnostics, so a transient engine outage cannot bury
// the log. The KV coordinator reports every failed llama.cpp call, which is
// right: a dropped checkpoint must never pass silently. But one unreachable
// engine retried once per turn and filled this log with 600 identical
// slot_erase_failed lines, pushing everything else off the visible tail. Print
// the first occurrence of a failure verbatim, then count the rest, and start
// over when the failure changes shape.
export function createLocalHostDiagnosticSink({ log = (...args) => console.log(...args), repeatEvery = 50 } = {}) {
  const seen = new Map();
  return function onLocalHostDiagnostic({ kind, message } = {}) {
    const key = String(kind || "unknown");
    const text = String(message || "");
    let entry = seen.get(key);
    if (!entry || entry.message !== text) {
      entry = { message: text, count: 0 };
      seen.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > 1 && entry.count % repeatEvery !== 0) return;
    const repeats = entry.count > 1 ? `. Repeated ${entry.count} times since it started.` : "";
    log(`[gate] local host ${key}: ${text}${repeats}`);
  };
}

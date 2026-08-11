#!/usr/bin/env node
// Delete memory units in a disposable node (e.g. the benchmark scope written
// through MODELDOCK_MEMORY_SCOPE), so a test run leaves no content residue in
// the shared vault. The vault is default-on; an explicit MODELDOCK_MEMORY=0
// disables it (and this cleanup refuses to run).
//
//   node scripts/memory-cleanup.mjs --scope "D:\bench\deepswe"

import { loadConfig } from "../src/config.mjs";
import { memoryStoreFor } from "../src/memory.mjs";

const argv = process.argv.slice(2);
const idx = argv.indexOf("--scope");
if (idx === -1 || !argv[idx + 1]) {
  console.error("usage: node scripts/memory-cleanup.mjs --scope <scope>");
  process.exit(2);
}
const scope = argv[idx + 1];

const config = loadConfig();
if (!config.memoryEnabled) {
  console.error("memory is disabled via MODELDOCK_MEMORY=0; remove it or set MODELDOCK_MEMORY=1 to re-enable");
  process.exit(1);
}

const store = memoryStoreFor(config);
try {
  console.log(JSON.stringify({
    scope,
    ...store.purgeScope(scope),
  }));
} finally {
  store.close();
}

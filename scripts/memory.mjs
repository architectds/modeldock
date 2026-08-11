#!/usr/bin/env node
// Memory vault CLI: capture, status, and recall.
//
//   node scripts/memory.mjs status
//   node scripts/memory.mjs capture
//   node scripts/memory.mjs search "QCM baseline" [--scope D:\projects\stockscan] [--limit 8]

import { loadConfig } from "../src/config.mjs";
import { memoryStoreFor } from "../src/memory.mjs";

const config = loadConfig();
if (!config.memoryEnabled) {
  console.log("Memory vault is disabled via MODELDOCK_MEMORY=0; remove it or set MODELDOCK_MEMORY=1 in .env to re-enable.");
  process.exit(0);
}

const store = memoryStoreFor(config);
const [command, ...rest] = process.argv.slice(2);

if (command === "capture") {
  console.log(JSON.stringify(store.captureCodexMemories(config.codexHome), null, 2));
} else if (command === "status") {
  console.log(JSON.stringify(store.status(), null, 2));
} else if (command === "search") {
  const scopeIndex = rest.indexOf("--scope");
  const limitIndex = rest.indexOf("--limit");
  const scope = scopeIndex >= 0 ? rest[scopeIndex + 1] : undefined;
  const limit = limitIndex >= 0 ? Number(rest[limitIndex + 1]) : 8;
  const skip = new Set();
  if (scopeIndex >= 0) { skip.add(scopeIndex); skip.add(scopeIndex + 1); }
  if (limitIndex >= 0) { skip.add(limitIndex); skip.add(limitIndex + 1); }
  const terms = rest.filter((_, index) => !skip.has(index));
  if (!terms.length) {
    console.log("usage: node scripts/memory.mjs search <query> [--scope <dir>] [--limit <n>]");
    process.exit(1);
  }
  const result = store.search({ query: terms.join(" "), scopeDir: scope, limit });
  console.log(result.text);
} else {
  console.log("usage: node scripts/memory.mjs {status|capture|search}");
  process.exit(1);
}

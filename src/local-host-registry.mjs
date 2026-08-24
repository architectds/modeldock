// Durable storage for declared local-host authority. This registry contains
// configuration and lifecycle facts only; it never probes, starts, stops, or
// exposes a local engine.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeLocalHostRecord } from "./local-hosts.mjs";

export const LOCAL_HOST_REGISTRY_VERSION = 2;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function copy(value) {
  return structuredClone(value);
}

export function createLocalHostRegistry({ hosts = {} } = {}) {
  if (!hosts || Array.isArray(hosts) || typeof hosts !== "object") {
    throw new TypeError("Local host registry hosts must be an object.");
  }
  const normalizedHosts = {};
  for (const id of Object.keys(hosts).sort()) {
    const record = normalizeLocalHostRecord(hosts[id]);
    if (record.id !== id) throw new TypeError(`Registry host key does not match record id: ${id}.`);
    normalizedHosts[id] = record;
  }
  return { version: LOCAL_HOST_REGISTRY_VERSION, hosts: normalizedHosts };
}

export function upsertLocalHost(registry, record) {
  const normalized = normalizeLocalHostRecord(record);
  return createLocalHostRegistry({
    hosts: {
      ...(registry?.hosts || {}),
      [normalized.id]: normalized,
    },
  });
}

export function removeLocalHost(registry, hostId) {
  const id = text(hostId);
  if (!id) throw new TypeError("A local host id is required.");
  const hosts = { ...(registry?.hosts || {}) };
  delete hosts[id];
  return createLocalHostRegistry({ hosts });
}

export async function readLocalHostRegistry(file) {
  const target = text(file);
  if (!target) throw new TypeError("A local host registry path is required.");
  let source;
  try {
    source = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return createLocalHostRegistry();
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError("Local host registry is not valid JSON.");
  }
  if (parsed?.version !== LOCAL_HOST_REGISTRY_VERSION) {
    throw new TypeError(`Unsupported local host registry version: ${parsed?.version ?? "(missing)"}.`);
  }
  return createLocalHostRegistry(parsed);
}

export async function writeLocalHostRegistry(file, registry) {
  const target = text(file);
  if (!target) throw new TypeError("A local host registry path is required.");
  const normalized = createLocalHostRegistry(registry);
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return copy(normalized);
}

import { BlockList, isIP } from "node:net";

// Gateway binding stays loopback-only. Explicit inference endpoints may also
// use private LAN literals; that permission must not widen the gateway bind.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_NETWORKS.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_NETWORKS.addSubnet("192.168.0.0", 16, "ipv4");
PRIVATE_NETWORKS.addSubnet("fc00::", 7, "ipv6");

// The spelling a host needs inside a URL: IPv6 literals get their brackets
// back ("::1" -> "[::1]"). Shared by the server's guards and the services
// wiring, which both build the gateway's own URL from config.host.
export function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function isLoopbackHost(value) {
  // Accept both spellings of an IPv6 literal: URL.hostname yields "[::1]", while a
  // host read straight from an env var or a config field has no brackets.
  const host = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(host);
}

export function isLocalNetworkHost(value) {
  if (isLoopbackHost(value)) return true;
  const host = String(value || "").trim().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  return Boolean(family && PRIVATE_NETWORKS.check(host, family === 6 ? "ipv6" : "ipv4"));
}

// Compare the network identity of two endpoint URLs while deliberately
// ignoring their API paths (/v1, /props, and so on).
export function sameEndpointHost(left, right) {
  if (!left || !right) return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    const hostKey = (url) => {
      const hostname = isLoopbackHost(url.hostname)
        ? "loopback"
        : url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      return `${hostname}:${url.port}`;
    };
    return hostKey(leftUrl) === hostKey(rightUrl);
  } catch {
    return false;
  }
}

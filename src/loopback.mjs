// Which hosts count as this machine.
//
// Two rules lean on that answer, in opposite directions: plaintext http is allowed
// only to loopback (the gateway's own bind address, an Ollama base URL, a custom
// endpoint), and remote image fetches are allowed only *away* from loopback. The
// membership test behind both was written out five times - config.mjs, ollama.mjs,
// custom-endpoint.mjs twice, media-store.mjs - and the copies had already drifted:
// media-store stripped the brackets URL.hostname puts around an IPv6 literal, the
// others did not, so `http://[::1]:11434` failed the check and was refused as a
// remote plaintext endpoint. A security rule kept in five places is a rule that
// gets changed in one.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

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

// Compare the network identity of two endpoint URLs while deliberately
// ignoring their API paths (/v1, /props, and so on).
export function sameEndpointHost(left, right) {
  if (!left || !right) return false;
  try {
    return new URL(left).host === new URL(right).host;
  } catch {
    return false;
  }
}

import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { loadConfig } from "./config.mjs";
import { MediaStore } from "./media-store.mjs";
import { CodexAttachmentIndex } from "./codex-attachment-index.mjs";
import { Metrics } from "./metrics.mjs";
import { createMcpNodeHandler } from "./mcp.mjs";
import { createUpstreams } from "./upstreams.mjs";
import { memoryStoreFor } from "./memory.mjs";

function urlHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

// Standalone MCP sidecar. Serves only /mcp (streamable HTTP) plus /healthz, so
// Codex can consume web / vision / audio tools without any Responses gateway in
// the loop. The dashboard and config switch are wired in Phase 3's server; this
// entry is the minimal tool surface.
export async function startMcpServer(config = loadConfig(), {
  port = Number(process.env.MODELDOCK_MCP_PORT || 4100),
  upstreams: injectedUpstreams = null,
  metrics: injectedMetrics = null,
  mediaStore: injectedMediaStore = null,
} = {}) {
  const metrics = injectedMetrics || new Metrics({ recentLimit: config.recentLimit });
  const attachmentIndex = new CodexAttachmentIndex({ codexHome: config.codexHome });
  const mediaStore = injectedMediaStore || new MediaStore({
    ttlMs: config.mediaTtlMs,
    maxBytes: config.mediaMaxBytes,
    maxEntries: config.mediaMaxEntries,
    maxStoredBytes: config.mediaMaxStoredBytes,
    stateDir: config.mediaDir,
    externalRoots: attachmentIndex.roots,
  });
  const memoryStore = injectedUpstreams ? null : memoryStoreFor(config);
  const upstreams = injectedUpstreams || createUpstreams({
    config,
    metrics,
    mediaStore,
    memoryStore,
    getVisionModel: () => config.visionModel,
    getSessionSeed: () => null,
  });
  const app = createMcpExpressApp({ host: config.host, jsonLimit: "25mb" });
  app.disable("x-powered-by");

  const mcpHandler = createMcpNodeHandler({
    upstreams,
    onError: (error) => {
      metrics.recent.unshift({
        id: "mcp",
        kind: "mcp",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      metrics.recent.length = Math.min(metrics.recent.length, metrics.recentLimit);
      metrics.emit("change");
    },
  });

  app.all("/mcp", (req, res) => mcpHandler(req, res, req.body));
  app.get("/healthz", (_req, res) => {
    const tokenReady = Boolean(config.tokens && Object.values(config.tokens).some(Boolean));
    return res.status(tokenReady ? 200 : 503).json({ ok: tokenReady });
  });

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, config.host, () => resolve(listener));
    listener.once("error", reject);
  });
  const actualPort = server.address().port;
  return {
    app,
    server,
    services: { config, metrics, mediaStore, upstreams, memoryStore, attachmentIndex },
    url: `http://${urlHost(config.host)}:${actualPort}`,
    async stop() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("src/mcp-server.mjs")) {
  const instance = await startMcpServer();
  console.log(`ModelDock MCP sidecar listening at ${instance.url}/mcp`);
  const missingTokens = Object.entries(instance.services.config.tokens || {})
    .filter(([, token]) => !token)
    .map(([provider]) => provider);
  if (missingTokens.length) console.warn(`Tokens missing for provider(s): ${missingTokens.join(", ")}; vision calls will fail until configured.`);
}

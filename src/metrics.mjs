import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { forEachSseEvent } from "./sse.mjs";

function emptyBucket() {
  return { total: 0, ok: 0, errors: 0, active: 0, latencyMs: 0, lastLatencyMs: 0 };
}

export class Metrics extends EventEmitter {
  constructor({ recentLimit = 50 } = {}) {
    super();
    this.startedAt = Date.now();
    this.recentLimit = recentLimit;
    this.responses = {
      ...emptyBucket(),
      streaming: 0,
      // Legacy bytesIn/bytesOut remain the dashboard's client-facing totals.
      // The explicit legs below keep compressed ingress, provider traffic and
      // reframed client output from being collapsed into one misleading number.
      bytesIn: 0,
      bytesOut: 0,
      ingressWireBytes: 0,
      ingressLogicalBytes: 0,
      upstreamRequestBytes: 0,
      upstreamResponseBytes: 0,
      clientResponseBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
      filteredToolSearch: 0,
      filteredWebSearch: 0,
      rewrittenToolChoice: 0,
      droppedAssistantMessages: 0,
      nativeToolCalls: 0,
      nativeToolOutputs: 0,
      fallbackToolResults: 0,
      imageAttachments: 0,
      receivedImages: 0,
      forwardedImages: 0,
      receivedImageWireBytes: 0,
      forwardedImageWireBytes: 0,
      imageReferences: 0,
      directVisionRoutes: 0,
      toolContinuations: 0,
    };
    this.web = emptyBucket();
    this.vision = { ...emptyBucket(), byModel: {} };
    this.memory = emptyBucket();
    this.recent = [];
  }

  begin(kind, meta = {}) {
    const bucket = this[kind];
    if (!bucket) throw new Error(`Unknown metric kind: ${kind}`);
    bucket.total += 1;
    bucket.active += 1;
    const record = {
      id: randomUUID().slice(0, 8),
      kind,
      startedAt: Date.now(),
      status: "active",
      ...meta,
    };
    this.recent.unshift(record);
    this.recent.length = Math.min(this.recent.length, this.recentLimit);
    this.emit("change");

    let finished = false;
    let firstResponseMarked = false;
    const markFirstResponse = () => {
      if (firstResponseMarked) return;
      firstResponseMarked = true;
      record.firstResponseLatencyMs = Math.max(0, Date.now() - record.startedAt);
      this.emit("change");
    };
    const finish = (result = {}) => {
      if (finished) return;
      finished = true;
      const latencyMs = Date.now() - record.startedAt;
      bucket.active = Math.max(0, bucket.active - 1);
      bucket.latencyMs += latencyMs;
      bucket.lastLatencyMs = latencyMs;
      const ok = result.ok !== false;
      bucket[ok ? "ok" : "errors"] += 1;
      Object.assign(record, result, { latencyMs, status: ok ? "ok" : "error", finishedAt: Date.now() });
      this.emit("change");
    };
    finish.markFirstResponse = markFirstResponse;
    return finish;
  }

  recordResponseTransform(report, { bytesIn = 0, wireBytes = bytesIn, logicalBytes = null, upstreamRequestBytes = 0, streaming = false, routeReason } = {}) {
    this.responses.bytesIn += wireBytes;
    this.responses.ingressWireBytes += wireBytes;
    this.responses.ingressLogicalBytes += Number(logicalBytes || 0);
    this.responses.upstreamRequestBytes += upstreamRequestBytes;
    this.responses.filteredToolSearch += report.blocked.tool_search;
    this.responses.filteredWebSearch += report.blocked.web_search;
    this.responses.rewrittenToolChoice += report.toolChoiceRewritten ? 1 : 0;
    this.responses.droppedAssistantMessages += Number(report.droppedAssistantMessages || 0);
    this.responses.nativeToolCalls += Number(report.nativeToolCalls || 0);
    this.responses.nativeToolOutputs += Number(report.nativeToolOutputs || 0);
    this.responses.fallbackToolResults += Number(report.fallbackToolResults || 0);
    const received = report.imageTransfer?.received;
    const forwarded = report.imageTransfer?.forwarded;
    this.responses.imageAttachments += Number(received?.images ?? report.imageRefs.length);
    this.responses.receivedImages += Number(received?.images || 0);
    this.responses.forwardedImages += Number(forwarded?.images || 0);
    this.responses.receivedImageWireBytes += Number(received?.imageWireBytes || 0);
    this.responses.forwardedImageWireBytes += Number(forwarded?.imageWireBytes || 0);
    this.responses.imageReferences += Number(forwarded?.imageReferences || 0);
    this.responses.directVisionRoutes += report.directVision ? 1 : 0;
    this.responses.toolContinuations += routeReason === "tool_continuation" ? 1 : 0;
    this.responses.streaming += streaming ? 1 : 0;
  }

  recordResponseUsage({ bytesOut = 0, upstreamBytes = bytesOut, usage } = {}) {
    this.responses.bytesOut += bytesOut;
    this.responses.clientResponseBytes += bytesOut;
    this.responses.upstreamResponseBytes += upstreamBytes;
    if (usage) {
      this.responses.inputTokens += Number(usage.input_tokens || 0);
      this.responses.outputTokens += Number(usage.output_tokens || 0);
    }
  }

  recordVisionModel(model) {
    this.vision.byModel[model] = (this.vision.byModel[model] || 0) + 1;
  }

  snapshot(extra = {}) {
    const average = (bucket) => (bucket.ok + bucket.errors ? Math.round(bucket.latencyMs / (bucket.ok + bucket.errors)) : 0);
    return {
      now: Date.now(),
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      responses: { ...this.responses, averageLatencyMs: average(this.responses) },
      web: { ...this.web, averageLatencyMs: average(this.web) },
      vision: { ...this.vision, byModel: { ...this.vision.byModel }, averageLatencyMs: average(this.vision) },
      recent: this.recent.map((item) => ({ ...item })),
      ...extra,
    };
  }
}

export function extractResponseUsage(body) {
  if (!body || typeof body !== "object") return undefined;
  return body.usage || body.response?.usage;
}

export function extractUsageFromSse(text) {
  let usage;
  forEachSseEvent(text, (event) => {
    usage = extractResponseUsage(event) || usage;
  });
  return usage;
}

import { bareModelId, providerForModel, tokenFor, profileById } from "./profiles.mjs";
import { VISION_EVIDENCE_INSTRUCTIONS, VISION_EVIDENCE_MAX_CHARS } from "./vision-evidence.mjs";
import { visionCacheKey, visionEvidenceCache } from "./vision-cache.mjs";
function upstreamUrl(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function safeErrorBody(text) {
  return String(text || "").replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]").slice(0, 1_000);
}

export function extractOutputText(response) {
  const texts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      if ((part?.type === "output_text" || part?.type === "text") && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

export function parseMcpTextResult(body) {
  const payloads = [];
  const trimmed = String(body || "").trim();
  if (trimmed.startsWith("{")) payloads.push(trimmed);
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith("data:")) payloads.push(line.slice(5).trim());
  }

  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload);
      const content = parsed?.result?.content;
      if (!Array.isArray(content)) continue;
      const texts = content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text);
      if (texts.length) return texts.join("\n");
    } catch {
      // Try the next JSON or SSE payload.
    }
  }
  return "";
}

export function createUpstreams({ config, metrics, mediaStore, memoryStore = null, getVisionModel = () => config.visionModel, visionCache = visionEvidenceCache }) {
  async function recallMemory(args) {
    const finish = metrics.begin("memory", { operation: "recall_memory", query: String(args.query || "").slice(0, 160) });
    try {
      const result = memoryStore.search({
        query: args.query,
        scopeDir: args.scope_dir,
        limit: args.limit || 8,
        scopeOnly: args.scope_only === true,
      });
      finish({ ok: true, hits: result.count, outputBytes: Buffer.byteLength(result.text) });
      return result.text;
    } catch (error) {
      finish({ ok: false, error: error.message });
      throw error;
    }
  }

  async function storeMemory(args) {
    const finish = metrics.begin("memory", { operation: "store_memory", kind: String(args.kind || "knowledge") });
    try {
      const result = memoryStore.storeMemory({
        content: args.content,
        scopeDir: args.scope_dir,
        kind: args.kind,
        key: args.key,
      });
      finish({ ok: true, stored: !result.skipped, revision: result.revision, units: result.units || 0 });
      return result;
    } catch (error) {
      finish({ ok: false, error: error.message });
      throw error;
    }
  }

  async function learnMemory(args) {
    const finish = metrics.begin("memory", { operation: "learn", path: String(args.path || "").slice(0, 160) });
    try {
      const result = memoryStore.learn({ path: args.path, scopeDir: args.scope_dir });
      finish({ ok: true, ingested: result.ingested, skipped: result.skipped, units: result.units });
      return result;
    } catch (error) {
      finish({ ok: false, error: error.message });
      throw error;
    }
  }

  async function searchWeb(args) {
    const finish = metrics.begin("web", { operation: "web_search_exa", query: args.query.slice(0, 160) });
    const endpoint = new URL(config.exaMcpUrl);
    if (config.exaApiKey) endpoint.searchParams.set("exaApiKey", config.exaApiKey);
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query: args.query,
          type: args.type || "auto",
          numResults: args.numResults || 8,
          livecrawl: args.livecrawl || "fallback",
          ...(args.contextMaxCharacters ? { contextMaxCharacters: args.contextMaxCharacters } : {}),
        },
      },
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(25_000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Exa MCP returned ${response.status}: ${safeErrorBody(body)}`);
      const output = parseMcpTextResult(body);
      if (!output) throw new Error("Exa MCP returned no text content");
      finish({ ok: true, httpStatus: response.status, outputBytes: Buffer.byteLength(output) });
      return output;
    } catch (error) {
      finish({ ok: false, error: error.message });
      throw error;
    }
  }

  const RESPONSES_MODELS = new Set(["gpt-5.6-luna", "grok-4.5", "mimo-v2.5", "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code"]);
  const ZEN_FREE_BASE = `${(config.zenBaseUrl || "https://opencode.ai/zen/v1").replace(/\/+$/, "")}/chat/completions`;

  function visionEndpointFor(model) {
    const provider = providerForModel(config, model);
    if (provider === "custom") {
      const base = (config.customBaseUrl || "").replace(/\/+$/, "");
      if (base) return { url: `${base}/responses`, style: "responses" };
    }
    if (provider === "deepseek-official") return { url: upstreamUrl(config.deepseekBaseUrl || profileById("deepseek-official").baseUrl, "responses"), style: "responses" };
    const opencodeBase = config.opencodeBaseUrl || config.goBaseUrl;
    // The selected model may be the published slug (gpt-5.6-luna@opencode-go); the
    // endpoint tables key on the bare id the upstream actually serves.
    const upstream = bareModelId(model);
    if (upstream.endsWith("-free") || upstream === "big-pickle") return { url: ZEN_FREE_BASE, style: "chat" };
    if (RESPONSES_MODELS.has(upstream)) return { url: upstreamUrl(opencodeBase, "responses"), style: "responses" };
    return { url: upstreamUrl(opencodeBase, "chat/completions"), style: "chat" };
  }

  async function callVisionModel(model, images, prompt) {
    const token = tokenFor(config, model);
    if (!token) throw new Error(`No token configured for provider of ${model}`);
    const { url, style } = visionEndpointFor(model);
    // Send the bare id upstream; the @provider suffix is a routing address for this
    // gate, never part of the model name an upstream API knows.
    const common = { model: bareModelId(model), max_output_tokens: 4_096, stream: false };
    if (style === "responses") {
      const content = [{ type: "input_text", text: prompt }];
      for (const image of images) content.push({ type: "input_image", image_url: image.imageUrl });
      common.input = [{ role: "user", content }];
    } else {
      const content = [{ type: "text", text: prompt }];
      for (const image of images) content.push({ type: "image_url", image_url: { url: image.imageUrl } });
      common.messages = [{ role: "user", content }];
      common.max_tokens = 4_096;
      delete common.max_output_tokens;
    }
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(common),
      signal: AbortSignal.timeout(config.visionTimeoutMs),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${model} returned ${response.status}: ${safeErrorBody(raw)}`);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${model} returned invalid JSON`);
    }
    const answer = style === "responses"
      ? extractOutputText(parsed)
      : (parsed.choices?.[0]?.message?.content ?? "");
    if (!answer) throw new Error(`${model} returned no output text`);
    return { answer, responseId: parsed.id, usage: parsed.usage };
  }

  async function inspectVision({ image_ref, compare_image_ref, path, question, mode = "general" }) {
    const { readFileSync, existsSync, statSync } = await import("node:fs");
    const { extname, resolve, isAbsolute } = await import("node:path");

    const loaded = [];
    const refs = [];
    const skipped = [];
    const pushRef = (ref) => { if (ref) { refs.push(ref); return ref; } return null; };
    const loadPath = (filePath) => {
      if (!filePath) return null;
      const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);
      if (!existsSync(absolute)) throw new Error(`Image path not found: ${absolute}`);
      const stat = statSync(absolute);
      if (!stat.isFile()) throw new Error(`Image path is not a file: ${absolute}`);
      const ext = extname(absolute).toLowerCase();
      // Only read recognized image types. Falling back to image/png for anything
      // let a (possibly prompt-injected) model exfiltrate arbitrary local files
      // (keys, /etc/shadow, .env) to the upstream vision model as "an image".
      const mimeByExt = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
      const mime = mimeByExt[ext];
      if (!mime) throw new Error(`Unsupported image type: ${absolute} (allowed: jpg, jpeg, png, gif, webp, bmp)`);
      const bytes = readFileSync(absolute);
      if (bytes.byteLength > mediaStore.maxBytes) throw new Error(`Image exceeds the ${mediaStore.maxBytes}-byte limit: ${absolute}`);
      return `data:${mime};base64,${bytes.toString("base64")}`;
    };

    if (path) {
      try {
        const dataUrl = loadPath(path);
        const ref = pushRef(mediaStore.put(dataUrl));
        loaded.push({ ref, imageUrl: dataUrl });
      } catch (error) {
        skipped.push(error.message);
      }
    }
    if (image_ref) {
      pushRef(image_ref);
      const item = mediaStore.get(image_ref);
      if (item) loaded.push(item);
      else skipped.push(`Unknown or expired image_ref: ${image_ref}`);
    }
    if (compare_image_ref) {
      pushRef(compare_image_ref);
      const item = mediaStore.get(compare_image_ref);
      if (item) loaded.push(item);
      else skipped.push(`Unknown or expired image_ref: ${compare_image_ref}`);
    }
    if (!loaded.length) {
      throw new Error(skipped.length ? `vision_inspect: every image failed to load - ${skipped.join(" | ")}` : "vision_inspect requires path, image_ref, or compare_image_ref");
    }

    const images = loaded;
    const finish = metrics.begin("vision", { operation: "vision_inspect", mode, imageRefs: refs });
    // Evidence contract: a text-only model relies on this transcription alone,
    // so the vision model must report structure and uncertainty verbatim instead
    // of inventing details. Cached per image set + question so multi-turn
    // sessions re-reading the same screenshot pay the vision model once.
    const prompt = [
      `Vision task mode: ${mode}.`,
      VISION_EVIDENCE_INSTRUCTIONS,
      `Question: ${question || "(none - transcribe the image)"}`,
    ].join("\n");
    const models = [...new Set([getVisionModel(), config.visionFallbackModel].filter(Boolean))];
    const failures = [];
    const note = skipped.length ? { skippedImages: skipped } : {};

    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const cacheKey = visionCacheKey({ images: images.map((item) => item.imageUrl), prompt, model });
      const cached = visionCache.get(cacheKey);
      if (cached !== undefined) {
        metrics.recordVisionModel(model, false);
        finish({ ok: true, model, fallbackUsed: false, inputImages: images.length, skipped: skipped.length, cached: true });
        return { model, fallbackUsed: false, mode, imageRefs: refs, answer: cached, cached: true, ...note };
      }
      try {
        const result = await callVisionModel(model, images, prompt);
        const answer = result.answer.slice(0, VISION_EVIDENCE_MAX_CHARS);
        const fallbackUsed = index > 0;
        visionCache.set(cacheKey, answer);
        metrics.recordVisionModel(model, fallbackUsed);
        finish({ ok: true, model, fallbackUsed, inputImages: images.length, skipped: skipped.length, cached: false });
        return { model, fallbackUsed, mode, imageRefs: refs, answer, usage: result.usage, cached: false, ...note };
      } catch (error) {
        failures.push(`${model}: ${error.message}`);
      }
    }

    const message = failures.join(" | ");
    finish({ ok: false, error: message });
    throw new Error(message);
  }

  return { searchWeb, inspectVision, ...(memoryStore ? { recallMemory, storeMemory, learnMemory } : {}) };
}

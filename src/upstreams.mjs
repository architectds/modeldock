import { bareModelId, providerForModel, tokenFor, profileById } from "./profiles.mjs";
import { VISION_EVIDENCE_INSTRUCTIONS, VISION_EVIDENCE_MAX_CHARS } from "./vision-evidence.mjs";
import { visionCacheKey, visionEvidenceCache } from "./vision-cache.mjs";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readCodexAuth } from "./codex-auth.mjs";
import { customEndpointFor } from "./custom-endpoints.mjs";
import os from "node:os";
import path from "node:path";
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

// Native image generation for every model, not just the ones Codex hands the
// hosted image_gen tool to. Reads the signed-in ChatGPT token from the Codex
// auth file and posts to the same native images endpoint the built-in tool
// uses; the returned PNG is saved to a local file and its path returned so the
// model can surface it in the conversation.
// The ChatGPT backend behind a Codex sign-in, shared by native image generation
// and native vision. Mirrors NATIVE_BASE in gateway.mjs, which relayNativeResponses
// uses for the main relay; the two must name the same host or a native model would
// answer on the relay and 404 in the harness.
const NATIVE_BASE = process.env.CODEX_NATIVE_BASE_URL || "https://chatgpt.com/backend-api/codex";

export function createUpstreams({ config, metrics, mediaStore, memoryStore = null, getVisionModel = () => config.visionModel, visionCache = visionEvidenceCache, getNativeSlugs = () => null }) {
  async function generateImage(args) {
    const model = String(args.model || "gpt-image-1");
    const size = String(args.size || "1024x1024");
    const finish = metrics.begin("vision", { operation: "image_gen", model });
    try {
      const auth = readCodexAuth(config.codexHome || path.join(os.homedir(), ".codex"));
      const token = auth.accessToken;
      const accountId = auth.accountId;
      if (!token) {
        throw new Error(
          `No ChatGPT session token in ${auth.file}; sign in to the Codex app so native image generation can use your subscription.`,
        );
      }
      const response = await fetch(`${NATIVE_BASE}/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...(accountId ? { "chatgpt-account-id": accountId } : {}),
        },
        body: JSON.stringify({ model, prompt: args.prompt, size, n: 1 }),
        signal: AbortSignal.timeout(180_000),
      });
      const text = await response.text();
      if (!response.ok) {
        // A rejected token reads as an opaque upstream error otherwise, and the
        // access token in auth.json expires routinely - the one failure here a
        // user can actually fix, so name the fix.
        const expired = response.status === 401 || response.status === 403
          ? ` The ChatGPT session in ${auth.file} was rejected; sign in again in the Codex app.`
          : "";
        throw new Error(`Native image API returned ${response.status}: ${safeErrorBody(text)}${expired}`);
      }
      const parsed = JSON.parse(text);
      const b64 = parsed?.data?.[0]?.b64_json;
      if (!b64) throw new Error("Native image API returned no b64_json payload.");
      const dir = path.join(os.tmpdir(), "modeldock-generated");
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `img-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
      writeFileSync(file, Buffer.from(b64, "base64"));
      finish({ ok: true, httpStatus: response.status, outputBytes: b64.length });
      return `Generated image saved to ${file}`;
    } catch (error) {
      finish({ ok: false, error: error.message });
      throw error;
    }
  }

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

  function isNativeVisionModel(model) {
    // The raw slug decides, never bareModelId: the "@provider" suffix is exactly
    // what distinguishes the routed twin from the native entry of one model.
    return Boolean(getNativeSlugs()?.has?.(model));
  }

  // Which dialect a vision call speaks is an OpenCode-side fact and stays
  // here; where it is sent is the provider's, and asking the profile is what
  // stops a local vision model from having its image posted to opencode.ai -
  // this had no case for ollama, llamacpp or vllm at all.
  function visionEndpointFor(model) {
    if (isNativeVisionModel(model)) return { url: `${NATIVE_BASE}/responses`, style: "responses", native: true };
    const provider = providerForModel(config, model);
    const base = profileById(provider).baseUrlFor(config, model);
    // Every provider in the registry other than OpenCode Go speaks Responses.
    // An empty base means nothing is configured for this model, so fall
    // through rather than build a URL with no host.
    if (provider !== "opencode-go" && base) return { url: `${base}/responses`, style: "responses" };
    const goBase = profileById("opencode-go").baseUrlFor(config, model);
    const upstream = bareModelId(model);
    if (upstream.endsWith("-free") || upstream === "big-pickle") return { url: `${goBase}/chat/completions`, style: "chat" };
    if (RESPONSES_MODELS.has(upstream)) return { url: `${goBase}/responses`, style: "responses" };
    return { url: `${goBase}/chat/completions`, style: "chat" };
  }

  async function callVisionModel(model, images, prompt) {
    // Resolve the endpoint first: it decides which credential the call needs.
    const { url, style, native } = visionEndpointFor(model);
    const nativeAuth = native ? readCodexAuth(config.codexHome || path.join(os.homedir(), ".codex")) : null;
    const token = native ? nativeAuth.accessToken : tokenFor(config, model);
    if (!token) {
      throw new Error(native
        ? `No ChatGPT session token in ${nativeAuth.file}; sign in to the Codex app to use ${bareModelId(model)} for vision.`
        : `No token configured for provider of ${model}`);
    }
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
        // The native backend bills the turn to this account; routed providers
        // have no such header and must not receive one.
        ...(nativeAuth?.accountId ? { "chatgpt-account-id": nativeAuth.accountId } : {}),
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

  return { searchWeb, inspectVision, generateImage, ...(memoryStore ? { recallMemory, storeMemory, learnMemory } : {}) };
}

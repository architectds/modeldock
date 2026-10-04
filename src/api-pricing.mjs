import { canonicalModelId } from "./model-identity.mjs";
import { modelRefParts } from "./model-ref.mjs";
import { readFileSync, statSync } from "node:fs";
import { atomicWriteTextSync } from "./atomic-file.mjs";
import { stateFile } from "./state-dir.mjs";

// Public API prices in USD per one million tokens.
//
// Bundled fallback for offline first start. A per-gateway price owner overlays
// validated public feeds and their last-good disk snapshot. Stats always uses
// current Standard base rates, not historical invoices or long-context tiers.
// Each row is one provider offer; never combine columns across providers.
const PRICE_OFFERS = [
  // OpenCode Go base rates, checked against its current models.dev directory
  // on 2026-08-29. Free Zen models come from the sibling OpenCode directory.
  ["deepseek-v4-flash@opencode-go", { input: 0.22, cached: 0.007, output: 0.66 }],
  ["deepseek-v4-flash-vision-exp@opencode-go", { input: 0.22, cached: 0.007, output: 0.66 }],
  ["deepseek-v4-flash-free@opencode-go", { input: 0, cached: 0, output: 0 }],
  ["nemotron-3-ultra-free@opencode-go", { input: 0, cached: 0, output: 0 }],
  ["laguna-s-2.1-free@opencode-go", { input: 0, cached: 0, output: 0 }],
  ["longcat-2.0-free@opencode-go", { input: 0, cached: 0, output: 0 }],
  ["mimo-v2.5-free@opencode-go", { input: 0, cached: 0, output: 0 }],
  ["deepseek-v4-pro@opencode-go", { input: 0.66, cached: 0.022, output: 1.98 }],
  ["glm-5@opencode-go", { input: 1, cached: 0.2, output: 3.2 }],
  ["glm-5.1@opencode-go", { input: 1.4, cached: 0.26, output: 4.4 }],
  ["glm-5.2@opencode-go", { input: 1.4, cached: 0.26, output: 4.4 }],
  ["glm-5.3-flash@opencode-go", { input: 0.075, cached: 0.015, output: 0.25 }],
  ["glm-5.3@opencode-go", { input: 1.4, cached: 0.26, output: 4.4 }],
  ["gpt-5.6-luna@opencode-go", { input: 0.2, cached: 0.02, output: 1.2 }],
  ["grok-4.5@opencode-go", { input: 2, cached: 0.3, output: 6 }],
  ["grok-4.6@opencode-go", { input: 2, cached: 0.5, output: 6 }],
  ["hy3@opencode-go", { input: 0.0175, cached: 0.004375, output: 0.0725 }],
  ["hy4-preview@opencode-go", { input: 0.834, cached: 0.042, output: 2.501 }],
  ["kimi-k2.5@opencode-go", { input: 0.6, cached: 0.1, output: 3 }],
  ["kimi-k2.6@opencode-go", { input: 0.95, cached: 0.16, output: 4 }],
  ["kimi-k2.7-code@opencode-go", { input: 0.95, cached: 0.19, output: 4 }],
  ["kimi-k3@opencode-go", { input: 3, cached: 0.3, output: 15 }],
  ["longcat-2.0@opencode-go", { input: 0.3, cached: 0.006, output: 1.2 }],
  ["mimo-v2.5@opencode-go", { input: 0.14, cached: 0.0028, output: 0.28 }],
  ["mimo-v2.5-pro@opencode-go", { input: 0.435, cached: 0.003625, output: 0.87 }],
  ["mimo-v2-omni@opencode-go", { input: 0.4, cached: 0.08, output: 2 }],
  ["mimo-v2-pro@opencode-go", { input: 1, cached: 0.2, output: 3 }],
  ["minimax-m2.5@opencode-go", { input: 0.3, cached: 0.03, output: 1.2 }],
  ["minimax-m2.7@opencode-go", { input: 0.3, cached: 0.06, output: 1.2 }],
  ["minimax-m3@opencode-go", { input: 0.3, cached: 0.06, output: 1.2 }],
  ["muse-spark-1.2-contributor@opencode-go", { input: 0.1, cached: 0.002, output: 0.2 }],
  ["ox-alpha-free@opencode-go", { input: 0, cached: 0, output: 0 }],
  ["qwen3.5-plus@opencode-go", { input: 0.2, cached: 0.02, output: 1.2 }],
  ["qwen3.6-plus@opencode-go", { input: 0.5, cached: 0.05, output: 3 }],
  ["qwen3.7-max@opencode-go", { input: 2.5, cached: 0.5, output: 7.5 }],
  ["qwen3.7-plus@opencode-go", { input: 0.4, cached: 0.04, output: 1.6 }],
  ["qwen3.8-flash@opencode-go", { input: 0.15, cached: 0.016, output: 0.47 }],
  ["qwen3.8-max@opencode-go", { input: 2, cached: 0.25, output: 6 }],

  // Command Code public model directory, checked 2026-09-11. Its page labels
  // these as per-token equivalents for subscription usage.
  ["deepseek/deepseek-v4-flash-fast@commandcode", { input: 0.28, cached: 0.07, output: 0.56 }],
  ["deepseek/deepseek-v4.1-flash@commandcode", { input: 0.15, cached: 0.003, output: 0.6 }],
  ["google/gemini-3.1-flash-lite@commandcode", { input: 0.25, cached: 0.03, output: 1.5 }],
  ["google/gemini-3.5-flash@commandcode", { input: 1.5, cached: 0.15, output: 9 }],
  ["google/gemini-3.5-flash-lite@commandcode", { input: 0.3, cached: 0.03, output: 2.5 }],
  ["google/gemini-3.6-flash@commandcode", { input: 1.5, cached: 0.15, output: 7.5 }],
  ["google/gemini-3.7-flash@commandcode", { input: 1.5, cached: 0.15, output: 7.5 }],
  ["google/gemini-3.8-flash@commandcode", { input: 1.5, cached: 0.15, output: 7.5 }],
  ["gpt-5.3-codex@commandcode", { input: 2, cached: 0.5, output: 8 }],
  ["gpt-5.4@commandcode", { input: 2.5, cached: 0.25, output: 15 }],
  ["inclusionai/ling-3.0-flash-sante:free@commandcode", { input: 0, cached: 0, output: 0 }],
  ["meta/muse-spark-1.1@commandcode", { input: 1.25, cached: 0.15, output: 4.25 }],
  ["meta/muse-spark-1.2@commandcode", { input: 1.25, cached: 0.15, output: 4.25 }],
  ["meta/muse-spark-1.3@commandcode", { input: 1.25, cached: 0.15, output: 4.25 }],
  ["meta/muse-spark-1.3-contributor@commandcode", { input: 0.1, cached: 0.002, output: 0.2 }],
  ["moonshotai/Kimi-K2.7-Code-Highspeed@commandcode", { input: 1.9, cached: 0.38, output: 8 }],
  ["nvidia/nemotron-3-ultra-550b-a55b@commandcode", { input: 0.6, cached: 0.12, output: 2.4 }],
  ["Qwen/Qwen3.6-Max-Preview@commandcode", { input: 1.3, cached: 0.26, output: 7.8 }],
  ["Qwen/Qwen3.7-Flash@commandcode", { input: 0.03, cached: 0.006, output: 0.13 }],
  // Published equivalent rates for subscription traffic. These are not the
  // subscription bill; the Stats card reports comparable API value.
  ["Qwen/Qwen3.8-Flash@commandcode", { input: 0.15, cached: 0.016, output: 0.47 }],
  ["Qwen/Qwen3.8-27B@commandcode", { input: 0.4, cached: 0.04, output: 3 }],
  ["Qwen/Qwen3.8-Max-0902@commandcode", { input: 2, cached: 0.25, output: 6 }],
  ["sakana/fugu-ultra@commandcode", { input: 5, cached: 0.5, output: 30 }],
  ["stepfun/Step-3.5-Flash@commandcode", { input: 0.1, cached: 0.02, output: 0.3 }],
  ["stepfun/Step-3.7-Flash@commandcode", { input: 0.2, cached: 0.04, output: 1.15 }],
  ["tencent/hy3-paid@commandcode", { input: 0.14, cached: 0.035, output: 0.58 }],
  ["thinkingmachines/inkling@commandcode", { input: 1, cached: 0.17, output: 4.05 }],
  ["thinkingmachines/inkling-small@commandcode", { input: 0.5, cached: 0.1, output: 1.2 }],
  ["zai-org/GLM-5.2-Fast@commandcode", { input: 3, cached: 0.5, output: 10.25 }],

  // Current direct-provider standard rates. Where a provider has time bands,
  // the cheapest published band is the relevant equivalent API comparator.
  ["deepseek-flash@deepseek-official", { input: 0.15, cached: 0.003, output: 0.6 }],
  ["grok-4.20-0309-non-reasoning@xai", { input: 1.25, cached: 0.2, output: 2.5 }],
  ["grok-4.20-0309-reasoning@xai", { input: 1.25, cached: 0.2, output: 2.5 }],
  ["grok-4.20-multi-agent-0309@xai", { input: 1.25, cached: 0.2, output: 2.5 }],
  ["grok-4.3@xai", { input: 1.25, cached: 0.2, output: 2.5 }],
  ["grok-build-0.1@xai", { input: 1, cached: 0.2, output: 2 }],

  // Qwen Cloud public API, checked 2026-09-11. Command Code currently wins
  // for 27B, but both complete offers remain so the selection is auditable.
  ["qwen3.8-27b@qwen-cloud", { input: 0.5, cached: 0.1, output: 3 }],

  // OpenAI direct API standard short-context rates for native Codex traffic.
  // Original rows were checked on 2026-09-08; later rows note their source.
  // Do not apply an OpenRouter-only promotional discount here.
  ["gpt-6-astra@openai", { input: 10, cached: 1, output: 50 }],
  // OpenAI Docs Sep 22 release, prompts up to 272K input tokens:
  // https://developers.openai.com/api/docs/changelog
  ["gpt-6-sol@openai", { input: 2, cached: 0.2, output: 10 }],
  // OpenAI Standard short-context rates, checked 2026-10-03:
  // https://developers.openai.com/api/docs/pricing
  ["gpt-6.1-sol@openai", { input: 2, cached: 0.1, output: 10 }],
  ["gpt-6-luna@openai", { input: 0.1, cached: 0.01, output: 0.5 }],
  ["gpt-5.6-sol@openai", { input: 4, cached: 0.4, output: 20 }],
  ["gpt-5.6-terra@openai", { input: 2, cached: 0.2, output: 12 }],
  ["gpt-5.6-luna@openai", { input: 0.2, cached: 0.02, output: 1.2 }],
  ["gpt-5.5@openai", { input: 5, cached: 0.5, output: 30 }],
  ["gpt-5.4-mini@openai", { input: 0.75, cached: 0.075, output: 4.5 }],
  ["gpt-5.2@openai", { input: 1.75, cached: 0.175, output: 14 }],
];

function indexOffers(sources = {}) {
  const index = new Map();
  const add = (offer) => {
    const modelId = canonicalModelId(offer.model);
    const offers = index.get(modelId) || [];
    offers.push(offer);
    index.set(modelId, offers);
  };
  for (const [sourceKey, rate] of PRICE_OFFERS) add({ model: sourceKey, sourceKey, source: "bundled", ...rate });
  for (const [source, batch] of Object.entries(sources)) {
    for (const offer of batch.offers) add({ ...offer, source });
  }
  return index;
}
const BUNDLED_OFFERS = indexOffers();

const perMillion = (tokens, rate) => (Math.max(0, Number(tokens) || 0) * rate) / 1_000_000;

function cheapestOffer(model, provider, { input = 0, cached = 0, output = 0 } = {}, index = BUNDLED_OFFERS) {
  const modelId = canonicalModelId(model);
  const owner = modelRefParts(model).provider || provider;
  // Local routes can carry arbitrary user-chosen names. If no public offer
  // matches, retain the hosted Qwen Flash equivalent-value convention without
  // changing the usage identity or duplicating its rates. The retired stable
  // llama.cpp key is retained only for historical rollup valuation.
  const localComparator = owner === "local" || (owner === "llamacpp" && modelId === "local");
  const offers = (index.get(modelId)
    || (localComparator ? index.get("qwen3.8-flash") : null) || [])
    .filter((offer) => cached === 0 || offer.cached !== null);
  const refreshed = offers.filter((offer) => offer.source !== "bundled");
  // Dynamic offers supersede old bundled rates, including price increases.
  // Missing cache rates cannot win by pretending that cache reads are free.
  const candidates = refreshed.length ? refreshed : offers;
  if (!candidates.length) return null;
  const costFor = (rate) => perMillion(input - cached, rate.input)
    + perMillion(cached, rate.cached)
    + perMillion(output, rate.output);
  return candidates.reduce((best, offer) => (costFor(offer) < costFor(best) ? offer : best));
}

export function estimateApiCost({ model, provider, inputTokens, cachedTokens, outputTokens } = {}, index = BUNDLED_OFFERS) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.max(0, Math.min(input, Number(cachedTokens) || 0));
  const output = Math.max(0, Number(outputTokens) || 0);
  const totalTokens = input + output;
  const rate = cheapestOffer(model, provider, { input, cached, output }, index);
  if (!rate) return { usd: 0, pricedTokens: 0, unpricedTokens: totalTokens };
  return {
    usd: perMillion(input - cached, rate.input)
      + perMillion(cached, rate.cached)
      + perMillion(output, rate.output),
    pricedTokens: totalTokens,
    unpricedTokens: 0,
  };
}

const MAX_FEED_BYTES = 16 * 1024 * 1024;
const SOURCE_URLS = {
  "models.dev": "https://models.dev/api.json",
  openrouter: "https://openrouter.ai/api/v1/models",
};

function priceNumber(value) {
  if (typeof value === "string" && !/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validOffer(offer) {
  if (typeof offer?.model !== "string" || !offer.model.trim() || offer.model.length > 240) return null;
  if (typeof offer.sourceKey !== "string" || !offer.sourceKey || offer.sourceKey.length > 480) return null;
  if (/:(?:free|batch)$/i.test(offer.model)) return null;
  const input = priceNumber(offer.input);
  const output = priceNumber(offer.output);
  const cached = offer.cached == null ? null : priceNumber(offer.cached);
  if (input === null || output === null || input + output === 0 || (offer.cached != null && cached === null)) return null;
  return { model: offer.model, sourceKey: offer.sourceKey, input, cached, output };
}

function feedOffers(source, body) {
  const offers = [];
  const add = (model, provider, input, output, cached, scale = 1) => {
    const offer = validOffer({ model, sourceKey: `${model}@${provider}`, input, output, cached });
    if (!offer) return;
    const scaled = validOffer({ ...offer, input: offer.input * scale, output: offer.output * scale,
      cached: offer.cached === null ? null : offer.cached * scale });
    if (scaled) offers.push(scaled);
  };
  if (source === "models.dev" && body && typeof body === "object" && !Array.isArray(body)) {
    for (const [provider, directory] of Object.entries(body)) {
      for (const model of Object.values(directory?.models || {})) {
        if (model?.modalities?.output && (!Array.isArray(model.modalities.output) || !model.modalities.output.includes("text"))) continue;
        add(model?.id, provider, model?.cost?.input, model?.cost?.output, model?.cost?.cache_read);
      }
    }
  } else if (source === "openrouter" && Array.isArray(body?.data)) {
    for (const model of body.data) {
      if (model?.architecture?.output_modalities && (!Array.isArray(model.architecture.output_modalities) || !model.architecture.output_modalities.includes("text"))) continue;
      add(model?.id, "openrouter", model?.pricing?.prompt, model?.pricing?.completion, model?.pricing?.input_cache_read, 1_000_000);
    }
  }
  if (!offers.length) throw new Error("No valid Standard token prices in feed");
  return offers;
}

async function fetchOffers(source, url, signal) {
  const response = await fetch(url, { headers: { Accept: "application/json" }, signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_FEED_BYTES) throw new Error("Price feed exceeds 16 MiB");
    chunks.push(chunk);
  }
  return feedOffers(source, JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export function createApiPricing({
  file = stateFile("api-prices.json"),
  modelsDevUrl = process.env.MODELDOCK_MODELS_DEV_PRICES_URL || SOURCE_URLS["models.dev"],
  openRouterUrl = process.env.MODELDOCK_OPENROUTER_PRICES_URL || SOURCE_URLS.openrouter,
  timeoutMs = 10_000,
  onChange = () => {},
} = {}) {
  const urls = { "models.dev": modelsDevUrl, openrouter: openRouterUrl };
  let sources = {};
  try {
    if (statSync(file).size > MAX_FEED_BYTES) throw new Error("Price snapshot exceeds 16 MiB");
    const snapshot = JSON.parse(readFileSync(file, "utf8"));
    if (snapshot.version !== 1 || snapshot.unit !== "USD_per_million_tokens") throw new Error("Unknown price snapshot format");
    for (const source of Object.keys(SOURCE_URLS)) {
      const batch = snapshot.sources?.[source];
      if (!Array.isArray(batch?.offers) || !Number.isFinite(Date.parse(batch.fetchedAt)) || typeof batch.url !== "string") continue;
      const offers = batch.offers.map(validOffer).filter(Boolean);
      if (offers.length) sources[source] = { url: batch.url, fetchedAt: batch.fetchedAt, offers };
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.log(`[gate] price snapshot ignored: ${error.message}`);
  }
  let index = indexOffers(sources);
  let revision = 0;
  let refreshJob = null;
  let controller = null;
  let closed = false;
  const status = () => ({
    revision, currency: "USD", unit: "per_million_tokens", basis: "current_standard_base_rates",
    sources: Object.fromEntries(Object.keys(SOURCE_URLS).map((source) => [source, {
      url: sources[source]?.url || urls[source], fetchedAt: sources[source]?.fetchedAt || null,
      offers: sources[source]?.offers.length || 0,
    }])),
  });
  const refresh = () => {
    if (closed) return Promise.resolve(status());
    if (refreshJob) return refreshJob;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    refreshJob = Promise.all(Object.entries(urls).map(async ([source, url]) => {
      try {
        const offers = await fetchOffers(source, url, signal);
        return [source, { url, fetchedAt: new Date().toISOString(), offers }];
      } catch (error) {
        if (!closed) console.log(`[gate] ${source} price refresh failed: ${error.message}; keeping last-good prices`);
        return null;
      }
    })).then((results) => {
      const valid = results.filter(Boolean);
      if (closed || !valid.length) return status();
      const next = { ...sources, ...Object.fromEntries(valid) };
      try {
        const snapshot = JSON.stringify({ version: 1, unit: "USD_per_million_tokens", sources: next });
        if (Buffer.byteLength(snapshot) > MAX_FEED_BYTES) throw new Error("Price snapshot exceeds 16 MiB");
        atomicWriteTextSync(file, snapshot);
      } catch (error) {
        console.log(`[gate] price snapshot save failed: ${error.message}; keeping last-good prices`);
        return status();
      }
      sources = next;
      index = indexOffers(sources);
      revision += 1;
      onChange();
      return status();
    }).finally(() => { refreshJob = null; controller = null; });
    return refreshJob;
  };
  return {
    file, status, refresh,
    estimateApiCost: (usage) => estimateApiCost(usage, index),
    close() { closed = true; controller?.abort(); },
  };
}

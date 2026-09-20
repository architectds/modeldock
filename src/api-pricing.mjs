import { canonicalModelId } from "./model-identity.mjs";

// Public API prices in USD per one million tokens.
//
// This is deliberately a small, explicit snapshot rather than a live pricing
// dependency. Stats must remain available offline and a provider catalog fetch
// must never change a historical chart behind the user's back. Update this
// table when a provider changes its published rates. Each row is one complete
// provider offer. Equivalent cost normalizes the model identity and chooses the
// cheapest real offer for the observed token mix; it never combines individual
// columns from different providers into a price no provider actually offers.
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

  // Shadow rate for the stable local llama.cpp entry. A model running on this
  // machine costs no API credits, but Stats prices it at the hosted Qwen 3.8
  // Flash standard rate so a local run and its hosted equivalent are directly
  // comparable on one ruler. This is a display convention, not a claim about
  // money spent: usage events keep carrying provider "llamacpp" regardless.
  ["Local@llamacpp", { input: 0.15, cached: 0.016, output: 0.47 }],

  // OpenAI direct API standard short-context rates for native Codex traffic,
  // checked on 2026-09-08. Do not apply an OpenRouter-only promotional
  // discount here.
  ["gpt-6-astra@openai", { input: 10, cached: 1, output: 50 }],
  ["gpt-5.6-sol@openai", { input: 4, cached: 0.4, output: 20 }],
  ["gpt-5.6-terra@openai", { input: 2, cached: 0.2, output: 12 }],
  ["gpt-5.6-luna@openai", { input: 0.2, cached: 0.02, output: 1.2 }],
  ["gpt-5.5@openai", { input: 5, cached: 0.5, output: 30 }],
  ["gpt-5.4-mini@openai", { input: 0.75, cached: 0.075, output: 4.5 }],
  ["gpt-5.2@openai", { input: 1.75, cached: 0.175, output: 14 }],
];

const OFFERS_BY_MODEL = new Map();
for (const [sourceKey, rate] of PRICE_OFFERS) {
  const modelId = canonicalModelId(sourceKey);
  const offers = OFFERS_BY_MODEL.get(modelId) || [];
  offers.push({ sourceKey, ...rate });
  OFFERS_BY_MODEL.set(modelId, offers);
}

const perMillion = (tokens, rate) => (Math.max(0, Number(tokens) || 0) * rate) / 1_000_000;

function cheapestOffer(model, { input = 0, cached = 0, output = 0 } = {}) {
  const offers = OFFERS_BY_MODEL.get(canonicalModelId(model)) || [];
  if (!offers.length) return null;
  const costFor = (rate) => perMillion(input - cached, rate.input)
    + perMillion(cached, rate.cached)
    + perMillion(output, rate.output);
  return offers.reduce((best, offer) => (costFor(offer) < costFor(best) ? offer : best));
}

export function estimateApiCost({ model, provider, inputTokens, cachedTokens, outputTokens } = {}) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.max(0, Math.min(input, Number(cachedTokens) || 0));
  const output = Math.max(0, Number(outputTokens) || 0);
  const totalTokens = input + output;
  const rate = cheapestOffer(model, { input, cached, output });
  if (!rate) return { usd: 0, pricedTokens: 0, unpricedTokens: totalTokens };
  return {
    usd: perMillion(input - cached, rate.input)
      + perMillion(cached, rate.cached)
      + perMillion(output, rate.output),
    pricedTokens: totalTokens,
    unpricedTokens: 0,
  };
}

export function apiRate(model, provider) {
  // apiRate has no workload. Use an equal one-million-token mix only to expose
  // a deterministic representative offer; estimateApiCost performs the actual
  // workload-aware comparison used by Stats.
  const selected = cheapestOffer(model, {
    input: 2_000_000,
    cached: 1_000_000,
    output: 1_000_000,
  });
  if (!selected) return null;
  return { input: selected.input, cached: selected.cached, output: selected.output };
}

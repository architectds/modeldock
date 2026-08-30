// Public API prices in USD per one million tokens.
//
// This is deliberately a small, explicit snapshot rather than a live pricing
// dependency. Stats must remain available offline and a provider catalog fetch
// must never change a historical chart behind the user's back. Update this
// table when a provider changes its published rates; models without a known
// rate are counted as unpriced instead of inheriting a made-up family price.
const RATES = new Map([
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

  // OpenAI direct API base rates for native Codex traffic, checked on
  // 2026-08-29. Do not apply an OpenRouter-only promotional discount here.
  ["gpt-5.6-sol@openai", { input: 4, cached: 0.4, output: 20 }],
  ["gpt-5.6-terra@openai", { input: 2, cached: 0.2, output: 12 }],
  ["gpt-5.6-luna@openai", { input: 0.2, cached: 0.02, output: 1.2 }],
  ["gpt-5.5@openai", { input: 5, cached: 0.5, output: 30 }],
  ["gpt-5.4-mini@openai", { input: 0.75, cached: 0.075, output: 4.5 }],
]);

const perMillion = (tokens, rate) => (Math.max(0, Number(tokens) || 0) * rate) / 1_000_000;

export function estimateApiCost({ model, provider, inputTokens, cachedTokens, outputTokens } = {}) {
  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.max(0, Math.min(input, Number(cachedTokens) || 0));
  const output = Math.max(0, Number(outputTokens) || 0);
  const totalTokens = input + output;
  const rate = RATES.get(`${model}@${provider}`);
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
  return RATES.get(`${model}@${provider}`) || null;
}

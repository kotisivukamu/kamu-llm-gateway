// Pure pricing math shared by the proxy (prices at request time until ADR 0003
// wave 2 removes that) and the api poller (prices at ingest, ADR 0003 §2).
// No runtime imports: proxy, api and admin images all copy shared/.

// One request's usage in the four billing buckets (see proxy/src/cost.ts for
// how provider responses normalise into them).
export interface NormUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

// USD per 1M tokens, plus an optional flat per-request charge. A catalog
// ModelEntry (proxy/src/catalog.ts) satisfies this structurally; an
// llm.model_prices row maps onto it with every field set and no
// long_context tier.
export interface Rates {
  input_cost_per_mtok_usd: number;
  output_cost_per_mtok_usd: number;
  cache_read_cost_per_mtok_usd?: number;
  cache_write_cost_per_mtok_usd?: number;
  per_request_cost_usd?: number;
  long_context?: {
    above_prompt_tokens: number;
    input_cost_per_mtok_usd: number;
    output_cost_per_mtok_usd: number;
    cache_read_cost_per_mtok_usd: number;
    cache_write_cost_per_mtok_usd: number;
  };
}

// USD cost of one request given normalised usage and the model's rates.
// A per-request charge (per_request_cost_usd) is added on top of token cost.
// Rates without explicit cache rates fall back to the Anthropic multipliers
// (read = 0.1x input, write = 1.25x input) — over-counting on providers that
// don't surcharge writes, which is the safe direction for a spend cap. A model
// with a long_context tier is billed entirely at the tier's rates once the
// prompt (all three input buckets) crosses its threshold.
export function computeCostUsd(model: Rates, usage: NormUsage): number {
  const prompt = usage.input_tokens + usage.cache_read_tokens +
    usage.cache_write_tokens;
  const rates =
    model.long_context && prompt > model.long_context.above_prompt_tokens
      ? model.long_context
      : model;
  const readRate = rates.cache_read_cost_per_mtok_usd ??
    rates.input_cost_per_mtok_usd * 0.1;
  const writeRate = rates.cache_write_cost_per_mtok_usd ??
    rates.input_cost_per_mtok_usd * 1.25;
  return (model.per_request_cost_usd ?? 0) + (
        usage.input_tokens * rates.input_cost_per_mtok_usd +
        usage.output_tokens * rates.output_cost_per_mtok_usd +
        usage.cache_read_tokens * readRate +
        usage.cache_write_tokens * writeRate
      ) / 1_000_000;
}

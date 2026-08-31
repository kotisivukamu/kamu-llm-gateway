// Static LLM catalog. Mirrors how LiteLLM (model_prices_and_context_window.json)
// and OpenRouter (their public model index) ship their registries: the catalog
// of *technically routable* providers + models lives in source, versioned in
// Git, and changes at code-deploy cadence. The DB layer is reserved for things
// the operator mutates — virtual keys, per-team allowlists, usage log.
//
// To add a new model: edit this file, set the corresponding env var in Doppler,
// redeploy.

// How we forward the upstream API key:
//   "x-api-key" → x-api-key: <key>             (Anthropic native)
//   "bearer"    → Authorization: Bearer <key>  (OpenAI-compatible, most others)
//   "both"      → both headers set             (hybrid aggregators that
//                                               emulate both SDK conventions
//                                               on the same base, e.g. opencode-zen)
export type AuthStyle = "x-api-key" | "bearer" | "both";

export interface ProviderEntry {
  base_url: string;
  auth_style: AuthStyle;
  // Name of the env var holding the upstream key. Resolved with Deno.env.get
  // at request time. Secrets live in Doppler → Fly secrets → process env.
  api_key_env_var: string;
  // Path allowlist on the upstream. The proxy refuses anything outside this
  // set so a compromised caller can't pivot into org/admin endpoints.
  allowed_paths: RegExp[];
}

export interface ModelEntry {
  provider_slug: string;
  // USD per 1M tokens at the upstream provider — what we pay. Used to populate
  // the cost column in the usage log.
  input_cost_per_mtok_usd: number;
  output_cost_per_mtok_usd: number;
  // Cache pricing, USD per 1M tokens. Providers bill cached prompt tokens
  // differently from fresh input: Anthropic charges 0.1x input for cache reads
  // and 1.25x input for (5-minute) cache writes; DeepSeek bills cache hits at
  // ~0.1x the miss rate and does not surcharge writes. When a field is absent
  // cost.ts falls back to read = 0.1x input, write = 1.25x input — the
  // Anthropic multipliers, which over-count on providers that don't surcharge
  // writes (safe direction for spend caps). Every entry below sets both
  // explicitly so the fallback only guards future additions.
  cache_read_cost_per_mtok_usd?: number;
  cache_write_cost_per_mtok_usd?: number;
  // The slug sent to the upstream provider when it differs from the
  // client-facing slug (the MODELS key). Defaults to the client-facing slug
  // when omitted. Set when a provider namespaces/renames a model the client
  // knows by another name — e.g. tensorx.ai wants `z-ai/glm-5.3` where cortecs
  // and opencode-zen accept the bare `glm-5.3`. The proxy rewrites the `model`
  // field upstream-only; authz, cost, and metering keep the client-facing slug
  // (ADR 0002). This is deliberately separate from request_overrides so the
  // merge-ordering concern (model must win) is not crammed into the override
  // map.
  upstream_model_slug?: string;
  // Optional shallow-merge override applied to JSON request bodies before
  // forwarding (e.g. silencing extended thinking on a specific Anthropic
  // model). NOT for the `model` field — use upstream_model_slug for that;
  // proxy.ts places `model` after the override merge so it always wins.
  request_overrides?: Record<string, unknown>;
}

const ANTHROPIC_PATHS: RegExp[] = [
  /^\/v1\/messages$/,
  /^\/v1\/messages\/count_tokens$/,
  /^\/v1\/messages\/batches(?:\/.*)?$/,
  /^\/v1\/models(?:\/.*)?$/,
];

const OPENAI_COMPAT_PATHS: RegExp[] = [
  /^\/v1\/chat\/completions$/,
  /^\/v1\/completions$/,
  /^\/v1\/models(?:\/.*)?$/,
  /^\/v1\/embeddings$/,
];

// OpenCode Zen exposes both shapes on the same base — OpenAI-compatible at
// /v1/chat/completions for most models, Anthropic-compatible at /v1/messages
// for the minimax-* family. Per https://opencode.ai/docs/go/.
const OPENCODE_ZEN_PATHS: RegExp[] = [
  /^\/v1\/chat\/completions$/,
  /^\/v1\/messages$/,
  /^\/v1\/models(?:\/.*)?$/,
];

export const PROVIDERS: Record<string, ProviderEntry> = {
  anthropic: {
    base_url: "https://api.anthropic.com",
    auth_style: "x-api-key",
    api_key_env_var: "ANTHROPIC_API_KEY",
    allowed_paths: ANTHROPIC_PATHS,
  },
  openai: {
    base_url: "https://api.openai.com",
    auth_style: "bearer",
    api_key_env_var: "OPENAI_API_KEY",
    allowed_paths: OPENAI_COMPAT_PATHS,
  },
  deepseek: {
    base_url: "https://api.deepseek.com",
    auth_style: "bearer",
    api_key_env_var: "DEEPSEEK_API_KEY",
    allowed_paths: OPENAI_COMPAT_PATHS,
  },
  moonshot: {
    base_url: "https://api.moonshot.ai",
    auth_style: "bearer",
    api_key_env_var: "MOONSHOT_API_KEY",
    allowed_paths: OPENAI_COMPAT_PATHS,
  },
  // sst's hosted aggregator. Single key fronts a curated set of community
  // models (kimi, deepseek, glm, mimo, qwen, minimax). Per its docs the base
  // is /zen/go — both OpenAI-shape and Anthropic-shape endpoints sit under it.
  // Set both auth headers because /v1/messages expects x-api-key while
  // /v1/chat/completions expects Bearer.
  //
  // Zen serves several of these models from China-hosted inference, which we
  // can't offer customers without an explicit opt-in. The GLM / MiniMax /
  // DeepSeek-V4 slugs therefore moved to cortecs (EU-only) below; zen keeps
  // the rest (qwen3.7-plus isn't on cortecs at all; glm-5 / minimax-m2.7 are
  // older generations we haven't repointed).
  "opencode-zen": {
    base_url: "https://opencode.ai/zen/go",
    auth_style: "both",
    api_key_env_var: "OPENCODE_ZEN_API_KEY",
    allowed_paths: OPENCODE_ZEN_PATHS,
  },
  // Cortecs (cortecs.ai) — EU-only inference aggregator, OpenAI-compatible
  // API. All routed providers (tensorix, scaleway, inceptron, berget) run in
  // the EU, which is why the GLM / MiniMax slugs live here instead of
  // opencode-zen.
  cortecs: {
    base_url: "https://api.cortecs.ai",
    auth_style: "bearer",
    api_key_env_var: "CORTECS_API_KEY",
    allowed_paths: OPENAI_COMPAT_PATHS,
  },
  // Tensorx (tensorx.ai, api.tensorx.ai) — OpenAI-compatible inference host.
  // Namespaces its model ids with a vendor prefix (`z-ai/glm-5.3`, not
  // `glm-5.3`); the bare slug 403s. Models routed here set
  // `upstream_model_slug` so the proxy rewrites `model` on the wire while
  // authz/metering keep the bare client-facing slug (ADR 0002). Most GLM/Qwen
  // workloads route through cortecs instead (EU residency, one key fronts
  // several backends); tensorx exists for models cortecs does not carry or
  // where direct routing is wanted.
  tensorx: {
    base_url: "https://api.tensorx.ai",
    auth_style: "bearer",
    api_key_env_var: "TENSORX_API_KEY",
    allowed_paths: OPENAI_COMPAT_PATHS,
  },
};

// Keyed by model slug (the value of the `model` field clients send). Values
// reference a provider in PROVIDERS. New models added here become routable
// once the corresponding provider key is set in Doppler.
export const MODELS: Record<string, ModelEntry> = {
  // --- Anthropic ----------------------------------------------------------
  // Cache rates from platform.claude.com pricing: cache reads bill at 0.1x
  // the input rate; 5-minute cache writes at 1.25x. (1-hour cache writes are
  // 2x, but nothing on our side requests the 1h TTL — if that changes these
  // write rates must change with it.)
  "claude-opus-4-7": {
    provider_slug: "anthropic",
    input_cost_per_mtok_usd: 5,
    output_cost_per_mtok_usd: 25,
    cache_read_cost_per_mtok_usd: 0.5,
    cache_write_cost_per_mtok_usd: 6.25,
  },
  "claude-opus-4-8": {
    provider_slug: "anthropic",
    input_cost_per_mtok_usd: 5,
    output_cost_per_mtok_usd: 25,
    cache_read_cost_per_mtok_usd: 0.5,
    cache_write_cost_per_mtok_usd: 6.25,
  },
  "claude-sonnet-4-6": {
    provider_slug: "anthropic",
    input_cost_per_mtok_usd: 3,
    output_cost_per_mtok_usd: 15,
    cache_read_cost_per_mtok_usd: 0.3,
    cache_write_cost_per_mtok_usd: 3.75,
  },
  "claude-sonnet-5": {
    provider_slug: "anthropic",
    input_cost_per_mtok_usd: 3,
    output_cost_per_mtok_usd: 15,
    cache_read_cost_per_mtok_usd: 0.3,
    cache_write_cost_per_mtok_usd: 3.75,
  },
  "claude-haiku-4-5-20251001": {
    provider_slug: "anthropic",
    input_cost_per_mtok_usd: 1,
    output_cost_per_mtok_usd: 5,
    cache_read_cost_per_mtok_usd: 0.1,
    cache_write_cost_per_mtok_usd: 1.25,
  },

  // --- OpenAI (native, api.openai.com) ------------------------------------
  // Prices from the official pricing page (developers.openai.com/api/docs/pricing,
  // read 2026-08-20), Standard tier, USD per 1M tokens. OpenAI publishes an
  // explicit cached-input rate (0.1x input on the gpt-5.6 family, 0.25x on o3)
  // which is used verbatim for cache reads. Cache writes ARE surcharged on the
  // gpt-5.6 family at 1.25x input, same shape as Anthropic — the usage payload
  // returns a distinct cache_write_tokens counter alongside cached_tokens. o3
  // lists no cache-write rate, so it keeps write = 1.0x input.
  // Deliberately a tight set: the three gpt-5.6 tiers plus o3 for reasoning.
  "gpt-5.6-sol": {
    provider_slug: "openai",
    input_cost_per_mtok_usd: 5,
    output_cost_per_mtok_usd: 30,
    cache_read_cost_per_mtok_usd: 0.5,
    cache_write_cost_per_mtok_usd: 6.25,
  },
  "gpt-5.6-terra": {
    provider_slug: "openai",
    input_cost_per_mtok_usd: 2,
    output_cost_per_mtok_usd: 12,
    cache_read_cost_per_mtok_usd: 0.2,
    cache_write_cost_per_mtok_usd: 2.5,
  },
  "gpt-5.6-luna": {
    provider_slug: "openai",
    input_cost_per_mtok_usd: 0.2,
    output_cost_per_mtok_usd: 1.2,
    cache_read_cost_per_mtok_usd: 0.02,
    cache_write_cost_per_mtok_usd: 0.25,
  },
  o3: {
    provider_slug: "openai",
    input_cost_per_mtok_usd: 2,
    output_cost_per_mtok_usd: 8,
    cache_read_cost_per_mtok_usd: 0.5,
    cache_write_cost_per_mtok_usd: 2,
  },

  // --- Moonshot (native, api.moonshot.ai) ---------------------------------
  // Prices are the published cache-miss input / output rates from
  // platform.kimi.ai/docs/pricing/*. Moonshot publishes cache-hit pricing per
  // model but we haven't re-verified the current numbers, so cache rates here
  // are the ASSUMED defaults: read = 0.1x input, write = 1.0x input (Moonshot
  // does not surcharge cache writes the way Anthropic does; storage fees for
  // context caching are billed separately and are not modelled here). Replace
  // with real per-model hit rates when someone verifies them.
  // kimi-k3 and kimi-k2.7-code are routed via cortecs (EU-only), not native
  // Moonshot: same slugs, OpenAI-compatible, no dependence on the Moonshot
  // account balance. Cortecs publishes EUR rates (k3: 2.693 in / 13.464 out,
  // k2.7-code: 0.673 in / 3.142 out, cache read 0.18); converted here at
  // ~1.1 USD/EUR. Cortecs lists no cache pricing for k3, so its cache rates
  // keep the assumed defaults relative to input.
  "kimi-k3": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 2.96,
    output_cost_per_mtok_usd: 14.81,
    cache_read_cost_per_mtok_usd: 0.3,
    cache_write_cost_per_mtok_usd: 2.96,
  },
  "kimi-k2.7-code": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 0.74,
    output_cost_per_mtok_usd: 3.46,
    cache_read_cost_per_mtok_usd: 0.2,
    cache_write_cost_per_mtok_usd: 0.74,
  },
  "kimi-k2.7-code-highspeed": {
    provider_slug: "moonshot",
    input_cost_per_mtok_usd: 1.9,
    output_cost_per_mtok_usd: 8,
    cache_read_cost_per_mtok_usd: 0.19,
    cache_write_cost_per_mtok_usd: 1.9,
  },
  "kimi-k2.6": {
    provider_slug: "moonshot",
    input_cost_per_mtok_usd: 0.95,
    output_cost_per_mtok_usd: 4,
    cache_read_cost_per_mtok_usd: 0.095,
    cache_write_cost_per_mtok_usd: 0.95,
  },
  "kimi-k2.5": {
    provider_slug: "moonshot",
    input_cost_per_mtok_usd: 0.6,
    output_cost_per_mtok_usd: 2.5,
    cache_read_cost_per_mtok_usd: 0.06,
    cache_write_cost_per_mtok_usd: 0.6,
  },
  "moonshot-v1-32k": {
    provider_slug: "moonshot",
    input_cost_per_mtok_usd: 1,
    output_cost_per_mtok_usd: 3,
    cache_read_cost_per_mtok_usd: 0.1,
    cache_write_cost_per_mtok_usd: 1,
  },

  // --- DeepSeek (native, api.deepseek.com) --------------------------------
  // deepseek-chat / deepseek-reasoner are the legacy aliases of
  // deepseek-v4-flash (non-thinking / thinking). DeepSeek retired the names on
  // 2026-07-24 and no longer publishes prices for them; we price them at the
  // v4-flash rate they aliased. Prefer the explicit v4 slugs for new work.
  // DeepSeek publishes explicit cache-hit pricing: hits bill at ~0.1x the
  // cache-miss input rate, and cache writes are NOT surcharged (a write is
  // just a normal miss, billed at the plain input rate) — hence read = 0.1x,
  // write = 1.0x input below. DeepSeek's usage block reports hits natively
  // (prompt_cache_hit_tokens), which cost.ts maps to cache reads.
  "deepseek-chat": {
    provider_slug: "deepseek",
    input_cost_per_mtok_usd: 0.14,
    output_cost_per_mtok_usd: 0.28,
    cache_read_cost_per_mtok_usd: 0.014,
    cache_write_cost_per_mtok_usd: 0.14,
  },
  "deepseek-reasoner": {
    provider_slug: "deepseek",
    input_cost_per_mtok_usd: 0.14,
    output_cost_per_mtok_usd: 0.28,
    cache_read_cost_per_mtok_usd: 0.014,
    cache_write_cost_per_mtok_usd: 0.14,
  },
  // The explicit v4 slugs, served natively by api.deepseek.com (verified
  // 2026-08-10: a live call with model=deepseek-v4-pro answers). These are the
  // slugs the legacy studio catalog uses; they were briefly removed in the
  // Cortecs move (mistaken for zen-only), which silenced their cost logging.
  "deepseek-v4-pro": {
    provider_slug: "deepseek",
    input_cost_per_mtok_usd: 1.74,
    output_cost_per_mtok_usd: 3.48,
    cache_read_cost_per_mtok_usd: 0.174,
    cache_write_cost_per_mtok_usd: 1.74,
  },
  "deepseek-v4-flash": {
    provider_slug: "deepseek",
    input_cost_per_mtok_usd: 0.14,
    output_cost_per_mtok_usd: 0.28,
    cache_read_cost_per_mtok_usd: 0.014,
    cache_write_cost_per_mtok_usd: 0.14,
  },

  // --- Cortecs aggregator (EU-only) ---------------------------------------
  // Slugs are Cortecs' own (GET api.cortecs.ai/v1/models). Prices are what
  // Cortecs charges us: their published EUR/Mtok rates converted to USD at
  // 1 EUR = 1.1554 USD (2026-08-10). GLM and MiniMax moved here from
  // opencode-zen for EU processing. Cortecs also carries deepseek-v4-pro and
  // deepseek-v4-flash-0731, but the native deepseek provider already covers
  // those workloads via deepseek-chat/deepseek-reasoner.
  // Cortecs' /v1/models now publishes a per-model cache_read_cost (in EUR), so
  // new entries use that rate verbatim (converted to USD). Cortecs still
  // publishes no cache-WRITE rate, so cache writes keep the assumed default
  // of 1.0x input (a write is billed as a normal miss). The older GLM /
  // MiniMax rows predate that published cache_read field and keep the prior
  // 0.1x-input read assumption; reconcile them when reverified.
  // The two Qwen 3.8 entries below are the EU-hosted Qwen 3.8 route (verified
  // 2026-08-20: live POST /v1/chat/completions answers 200 with a usage
  // block). qwen3.8-max is NOT on cortecs — that slug lives only on
  // opencode-zen; cortecs carries the open-weight variants qwen3.8-27b
  // (compact 27B, multimodal: text+image in) and qwen3.8-2.4t-a95b (flagship
  // 2.4T MoE). Both are reasoning models; reasoning tokens ride inside
  // completion_tokens and are priced at the output rate.
  "qwen3.8-27b": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 0.3466,
    output_cost_per_mtok_usd: 2.5419,
    cache_read_cost_per_mtok_usd: 0.1155,
    cache_write_cost_per_mtok_usd: 0.3466,
  },
  "qwen3.8-2.4t-a95b": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 2.5927,
    output_cost_per_mtok_usd: 6.223,
    cache_read_cost_per_mtok_usd: 0.6482,
    cache_write_cost_per_mtok_usd: 2.5927,
  },
  // GLM 5.3 family. Routes through cortecs, which fronts tensorix (and
  // berget) under the hood and accepts the bare slugs — so no
  // upstream_model_slug is needed here. Cortecs' published EUR/Mtok converted
  // at 1.1554 USD/EUR (the rate this catalog uses, see the cortecs block
  // above). Cortecs publishes a cache-read rate but no cache-WRITE rate, so
  // cache writes keep the assumed default of 1.0x input (a write is billed as
  // a normal miss). GLM 5.3 is a thinking model — reasoning tokens ride inside
  // completion_tokens and are priced at the output rate, same as the qwen
  // reasoning models. The flash variant is multimodal (text+image in).
  // ADR 0002 notes the tensorx-native route would set
  // upstream_model_slug: "z-ai/glm-5.3" instead; cortecs is preferred for EU
  // residency. (Moved from opencode-zen 2026-08-31.)
  "glm-5.3": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 1.8151,
    output_cost_per_mtok_usd: 4.6667,
    cache_read_cost_per_mtok_usd: 0.4541,
    cache_write_cost_per_mtok_usd: 1.8151,
  },
  "glm-5.3-flash": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 0.208,
    output_cost_per_mtok_usd: 0.5188,
    cache_read_cost_per_mtok_usd: 0.052,
    cache_write_cost_per_mtok_usd: 0.208,
  },
  "glm-5.2": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 1.24,
    output_cost_per_mtok_usd: 4.36,
    cache_read_cost_per_mtok_usd: 0.124,
    cache_write_cost_per_mtok_usd: 1.24,
  },
  "glm-5.1": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 1.44,
    output_cost_per_mtok_usd: 4.51,
    cache_read_cost_per_mtok_usd: 0.144,
    cache_write_cost_per_mtok_usd: 1.44,
  },
  "minimax-m3": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 0.41,
    output_cost_per_mtok_usd: 2.05,
    cache_read_cost_per_mtok_usd: 0.041,
    cache_write_cost_per_mtok_usd: 0.41,
  },

  // --- OpenCode Zen aggregator --------------------------------------------
  // Its own namespace: these slugs are Zen's, not the upstream vendors'.
  // Prices from opencode.ai/docs/zen (what Zen charges us, not the vendor).
  // Zen's GLM / MiniMax M3 / DeepSeek V4 routing is China-hosted, so those
  // slugs moved to cortecs above (deepseek-v4-* dropped entirely — the native
  // deepseek provider covers them). Routing is decided by the URL's provider
  // slug, never by this map —
  // MODELS is keyed by slug alone and only feeds authz/overrides/cost
  // metadata. The 2026-08-06 legacy-studio incident (duplicate slugs under a
  // keyless provider row in the DB) cannot recur here: keys are env-only and
  // the provider is always explicit in the path.
  // Zen's docs (opencode.ai/docs/zen) publish explicit per-model cached-read
  // AND cached-write rates for the Qwen family; the Qwen entries below use
  // those verbatim (verified 2026-08-20). The GLM-5 / MiniMax-M2.7 rows predate
  // that published table and keep the ASSUMED defaults (read = 0.1x input,
  // write = 1.0x input) — the docs DO publish a cached-read rate for them now
  // (GLM-5 $0.20, MiniMax-M2.7 $0.06) that these entries have not yet been
  // updated to; priced conservatively until reconciled.
  "glm-5": {
    provider_slug: "opencode-zen",
    input_cost_per_mtok_usd: 1,
    output_cost_per_mtok_usd: 3.2,
    cache_read_cost_per_mtok_usd: 0.1,
    cache_write_cost_per_mtok_usd: 1,
  },
  "minimax-m2.7": {
    provider_slug: "opencode-zen",
    input_cost_per_mtok_usd: 0.3,
    output_cost_per_mtok_usd: 1.2,
    cache_read_cost_per_mtok_usd: 0.03,
    cache_write_cost_per_mtok_usd: 0.3,
  },
  // Zen's docs (opencode.ai/docs/zen) now publish explicit cache-read AND
  // cache-write rates for the Qwen / Max family (previously only the assumed
  // defaults were used). Verified 2026-08-20 against the live pricing table;
  // the live /v1/models endpoint also lists qwen3.8-max (and qwen3.7-max) even
  // though the docs prose only lists Qwen3.7 Max, so the 3.8 entry inherits
  // the documented 3.7-Max rates until Zen publishes a distinct 3.8 row.
  // A live probe through this proxy (POST /llm/opencode-zen/v1/chat/completions
  // with model=qwen3.8-max) answers 200 and returns a normal usage block.
  // qwen3.8-max is a thinking model (returns reasoning_content / thinking
  // blocks); the reasoning tokens ride inside completion_tokens and are
  // priced at the output rate, same as Qwen3.7 Max.
  "qwen3.8-max": {
    provider_slug: "opencode-zen",
    input_cost_per_mtok_usd: 2.5,
    output_cost_per_mtok_usd: 7.5,
    cache_read_cost_per_mtok_usd: 0.5,
    cache_write_cost_per_mtok_usd: 3.125,
  },
  "qwen3.7-max": {
    provider_slug: "opencode-zen",
    input_cost_per_mtok_usd: 2.5,
    output_cost_per_mtok_usd: 7.5,
    cache_read_cost_per_mtok_usd: 0.5,
    cache_write_cost_per_mtok_usd: 3.125,
  },
  "qwen3.7-plus": {
    provider_slug: "opencode-zen",
    input_cost_per_mtok_usd: 0.4,
    output_cost_per_mtok_usd: 1.6,
    cache_read_cost_per_mtok_usd: 0.04,
    cache_write_cost_per_mtok_usd: 0.5,
  },
  "qwen3.6-plus": {
    provider_slug: "opencode-zen",
    input_cost_per_mtok_usd: 0.5,
    output_cost_per_mtok_usd: 3,
    cache_read_cost_per_mtok_usd: 0.05,
    cache_write_cost_per_mtok_usd: 0.625,
  },
  "qwen3.5-plus": {
    provider_slug: "opencode-zen",
    input_cost_per_mtok_usd: 0.2,
    output_cost_per_mtok_usd: 1.2,
    cache_read_cost_per_mtok_usd: 0.02,
    cache_write_cost_per_mtok_usd: 0.25,
  },
};

export function getProvider(slug: string): ProviderEntry | null {
  return PROVIDERS[slug] ?? null;
}

export function getModel(slug: string): ModelEntry | null {
  return MODELS[slug] ?? null;
}

// Rewrite the request body for upstream forwarding: apply the model's
// `upstream_model_slug` (when the provider namespaces/renames it — ADR 0002)
// and any `request_overrides`, with `model` placed LAST so the upstream slug
// wins over both the client's `model` and any stray `model` in the overrides.
// `clientModel` is what the client sent and stays the authority for
// authz/cost/metering — only the bytes on the wire change.
//
// Pure (no I/O) so the merge-ordering invariant is testable without standing
// up the gateway DB the full proxy route needs. Returns the original object
// unchanged when no rewrite is needed, so un-routed/non-JSON bodies skip a
// reserialize.
export function mergeRequestBody(
  clientModel: string,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const entry = getModel(clientModel);
  const overrides = entry?.request_overrides ?? {};
  const upstreamModel = entry?.upstream_model_slug ?? clientModel;
  const needsRewrite = upstreamModel !== clientModel ||
    Object.keys(overrides).length > 0;
  return needsRewrite
    ? { ...original, ...overrides, model: upstreamModel }
    : original;
}

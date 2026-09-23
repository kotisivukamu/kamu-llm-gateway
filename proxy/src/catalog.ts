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
//                                               on the same base)
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
  // accepts the bare `glm-5.3`. The proxy rewrites the `model`
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

// Speech-to-text (Whisper) for voice notes and dashboard voice input. Only
// OpenAI serves it; the body is multipart audio and passes through as-is.
const OPENAI_PATHS: RegExp[] = [
  ...OPENAI_COMPAT_PATHS,
  /^\/v1\/audio\/transcriptions$/,
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
    allowed_paths: OPENAI_PATHS,
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
  // Cortecs (cortecs.ai) — EU-only inference aggregator, OpenAI-compatible
  // API. All routed providers (tensorix, scaleway, inceptron, berget) run in
  // the EU, which is why the GLM / MiniMax slugs live here. OpenCode Zen was
  // dropped on 2026-09-09: its /zen/go endpoint became coding-agent-only
  // (400 MissingSessionID without an opencode/pi session) and everything we
  // used it for is on cortecs or a native provider.
  cortecs: {
    base_url: "https://api.cortecs.ai",
    auth_style: "bearer",
    api_key_env_var: "CORTECS_API_KEY",
    allowed_paths: OPENAI_COMPAT_PATHS,
  },
  // Tensorx (tensorx.ai, api.tensorx.ai) — EU-hosted, OpenAI-compatible, a
  // LiteLLM-style router. Namespaces its model ids with a vendor prefix
  // (`z-ai/glm-5.3`, `moonshotai/kimi-k2.6`); the bare slug 403s. No header
  // picks a backend: tensorx routes each id itself. Reached only through the
  // `<slug>@tensorx` variants at the end of MODELS, which set
  // `upstream_model_slug` to the namespaced id (ADR 0002).
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
  // kimi-k2.5 moved to cortecs 2026-09-23: Moonshot no longer serves it
  // (404 resource_not_found; absent from GET /v1/models) and moonshot-v1-32k
  // was dropped for the same reason. Cortecs EUR 0.444 in / 2.485 out / cache
  // read 0.111 at 1.1554 USD/EUR; cache write = input (none published).
  "kimi-k2.5": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 0.513,
    output_cost_per_mtok_usd: 2.8712,
    cache_read_cost_per_mtok_usd: 0.1282,
    cache_write_cost_per_mtok_usd: 0.513,
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
  // The tensorx-native route is the `glm-5.3@tensorx` variant below.
  // (Moved from opencode-zen 2026-08-31.)
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

  // GLM-5 and MiniMax-M2.7 (older generations) moved from OpenCode Zen to
  // cortecs on 2026-09-09. Rates are cortecs' EUR/Mtok (GET /v1/models:
  // glm-5 0.887/2.84 cache-read 0.222; minimax-m2.7 0.6/2.4, no cache rate
  // published so the ASSUMED defaults apply: read = 0.1x, write = 1.0x)
  // converted at 1.1554 USD/EUR like the rest of the cortecs rows.
  "glm-5": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 1.0248,
    output_cost_per_mtok_usd: 3.2813,
    cache_read_cost_per_mtok_usd: 0.2565,
    cache_write_cost_per_mtok_usd: 1.0248,
  },
  "minimax-m2.7": {
    provider_slug: "cortecs",
    input_cost_per_mtok_usd: 0.6932,
    output_cost_per_mtok_usd: 2.773,
    cache_read_cost_per_mtok_usd: 0.0693,
    cache_write_cost_per_mtok_usd: 0.6932,
  },

  // --- Provider-pinned variants (`<slug>@<provider>`, ADR 0002) -----------
  // The bare slug is the platform-routed default above; `@provider` pins a
  // specific provider. The OpenAI/Anthropic protocols give the client only the
  // `model` string, so the pin has to live in the name. Each variant is its
  // own entry: authz, pricing and usage_log.model all key on the full
  // `slug@provider`. Only providers that serve the model and publish a price
  // get a variant (no @moonshot for kimi-k3 / kimi-k2.7-code: no verified
  // Moonshot rate).
  //
  // @cortecs: EUR/Mtok from cortecs GET /v1/models at 1.1554 USD/EUR; cache
  // write = input (none published). Every variant must set
  // upstream_model_slug, even to the bare slug: without it the proxy forwards
  // `slug@provider` verbatim and the provider 404s.
  "kimi-k2.6@cortecs": {
    provider_slug: "cortecs",
    upstream_model_slug: "kimi-k2.6",
    input_cost_per_mtok_usd: 0.535,
    output_cost_per_mtok_usd: 2.9752,
    cache_read_cost_per_mtok_usd: 0.119,
    cache_write_cost_per_mtok_usd: 0.535,
  },
  "deepseek-v4-pro@cortecs": {
    provider_slug: "cortecs",
    upstream_model_slug: "deepseek-v4-pro",
    input_cost_per_mtok_usd: 1.7943,
    output_cost_per_mtok_usd: 3.5887,
    cache_read_cost_per_mtok_usd: 0.4483,
    cache_write_cost_per_mtok_usd: 1.7943,
  },
  // @tensorx: USD/token from tensorx GET /v1/model/info (2026-09-23) x 1e6;
  // cache write = input (tensorx publishes none).
  "kimi-k3@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "moonshotai/kimi-k3",
    input_cost_per_mtok_usd: 3.0,
    output_cost_per_mtok_usd: 15.0,
    cache_read_cost_per_mtok_usd: 0.75,
    cache_write_cost_per_mtok_usd: 3.0,
  },
  "kimi-k2.7-code@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "moonshotai/kimi-k2.7-code",
    input_cost_per_mtok_usd: 1.25,
    output_cost_per_mtok_usd: 4.5,
    cache_read_cost_per_mtok_usd: 0.3125,
    cache_write_cost_per_mtok_usd: 1.25,
  },
  "kimi-k2.6@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "moonshotai/kimi-k2.6",
    input_cost_per_mtok_usd: 1.0,
    output_cost_per_mtok_usd: 4.0,
    cache_read_cost_per_mtok_usd: 0.25,
    cache_write_cost_per_mtok_usd: 1.0,
  },
  "kimi-k2.5@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "moonshotai/kimi-k2.5",
    input_cost_per_mtok_usd: 0.5,
    output_cost_per_mtok_usd: 2.8,
    cache_read_cost_per_mtok_usd: 0.125,
    cache_write_cost_per_mtok_usd: 0.5,
  },
  "deepseek-v4-pro@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "deepseek/deepseek-v4-pro",
    input_cost_per_mtok_usd: 1.75,
    output_cost_per_mtok_usd: 3.5,
    cache_read_cost_per_mtok_usd: 0.4375,
    cache_write_cost_per_mtok_usd: 1.75,
  },
  "qwen3.8-27b@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "qwen/qwen3.8-27b",
    input_cost_per_mtok_usd: 0.4,
    output_cost_per_mtok_usd: 2.4,
    cache_read_cost_per_mtok_usd: 0.1,
    cache_write_cost_per_mtok_usd: 0.4,
  },
  "qwen3.8-2.4t-a95b@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "qwen/qwen3.8-2.4t-a95b",
    input_cost_per_mtok_usd: 2.5,
    output_cost_per_mtok_usd: 6.0,
    cache_read_cost_per_mtok_usd: 0.625,
    cache_write_cost_per_mtok_usd: 2.5,
  },
  "glm-5.3@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "z-ai/glm-5.3",
    input_cost_per_mtok_usd: 1.75,
    output_cost_per_mtok_usd: 4.5,
    cache_read_cost_per_mtok_usd: 0.4375,
    cache_write_cost_per_mtok_usd: 1.75,
  },
  "glm-5.3-flash@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "z-ai/glm-5.3-flash",
    input_cost_per_mtok_usd: 0.2,
    output_cost_per_mtok_usd: 0.5,
    cache_read_cost_per_mtok_usd: 0.05,
    cache_write_cost_per_mtok_usd: 0.2,
  },
  "glm-5.2@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "z-ai/glm-5.2",
    input_cost_per_mtok_usd: 1.5,
    output_cost_per_mtok_usd: 4.5,
    cache_read_cost_per_mtok_usd: 0.375,
    cache_write_cost_per_mtok_usd: 1.5,
  },
  "glm-5.1@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "z-ai/glm-5.1",
    input_cost_per_mtok_usd: 1.4,
    output_cost_per_mtok_usd: 4.4,
    cache_read_cost_per_mtok_usd: 0.35,
    cache_write_cost_per_mtok_usd: 1.4,
  },
  "glm-5@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "z-ai/glm-5",
    input_cost_per_mtok_usd: 1.0,
    output_cost_per_mtok_usd: 3.2,
    cache_read_cost_per_mtok_usd: 0.25,
    cache_write_cost_per_mtok_usd: 1.0,
  },
  "minimax-m3@tensorx": {
    provider_slug: "tensorx",
    upstream_model_slug: "minimax/minimax-m3",
    input_cost_per_mtok_usd: 0.4,
    output_cost_per_mtok_usd: 2.0,
    cache_read_cost_per_mtok_usd: 0.1,
    cache_write_cost_per_mtok_usd: 0.4,
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

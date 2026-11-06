// The LLM catalog for the Deno packages (api, admin). The data lives in
// proxy/catalog.json, the one source the Go proxy embeds at build time; this
// module only types it and compiles the path regexes. Edit the JSON, not this
// file, to add a provider or model (see the "note" fields there).
//
// The api and admin images copy proxy/catalog.json next to shared/.

import data from "../proxy/catalog.json" with { type: "json" };

// How the proxy forwards the upstream API key:
//   "x-api-key" → x-api-key: <key>             (Anthropic native)
//   "bearer"    → Authorization: Bearer <key>  (OpenAI-compatible, most others)
//   "both"      → both headers set
export type AuthStyle = "x-api-key" | "bearer" | "both";

export interface ProviderEntry {
  base_url: string;
  auth_style: AuthStyle;
  // Name of the env var holding the upstream key (never the key itself).
  api_key_env_var: string;
  // Upstream path allowlist; the proxy refuses anything else.
  allowed_paths: RegExp[];
  // Prefix removed from the caller's path before it is appended to base_url.
  strip_path_prefix?: string;
  // Headers always set on the upstream request (jev-images).
  upstream_headers?: Record<string, string>;
}

export interface ModelEntry {
  provider_slug: string;
  // USD per 1M tokens at the upstream provider: the fallback price when the
  // model has no llm.model_prices row (ADR 0003).
  input_cost_per_mtok_usd: number;
  output_cost_per_mtok_usd: number;
  // Absent: read = 0.1x input, write = 1.25x input (shared/pricing.ts).
  cache_read_cost_per_mtok_usd?: number;
  cache_write_cost_per_mtok_usd?: number;
  // The slug sent upstream when it differs from the client-facing one (ADR
  // 0002). Defaults to the MODELS key.
  upstream_model_slug?: string;
  // Shallow merge into JSON request bodies before forwarding; never `model`.
  request_overrides?: Record<string, unknown>;
  // Flat USD charge per successful request (Jev).
  per_request_cost_usd?: number;
  // Past above_prompt_tokens the whole request bills at these rates.
  long_context?: {
    above_prompt_tokens: number;
    input_cost_per_mtok_usd: number;
    output_cost_per_mtok_usd: number;
    cache_read_cost_per_mtok_usd: number;
    cache_write_cost_per_mtok_usd: number;
  };
}

type RawProvider = Omit<ProviderEntry, "allowed_paths" | "auth_style"> & {
  auth_style: string;
  allowed_paths: string[];
};

export const PROVIDERS: Record<string, ProviderEntry> = Object.fromEntries(
  Object.entries(data.providers as Record<string, RawProvider>).map((
    [slug, p],
  ) => [slug, {
    ...p,
    auth_style: p.auth_style as AuthStyle,
    allowed_paths: p.allowed_paths.map((s) => new RegExp(s)),
  }]),
);

export const MODELS: Record<string, ModelEntry> = data.models as Record<
  string,
  ModelEntry
>;

export function getProvider(slug: string): ProviderEntry | null {
  return PROVIDERS[slug] ?? null;
}

export function getModel(slug: string): ModelEntry | null {
  return MODELS[slug] ?? null;
}

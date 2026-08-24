import { type Context, Hono } from "@hono/hono";
import { MODELS, PROVIDERS } from "../catalog.ts";
import { extractCredential, verifyCredential } from "../auth.ts";

// Read-only view of the compiled-in catalog.
//
// Exists so kotisivukamu stops keeping a hand-maintained second copy of our
// upstream prices. Its llm_models table prices every studio session in cents,
// and the two copies had silently drifted: when kimi was rerouted from the
// suspended Moonshot to cortecs, this catalog got the new rates and Postgres
// kept the old ones, so sessions were billed against a cost basis 28% too
// high on kimi-k2.7-code. Nothing would ever have noticed.
//
// Deliberately READ ONLY. The catalog stays a source file that ships with a
// deploy, which keeps it reviewable in Git and keeps this service free of
// runtime-mutable config. Adding or repricing a model is still a code change.
// Callers sync FROM here; nothing writes back.
//
// Never exposes credentials, and not even the names of the env vars holding
// them: an env var name is a hint about how to attack the machine, and no
// consumer needs it. allowed_paths is withheld for the same reason. Providers
// are reduced to their slugs, which is all a caller needs to see which
// upstream a model routes to.
//
// Auth: the same DB-backed credential as the proxy path (a verified top-level
// opaque key or Ed25519 sub-key JWT). The catalog is not secret exactly, but
// our per-model cost basis is commercially sensitive, so it does not go out
// unauthenticated.
export const catalog = new Hono();

catalog.get("/", async (c) => {
  const token = await verifyCredential(extractCredential(c.req.raw.headers));
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({
    providers: Object.keys(PROVIDERS).sort().map((slug) => ({ slug })),
    models: Object.entries(MODELS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([slug, m]) => ({
        slug,
        provider_slug: m.provider_slug,
        input_cost_per_mtok_usd: m.input_cost_per_mtok_usd,
        output_cost_per_mtok_usd: m.output_cost_per_mtok_usd,
        cache_read_cost_per_mtok_usd: m.cache_read_cost_per_mtok_usd ?? null,
        cache_write_cost_per_mtok_usd: m.cache_write_cost_per_mtok_usd ?? null,
      })),
  });
});

// GET /llm/catalog — the same catalog in pi's models.json shape.
//
// A third copy of this table currently lives in builder/src/agent-cli.ts,
// whose own comment admits it is "intentionally duplicated from
// llm-proxy/src/catalog.ts ... When adding a model in the proxy catalog,
// mirror it here." This endpoint exists so a pi extension can discover
// providers at load instead, and always match what prod can actually route.
//
// baseUrl is derived from the request origin rather than configured, so the
// caller is told the address it actually reached us on. The scheme comes from
// x-forwarded-proto: Fly terminates TLS, so the request we see is plain http
// and the raw URL would advertise http:// baseUrls. force_https then 301s
// those to https, the redirect drops the x-api-key header, and the retried
// call arrives with no credential -- a 401 that looks like a bad token and is
// not one. Only the scheme is taken from the edge. The host stays as the
// caller asked for it: baseUrl is where pi sends $LLM_PROXY_TOKEN, so
// honouring x-forwarded-host would let anyone reaching this service directly
// (Flycast/6PN, bypassing the edge) point the catalog at a host of their
// choosing and collect the token. The /v1 suffix rule
// is pi's: anthropic-messages appends /v1/messages itself, so its baseUrl must
// not already end in /v1, while openai-completions appends /chat/completions
// and needs it.
//
// apiKey is emitted as a shell-style env var reference, never a token: pi
// interpolates it from the child process env. The var name is a query param
// because it is the caller's convention, not ours.
export const piCatalogHandler = async (c: Context) => {
  const token = await verifyCredential(extractCredential(c.req.raw.headers));
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const apiKeyEnv = c.req.query("api_key_env") ?? "LLM_PROXY_TOKEN";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv)) {
    return c.json({ error: "api_key_env must be a shell env var name" }, 400);
  }

  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ??
    url.protocol.replace(":", "");
  const origin = `${proto}://${url.host}`;
  const providers: Record<string, unknown> = {};

  for (const [slug, provider] of Object.entries(PROVIDERS)) {
    // Native Anthropic wire protocol is the only non-OpenAI shape we speak.
    const api = provider.auth_style === "x-api-key"
      ? "anthropic-messages"
      : "openai-completions";

    const models = Object.entries(MODELS)
      .filter(([, m]) => m.provider_slug === slug)
      .map(([id, m]) => ({
        id,
        cost: {
          input: m.input_cost_per_mtok_usd,
          output: m.output_cost_per_mtok_usd,
          cacheRead: m.cache_read_cost_per_mtok_usd ?? 0,
          cacheWrite: m.cache_write_cost_per_mtok_usd ?? 0,
        },
      }));

    if (models.length === 0) continue;

    providers[slug] = {
      baseUrl: api === "anthropic-messages"
        ? `${origin}/llm/${slug}`
        : `${origin}/llm/${slug}/v1`,
      api,
      apiKey: `$${apiKeyEnv}`,
      models,
    };
  }

  return c.json({ providers });
};

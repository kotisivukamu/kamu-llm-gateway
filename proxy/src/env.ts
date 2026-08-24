import { z } from "zod";

// Proxy satellite env (ADR 0001). The legacy shared SESSION_JWT_SECRET is GONE
// — verification is now the two DB-backed credential shapes (top-level opaque
// `sk_live_…` keys looked up by hash; Ed25519-signed sub-key JWTs verified with
// ED25519_PUBLIC_KEY and looked up by jti). Fail fast: a misconfigured value
// crashes the process at boot instead of silently accepting unverified keys.

const schema = z.object({
  PORT: z.coerce.number().default(8301),
  VERSION: z.string().default("dev"),

  // SQLite file backing per-key spend tracking + the per-request usage_log
  // buffer the control-plane poller drains. Only opened when a budgeted key is
  // used or a request is metered; uncapped deployments still create the usage
  // buffer. On Fly point at a mounted volume if budgets/rows must survive
  // restarts — without one a restart loses unpolled rows.
  DB_PATH: z.string().default("llm-proxy.db"),

  // Read-only Postgres connect to the gateway DB for key-meta lookups. The
  // proxy looks up `llm.keys` rows by `key_hash` (top-level opaque keys) and by
  // `id = jti` (derived sub-keys), then caches them in-process
  // (KEY_META_CACHE_TTL_SEC). Required: without it neither credential shape
  // can resolve a row.
  GATEWAY_DATABASE_URL: z.string().min(1),

  // Ed25519 PUBLIC key for verifying derived sub-key JWTs (ADR 0001 §10.4a).
  // Base64 of the raw 32-byte public key — the SAME key the control-plane api
  // signs sub-keys with. The proxy holds only this public key: it can verify
  // but can never mint.
  ED25519_PUBLIC_KEY: z.string().min(1),

  // Key id set in the JWT `kid` header. The proxy accepts signatures from
  // this kid. Rotation: bump the kid + republish the public key; accept the
  // previous kid during a grace window. Must match the api's ED25519_KEY_ID.
  ED25519_KEY_ID: z.string().default("dev-ed25519-1"),

  // Key-metadata cache TTL (seconds). The hot path reads from an in-process
  // cache; a cache MISS does a gateway-DB lookup. This is the ONLY window in
  // which a revocation takes to propagate (a revoked row is cached as "deny"
  // for up to this TTL) — ADR 0001 §10.4/§10.6.
  KEY_META_CACHE_TTL_SEC: z.coerce.number().int().positive().default(10),

  // Shared internal secret for the /usage control-plane poll endpoint. This
  // is a service-to-service secret, NOT a user credential. The poller presents
  // it as `Authorization: Bearer`. Required: /usage 401s without it.
  CONTROL_PLANE_POLL_TOKEN: z.string().min(1),
  // Upstream provider keys are OPTIONAL — read from Deno.env at request time
  // (catalog.ts names the env var per provider). A request to a provider whose
  // key is unset gets a 502 (provider_key_missing), same as the legacy proxy.
  // They are deliberately NOT in this schema: keeping them optional + env-only
  // means a dev box with no provider keys still boots and serves /health.
});

const parsed = schema.safeParse(Deno.env.toObject());
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.issues);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;

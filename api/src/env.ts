import { z } from "zod";

// The api's full env, validated once at startup. The api owns every var it
// needs — no shared schema — so the contract lives in one place. Fail fast:
// a misconfigured value crashes the process at boot instead of silently
// bypassing RLS or minting un-verifiable sub-keys.

const schema = z.object({
  // Two DB pools, named by privilege (see config/db.ts). No generic fallback:
  // a misconfigured URL fails fast instead of silently bypassing RLS.
  APP_USER_DATABASE_URL: z.string().min(1),
  BYPASSRLS_DATABASE_URL: z.string().min(1),

  PORT: z.coerce.number().default(8300),

  // Leveled-logger threshold (shared knob across the kamu services). Flip via a
  // Fly/Doppler secret to turn debug on or quiet things down — no code change.
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // KamuID OIDC (this service validates the opaque access token via /userinfo).
  // Issuer only — the gateway owns no client; it is a resource server, not an RP.
  // Identity comes from KamuID; org membership + grants come from the signed
  // X-Kamuhub-Authz context, never the raw KamuID claim.
  KAMUID_ISSUER: z.string().url().default("https://accounts.kamuhub.com"),

  // kamuhub JWKS URL for verifying the X-Kamuhub-Authz platform-context JWT
  // (EdDSA) that gates admission + fine-grained RBAC (llm.keys.create / revoke).
  // The signed context is MANDATORY on every authenticated request (see
  // middleware/auth.ts). The default targets the locally-run kamuhub BFF: dev
  // runs the BFF, so the context is always present and there is no dev bypass.
  // Prod overrides via Doppler/Fly (https://app.kamuhub.com/.well-known/jwks.json).
  //
  // DEV FALLBACK: set KAMUHUB_JWKS_URL=dev to skip the remote JWKS and verify
  // against a single dev public key supplied in KAMUHUB_DEV_JWK (a JWK JSON
  // string, kty=OKP crv=Ed25519 with `x`). This exists ONLY for the local smoke
  // test where the kamuhub BFF is not running and there is no live JWKS to fetch.
  // The dev JWK is the PUBLIC half of a locally-generated Ed25519 keypair; the
  // matching private key signs the platform-context JWT in scripts/dev-token.ts.
  // Prod must set a real https:// JWKS URL — `dev` is rejected by the url()
  // validator, so accept a literal `dev` sentinel here.
  KAMUHUB_JWKS_URL: z.string().default("dev"),
  // A single JWK JSON (Ed25519 public key) used ONLY when KAMUHUB_JWKS_URL=dev.
  // Example: {"kty":"OKP","crv":"Ed25519","x":"<base64url pub>"}. Empty string
  // disables the dev path (a `dev` JWKS URL with no dev JWK fails closed).
  KAMUHUB_DEV_JWK: z.string().default(""),

  // Ed25519 key pair for signing derived sub-key JWTs (ADR 0001 §10.4a). The
  // PRIVATE key is held ONLY by the central API — the single place that mints
  // (POST /api/keys/derive). The proxy satellite holds only the PUBLIC key (can
  // verify, can never mint, even under full VM compromise). Base64 of the raw
  // 32-byte seed (private) and 32-byte raw public key, so the loader can
  // reconstruct the key pair from a single-line env var with no PEM wrangling.
  // Generate with:
  //   openssl genpkey -algorithm Ed25519 -out ed25519-priv.pem
  // then derive the base64 seed/public:
  //   openssl pkey -in ed25519-priv.pem -outform DER 2>/dev/null | tail -c 32 | base64
  //   openssl pkey -in ed25519-priv.pem -pubout -outform DER 2>/dev/null | tail -c 32 | base64
  ED25519_PRIVATE_KEY: z.string().min(1),
  ED25519_PUBLIC_KEY: z.string().min(1),

  // Optional key id set as the JWT `kid` on minted sub-keys so the proxy's JWKS
  // lookup resolves. Used for rotation: bump the kid + republish the public key,
  // proxies accept the previous kid during the grace window. Dev default keeps
  // local mint working without a real kid.
  ED25519_KEY_ID: z.string().default("dev-ed25519-1"),

  // Default TTL for a derived sub-key when the caller doesn't specify one.
  // Bounded by the parent's remaining TTL at derive time (ADR 0001 §7.1).
  // 1h = 3600s, the ADR's stated sub-key lifetime.
  DEFAULT_SUBKEY_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // Absolute ceiling on a derived sub-key's TTL (ADR 0001 §7.1 / open
  // question "Budget enforcement location" doesn't cover this directly, but
  // §7.1's own framing does: an unbounded parent (expires_at IS NULL, e.g. a
  // permanent studio/builder-queue service key) imposes no upper bound from
  // the parent-clamp alone, so without a separate hard ceiling a can_mint
  // parent could mint a multi-year sub-key. Enforced independently of the
  // parent-TTL clamp below — whichever of (parent remaining, this ceiling) is
  // tighter wins. 24h default: generous headroom over the ADR's stated 1h
  // sub-key lifetime (§2/§10.4) for the longest legitimate case in the
  // current caller set (a long build), while still bounding worst-case
  // blast radius of a leaked/compromised sub-key to about a day.
  MAX_SUBKEY_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

  // Per-parent derivation rate limiting (ADR 0001 §7.7). POST /api/keys/derive
  // is rate-limited per parent key: at most SUBKEY_DERIVE_RATE_PER_MIN mints per
  // minute, and at most SUBKEY_DERIVE_MAX_ACTIVE children alive at once
  // (expired/revoked children don't count toward the cap). Bounds the DB/cache
  // impact of a runaway script or a compromised can_mint key.
  SUBKEY_DERIVE_RATE_PER_MIN: z.coerce.number().int().positive().default(60),
  SUBKEY_DERIVE_MAX_ACTIVE: z.coerce.number().int().positive().default(1000),

  // Key-metadata cache TTL for top-level opaque-key verification on the proxy
  // hot path (ADR 0001 §10.4/§10.6). This is the window in which a revocation
  // or org/team suspension propagates to the proxy without a DB read per
  // request. Owned by the gateway; the proxy's poller pulls the cache from
  // here. 10s = the ADR's stated cache window. The control plane only needs
  // this to expose it on a cache-config endpoint; the signing path does not
  // read it.
  KEY_META_CACHE_TTL_SEC: z.coerce.number().int().positive().default(10),

  // Internal-caller boundary for POST /api/keys/derive (ADR 0001, open
  // question "internal-caller authz to the gateway", resolved 2026-08-25): we
  // never issue can_mint to external orgs, so derive additionally requires
  // the parent key's team_id to equal this fixed internal-platform org id, on
  // top of the existing can_mint check. This is the llm.teams.id (not the
  // KamuID org id) of the one team that owns every can_mint key (studio,
  // builder-queue, the kamuhub agent).
  INTERNAL_PLATFORM_TEAM_ID: z.string().min(1),

  // Control-plane poller (ADR 0001 §8/§9): pulls the proxy satellite's local
  // usage buffer (GET /usage) into the durable llm.usage_log table. Base URL
  // of the proxy satellite and the shared service-to-service token it expects
  // (proxy/src/routes/usage.ts's CONTROL_PLANE_POLL_TOKEN — the same value on
  // both sides). Interval in ms between poll runs; the poller itself streams
  // through the whole backlog per run (paging on max_id) so a slow interval
  // still catches up in one run after an outage.
  LLM_PROXY_URL: z.string().url().default("http://localhost:8301"),
  CONTROL_PLANE_POLL_TOKEN: z.string().min(1),
  USAGE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
});

const parsed = schema.safeParse(Deno.env.toObject());
if (!parsed.success) {
  console.error("Invalid environment:", parsed.error.issues);
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;

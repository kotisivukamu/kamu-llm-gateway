// Test-only environment bootstrap. MUST be the first import of every test
// file (before any module that imports `../env.ts`, directly or transitively)
// so `env.ts`'s top-level `schema.safeParse(Deno.env.toObject())` sees a
// complete, valid environment. `deno test` collects and imports every test
// file into one process, and env.ts's parse runs once at first import — so
// this only needs to run once, but every file importing it first is what
// makes the suite order-independent.
//
// Every value here is throwaway test fixture material (a fresh Ed25519
// keypair generated for this suite, never used outside it) — never commit
// real secrets. Values already set in the process env (CI's `env:` block, or
// a developer's shell) are left alone, so CI can point this at its Postgres
// service container without editing this file.

function setDefault(key: string, value: string) {
  if (!Deno.env.get(key)) Deno.env.set(key, value);
}

// Points at the throwaway Postgres started for the regression suite (see
// README "Running tests"). CI overrides both via its `env:` block to match
// the service container it starts.
setDefault(
  "APP_USER_DATABASE_URL",
  "postgres://app_user:app_user@localhost:5432/kamu_llm_gateway_test",
);
setDefault(
  "BYPASSRLS_DATABASE_URL",
  "postgres://postgres:postgres@localhost:5432/kamu_llm_gateway_test",
);

setDefault("PORT", "8399");
setDefault("LOG_LEVEL", "error");
setDefault("KAMUID_ISSUER", "https://accounts.kamuhub.com");

// `dev` sentinel: verify platform-context JWTs against a single fixed test
// public key instead of a live kamuhub JWKS (see lib/platform-context.ts).
setDefault("KAMUHUB_JWKS_URL", "dev");
setDefault(
  "KAMUHUB_DEV_JWK",
  '{"kty":"OKP","crv":"Ed25519","x":"-P0V-0GhV1nFu5fXTHaquDkhWJoeXNe3Wm3kjKANXnc"}',
);
// Matching private key (base64 of the raw 32-byte seed) — used by
// support/token.ts to sign test platform-context JWTs against KAMUHUB_DEV_JWK.
setDefault(
  "KAMUHUB_DEV_PRIVATE_KEY",
  "BABUQlkxgTrmH2mdLOdlaIHdelYEqrWPKQqOpSWHAX4=",
);

// Sub-key signing pair (ADR 0001 SS10.4a) — separate from the context pair above.
setDefault(
  "ED25519_PRIVATE_KEY",
  "9eoI/HkwmmgkmKzs9yu8drtLyeglFbz5FIulBSRHXrk=",
);
setDefault(
  "ED25519_PUBLIC_KEY",
  "VxiWrfnCtLTKomsUlDYHqGcLrUsyUh0g+n310PIbS64=",
);
setDefault("ED25519_KEY_ID", "test-ed25519-1");

setDefault("DEFAULT_SUBKEY_TTL_SECONDS", "3600");
setDefault("MAX_SUBKEY_TTL_SECONDS", "86400");
// Deliberately low (not the prod default of 60/1000): the derive
// concurrency-race test (keys.derive-race.test.ts) needs a small, easily
// exceeded limit to make a TOCTOU race observable with a realistic number of
// concurrent requests. No other test mints more than one or two keys per
// parent, so this doesn't affect them.
setDefault("SUBKEY_DERIVE_RATE_PER_MIN", "5");
setDefault("SUBKEY_DERIVE_MAX_ACTIVE", "5");
setDefault("KEY_META_CACHE_TTL_SEC", "10");

setDefault("LLM_PROXY_URL", "http://localhost:8301");
setDefault("CONTROL_PLANE_POLL_TOKEN", "test-poll-token");
// Effectively disabled for tests — nothing here exercises the poller's own
// interval loop; usage-poller tests call pollOnce-equivalent logic directly.
setDefault("USAGE_POLL_INTERVAL_MS", "3600000");

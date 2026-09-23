// Test-only environment bootstrap for the proxy package. Must be imported
// before any module that imports `../../env.ts` (directly or transitively) —
// see api/src/tests/support/env.ts for the full rationale, identical here.

function setDefault(key: string, value: string) {
  if (!Deno.env.get(key)) Deno.env.set(key, value);
}

setDefault(
  "GATEWAY_DATABASE_URL",
  "postgres://admin_role:admin_role@localhost:5432/kamu_llm_gateway_test",
);
setDefault(
  "ED25519_PUBLIC_KEY",
  "VxiWrfnCtLTKomsUlDYHqGcLrUsyUh0g+n310PIbS64=",
);
setDefault("ED25519_KEY_ID", "test-ed25519-1");
setDefault("KEY_META_CACHE_TTL_SEC", "10");
setDefault("CONTROL_PLANE_POLL_TOKEN", "test-poll-token");
setDefault("DB_PATH", ":memory:");

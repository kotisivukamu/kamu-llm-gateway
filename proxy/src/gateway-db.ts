import postgres from "postgres";
import { env } from "./env.ts";

// Read-only Postgres connect to the gateway DB for key-meta lookups (ADR 0001
// §3/§10.4). The proxy looks up `llm.keys` rows here to resolve the two
// credential shapes:
//   - top-level opaque keys (`sk_live_…`): by `key_hash` (sha256 hex of the
//     presented secret).
//   - derived sub-keys: by `id = jti` (the JWT's jti IS the row's PK).
//
// This pool is the cache's source of truth. It is NEVER on the hot path: the
// hot path reads from the in-process cache in auth.ts, and only a cache MISS
// reaches here. A cache row is held for KEY_META_CACHE_TTL_SEC; a revoked row
// is cached as "deny" for up to that TTL (ADR 0001 §10.6 step 3).
//
// search_path makes unqualified names resolve to llm.* (then public), so the
// schema is relocatable and collision-free in a shared dev DB (same convention
// as the gateway api — see api/src/config/db.ts).
export const gateway = postgres(env.GATEWAY_DATABASE_URL, {
  max: 3,
  idle_timeout: 30,
  connect_timeout: 10,
  connection: { search_path: "llm,public" },
  onnotice: () => {},
  // The proxy never writes to the gateway DB; this pool is read-only by
  // construction (we only ever SELECT).
});

// The subset of the `llm.keys` row the proxy needs to authorize and meter a
// request. Returned from a cache HIT or a fresh DB lookup; the cache stores
// exactly this shape (or a "deny" sentinel for revoked rows).
export interface KeyMeta {
  key_id: string;
  label: string;
  models: string[];
  budget_usd: number | null;
  status: string;
  key_type: "top" | "derived";
  parent_key_id: string | null;
  root_key_id: string | null;
  // expires_at as an ISO string (timestamptz), or null for a permanent key.
  expires_at: string | null;
}

// Sentinel cached for a row that must deny (status != 'active', or expired, or
// no row found). ADR 0001 §10.6 step 3 folds revocation into the same cached
// row: a row with status='revoked' is cached as "deny" for up to the TTL.
export const DENY: unique symbol = Symbol("deny");
export type CachedKeyMeta = KeyMeta | typeof DENY | null;

// Postgres NUMERIC columns (budget_usd) come back from postgres.js as
// strings, never as `number` (postgres.js never auto-coerces numeric, to
// avoid silent float precision loss). Coerce once here, at the boundary
// where a DB row becomes a KeyMeta, so every downstream consumer (the
// key-meta cache, auth.ts, proxy.ts) can trust `budget_usd` is a real
// `number | null` and compare it directly. Coercing at the call sites
// instead would be easy to miss on the hot path — this is the one place a
// row is turned into the cached shape.
function toKeyMeta(
  row:
    | (Omit<KeyMeta, "budget_usd"> & { budget_usd: string | number | null })
    | undefined,
): KeyMeta | null {
  if (!row) return null;
  return {
    ...row,
    budget_usd: row.budget_usd === null ? null : Number(row.budget_usd),
  };
}

// Look up a top-level opaque key by its sha256 hex hash.
export async function lookupKeyByHash(
  hash: string,
): Promise<KeyMeta | null> {
  const rows = await gateway<
    (Omit<KeyMeta, "budget_usd"> & { budget_usd: string | number | null })[]
  >`
    SELECT id AS key_id, label, models, budget_usd, status, key_type,
           parent_key_id::text AS parent_key_id,
           root_key_id::text   AS root_key_id,
           expires_at::text    AS expires_at
      FROM llm.keys
     WHERE key_hash = ${hash}
     LIMIT 1
  `;
  return toKeyMeta(rows[0]);
}

// Look up a derived sub-key by its row PK (= the JWT's jti).
export async function lookupKeyById(
  keyId: string,
): Promise<KeyMeta | null> {
  const rows = await gateway<
    (Omit<KeyMeta, "budget_usd"> & { budget_usd: string | number | null })[]
  >`
    SELECT id AS key_id, label, models, budget_usd, status, key_type,
           parent_key_id::text AS parent_key_id,
           root_key_id::text   AS root_key_id,
           expires_at::text    AS expires_at
      FROM llm.keys
     WHERE id = ${keyId}
     LIMIT 1
  `;
  return toKeyMeta(rows[0]);
}

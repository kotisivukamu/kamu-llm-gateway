import postgres from "postgres";
import { env } from "./env.ts";

// Postgres connection to the gateway DB, read-only: key-meta lookups (ADR
// 0001 §3/§10.4). The proxy writes nothing here. Spend is charged by the api
// when it ingests usage, which also flips a key to 'over_budget' (ADR 0003
// §4); the proxy only sees that status through these lookups.
//
// The proxy looks up `llm.keys` rows to resolve the two credential shapes:
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
});

// The subset of the `llm.keys` row the proxy needs to authorize and meter a
// request. Returned from a cache HIT or a fresh DB lookup; the cache stores
// exactly this shape (or a "deny" sentinel for revoked rows).
export interface KeyMeta {
  key_id: string;
  label: string;
  models: string[];
  status: string;
  key_type: "top" | "derived";
  parent_key_id: string | null;
  root_key_id: string | null;
  // expires_at as an ISO string (timestamptz), or null for a permanent key.
  expires_at: string | null;
}

// Look up a top-level opaque key by its sha256 hex hash.
export async function lookupKeyByHash(
  hash: string,
): Promise<KeyMeta | null> {
  const rows = await gateway<KeyMeta[]>`
    SELECT id AS key_id, label, models, status, key_type,
           parent_key_id::text AS parent_key_id,
           root_key_id::text   AS root_key_id,
           expires_at::text    AS expires_at
      FROM llm.keys
     WHERE key_hash = ${hash}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

// Look up a key by its row PK: a derived sub-key by its JWT jti, or the
// root of a derived key by root_key_id.
export async function lookupKeyById(
  keyId: string,
): Promise<KeyMeta | null> {
  const rows = await gateway<KeyMeta[]>`
    SELECT id AS key_id, label, models, status, key_type,
           parent_key_id::text AS parent_key_id,
           root_key_id::text   AS root_key_id,
           expires_at::text    AS expires_at
      FROM llm.keys
     WHERE id = ${keyId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

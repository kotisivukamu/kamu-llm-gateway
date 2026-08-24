import { env } from "./env.ts";
import { type KeyMeta, lookupKeyByHash, lookupKeyById } from "./gateway-db.ts";

// Re-export the row shape so consumers import the full cache API + the row
// type from one place.
export type { KeyMeta } from "./gateway-db.ts";

// In-process key-metadata cache (ADR 0001 §10.4 / §10.6 step 3).
//
// The hot path reads from here; a cache MISS does the gateway-DB lookup. This
// keeps the hot path ~0ms on hits (no network call, no DB read, no disk read).
// The cache is the ONLY place revocation takes up to KEY_META_CACHE_TTL_SEC to
// propagate: a row with status='revoked' is cached as DENY for up to the TTL,
// and a missing row is cached as null for the same window (so a brute-force
// sweep of nonexistent hashes still doesn't hit the DB on every try).
//
// Two keyed maps mirror the two lookup paths:
//   - byHash: top-level opaque keys, keyed by sha256(secret) hex.
//   - byId:   derived sub-keys (and any id-based lookup), keyed by the row PK
//             (= the JWT jti).
//
// Entries expire (TTL = KEY_META_CACHE_TTL_SEC). A naive size bound is not
// needed at projected traffic (ADR 0001 §10.9: distinct keys alive is small
// and bounded by exp-pruning for short-lived keys); the TTL sweep keeps the
// permanent-key population from growing without bound across a long uptime.

export interface CacheEntry {
  meta: CachedKeyMeta;
  expiresAt: number; // epoch ms
}

// ADR 0001 §10.6 step 3 `revokedSet` is folded into this same cached row: a
// row with status='revoked' (or an expired row, or a missing row) is cached as
// DENY. The hot path treats DENY as "deny" without re-reading the DB.
export const DENY: unique symbol = Symbol("deny");
export type CachedKeyMeta = KeyMeta | typeof DENY | null;

const byHash = new Map<string, CacheEntry>();
const byId = new Map<string, CacheEntry>();

function ttlMs(): number {
  return env.KEY_META_CACHE_TTL_SEC * 1000;
}

function fresh(entry: CacheEntry | undefined): CachedKeyMeta | undefined {
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) return undefined;
  return entry.meta;
}

// Resolve a row into its cached form: DENY if it must deny (not active /
// expired / missing), else the row metadata.
function toCached(row: KeyMeta | null): CachedKeyMeta {
  if (!row) return DENY;
  if (row.status !== "active") return DENY;
  if (row.expires_at) {
    const exp = new Date(row.expires_at).getTime();
    if (!Number.isFinite(exp) || exp <= Date.now()) return DENY;
  }
  return row;
}

function store(
  map: Map<string, CacheEntry>,
  key: string,
  meta: CachedKeyMeta,
): void {
  map.set(key, { meta, expiresAt: Date.now() + ttlMs() });
}

// Top-level opaque key: lookup by sha256(secret) hex.
export async function lookupByHash(
  hash: string,
): Promise<CachedKeyMeta> {
  const hit = fresh(byHash.get(hash));
  if (hit !== undefined) return hit;
  const row = await lookupKeyByHash(hash);
  const cached = toCached(row);
  store(byHash, hash, cached);
  return cached;
}

// Derived sub-key: lookup by row PK (= the JWT jti).
export async function lookupById(
  keyId: string,
): Promise<CachedKeyMeta> {
  const hit = fresh(byId.get(keyId));
  if (hit !== undefined) return hit;
  const row = await lookupKeyById(keyId);
  const cached = toCached(row);
  store(byId, keyId, cached);
  return cached;
}

import { importJWK, jwtVerify } from "jose";
import { env } from "./env.ts";
import { DENY, type KeyMeta, lookupByHash, lookupById } from "./keymeta.ts";

// Credential verification for the two DB-backed shapes (ADR 0001 §3 / §10.6).
// The legacy shared SESSION_JWT_SECRET is gone — this is the new authority.
//
// The proxy holds TWO verification capabilities and ZERO minting capabilities
// (ADR 0001 §10.4a):
//   - the Ed25519 PUBLIC key (verifies sub-key JWTs, can never mint), and
//   - the key-meta cache (looks up top-level opaque keys, can never forge).
//
// Token is presented in `x-api-key` (Anthropic SDK) or `Authorization: Bearer`
// (OpenAI SDK). Either header works — same as the legacy proxy.

// The verified credential the hot path carries forward. Same semantics as the
// legacy LlmToken (jti, name, models, budget_usd) plus the lineage + key_type
// the new model needs for metering and roll-up (ADR 0001 §7.6/§8).
export interface KeyCredential {
  // The gateway row PK. Spend and usage_log are keyed by this (ADR 0001 §8).
  key_id: string;
  // jti is kept as an alias = key_id for the poll contract + log shape parity.
  jti: string;
  // Human-readable label set at mint time. Surfaces in proxy logs.
  name: string;
  // Allowed catalog model slugs. "*" anywhere means any model; empty is
  // fail-closed. For sub-keys this is the (subset) set signed into the JWT,
  // but the row is the authority — we read it from the row.
  models: string[];
  // Optional hard spend cap in USD. null = uncapped (skip the pre-check,
  // same as the legacy proxy). For sub-keys this comes from the row.
  budget_usd: number | null;
  // 'top' = top-level opaque key; 'derived' = Ed25519-signed sub-key JWT.
  key_type: "top" | "derived";
  // Lineage (ADR 0001 §7.6). For a top-level key, parent_key_id = null and
  // root_key_id = self. Metering writes both into usage_log so spend rolls up
  // to a service's whole subtree.
  parent_key_id: string | null;
  root_key_id: string | null;
}

export function extractCredential(headers: Headers): string {
  const xKey = headers.get("x-api-key");
  if (xKey) return xKey;
  const auth = headers.get("authorization");
  if (auth) return auth.replace(/^Bearer\s+/i, "");
  return "";
}

// sha256(secret) as a hex string — same hashKey the control-plane
// lib/keys.ts stores in `keys.key_hash` (ADR 0001 §3). The proxy hashes the
// presented secret and looks the row up by this column.
async function hashKey(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

// --- Ed25519 public key (sub-key JWT verification) ---------------------------
// The proxy holds ONLY the public key. It can verify sub-key signatures in
// <0.1ms but can never mint, even under full VM compromise (ADR 0001 §10.4a).
// Reconstructed from the base64 raw 32-byte public key, the same encoding the
// api uses (api/src/lib/ed25519.ts). Built once and cached.

function b64ToB64url(b: string): string {
  return b.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const pubBytes = decodeBase64Bytes(env.ED25519_PUBLIC_KEY);
if (pubBytes.length !== 32) {
  throw new Error(
    `ED25519_PUBLIC_KEY must be 32 bytes (base64 of the raw public key); got ${pubBytes.length} bytes`,
  );
}
const pubX = b64ToB64url(
  btoa(String.fromCharCode(...pubBytes)),
);

let verifyKey: CryptoKey | null = null;
async function getVerifyKey(): Promise<CryptoKey> {
  if (!verifyKey) {
    const k = await importJWK({ kty: "OKP", crv: "Ed25519", x: pubX }, "EdDSA");
    if (!(k instanceof CryptoKey)) {
      throw new Error("Ed25519 JWK import did not yield a CryptoKey");
    }
    verifyKey = k;
  }
  return verifyKey;
}

// --- Format detection (ADR 0001 §10.6 step 1) -------------------------------
//   sk_live_…  → top-level opaque key (lookup by hash)
//   three-segment compact JWT (header.payload.signature) → derived sub-key
//   neither → 401

const TOP_PREFIX = "sk_live_";

function looksLikeJwt(presented: string): boolean {
  // A compact JWT is exactly three base64url segments separated by '.'.
  const parts = presented.split(".");
  if (parts.length !== 3) return false;
  // Each segment is non-empty and base64url-ish. Cheap structural check; the
  // real authority is the signature verification that follows.
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

// Resolve a raw key-meta row into a verified credential, applying the active +
// expiry checks that are the same for both credential shapes (ADR 0001 §10.6
// step 3: a row with status='revoked' denies; an expired row denies). Returns
// null if the row must deny (so the cache can store DENY for it).
function rowToCredential(row: KeyMeta): KeyCredential | null {
  if (row.status !== "active") return null;
  if (row.expires_at) {
    const exp = new Date(row.expires_at).getTime();
    if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  }
  return {
    key_id: row.key_id,
    jti: row.key_id,
    name: row.label,
    models: row.models,
    budget_usd: row.budget_usd,
    key_type: row.key_type,
    parent_key_id: row.parent_key_id,
    root_key_id: row.root_key_id,
  };
}

// The hot-path entry point. ADR 0001 §10.6:
//   1. detect format
//   2. verify (lookup by hash / verify Ed25519 signature + extract jti)
//   3. lookup the row (from cache, or DB on miss) and deny if revoked
//   4. (budget pre-check happens in proxy.ts, against getSpentUsd(key_id))
//
// The cache (keymeta.ts) holds the row metadata; on a MISS it does the DB
// lookup. This keeps the hot path ~0ms on hits. The cache is the ONLY place
// revocation takes up to KEY_META_CACHE_TTL_SEC to propagate (a revoked row is
// cached as DENY).
export async function verifyCredential(
  presented: string,
): Promise<KeyCredential | null> {
  if (!presented) return null;

  // --- Top-level opaque key ------------------------------------------------
  if (presented.startsWith(TOP_PREFIX)) {
    const hash = await hashKey(presented);
    const cached = await lookupByHash(hash);
    if (cached === DENY) return null;
    if (cached) return rowToCredential(cached);
    return null;
  }

  // --- Derived sub-key JWT --------------------------------------------------
  if (looksLikeJwt(presented)) {
    // Verify the Ed25519 signature statelessly (~0ms). jwtVerify checks exp
    // (ADR 0001 §10.6 step 1 for sub-keys). The kid in the header must match
    // ED25519_KEY_ID — rotation: accept the previous kid during a grace window
    // (TODO when rotated keys exist; for now a single kid).
    const key = await getVerifyKey();
    let payload: { jti?: string };
    try {
      const { payload: p } = await jwtVerify(presented, key, {
        algorithms: ["EdDSA"],
      });
      payload = p as { jti?: string };
    } catch {
      return null;
    }
    const jti = payload.jti;
    if (!jti) return null;

    // The row is the authority on lifecycle/lineage/budget (ADR 0001 §3).
    const cached = await lookupById(jti);
    if (cached === DENY) return null;
    if (cached) return rowToCredential(cached);
    return null;
  }

  // Neither shape — fail: 401.
  return null;
}

// Authorization check. The credential carries an allowlist of catalog model
// slugs; the literal "*" grants any model. Empty allowlist is fail-closed.
// Same semantics as the legacy isModelAllowed (reads token.models).
export function isModelAllowed(
  token: KeyCredential,
  model_slug: string,
): boolean {
  return token.models.includes("*") || token.models.includes(model_slug);
}

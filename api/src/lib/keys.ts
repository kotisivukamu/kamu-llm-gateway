import { SignJWT } from "jose";
import { getSigningKey, signingKeyId } from "./ed25519.ts";

// Key material helpers for the two credential shapes (ADR 0001 §3).
//
// Top-level keys: an opaque random secret (`sk_live_…`) stored as a sha256 hash
// on the row (never the secret itself), plus a human-readable prefix for
// display. Verified on the proxy hot path by lookup against the key-meta cache.
//
// Derived sub-keys: a compact Ed25519-signed JWT on the wire whose `jti` IS the
// DB row's PK (§10.4). The row is the authority on lifecycle/lineage/budget;
// the JWT is the authority on request authenticity.

export const PREFIX_LIVE = "sk_live_";

/**
 * Generate a fresh top-level opaque key secret. Returns the full secret (shown
 * ONCE to the caller on POST /api/keys), its sha256 hex hash (stored on the
 * row), and a human-readable prefix for display. The secret is 32 random bytes
 * hex-encoded, prefixed `sk_live_` for grep/display safety.
 *
 * `hash` is async because sha256 goes through WebCrypto's async digest; the
 * caller (an async handler) awaits it.
 */
export async function generateTopLevelKey(): Promise<{
  secret: string;
  hash: string;
  prefix: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  const secret = PREFIX_LIVE + hex;
  return {
    secret,
    hash: await hashKey(secret),
    prefix: secret.slice(0, 12),
  };
}

/**
 * sha256(secret) as a hex string — what the `keys.key_hash` column stores.
 * The proxy hashes the presented secret and looks it up against this column
 * via the key-meta cache (ADR 0001 §3/§10.4).
 */
export async function hashKey(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export interface SubKeyJwtPayload {
  // jti = the keys row's PK (the binding between the JWT on the wire and the
  // DB row that is the authority on lifecycle/lineage/budget).
  jti: string;
  // sub = the root key id (root_key_id), so the proxy can roll up a service's
  // whole subtree spend without a DB join.
  sub: string;
  models: string[];
  budget_usd: number | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Sign a derived sub-key JWT (compact, Ed25519). The `jti` is the keys row's
 * PK; `exp` is the clamped child expiry (ADR 0001 §7.1). The JWT is the wire
 * authority on request authenticity; the DB row (looked up by jti) is the
 * authority on lifecycle. Returns the compact JWT string.
 */
export async function signSubKeyJwt(
  payload: SubKeyJwtPayload,
  expEpochSeconds: number,
): Promise<string> {
  const key = await getSigningKey();
  const jwt = await new SignJWT({
    jti: payload.jti,
    sub: payload.sub,
    models: payload.models,
    budget_usd: payload.budget_usd,
    metadata: payload.metadata ?? undefined,
  })
    .setProtectedHeader({ alg: "EdDSA", kid: signingKeyId() })
    .setIssuedAt()
    .setExpirationTime(expEpochSeconds)
    .sign(key);
  return jwt;
}

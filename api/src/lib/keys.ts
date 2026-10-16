import { jwtVerify, SignJWT } from "jose";
import { adminSql } from "../config/db.ts";
import { getSigningKey, getVerifyKey, signingKeyId } from "./ed25519.ts";

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

/** The presented gateway credential: `x-api-key`, else the bearer token. */
export function extractCredential(headers: Headers): string {
  return headers.get("x-api-key") ??
    (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
}

/** Whose usage a verified gateway credential may read. */
export interface UsageScope {
  key_id: string;
  key_type: "top" | "derived";
}

/**
 * Verifies a gateway credential the way the proxy does (proxy/src/auth.ts):
 * a top-level `sk_live_` key by its hash, a derived sub-key JWT by its
 * Ed25519 signature and then its row (jti = row PK). The row must be active
 * or over_budget and unexpired; a derived key's root must be too. Over-budget
 * keys may still read their usage, as on the proxy. One DB read, no cache:
 * this path serves usage reads, not the LLM hot path. Null = 401.
 */
export async function verifyGatewayCredential(
  presented: string,
): Promise<UsageScope | null> {
  let where: { hash: string } | { id: string };
  if (presented.startsWith(PREFIX_LIVE)) {
    where = { hash: await hashKey(presented) };
  } else if (presented.split(".").length === 3) {
    try {
      const { payload } = await jwtVerify(presented, await getVerifyKey(), {
        algorithms: ["EdDSA"],
      });
      if (typeof payload.jti !== "string") return null;
      where = { id: payload.jti };
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const [row] = await adminSql<UsageScope[]>`
    SELECT k.id::text AS key_id, k.key_type
      FROM llm.keys k
      JOIN llm.keys r ON r.id = COALESCE(k.root_key_id, k.id)
     WHERE ${
    "hash" in where
      ? adminSql`k.key_hash = ${where.hash} AND k.key_type = 'top'`
      : adminSql`k.id = ${where.id}::uuid AND k.key_type = 'derived'`
  }
       AND k.status IN ('active', 'over_budget')
       AND (k.expires_at IS NULL OR k.expires_at > now())
       AND r.status IN ('active', 'over_budget')
       AND (r.expires_at IS NULL OR r.expires_at > now())
  `;
  return row ?? null;
}

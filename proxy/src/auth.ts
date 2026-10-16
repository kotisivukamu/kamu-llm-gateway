import { importJWK, jwtVerify } from "jose";
import { env } from "./env.ts";
import {
  type CachedKeyMeta,
  DENY,
  type KeyMeta,
  lookupByHash,
  lookupById,
} from "./keymeta.ts";

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
// legacy LlmToken (jti, name, models) plus the lineage + key_type
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
  // The key, or the root it derives from, has reached its budget (ADR 0003
  // §4: the api sets status 'over_budget' at ingest). LLM calls get 402;
  // reading its own usage is still allowed.
  over_budget: boolean;
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

// A cached row the request may use: not DENY, and not expired. The cache
// turned revoked, expired and missing rows into DENY when it stored them;
// expiry is checked again because a cached row can expire within the TTL.
function usable(cached: CachedKeyMeta): cached is KeyMeta {
  if (!cached || cached === DENY) return false;
  if (!cached.expires_at) return true;
  const exp = new Date(cached.expires_at).getTime();
  return Number.isFinite(exp) && exp > Date.now();
}

// Resolve a cached key-meta row into a verified credential (ADR 0001 §10.6
// step 3). A usable row is 'active' or 'over_budget'. A derived key also
// needs its root: an over-budget root stops the whole subtree (402), and a
// root that is revoked or gone denies (401). Ingest flips only the key it
// charged and that key's root, never the root's other children, so this check
// is what makes a root's budget cover them. The root row comes from the same
// cache, so this adds no DB read on a hit.
async function toCredential(
  cached: CachedKeyMeta,
): Promise<KeyCredential | null> {
  if (!usable(cached)) return null;
  let overBudget = cached.status === "over_budget";
  if (cached.root_key_id && cached.root_key_id !== cached.key_id) {
    const root = await lookupById(cached.root_key_id);
    if (!usable(root)) return null;
    overBudget ||= root.status === "over_budget";
  }
  return {
    key_id: cached.key_id,
    jti: cached.key_id,
    name: cached.label,
    models: cached.models,
    over_budget: overBudget,
    key_type: cached.key_type,
    parent_key_id: cached.parent_key_id,
    root_key_id: cached.root_key_id,
  };
}

// The hot-path entry point. ADR 0001 §10.6:
//   1. detect format
//   2. verify (lookup by hash / verify Ed25519 signature + extract jti)
//   3. lookup the row (from cache, or DB on miss) and deny if revoked; for a
//      derived key, the root's row too
//   4. budget: over_budget on the credential, proxy.ts answers 402 (ADR 0003)
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
    return toCredential(await lookupByHash(hash));
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
    return toCredential(await lookupById(jti));
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

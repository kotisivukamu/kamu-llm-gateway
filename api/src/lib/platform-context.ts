import { createRemoteJWKSet, importJWK, jwtVerify } from "jose";
import { env } from "../env.ts";

// Verifies the kamuhub platform-context header (X-Kamuhub-Authz) the BFF injects
// on the browser path. It's an EdDSA-signed JWT; we verify it with kamuhub's
// PUBLIC key from its JWKS (KAMUHUB_JWKS_URL) — asymmetric, so we can verify but
// never forge, and key rotation is automatic (jose refetches on a new `kid`).
// See kamuhub ARCHITECTURE.md ("How products consume platform authz").
//
// DEV FALLBACK: when KAMUHUB_JWKS_URL is the literal sentinel `dev`, the remote
// JWKS is not fetched (the kamuhub BFF is not running locally during a smoke
// test, so there is no live JWKS to fetch). Instead verification uses a single
// dev public key supplied in KAMUHUB_DEV_JWK (a JWK JSON string, Ed25519). This
// is the ONLY deviation from the prod path, and it is gated on the explicit
// `dev` sentinel — a real https:// JWKS URL always takes the remote path. The
// dev JWK is the PUBLIC half of a locally-generated Ed25519 keypair; the matching
// private key signs the platform-context JWT in scripts/dev-token.ts. Prod must
// not set `dev` (the env schema documents this; a CI/stage deploy with the
// sentinel left in fails closed against an unconfigured dev JWK).

export interface ContextOrg {
  id: string;
  kamuid_org_id: string | null;
  slug: string;
  name: string;
  role: string;
  grants: string[];
}

export interface PlatformContext {
  user_id: string;
  sub: string;
  orgs: ContextOrg[];
  iat: number;
  exp: number;
}

// Lazily built remote JWK set — caches keys and refetches when a token presents
// an unknown `kid` (i.e. after a kamuhub key rotation). Only constructed when a
// real JWKS URL is configured (not the `dev` sentinel).
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function remoteJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(env.KAMUHUB_JWKS_URL));
  return jwks;
}

// Lazily imported dev verification key (Ed25519 public key from KAMUHUB_DEV_JWK).
// Built once and cached. `dev` mode fails closed if the JWK is missing/invalid.
let devKey: CryptoKey | null = null;
async function devVerifyKey(): Promise<CryptoKey | null> {
  if (!env.KAMUHUB_DEV_JWK) return null;
  if (!devKey) {
    try {
      const jwk = JSON.parse(env.KAMUHUB_DEV_JWK);
      if (
        jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string"
      ) {
        return null;
      }
      // importJWK returns a CryptoKey for OKP/Ed25519.
      const k = await importJWK(jwk, "EdDSA");
      if (!(k instanceof CryptoKey)) return null;
      devKey = k;
    } catch {
      return null;
    }
  }
  return devKey;
}

// Returns the verified context, or null if the JWT is missing/invalid/expired.
// jose checks the EdDSA signature and `exp`; we just sanity-check the shape.
export async function verifyPlatformContext(
  token: string,
): Promise<PlatformContext | null> {
  try {
    let verifyResult;
    if (env.KAMUHUB_JWKS_URL === "dev") {
      // `dev` sentinel: verify with the single dev public key from KAMUHUB_DEV_JWK.
      // Fail closed (return null) if no/invalid dev JWK — never fall through to
      // constructing a remote JWKS from the non-URL `dev` string, which would throw.
      const dk = await devVerifyKey();
      if (!dk) return null;
      verifyResult = await jwtVerify(token, dk, { algorithms: ["EdDSA"] });
    } else {
      verifyResult = await jwtVerify(token, remoteJwks(), {
        algorithms: ["EdDSA"],
      });
    }
    const { payload } = verifyResult;
    if (!Array.isArray((payload as { orgs?: unknown }).orgs)) return null;
    return payload as unknown as PlatformContext;
  } catch {
    return null;
  }
}

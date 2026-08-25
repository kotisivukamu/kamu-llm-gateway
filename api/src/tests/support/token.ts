import "./env.ts";
import { importJWK, SignJWT } from "jose";

// Mints signed platform-context JWTs for tests, mirroring scripts/dev-token.ts
// but parameterized per-test (arbitrary subject/org/grants). Presented as the
// bearer token, this is the "access-key path (a)" credential from
// middleware/auth.ts: the API verifies it directly against KAMUHUB_DEV_JWK
// (KAMUHUB_JWKS_URL=dev, set by support/env.ts) with no KamuID round-trip and
// no separate X-Kamuhub-Authz header, so a test can exercise `requireGrant`
// with an exact, controlled grant set.

function b64ToB64url(b: string): string {
  return b.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let signingKey: CryptoKey | null = null;
async function getTestSigningKey(): Promise<CryptoKey> {
  if (!signingKey) {
    const seedB64 = Deno.env.get("KAMUHUB_DEV_PRIVATE_KEY")!;
    const d = b64ToB64url(
      btoa(String.fromCharCode(...decodeBase64Bytes(seedB64))),
    );
    const key = await importJWK({ kty: "OKP", crv: "Ed25519", d }, "EdDSA");
    if (!(key instanceof CryptoKey)) {
      throw new Error("Ed25519 JWK import did not yield a CryptoKey");
    }
    signingKey = key;
  }
  return signingKey;
}

export interface TestOrgClaim {
  kamuidOrgId: string;
  grants: string[];
  slug?: string;
  name?: string;
  role?: string;
}

/**
 * Sign a platform-context JWT for a test user scoped to the given orgs+grants.
 * `sub` becomes the RLS principal (app.current_user_id).
 */
export async function signTestContext(opts: {
  sub?: string;
  orgs: TestOrgClaim[];
  ttlSeconds?: number;
}): Promise<string> {
  const key = await getTestSigningKey();
  const sub = opts.sub ?? `user_test_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (opts.ttlSeconds ?? 3600);

  const orgs = opts.orgs.map((o) => ({
    id: o.kamuidOrgId,
    kamuid_org_id: o.kamuidOrgId,
    slug: o.slug ?? o.kamuidOrgId,
    name: o.name ?? o.kamuidOrgId,
    role: o.role ?? "owner",
    grants: o.grants,
  }));

  return await new SignJWT({
    user_id: sub,
    sub,
    email: "test@kamuhub.dev",
    name: "Test User",
    orgs,
  })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(key);
}

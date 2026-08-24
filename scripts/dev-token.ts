// scripts/dev-token.ts
//
// Mints a signed platform-context JWT (EdDSA / Ed25519) for the kamu-llm-gateway
// local smoke test. This is the "access-key path (a)" credential from
// middleware/auth.ts: the bearer token IS a kamuhub-signed platform context, so
// the API verifies it directly (no KamuID /userinfo round-trip, no
// X-Kamuhub-Authz header) and admits the caller.
//
// Why this exists: the kamuhub BFF is not running locally during the smoke
// test, so there is no live process minting X-Kamuhub-Authz headers. The API's
// dev fallback (lib/platform-context.ts, KAMUHUB_JWKS_URL=dev) verifies against
// the single dev public key in KAMUHUB_DEV_JWK. This script signs with the
// matching dev PRIVATE key, so the two are a verified pair.
//
// The dev signing key is SEPARATE from the api's ED25519_* sub-key signing key:
//   - KAMUHUB_DEV_*  — signs/verifies the platform-context JWT (admission).
//   - ED25519_*      — signs derived sub-key JWTs (POST /api/keys/derive).
//
// Usage (from the repo root):
//   deno task dev-token            # prints the JWT
//   deno task dev-token -- --ttl 86400   # custom TTL in seconds
//   TOKEN=$(deno task dev-token)
//
// The payload carries the test user + their single scoped org with the grants
// the smoke test exercises (llm.keys.create + llm.keys.revoke). sub is the
// KamuID subject = the RLS principal (app.current_user_id).

import { importJWK, SignJWT } from "jose";
import { parseArgs } from "@std/cli/parse_args";

const args = parseArgs(Deno.args, {
  number: ["ttl"],
  default: { ttl: 3600 },
});

// The dev private key (Ed25519 seed) for signing platform-context JWTs. Read
// from the env so the secret never lives in the repo. base64 of the raw 32-byte
// seed — the same shape the api's ED25519_PRIVATE_KEY uses, but for the CONTEXT
// key, not the sub-key key. Required: fail fast if missing.
const seedB64 = Deno.env.get("KAMUHUB_DEV_PRIVATE_KEY");
if (!seedB64) {
  console.error(
    "KAMUHUB_DEV_PRIVATE_KEY is required (base64 of the 32-byte Ed25519 seed).",
  );
  console.error(
    "Generate one with: openssl genpkey -algorithm Ed25519 | openssl pkey -outform DER | tail -c 32 | base64",
  );
  Deno.exit(1);
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToB64url(b: string): string {
  return b.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const seedBytes = decodeBase64Bytes(seedB64);
if (seedBytes.length !== 32) {
  console.error(
    `KAMUHUB_DEV_PRIVATE_KEY must be 32 bytes (base64 of the raw seed); got ${seedBytes.length}`,
  );
  Deno.exit(1);
}
const d = b64ToB64url(btoa(String.fromCharCode(...seedBytes)));

// Build the Ed25519 signing key from the seed JWK. jose importJWK reconstructs
// the OKP private key from {kty, crv, d}.
const key = await importJWK({ kty: "OKP", crv: "Ed25519", d }, "EdDSA");
if (!(key instanceof CryptoKey)) {
  console.error("Ed25519 JWK import did not yield a CryptoKey");
  Deno.exit(1);
}

// The test principal + scoped org. Matches database/seeds/dev.sql:
//   team: kamuid_org_id='org_test_1', slug='testorg', name='Test Org'
//   team_members: user_id='user_test_1', role='owner'
const sub = "user_test_1";
const orgs = [
  {
    id: "org_test_1",
    kamuid_org_id: "org_test_1",
    slug: "testorg",
    name: "Test Org",
    role: "owner",
    grants: ["llm.keys.create", "llm.keys.revoke"],
  },
];

const now = Math.floor(Date.now() / 1000);
const exp = now + args.ttl;

const jwt = await new SignJWT({
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

console.log(jwt);

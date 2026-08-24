import { importJWK } from "jose";
import { env } from "../env.ts";

// Loads the Ed25519 key pair from env (ADR 0001 §10.4a). The PRIVATE key is held
// ONLY by the central API — the single place that mints derived sub-keys
// (POST /api/keys/derive). The proxy satellite holds only the PUBLIC key (can
// verify, can never mint, even under full VM compromise).
//
// The env stores the raw 32-byte seed (private) and raw 32-byte public key as
// base64 (standard alphabet). jose's importJWK wants base64url OKP JWK fields,
// so we re-encode and let jose reconstruct the CryptoKey. The control plane
// only SIGNS (it never verifies sub-key JWTs here — that's the proxy's job),
// but getVerifyKey() is exposed so a future internal-verify path or test can
// round-trip without re-parsing env.

function b64ToB64url(b: string): string {
  return b.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Eagerly decode + validate at module load (fail fast): a malformed key
// crashes the process at boot instead of failing mid-request.
const seedBytes = decodeBase64Bytes(env.ED25519_PRIVATE_KEY);
const pubBytes = decodeBase64Bytes(env.ED25519_PUBLIC_KEY);
if (seedBytes.length !== 32) {
  throw new Error(
    `ED25519_PRIVATE_KEY must be 32 bytes (base64 of the raw seed); got ${seedBytes.length} bytes`,
  );
}
if (pubBytes.length !== 32) {
  throw new Error(
    `ED25519_PUBLIC_KEY must be 32 bytes (base64 of the raw public key); got ${pubBytes.length} bytes`,
  );
}

const x = b64ToB64url(btoa(String.fromCharCode(...pubBytes)));
const d = b64ToB64url(btoa(String.fromCharCode(...seedBytes)));

// importJWK is async (it calls crypto.subtle.importKey), so the keys are built
// lazily on first use and cached. importJWK returns `Uint8Array | KeyLike` for
// the general case (oct symmetric keys decode to raw bytes); for OKP/Ed25519 it
// always returns a CryptoKey, so we narrow here.
let signingKey: CryptoKey | null = null;
let verifyKey: CryptoKey | null = null;

function asCryptoKey(k: unknown): CryptoKey {
  if (!(k instanceof CryptoKey)) {
    throw new Error("Ed25519 JWK import did not yield a CryptoKey");
  }
  return k;
}

export async function getSigningKey(): Promise<CryptoKey> {
  if (!signingKey) {
    signingKey = asCryptoKey(
      await importJWK({ kty: "OKP", crv: "Ed25519", x, d }, "EdDSA"),
    );
  }
  return signingKey;
}

export async function getVerifyKey(): Promise<CryptoKey> {
  if (!verifyKey) {
    verifyKey = asCryptoKey(
      await importJWK({ kty: "OKP", crv: "Ed25519", x }, "EdDSA"),
    );
  }
  return verifyKey;
}

// The kid placed in the JWT header so the proxy's JWKS lookup resolves. Bump on
// rotation; proxies accept the previous kid during a grace window.
export function signingKeyId(): string {
  return env.ED25519_KEY_ID;
}

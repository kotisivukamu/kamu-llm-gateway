// Top-level opaque-key generation, duplicated (not imported) from
// api/src/lib/keys.ts. Per the task's package-boundary guidance: this is two
// small pure functions, and importing across the api/admin package boundary
// (a relative `../../api/src/lib/keys.ts`) would couple two independently
// deployed Fly apps' source trees for no real reuse benefit — admin/ never
// needs generateTopLevelKey's sibling (signSubKeyJwt/Ed25519), only this. If
// the two ever drift, that's a bug to fix by hand, same as any duplicated
// logic — there's no shared/ home for it because shared/ is types-only
// (see shared/types.ts's own header comment).

export const PREFIX_LIVE = "sk_live_";

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

export async function hashKey(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

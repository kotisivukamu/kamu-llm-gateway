import type { Context, Next } from "@hono/hono";
import { env } from "../env.ts";
import { ensureTeams, reconcileTeams } from "../lib/kamuid-sync.ts";
import {
  type ContextOrg,
  verifyPlatformContext,
} from "../lib/platform-context.ts";
import type { OrgClaim, Role } from "@shared/types.ts";

// Resource-server auth for the kamuhub-proxy path. Per kamuhub ADR 0001
// (identity vs authz boundary), an authenticated request is admitted ONLY if it
// carries a verified kamuhub EdDSA platform context, in one of two forms:
//
//   (a) ACCESS-KEY path: the bearer token IS itself a kamuhub-signed platform
//       context (CLI / coding harness). The bearer already proves BFF-mint, so
//       this path is exempt from the header requirement below.
//   (b) OPAQUE-KAMUID path: the bearer is an opaque KamuID access token
//       (identity), validated via /userinfo, that MUST be accompanied by a
//       valid signed X-Kamuhub-Authz platform context (orgs + grants).
//
// The context is MANDATORY on path (b): a bare KamuID bearer with no/invalid
// X-Kamuhub-Authz is rejected. KamuID issues OPAQUE access tokens to RPs without
// a resource indicator (RFC 8707), so /userinfo proves the token is live but NOT
// that it was minted for us or reached us through the BFF — a token minted for
// ANY RP would otherwise replay directly against this API. The signed context is
// the proof the request transited the BFF, which did the authn and is the RP
// that owns the token.
//
//   - IDENTITY comes from KamuID: /userinfo (a 200 with a sub = a live token).
//     The gateway owns NO account model — the KamuID `sub` IS the RLS principal
//     (app.current_user_id). No local user row is upserted.
//   - ORG MEMBERSHIP comes from the signed PLATFORM CONTEXT, never the raw
//     KamuID claim. We project the verified context's orgs into local teams +
//     team_members (keyed on the shared kamuid_org_id).

export type AuthUser = {
  id: string;
  email: string;
  name: string;
};

export type AuthEnv = {
  Variables: {
    user: AuthUser;
    platformContext?: Awaited<ReturnType<typeof verifyPlatformContext>>;
  };
};

const ISSUER = env.KAMUID_ISSUER.replace(/\/$/, "");

// Keyed by the access token. Bounds /userinfo + reconcile to once per token per
// window; access tokens are short-lived so entries age out naturally.
const RESYNC_MS = 5 * 60 * 1000;
const cache = new Map<string, { user: AuthUser; sub: string; exp: number }>();

interface UserInfo {
  sub: string;
  email?: string;
  name?: string;
  email_verified?: boolean;
}

async function fetchUserInfo(token: string): Promise<UserInfo | null> {
  const res = await fetch(`${ISSUER}/api/auth/oauth2/userinfo`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return await res.json() as UserInfo;
}

// Provision the RLS principal from the KamuID identity. The gateway owns NO
// account model — the KamuID `sub` IS the user id that RLS scopes on
// (app.current_user_id). There is no local user row to upsert; we just
// normalize the identity for display. Org membership is reconciled separately
// from the verified platform context.
function provisionUser(
  info: Pick<UserInfo, "sub" | "email" | "name">,
): AuthUser {
  const email = info.email ?? "";
  const name = info.name ?? (email || info.sub);
  return { id: info.sub, email, name };
}

// Map the verified platform context's orgs to the OrgClaim shape reconcileTeams
// expects. Only orgs carrying the shared kamuid_org_id are projected.
function contextToOrgClaims(orgs: ContextOrg[]): OrgClaim[] {
  return orgs.flatMap((o): OrgClaim[] => {
    if (!o.kamuid_org_id) return [];
    const role: Role = o.role === "owner" || o.role === "admin"
      ? o.role
      : "member";
    return [{
      id: o.kamuid_org_id,
      slug: o.slug,
      name: o.name || o.slug,
      role,
    }];
  });
}

export async function authMiddleware(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  // (a) Access-key path: a kamuhub-signed platform context presented AS the
  // bearer (CLI / coding harness). It carries identity (sub, email, name) and the
  // key's SCOPED grants, so there is no KamuID /userinfo round-trip and no
  // separate X-Kamuhub-Authz header — the signed bearer itself proves BFF-mint,
  // so this path is exempt from the mandatory-header gate below. A KamuID opaque
  // token is not a JWT, so this verify returns null and we fall through to the
  // opaque-KamuID path. We stash the context for requireGrant, and ensure (never
  // reconcile-delete) the single scoped org so we don't revoke the user's other
  // memberships.
  const keyCtx = await verifyPlatformContext(token);
  if (keyCtx?.sub) {
    const ident = keyCtx as unknown as { email?: string; name?: string };
    const user = provisionUser({
      sub: keyCtx.sub,
      email: ident.email,
      name: ident.name,
    });
    await ensureTeams(user.id, contextToOrgClaims(keyCtx.orgs)).catch((err) =>
      console.error("[access-key] team ensure failed:", err)
    );
    c.set("user", user);
    c.set("platformContext", keyCtx);
    await next();
    return;
  }

  // (b) Opaque-KamuID path. The signed platform context is MANDATORY here: an
  // opaque KamuID bearer only proves the token is live, not that it was minted
  // for us or reached us via the BFF, so without a valid X-Kamuhub-Authz we
  // reject rather than admit a cross-RP token replayed straight at this API.
  // Unconditional — no JWKS/dev guard: dev runs the BFF locally, so the context
  // is always present (KAMUHUB_JWKS_URL defaults to the local BFF JWKS).
  const ctxHeader = c.req.header("x-kamuhub-authz") ?? "";
  const ctx = ctxHeader ? await verifyPlatformContext(ctxHeader) : null;
  if (!ctx) return c.json({ error: "Unauthorized" }, 401);

  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) {
    // Defense-in-depth: the cached identity must belong to the subject the
    // verified context asserts, or a swapped context/token pairing is rejected.
    if (hit.sub !== ctx.sub) return c.json({ error: "Unauthorized" }, 401);
    c.set("user", hit.user);
    await next();
    return;
  }

  const info = await fetchUserInfo(token);
  if (!info?.sub) return c.json({ error: "Unauthorized" }, 401);
  if (info.email_verified === false) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // Defense-in-depth: the bearer's subject (/userinfo) MUST equal the signed
  // context's subject. A mismatch means the token and the context describe
  // different users — reject rather than provision a crossed identity.
  if (info.sub !== ctx.sub) return c.json({ error: "Unauthorized" }, 401);

  const user = provisionUser(info);

  // Org membership from the verified platform context (ADR 0001), NOT the raw
  // KamuID claim: project its orgs into local teams + team_members. The context
  // is guaranteed present here (gated above), so the reconcile — which deletes
  // stale memberships — always runs against an authoritative source.
  await reconcileTeams(user.id, contextToOrgClaims(ctx.orgs)).catch((err) =>
    console.error("[platform-ctx] team reconcile failed:", err)
  );

  if (cache.size > 2000) cache.clear(); // crude cap; entries are short-lived
  cache.set(token, { user, sub: info.sub, exp: Date.now() + RESYNC_MS });

  c.set("user", user);
  await next();
}

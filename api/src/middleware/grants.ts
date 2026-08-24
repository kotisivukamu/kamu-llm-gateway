import type { Context, Next } from "@hono/hono";
import { HTTPException } from "@hono/hono/http-exception";
import { verifyPlatformContext } from "../lib/platform-context.ts";

// Fine-grained RBAC enforcement. The platform authz layer (kamuhub) owns grants
// like `llm.keys.create`; products enforce them. `requireGrant` reads the
// verified platform context from the signed X-Kamuhub-Authz header, finds the
// org the request targets (via its KamuID org id), and 403s unless that org
// carries the grant. RLS still scopes visibility; this is the explicit
// permission gate.
//
// Fail-closed unconditionally: no verified context => 403. Dev included — the
// locally-run kamuhub BFF injects the signed context, so there is no bypass.

export function requireGrant(
  permission: string,
  resolveKamuidOrgId: (c: Context) => Promise<string | null>,
) {
  return async (c: Context, next: Next) => {
    // The access-key path (authMiddleware) verifies a key presented as the
    // bearer and stashes its context here; otherwise read the signed header the
    // BFF injects on the browser/proxy path.
    const stashed = c.get("platformContext") as
      | Awaited<ReturnType<typeof verifyPlatformContext>>
      | undefined;
    const header = c.req.header("x-kamuhub-authz") ?? "";
    const ctx = stashed ??
      (header ? await verifyPlatformContext(header) : null);
    if (!ctx) {
      throw new HTTPException(403, {
        message: "platform authorization required",
      });
    }

    const kamuidOrgId = await resolveKamuidOrgId(c);
    const org = ctx.orgs.find((o) => o.kamuid_org_id === kamuidOrgId);
    if (!org || !org.grants.includes(permission)) {
      throw new HTTPException(403, { message: `missing grant: ${permission}` });
    }

    await next();
  };
}

import type { Context, Next } from "@hono/hono";
import { auth } from "../lib/auth.ts";

export interface AdminUser {
  id: string;
  email: string;
  name: string;
}

export type SessionEnv = { Variables: { admin: AdminUser } };

// Every route in this app is internal-admin-only. requireSession is the ONE
// gate: no self-service signup, no grant model, no RLS — a valid admin_auth
// session cookie is both authentication AND authorization here (Feature 3's
// "why not kamuhub" rationale: this surface intentionally has no per-org
// concept to scope a grant to). Redirects browsers to /login; JSON callers
// (fetch from the pages' own scripts) get a 401.
export async function requireSession(
  c: Context<SessionEnv>,
  next: Next,
) {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    if (c.req.header("accept")?.includes("application/json")) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.redirect("/login");
  }
  c.set("admin", {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
  await next();
}

import { Hono } from "@hono/hono";
import { HTTPException } from "@hono/hono/http-exception";
import { env } from "./env.ts";
import { adminSql } from "./config/db.ts";
import { auth } from "./lib/auth.ts";
import { authRoutes } from "./routes/auth.tsx";
import { usageRoutes } from "./routes/usage.tsx";
import { keysRoutes } from "./routes/keys.tsx";
import { settingsRoutes } from "./routes/settings.tsx";
import { requireSession, type SessionEnv } from "./middleware/session.ts";

adminSql<{ role: string; db: string }[]>`
  SELECT current_user AS role, current_database() AS db
`
  .then((rows) => {
    const r = rows[0];
    console.log(`[db] admin connected as role=${r?.role} db=${r?.db}`);
  })
  .catch((err) => console.error("[db] role probe failed:", err));

const app = new Hono<SessionEnv>();

app.get("/health", (c) => c.json({ ok: true }));

// better-auth's own handler owns everything under /api/auth/* (sign-in,
// sign-out, get-session, csrf, etc). No self-service sign-up route is exposed
// by THIS app's own routes.tsx (see routes/auth.tsx) but better-auth's
// generic handler technically still answers /api/auth/sign-up/email if
// someone posts to it directly — closed off in admin/README.md's threat
// notes; scripts/create-admin.ts is the only sanctioned path in practice
// because there is no link to sign-up anywhere and the seed script is the
// one this task specifies.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/", authRoutes);
app.route("/", usageRoutes);
app.route("/", keysRoutes);
app.route("/", settingsRoutes);

app.get("/", requireSession, (c) => c.redirect("/usage"));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error("llm-proxy-admin error:", err);
  return c.json({ error: msg }, 500);
});

Deno.serve({ port: env.PORT, hostname: "::" }, app.fetch);
console.log(`llm-proxy-admin listening on :${env.PORT}`);

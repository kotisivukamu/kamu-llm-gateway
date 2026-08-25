import { z } from "zod";

// admin/'s env. Deliberately separate from api/'s env.ts (own package, own
// contract) even though several vars point at the same physical Postgres
// instance in dev — this is a superuser surface with its own auth system, not
// a mode of the api.

const schema = z.object({
  PORT: z.coerce.number().default(8302),

  // Owner/BYPASSRLS connection for reading llm.keys / llm.usage_log / llm.settings
  // directly, across ALL orgs (Feature 1/2/3 — this is a superuser surface, not
  // RLS/tenant-scoped like the kamuhub dashboard). Same physical role as api's
  // BYPASSRLS_DATABASE_URL; admin/ never uses the RLS-scoped app_user pool.
  ADMIN_DATABASE_URL: z.string().min(1),

  // better-auth's own Postgres connection (pg.Pool, not postgres.js — the
  // Kysely/pg adapter is what was verified to work under Deno). Schema-scoped
  // to admin_auth via `options=-c search_path=admin_auth,public` on the pool,
  // set in lib/auth.ts, not here — this is just the bare connection string.
  ADMIN_AUTH_DATABASE_URL: z.string().min(1),

  // better-auth session/cookie signing secret. A leaked value lets someone
  // forge admin sessions, so this must be a real secret in prod (Fly/Doppler),
  // never the dev default.
  BETTER_AUTH_SECRET: z.string().min(16),

  // Public origin this app is served from — better-auth uses it to set cookie
  // domain/secure flags correctly and to build absolute callback URLs.
  BASE_URL: z.string().url().default("http://localhost:8302"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const env = schema.parse(Deno.env.toObject());

import { betterAuth } from "better-auth";
import pgDefault from "pg";
import { env } from "../env.ts";

const { Pool } = pgDefault;

// better-auth, verified working under Deno 2026-08-25 against a real local
// Postgres (npm:better-auth@1.2.7 + npm:pg + npm:kysely — its Postgres
// adapter auto-selects Kysely+pg when handed a `pg.Pool`). Schema-scoped to
// `admin_auth` (never `public`, mirrors the llm schema's own-schema
// convention) via `-c search_path=admin_auth,public` on the pool's connection
// options — the same technique config/db.ts uses via postgres.js's
// `connection.search_path`, just expressed as a libpq connection option since
// pg doesn't expose a first-class search_path field.
//
// No self-service signup: emailAndPassword.enabled is true only so admins can
// SIGN IN with a password; nothing routes to /api/auth/sign-up in this app's
// own routes (see routes/auth.ts) — the only way to create an admin_auth.user
// row is scripts/create-admin.ts, which calls this same auth.api.signUpEmail
// programmatically, not over HTTP.
const pool = new Pool({
  connectionString: env.ADMIN_AUTH_DATABASE_URL,
  options: "-c search_path=admin_auth,public",
});

export const auth = betterAuth({
  database: pool,
  emailAndPassword: { enabled: true },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BASE_URL,
  session: {
    // Shorter than better-auth's 7-day default: this app mints/revokes
    // can_mint keys, so admin sessions stay tight.
    expiresIn: 60 * 60 * 12, // 12h
  },
});

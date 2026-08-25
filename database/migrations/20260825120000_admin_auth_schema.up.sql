-- 20260825120000_admin_auth_schema.up.sql
-- Auth tables for the admin/ app (internal-admin-only surface, its own Fly app
-- "llm-proxy-admin"). Deliberately its own schema `admin_auth`, separate from
-- `llm` (mirrors the initial migration's own-schema convention) and from
-- KamuID/kamuhub: admin auth is a genuinely separate, superuser system, not a
-- customer-facing org/grant model (see docs/adr/0001, "can_mint provisioning"
-- 2026-08-25 revision).
--
-- Table shape is dictated by better-auth's Kysely/Postgres adapter (verified
-- against a real local Postgres 2026-08-25: `deno run` against
-- npm:better-auth@1.2.7 + npm:pg + npm:kysely, schema-scoped via
-- `search_path=admin_auth,public` on the pg Pool, ran signup -> signin ->
-- get-session end to end). Columns/casing (camelCase, matching better-auth's
-- own generated migration) must not be renamed — the adapter queries these
-- exact names. No self-service signup: rows are seeded by
-- admin/scripts/create-admin.ts, never by an app route.

CREATE SCHEMA IF NOT EXISTS admin_auth;

CREATE TABLE admin_auth."user" (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL,
  image          TEXT,
  "createdAt"    TIMESTAMP NOT NULL,
  "updatedAt"    TIMESTAMP NOT NULL
);

CREATE TABLE admin_auth.session (
  id         TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMP NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId"    TEXT NOT NULL REFERENCES admin_auth."user"(id)
);

CREATE TABLE admin_auth.account (
  id                      TEXT PRIMARY KEY,
  "accountId"             TEXT NOT NULL,
  "providerId"            TEXT NOT NULL,
  "userId"                TEXT NOT NULL REFERENCES admin_auth."user"(id),
  "accessToken"           TEXT,
  "refreshToken"          TEXT,
  "idToken"               TEXT,
  "accessTokenExpiresAt"  TIMESTAMP,
  "refreshTokenExpiresAt" TIMESTAMP,
  scope                   TEXT,
  password                TEXT,
  "createdAt"             TIMESTAMP NOT NULL,
  "updatedAt"             TIMESTAMP NOT NULL
);

CREATE TABLE admin_auth.verification (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  value       TEXT NOT NULL,
  "expiresAt" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP,
  "updatedAt" TIMESTAMP
);

-- admin/ connects to this schema as the postgres owner (superuser surface,
-- same rationale as llm's adminSql pool) -- no RLS, no authenticated/anon
-- roles here. If a lower-privileged app role is ever introduced for admin/,
-- grant it explicitly then; there is none today.

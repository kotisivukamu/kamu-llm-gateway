-- 20260825130000_settings.up.sql
-- System-wide settings (admin/ Feature 2). Scope: the provider/model catalog
-- itself (proxy/src/catalog.ts) stays code -- it is keyed by env-var names
-- for upstream secrets (Doppler/Fly), so making it fully DB-driven would mean
-- either duplicating secret plumbing into the DB or teaching the proxy a
-- secrets-from-DB path, both bigger than "system-wide settings" as scoped
-- here. What IS reasonably DB-backed and admin-editable at this size: a
-- single settings row of *operator overrides* layered on top of the static
-- catalog -- which models are currently disabled platform-wide, and the
-- default budget_usd applied when an admin mints a key without specifying
-- one. See admin/README.md "Feature 2 scope" for exactly what a follow-up
-- needs to make this affect the live proxy (it does not yet -- see below).
--
-- Single-row table (id fixed to a constant) rather than a generic key/value
-- table: there is exactly one operator-facing settings object today, and a
-- fixed-id singleton keeps reads/writes trivial (no upsert-by-key ambiguity).
-- If a second independent setting group appears, split into a new row/table
-- rather than overloading this one.

SET search_path = llm, public;

CREATE TABLE llm.settings (
  id                 BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  disabled_models    TEXT[] NOT NULL DEFAULT '{}',
  default_budget_usd NUMERIC(12, 4),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         TEXT
);

INSERT INTO llm.settings (id) VALUES (true);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT SELECT, UPDATE ON llm.settings TO app_user;
  END IF;
END $$;

-- No RLS: this is a platform-wide singleton, not team-scoped data, and it is
-- read/written only through admin/ (its own superuser Postgres role), never
-- through api/'s RLS-scoped `authenticated` role.

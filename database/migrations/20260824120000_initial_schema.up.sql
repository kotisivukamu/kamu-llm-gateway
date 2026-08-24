-- 20260824120000_initial_schema.up.sql
-- kamu-llm-gateway foundation: teams/membership projection of a KamuID org, the
-- `keys` product row (ADR 0001 §2/§7 — the API key is the product), the
-- `usage_log` spend ledger keyed by `key_id` (ADR 0001 §8), and RLS — all in
-- the `llm` schema (never public), so this DB is relocatable and collision-free
-- even when co-located with the kotisivukamu dev DB.
--
-- Run as a superuser/admin (creates roles, ALTER ROLE BYPASSRLS, SECURITY
-- DEFINER functions). The app connects at runtime as `app_user`. `app_user` is
-- expected to already exist (created by infra/dev bootstrap), like kamusites.
--
-- The full key secret is NEVER stored — only `key_hash` (sha256 of the opaque
-- secret, hex) plus a human-readable `prefix` for display. Derived sub-keys
-- (key_type = 'derived') are JWT-only on the wire; their row's PK is bound to
-- the JWT `jti`, so `key_hash` is NULL for them (ADR 0001 §3/§10.4).

CREATE SCHEMA IF NOT EXISTS llm;
SET search_path = llm, public;

-- ---------------------------------------------------------------------------
-- Roles (global, shared across services in a co-located DB; guarded)
--   app_user      — LOGIN, BYPASSRLS. The API connection role (owner pool).
--   authenticated — NOLOGIN. Dashboard requests via SET LOCAL ROLE. Key RLS.
--   anon          — NOLOGIN. Reserved (no public reads today). Kept for parity.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    ALTER ROLE app_user BYPASSRLS;
    GRANT authenticated TO app_user;
    GRANT anon TO app_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Teams = local projection of a KamuID org (linked by kamuid_org_id).
-- Managed by the login reconcile (app_user); not by authenticated users.
-- ---------------------------------------------------------------------------
CREATE TABLE llm.teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kamuid_org_id TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- team_members = org membership, claim-derived. The reconcile fully owns this
-- (insert/update/delete from the KamuID organizations claim).
CREATE TABLE llm.team_members (
  team_id    UUID NOT NULL REFERENCES llm.teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
CREATE INDEX idx_team_members_user_id ON llm.team_members (user_id);

-- ---------------------------------------------------------------------------
-- keys = THE product row (ADR 0001 §2/§7). A key is a first-class resource
-- row, not an authz artifact. Top-level keys (key_type = 'top') carry an
-- opaque-hash credential (`key_hash` + `prefix`); derived sub-keys
-- (key_type = 'derived') are signed-JWT-on-the-wire rows whose PK is the JWT
-- `jti`, with `parent_key_id` set and `key_hash` NULL. Both are consumed and
-- revoked identically (status/revoked_at cascade via root_key_id).
--
-- Lineage columns (ADR 0001 §7.6): parent_key_id (immediate creator, NULL for
-- top-level) and root_key_id (the top-level key the chain descends from; for a
-- top-level key this equals the row's own id — set by the app on mint, not by a
-- trigger, to keep the row's lifecycle authority explicit).
-- ---------------------------------------------------------------------------
CREATE TABLE llm.keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       UUID NOT NULL REFERENCES llm.teams(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  key_hash      TEXT,
  prefix        TEXT,
  key_type      TEXT NOT NULL CHECK (key_type IN ('top', 'derived')),
  models        TEXT[] NOT NULL DEFAULT '{}',
  budget_usd    NUMERIC(12, 4),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  can_mint      BOOLEAN NOT NULL DEFAULT false,
  parent_key_id UUID REFERENCES llm.keys(id) ON DELETE CASCADE,
  root_key_id   UUID REFERENCES llm.keys(id),
  metadata      JSONB,
  constraints   JSONB,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  created_by    TEXT,
  revoked_by    TEXT
);
CREATE INDEX idx_keys_team_id       ON llm.keys (team_id);
CREATE INDEX idx_keys_key_hash      ON llm.keys (key_hash) WHERE key_hash IS NOT NULL;
CREATE INDEX idx_keys_parent_key_id ON llm.keys (parent_key_id);
CREATE INDEX idx_keys_root_key_id   ON llm.keys (root_key_id);

-- ---------------------------------------------------------------------------
-- usage_log = the spend ledger, keyed by key_id (ADR 0001 §8). Every metered
-- request writes a row carrying key_id plus the lineage columns (parent_key_id,
-- root_key_id) so spend rolls up to a service's whole subtree and drills down
-- to a specific session/build via the key's metadata blob. Append-only via the
-- owner pool (the poller flushes the satellite's local buffer here); RLS below
-- exposes SELECT to authenticated users keyed on key reachability.
-- ---------------------------------------------------------------------------
CREATE TABLE llm.usage_log (
  id             BIGSERIAL PRIMARY KEY,
  key_id         UUID NOT NULL REFERENCES llm.keys(id),
  parent_key_id  UUID,
  root_key_id    UUID,
  model          TEXT,
  cost_usd       NUMERIC(12, 6),
  tokens_in      INT,
  tokens_out     INT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_usage_log_key_id      ON llm.usage_log (key_id, created_at);
CREATE INDEX idx_usage_log_root_key_id ON llm.usage_log (root_key_id, created_at);

-- ---------------------------------------------------------------------------
-- RLS helper functions (namespaced into llm; SECURITY DEFINER to avoid
-- recursing through the policies they back).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION llm.uid() RETURNS TEXT AS $$
  SELECT current_setting('app.current_user_id', true);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION llm.user_teams() RETURNS uuid[] AS $$
  SELECT COALESCE(ARRAY(
    SELECT team_id FROM llm.team_members WHERE user_id = llm.uid()
  ), '{}');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- All key IDs the current user can reach: keys whose team_id is one of the
-- user's teams (ADR 0001 §5 — RLS keyed on the team/org projection).
CREATE OR REPLACE FUNCTION llm.user_keys() RETURNS uuid[] AS $$
  SELECT COALESCE(ARRAY(
    SELECT k.id FROM llm.keys k
    WHERE k.team_id = ANY(llm.user_teams())
  ), '{}');
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION llm.is_team_admin(p_team_id uuid) RETURNS boolean AS $$
  SELECT EXISTS(
    SELECT 1 FROM llm.team_members
    WHERE user_id = llm.uid()
      AND team_id = p_team_id
      AND role IN ('admin', 'owner')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA llm TO authenticated;
GRANT USAGE ON SCHEMA llm TO anon;
GRANT EXECUTE ON FUNCTION llm.uid() TO authenticated;
GRANT EXECUTE ON FUNCTION llm.user_teams() TO authenticated;
GRANT EXECUTE ON FUNCTION llm.user_keys() TO authenticated;
GRANT EXECUTE ON FUNCTION llm.is_team_admin(uuid) TO authenticated;

GRANT SELECT ON llm.teams TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON llm.team_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON llm.keys TO authenticated;
GRANT SELECT ON llm.usage_log TO authenticated;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    GRANT USAGE ON SCHEMA llm TO app_user;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA llm TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA llm TO app_user;
    -- usage_log.id is BIGSERIAL; the owner pool (poller) appends rows, so app_user
    -- needs the sequence. authenticated only SELECTs (no INSERT), so it does not.
    GRANT USAGE, SELECT ON SEQUENCE llm.usage_log_id_seq TO app_user;
    ALTER DEFAULT PRIVILEGES IN SCHEMA llm
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- RLS. teams and team_members are reconcile-owned (app_user BYPASSRLS), so
-- authenticated gets read-only visibility. keys are editable by team members;
-- deleted only by team admins. usage_log is append-only via the owner pool
-- (no INSERT policy to authenticated) with SELECT keyed on key reachability.
-- ---------------------------------------------------------------------------
ALTER TABLE llm.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm.keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm.usage_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY teams_select ON llm.teams FOR SELECT TO authenticated
  USING (id = ANY(llm.user_teams()));

CREATE POLICY team_members_select ON llm.team_members FOR SELECT TO authenticated
  USING (team_id = ANY(llm.user_teams()));

-- Keys: visible if reachable via the user's teams; created/edited by team
-- members; deleted only by team admins.
CREATE POLICY keys_select ON llm.keys FOR SELECT TO authenticated
  USING (team_id = ANY(llm.user_teams()));

CREATE POLICY keys_insert ON llm.keys FOR INSERT TO authenticated
  WITH CHECK (team_id = ANY(llm.user_teams()));

CREATE POLICY keys_update ON llm.keys FOR UPDATE TO authenticated
  USING (team_id = ANY(llm.user_teams()));

CREATE POLICY keys_delete ON llm.keys FOR DELETE TO authenticated
  USING (llm.is_team_admin(team_id));

-- usage_log: SELECT keyed on key reachability (ADR 0001 §8). Append-only via
-- the owner pool — no INSERT/UPDATE/DELETE policy for authenticated.
CREATE POLICY usage_log_select ON llm.usage_log FOR SELECT TO authenticated
  USING (key_id = ANY(llm.user_keys()));

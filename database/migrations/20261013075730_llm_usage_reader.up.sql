-- 20261013075730_llm_usage_reader.up.sql
-- Read-only, cross-tenant access to the spend ledger for platform reporting.
--
-- The kotisivukamu internal dashboard shows LLM spend for every key (its own
-- services' top-level keys and the per-build sub-keys builder-queue derives).
-- It reads this database directly instead of going through the gateway API,
-- whose usage routes are RLS-scoped to one KamuID user's teams.
--
-- llm_usage_reader is a NOLOGIN group role. The owner creates a separate
-- LOGIN user per consumer out-of-band and makes it a member (password never
-- in a migration). The role does not bypass RLS (BYPASSRLS can only be set at
-- CREATE ROLE time on PlanetScale, and read-only reporting should not have it
-- anyway); instead each table gets a SELECT-only policy for this role.
--
-- Grants are column-level and leave out every credential or write-side
-- column: keys.key_hash, keys.constraints, keys.created_by/revoked_by, and
-- team_members entirely. A `SELECT *` by this role fails by design.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'llm_usage_reader') THEN
    CREATE ROLE llm_usage_reader NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA llm TO llm_usage_reader;

GRANT SELECT (id, key_id, parent_key_id, root_key_id, model, cost_usd,
              tokens_in, tokens_out, created_at, usage_id, machine_id)
  ON llm.usage_log TO llm_usage_reader;

GRANT SELECT (id, team_id, label, prefix, key_type, status, parent_key_id,
              root_key_id, metadata, budget_usd, expires_at, created_at,
              revoked_at)
  ON llm.keys TO llm_usage_reader;

GRANT SELECT (id, kamuid_org_id, name, slug) ON llm.teams TO llm_usage_reader;

CREATE POLICY usage_log_select_reader ON llm.usage_log
  FOR SELECT TO llm_usage_reader USING (true);

CREATE POLICY keys_select_reader ON llm.keys
  FOR SELECT TO llm_usage_reader USING (true);

CREATE POLICY teams_select_reader ON llm.teams
  FOR SELECT TO llm_usage_reader USING (true);

-- database/seeds/dev.sql
-- Minimal dev seed for the kamu-llm-gateway smoke test: one team (KamuID org
-- projection) + one team_members row (the test user as owner). Idempotent.
--
-- The gateway owns NO account model (ADR 0001 §1): team_members.user_id is just
-- a TEXT holding the KamuID sub (the RLS principal), not a FK to a user table.
-- RLS reads it via llm.uid() = current_setting('app.current_user_id').
--
-- Run as the owner pool (adminSql / postgres BYPASSRLS): these writes touch
-- teams + team_members, which the reconcile owns.

INSERT INTO llm.teams (kamuid_org_id, name, slug)
VALUES ('org_test_1', 'Test Org', 'testorg')
ON CONFLICT (kamuid_org_id) DO UPDATE
  SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = now();

INSERT INTO llm.team_members (team_id, user_id, role)
SELECT t.id, 'user_test_1', 'owner'
FROM llm.teams t
WHERE t.kamuid_org_id = 'org_test_1'
ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role;

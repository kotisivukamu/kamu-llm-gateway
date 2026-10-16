-- 20261016170000_key_scopes.down.sql
ALTER TABLE llm.keys
  DROP CONSTRAINT keys_scopes_top_only,
  DROP COLUMN scopes;

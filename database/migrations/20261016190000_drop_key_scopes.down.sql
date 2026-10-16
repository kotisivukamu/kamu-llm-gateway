-- 20261016190000_drop_key_scopes.down.sql
-- Restores the column and CHECK of 20261016170000_key_scopes, empty.
ALTER TABLE llm.keys
  ADD COLUMN scopes TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT keys_scopes_top_only
    CHECK (key_type = 'top' OR scopes = '{}');

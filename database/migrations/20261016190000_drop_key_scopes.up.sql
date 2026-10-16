-- Drops llm.keys.scopes (20261016170000_key_scopes). Price writes are not a
-- capability a gateway key can hold: /internal/prices now authenticates with
-- the api's INTERNAL_API_TOKEN, a service secret shared with the kamuhub
-- billing worker only. prices:write was the only scope, so the column goes.

ALTER TABLE llm.keys
  DROP CONSTRAINT keys_scopes_top_only,
  DROP COLUMN scopes;

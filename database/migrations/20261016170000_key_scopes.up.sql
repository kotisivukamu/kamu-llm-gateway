-- 20261016170000_key_scopes.up.sql
-- Capability scopes on top-level keys: what a key may do on the gateway's own
-- api beyond calling models. The first one is 'prices:write', held by the
-- kamuhub billing worker's key to sync llm.model_prices from the providers'
-- price lists (POST /internal/prices).
--
-- Scopes are a property of the product row the operator grants, so they live
-- on top-level keys only: a derived sub-key is a short-lived child handed to
-- a build or session and never carries them. The CHECK makes that hold for
-- every writer, not only the derive route.

ALTER TABLE llm.keys
  ADD COLUMN scopes TEXT[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT keys_scopes_top_only
    CHECK (key_type = 'top' OR scopes = '{}');

-- New column on an existing table: the table-level grants already cover it
-- for app_user/admin_role/authenticated. llm_usage_reader has column grants
-- only and does not need it.

-- 20261016120000_pricing_at_ingest.up.sql
-- ADR 0003: the proxy meters tokens, the api prices them at ingest.
--
-- 1. llm.model_prices: append-only price list, USD per 1M tokens. A price
--    change is a new row with a later valid_from; rows are never updated.
--    Ingest prices a usage row with the row for its model that has the
--    greatest valid_from <= the usage row's created_at, else with the proxy
--    catalog's price (price_id null). Created empty: price data is managed
--    from the admin app, never in a migration.
--
-- 2. llm.usage_log keeps the raw buckets so a period can be repriced and
--    compared against the provider: cache_read_tokens/cache_write_tokens
--    (tokens_in stays the uncached input), the provider-reported cost when
--    the response carried one, and which price row the cost came from.
--
-- 3. llm.keys.status gains 'over_budget': ingest sets it when a key's (or
--    its root's) spend reaches budget_usd; the proxy denies any non-active
--    key.

CREATE TABLE llm.model_prices (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model                         TEXT NOT NULL,
  input_cost_per_mtok_usd       NUMERIC(12, 6) NOT NULL,
  output_cost_per_mtok_usd      NUMERIC(12, 6) NOT NULL,
  cache_read_cost_per_mtok_usd  NUMERIC(12, 6) NOT NULL,
  cache_write_cost_per_mtok_usd NUMERIC(12, 6) NOT NULL,
  per_request_cost_usd          NUMERIC(12, 6) NOT NULL DEFAULT 0,
  valid_from                    TIMESTAMPTZ NOT NULL,
  source                        TEXT NOT NULL,
  note                          TEXT,
  created_by                    TEXT,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX model_prices_model_valid_from_idx
  ON llm.model_prices (model, valid_from DESC);

-- Read by the api poller and the admin app, never by authenticated
-- sessions: RLS on with no policies keeps it invisible to them, like
-- llm.key_spend. The schema's default privileges grant app_user and
-- admin_role full DML on new tables; take UPDATE/DELETE back so the table
-- stays append-only for every non-owner role.
ALTER TABLE llm.model_prices ENABLE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON llm.model_prices FROM app_user, admin_role;
GRANT SELECT, INSERT ON llm.model_prices TO app_user, admin_role;

ALTER TABLE llm.usage_log
  ADD COLUMN cache_read_tokens      INT NOT NULL DEFAULT 0,
  ADD COLUMN cache_write_tokens     INT NOT NULL DEFAULT 0,
  ADD COLUMN provider_cost          NUMERIC,
  ADD COLUMN provider_cost_currency TEXT,
  ADD COLUMN price_id               UUID REFERENCES llm.model_prices(id);

-- Platform reporting reads the new columns too (see
-- 20261013075730_llm_usage_reader).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'llm_usage_reader') THEN
    GRANT SELECT (cache_read_tokens, cache_write_tokens, provider_cost,
                  provider_cost_currency, price_id)
      ON llm.usage_log TO llm_usage_reader;
  END IF;
END $$;

ALTER TABLE llm.keys DROP CONSTRAINT keys_status_check;
ALTER TABLE llm.keys ADD CONSTRAINT keys_status_check
  CHECK (status IN ('active', 'revoked', 'over_budget'));

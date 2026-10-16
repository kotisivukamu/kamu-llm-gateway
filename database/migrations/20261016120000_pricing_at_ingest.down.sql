-- 20261016120000_pricing_at_ingest.down.sql
-- An over_budget key goes back to active: before this migration budgets were
-- enforced by the proxy's spend check alone.
UPDATE llm.keys SET status = 'active' WHERE status = 'over_budget';
ALTER TABLE llm.keys DROP CONSTRAINT keys_status_check;
ALTER TABLE llm.keys ADD CONSTRAINT keys_status_check
  CHECK (status IN ('active', 'revoked'));

ALTER TABLE llm.usage_log
  DROP COLUMN price_id,
  DROP COLUMN provider_cost_currency,
  DROP COLUMN provider_cost,
  DROP COLUMN cache_write_tokens,
  DROP COLUMN cache_read_tokens;

DROP TABLE llm.model_prices;

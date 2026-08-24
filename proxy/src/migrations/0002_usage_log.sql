-- Per-request usage log for EVERY key (budgeted or not).
--
-- One row per completed upstream request that carried a usage block. Unlike
-- token_spend (a running per-key total used only for budget enforcement),
-- this is the accounting source of truth: raw token buckets plus the computed
-- USD cost, keyed so cost can be aggregated per `key_id` (the gateway row PK,
-- ADR 0001 §8) and per label. The lineage columns (`parent_key_id`,
-- `root_key_id`) flow into every row so the gateway's durable `usage_log`
-- can roll spend up to a service's whole subtree and drill down to a specific
-- session/build via the key's metadata blob (ADR 0001 §7.6).
--
-- `jti` is kept as an alias = key_id for the poll contract (the control-plane
-- poller still reads `jti`); the authority column is `key_id`.
--
-- cost_usd is NULL when the model had no catalog price at request time (token
-- counts are still recorded so the gap is visible and re-priceable).
CREATE TABLE usage_log (
  id                 INTEGER PRIMARY KEY,
  key_id             TEXT NOT NULL,
  jti                TEXT NOT NULL,                  -- alias = key_id (poll contract)
  name               TEXT NOT NULL,
  parent_key_id      TEXT,
  root_key_id        TEXT,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_usd           REAL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX usage_log_key_id_idx ON usage_log (key_id);
CREATE INDEX usage_log_jti_idx ON usage_log (jti);
CREATE INDEX usage_log_name_idx ON usage_log (name);

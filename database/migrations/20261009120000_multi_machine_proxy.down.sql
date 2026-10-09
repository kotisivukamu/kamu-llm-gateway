-- 20261009120000_multi_machine_proxy.down.sql
DROP INDEX llm.usage_log_store_source_idx;
ALTER TABLE llm.usage_log
  DROP COLUMN source_id,
  DROP COLUMN store_id;
DROP TABLE llm.key_spend;

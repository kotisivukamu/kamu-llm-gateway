-- 20261009140000_usage_id_machine_id.down.sql
DROP INDEX llm.usage_log_machine_usage_idx;
DROP INDEX llm.usage_log_usage_id_idx;
ALTER TABLE llm.usage_log
  DROP COLUMN machine_id,
  DROP COLUMN usage_id,
  ADD COLUMN store_id  TEXT,
  ADD COLUMN source_id BIGINT;
CREATE UNIQUE INDEX usage_log_store_source_idx
  ON llm.usage_log (store_id, source_id);

-- 20261009140000_usage_id_machine_id.up.sql
-- Replaces 20261009120000's (store_id, source_id) with two plain columns:
--   usage_id   UUIDv7 the proxy assigns each row: unique across machines and
--              time-ordered, so it is both the dedupe key and the cursor.
--   machine_id the Fly machine that served the call.
-- With these the poller needs no per-file identity: it asks each machine for
-- rows newer than the newest usage_id it already has from that machine.
--
-- The DELETE removes the 55 rows ingested before 20261009120000 (NULL
-- store_id). The same rows were re-ingested under a store_id during that
-- rollout, so these are exact duplicates. One-off cleanup of that rollout,
-- not content.

DELETE FROM llm.usage_log WHERE store_id IS NULL;

DROP INDEX llm.usage_log_store_source_idx;
ALTER TABLE llm.usage_log
  DROP COLUMN store_id,
  DROP COLUMN source_id,
  ADD COLUMN usage_id   UUID,
  ADD COLUMN machine_id TEXT;

CREATE UNIQUE INDEX usage_log_usage_id_idx ON llm.usage_log (usage_id);
CREATE INDEX usage_log_machine_usage_idx
  ON llm.usage_log (machine_id, usage_id);

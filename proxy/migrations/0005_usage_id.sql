-- Every usage row gets a globally unique, time-ordered id (UUIDv7) and the Fly
-- machine that served it. The control-plane poller dedupes on usage_id and
-- pages each machine by it, so rows from several machines never collide.
-- Rows written before this migration keep NULL here and are never re-polled
-- (they were already copied under the old scheme). Replaces 0004's store_meta.
ALTER TABLE usage_log ADD COLUMN usage_id TEXT;
ALTER TABLE usage_log ADD COLUMN machine_id TEXT;
CREATE INDEX usage_log_usage_id_idx ON usage_log (usage_id);
DROP TABLE store_meta;

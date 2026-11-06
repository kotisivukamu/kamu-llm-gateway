-- GET /usage scopes a top-level key holder to its whole derived tree via
-- root_key_id (key holders poll every ~10 s per running job). Without this the
-- scoped read is a full scan of a table that is never pruned. The rowid is
-- implicitly the trailing index column, so `root_key_id = ? AND id > ?
-- ORDER BY id` walks the index in cursor order.
CREATE INDEX usage_log_root_key_id_idx ON usage_log (root_key_id);

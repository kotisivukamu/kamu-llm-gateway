-- A random, permanent id for this SQLite file. Every proxy machine has its own
-- file on its own volume, and each numbers usage_log rows from 1, so the
-- control-plane poller needs (store_id, id) to tell rows from different
-- machines apart and to keep one cursor per store. Generated once, when this
-- migration first runs against the file, and never changed after.
CREATE TABLE store_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT INTO store_meta (k, v) VALUES ('store_id', lower(hex(randomblob(16))));

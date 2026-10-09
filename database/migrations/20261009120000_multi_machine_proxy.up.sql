-- 20261009120000_multi_machine_proxy.up.sql
-- Lets the proxy run on more than one machine (one per region).
--
-- 1. llm.key_spend: the running USD total per budgeted key. It used to live in
--    each proxy machine's SQLite (token_spend), where a machine only saw its
--    own share: a $3 key could spend $3 per machine. The proxy now reads it
--    before a budgeted request and adds to it after, on the admin_role pool.
--    Starts empty: budgeted keys begin from $0 here (their earlier spend was
--    in the per-machine ledger).
--
-- 2. llm.usage_log gains (store_id, source_id): which proxy SQLite file a row
--    came from and its id there. Every machine numbers its rows from 1, so the
--    old scheme (usage_log.id = the proxy's row id) would drop one machine's
--    rows as conflicts. id goes back to being a plain BIGSERIAL; the sequence
--    is moved past the explicit ids the old poller inserted.
--    Rows ingested before this migration have NULL store_id. The proxy
--    machine that produced them still holds them, so the new poller
--    re-ingests them under its store_id; the NULL-store copies are then
--    deleted by hand once the counts match (see the commit message).

CREATE TABLE llm.key_spend (
  key_id        UUID PRIMARY KEY REFERENCES llm.keys(id) ON DELETE CASCADE,
  spent_usd     NUMERIC(12, 6) NOT NULL DEFAULT 0,
  request_count INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Only the proxy (admin_role, BYPASSRLS) touches it. RLS on with no policies
-- keeps it invisible to authenticated sessions.
ALTER TABLE llm.key_spend ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON llm.key_spend TO admin_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON llm.key_spend TO app_user;

ALTER TABLE llm.usage_log
  ADD COLUMN store_id  TEXT,
  ADD COLUMN source_id BIGINT;

CREATE UNIQUE INDEX usage_log_store_source_idx
  ON llm.usage_log (store_id, source_id);

SELECT setval(
  'llm.usage_log_id_seq',
  GREATEST((SELECT MAX(id) FROM llm.usage_log), 1)
);

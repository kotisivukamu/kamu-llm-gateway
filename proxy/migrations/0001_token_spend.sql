-- Per-key spend ledger for budgeted LLM keys.
--
-- One row per key (keyed by `key_id` — the DB row's PK on the gateway Postgres,
-- ADR 0001 §8), created lazily the first time a budgeted key makes a metered
-- request. Uncapped keys never touch this table. `budget_usd` is cached here
-- for observability only; enforcement always reads the authoritative cap from
-- the key row (via the key-meta cache), so re-issuing a key_id with a different
-- budget can never be spoofed via the DB.
--
-- `jti` is kept as an alias = key_id for the poll contract (legacy callers
-- read `jti`); the authority column is `key_id`. Lineage columns
-- (`parent_key_id`, `root_key_id`) mirror the gateway's `llm.keys` row so a
-- key's spend can roll up to its whole subtree without a join (ADR 0001 §7.6).
CREATE TABLE token_spend (
  key_id         TEXT PRIMARY KEY,
  jti            TEXT NOT NULL,                     -- alias = key_id (poll contract)
  name           TEXT NOT NULL,
  budget_usd     REAL NOT NULL,
  spent_usd      REAL NOT NULL DEFAULT 0,
  request_count  INTEGER NOT NULL DEFAULT 0,
  parent_key_id  TEXT,
  root_key_id    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

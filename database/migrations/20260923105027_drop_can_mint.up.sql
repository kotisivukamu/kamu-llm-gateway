-- 20260923105027_drop_can_mint.up.sql
-- Any active top-level key may derive sub-keys now (depth 1 is enforced by
-- derive itself), so the per-key minting capability is gone. See ADR 0001,
-- "can_mint removed" (2026-09-23).

ALTER TABLE llm.keys DROP COLUMN can_mint;

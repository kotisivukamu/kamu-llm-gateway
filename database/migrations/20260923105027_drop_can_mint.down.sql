-- 20260923105027_drop_can_mint.down.sql

ALTER TABLE llm.keys ADD COLUMN can_mint BOOLEAN NOT NULL DEFAULT false;

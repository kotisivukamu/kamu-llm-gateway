-- 20260824120000_initial_schema.down.sql
-- Drops everything in the llm schema. Leaves the global roles
-- (authenticated/anon/app_user) alone — they may be shared with a co-located DB.

DROP SCHEMA IF EXISTS llm CASCADE;

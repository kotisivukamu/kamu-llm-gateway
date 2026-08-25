-- 20260824120000_initial_schema.down.sql
-- Drops everything in the llm schema. Leaves the global roles
-- (authenticated/anon/app_user/admin_role) alone — this migration never
-- creates or drops roles (see database/init-roles.example.sql); they may
-- also be shared with a co-located DB.

DROP SCHEMA IF EXISTS llm CASCADE;

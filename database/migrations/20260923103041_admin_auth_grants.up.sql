-- 20260923103041_admin_auth_grants.up.sql
-- Let admin_role (BYPASSRLS runtime role, owns nothing) use better-auth's
-- admin_auth schema, so admin/'s ADMIN_AUTH_DATABASE_URL connects as
-- admin_role instead of the postgres owner. 20260825120000 created the schema
-- without granting it to any runtime role.

GRANT USAGE ON SCHEMA admin_auth TO admin_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA admin_auth TO admin_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA admin_auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO admin_role;

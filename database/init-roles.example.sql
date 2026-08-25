-- database/init-roles.example.sql
--
-- NOT A MIGRATION. This file is never run by `deno task migrate`, never run
-- by migrate.ts, and never run by CI or any bot/agent. It is a copy-paste
-- template that the repo owner runs manually, once per real Postgres
-- instance, via psql (or any interactive client).
--
-- The migrations under database/migrations/ already create app_user and
-- admin_role themselves (guarded with IF NOT EXISTS, name + capability
-- flags only -- LOGIN / LOGIN BYPASSRLS -- never a PASSWORD clause). A LOGIN
-- role with no password set cannot authenticate at all, so both roles are
-- inert right after migrating: nothing can connect as them yet.
--
-- What THIS file does is the one step migrations deliberately never do:
-- setting the real password. Reasoning: a password must never be generated
-- by or pass through an LLM/agent conversation, and must never live in a
-- file that gets committed to git -- even a migration a bot might run
-- automatically later. So password-setting is a deliberate, out-of-band,
-- human step: the owner picks/generates the real password themselves and
-- stores it directly in Doppler, never in this repo.
--
-- Usage:
--   psql "$DATABASE_URL" -f database/init-roles.example.sql
-- after replacing every <SET-VIA-DOPPLER> placeholder with a real,
-- freshly-generated password of your own choosing -- then store that real
-- password in Doppler immediately and never paste it anywhere else,
-- including this file.

ALTER ROLE app_user PASSWORD '<SET-VIA-DOPPLER>';
ALTER ROLE admin_role PASSWORD '<SET-VIA-DOPPLER>';

-- After running this once against a real instance:
--   1. Generate real, distinct passwords for both roles (a password
--      manager or `openssl rand -base64 32`, not this file, not an agent).
--   2. Store them in Doppler under this environment's config.
--   3. Point APP_USER_DATABASE_URL / ADMIN_DATABASE_URL /
--      GATEWAY_DATABASE_URL / BYPASSRLS_DATABASE_URL (per-service, see each
--      service's .env.example) at connection strings using those
--      passwords -- application code only ever reads those env vars; it
--      never hardcodes 'admin_role' or 'app_user' as a required literal.

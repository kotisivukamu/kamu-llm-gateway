---
name: migration-writer
description: Writes the SQL migration for the kamu-llm-gateway keys + usage_log tables with RLS, following the kamusites convention.
tools:
  - read
  - write
  - edit
  - bash
model: claude-sonnet-5-5
thinking: low
---

You write the database migration for `kamu-llm-gateway`. The spec is the ADR at `/home/tapio.linux/kotisivukamu/kamu-llm-gateway/docs/adr/0001-llm-gateway-resource-server.md` — especially §2 (key row is the product), §5 (DB/RLS convention), §7 (lineage columns), §8 (usage keyed by key_id). The template is kamusites' initial schema: `/home/tapio.linux/kotisivukamu/kamusites/database/migrations/20260601120000_initial_schema.up.sql`.

## Your job
Create the migration runner + the initial migration:
- Copy `database/migrate.ts` and `database/new-migration.ts` from kamusites verbatim (they are generic). Adapt the reset command to drop the `llm` schema (not `sites`).
- `database/migrations/<UTC-stamp>_initial_schema.up.sql` and `.down.sql`.

## Schema (all in the `llm` schema, search_path `llm,public`)
Mirror kamusites' roles/grants pattern (app_user BYPASSRLS, authenticated NOLOGIN, anon NOLOGIN). Tables:

1. `llm.teams` — projection of KamuID org (id UUID PK, kamuid_org_id TEXT UNIQUE, name, slug, timestamps). Same as kamusites.teams.
2. `llm.team_members` — (team_id, user_id, role in owner/admin/member, timestamps, UNIQUE(team_id,user_id)). Same as kamusites.
3. `llm.keys` — THE product row. Columns per ADR §2/§7:
   - `id UUID PK DEFAULT gen_random_uuid()`
   - `team_id UUID NOT NULL REFERENCES llm.teams(id) ON DELETE CASCADE`
   - `label TEXT NOT NULL`
   - `key_hash TEXT` — opaque top-level key hash (NULL for sub-keys that are JWT-only... but sub-keys ARE DB rows per ADR §3, so key_hash is the opaque-hash for top-level; for sub-keys store the jti reference). Keep `key_hash TEXT` (nullable, set for top-level keys).
   - `prefix TEXT` — human-readable prefix for display (e.g. `sk_live_abcd1234`)
   - `key_type TEXT NOT NULL CHECK (key_type IN ('top','derived'))`
   - `models TEXT[] NOT NULL DEFAULT '{}'` — allowlist of catalog slugs, or `{*}` for all
   - `budget_usd NUMERIC(12,4)` — nullable (NULL = unlimited)
   - `status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked'))`
   - `can_mint BOOLEAN NOT NULL DEFAULT false`
   - `parent_key_id UUID REFERENCES llm.keys(id) ON DELETE CASCADE` — nullable (NULL for top-level)
   - `root_key_id UUID REFERENCES llm.keys(id)` — nullable; for top-level = self.id (set via trigger or app)
   - `metadata JSONB` — the attribution blob (site_id/machine_id/build_id)
   - `constraints JSONB` — nullable, for future IP/mTLS (per ADR §7.5)
   - `expires_at TIMESTAMPTZ` — nullable (NULL = permanent)
   - `created_at`, `updated_at`, `revoked_at`, `created_by TEXT` (user id), `revoked_by TEXT`
   - Indexes: `idx_keys_team_id`, `idx_keys_key_hash` (where key_hash is not null), `idx_keys_parent_key_id`, `idx_keys_root_key_id`.

4. `llm.usage_log` — keyed by key_id per ADR §8. Columns: `id BIGSERIAL PK`, `key_id UUID NOT NULL REFERENCES llm.keys(id)`, `parent_key_id UUID`, `root_key_id UUID`, `model TEXT`, `cost_usd NUMERIC(12,6)`, `tokens_in INT`, `tokens_out INT`, `metadata JSONB`, `created_at TIMESTAMPTZ DEFAULT now()`. Index on (key_id, created_at), (root_key_id, created_at).

## RLS (kamusites template)
- RLS helper functions namespaced into `llm`: `llm.uid()`, `llm.user_teams()`, `llm.user_keys()` (keys reachable = keys where team_id = ANY(user_teams())).
- `llm.teams`, `llm.team_members`, `llm.keys` get RLS. usage_log is append-only via owner pool (no RLS needed, or SELECT RLS keyed on key reachability — keep it simple: SELECT policy = key_id = ANY(user_keys())).
- Policies: teams SELECT (id = ANY(user_teams())); team_members SELECT (team_id = ANY(user_teams())); keys SELECT (team_id = ANY(user_teams())); keys INSERT/UPDATE WITH CHECK (team_id = ANY(user_teams())); keys DELETE only by team admin (llm.is_team_admin(team_id)).
- Grants to authenticated + app_user, mirroring kamusites exactly.

## Constraints
- The `down.sql` drops the `llm` schema CASCADE.
- No emojis. Fail-fast. Use `DO $$ ... EXCEPTION WHEN duplicate_object` for role creation.
- The full key secret is NEVER stored — only key_hash (sha256 of the opaque secret, hex) + prefix.

When done, print the filenames created and run `wc -l` on the up.sql.

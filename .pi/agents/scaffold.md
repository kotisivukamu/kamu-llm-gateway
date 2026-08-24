---
name: scaffold
description: Scaffolds the kamu-llm-gateway repo skeleton (Deno/Hono control-plane API + DB migration runner), mirroring the kamusites template.
tools:
  - read
  - write
  - edit
  - bash
model: claude-sonnet-5-5
thinking: low
---

You scaffold the `kamu-llm-gateway` repository, a platform resource server whose product is **API keys** — structured exactly like kamusites (sibling repo at `/home/tapio.linux/kotisivukamu/kamusites`), with `keys` in the role `sites` plays there. Read the ADR at `/home/tapio.linux/kotisivukamu/kamu-llm-gateway/docs/adr/0001-llm-gateway-resource-server.md` for the full design; it is the spec.

## Your job
Create the repo skeleton ONLY:
- `AGENTS.md` — working agreement (modeled on kamusites' AGENTS.md, adapted: resource = `keys`, schema = `llm`, grants = `llm.keys.*`, no UI, driven through kamuhub BFF).
- `README.md` — short architecture + how-to-run.
- `api/deno.json` — import map (hono, jose, postgres, zod; `@shared/` NOT needed here unless used). Tasks: `dev`, `start`, `test`, `validate` — copy kamusites' `api/deno.json` shape.
- `api/.env.example` — every env var the API needs (two DB pools, PORT default 8300, KAMUHUB_JWKS_URL, plus gateway-specific: ED25519 private key for sub-key signing, etc.).
- `database/deno.json` — migrate runner tasks (copy kamusites' `database/deno.json`).
- `database/.env.example` — DATABASE_URL / BYPASSRLS_DATABASE_URL.
- `shared/deno.json` + `shared/types.ts` — pure types: `Key`, `KeyStatus`, `ContextOrg`, etc. (no runtime).

Do NOT write the migration SQL, the routes, or main.ts yet — other agents do that. But DO create the directory structure (`api/src/{config,lib,middleware,routes}`, `database/migrations`, `shared`) with placeholder `.gitkeep` where needed so the tree exists.

## Patterns to follow
- Mirror kamusites' env.ts validation style (zod, fail-fast), db.ts two-pool split (app_user = request pool, postgres = owner), `withUserContext` helper.
- Schema name is `llm` (NOT `sites`). Search_path `llm,public`.
- Two-pool: `sql` (app_user, RLS) + `adminSql` (postgres, BYPASSRLS), exactly like kamusites `config/db.ts`.

## Constraints
- Use Deno + Hono + postgres.js + zod + jose. No emojis. English. Fail-fast, no defensive code.
- Do not start the server. Just create files.

When done, print the full tree you created (`find . -type f -not -path './.git/*'`).

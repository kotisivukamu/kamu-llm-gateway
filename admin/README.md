# admin/ — llm-proxy-admin

Internal-admin-only surface for `kamu-llm-gateway`, deployed as its own Fly app
(`llm-proxy-admin`, see `fly.toml`), separate from `api/`'s
`kamu-llm-gateway-api`. It is a **superuser** surface — cross-org, reads and
writes `llm.keys` / `llm.usage_log` / `llm.settings` directly as the owner role,
with no RLS/tenant scoping — not a mode of the kamuhub-rendered dashboard `api/`
serves.

## Why this exists, and why it's separate from kamuhub

Platform operators need a cross-org view of every key and the usage ledger, and
a way to mint/revoke keys in any org (e.g. keys for platform services) outside
kamuhub's per-org grant model (`llm.keys.create`, `llm.keys.revoke`). That is a
superuser capability with no owning org, so it gets its own surface with its own
(separate, non-KamuID) auth instead of being bent into the grant model. (It was
originally built for `can_mint` key provisioning; `can_mint` was removed
2026-09-23, see ADR 0001.)

## Running locally

Needs a real Postgres with the `llm` and `admin_auth` schemas migrated (the same
DB `api/`/`proxy/` use is fine — schema-separated, no collisions):

```bash
# from database/
DATABASE_URL=postgres://postgres:postgres@localhost:5432/kamu-llm-gateway \
  deno run --allow-net --allow-read --allow-env --allow-write migrate.ts up

# from admin/
cp .env.example .env   # fill in ADMIN_DATABASE_URL / ADMIN_AUTH_DATABASE_URL /
                        # BETTER_AUTH_SECRET
deno task dev           # :8302
```

Seed the first admin (no self-service signup anywhere in this app):

```bash
deno run --allow-net --allow-env --allow-read --allow-sys --env-file \
  scripts/create-admin.ts --email you@kamuhub.dev --password 'at-least-8-chars'
```

Then sign in at `http://localhost:8302/login`.

## Auth — better-auth, verified working under Deno

**Outcome: better-auth works.** This was verified for real, not assumed from
docs, against a throwaway local Postgres (`docker run postgres:16`), on
2026-08-25:

1. `npm:better-auth@1.2.7` imports and initializes under Deno with no
   compatibility shims.
2. Its Postgres adapter needs a real `pg.Pool` (not `postgres.js` — passing a
   bare/undefined dialect throws
   `Cannot read properties of undefined
   (reading 'createDriver')`; a
   `pg.Pool` auto-selects the Kysely+pg adapter and works). Note also:
   `import { Pool } from "pg"` fails under Deno's npm CJS interop
   (`does not provide an export named 'Pool'`) — use
   `import pgDefault from "pg"; const { Pool } = pgDefault;` instead.
3. Schema-scoping to `admin_auth` (not `public`) works by setting
   `options: "-c search_path=admin_auth,public"` on the `pg.Pool`'s connection
   options — the libpq-option equivalent of `config/db.ts`'s
   `connection.search_path` on `postgres.js`.
4. `getMigrations()` from `better-auth/db` can generate + apply the schema
   programmatically against a real DB (used once, by hand, to capture the exact
   DDL below — not run at boot; see next point).
5. Full flow verified end to end over real HTTP through `auth.handler()`:
   `POST /api/auth/sign-up/email` → 200 + session cookie,
   `POST /api/auth/sign-in/email` → 200 + session cookie,
   `GET /api/auth/get-session` with that cookie → 200 with the session + user
   object.

**What's built here, differently from a naive better-auth setup:**

- The `admin_auth.user` / `session` / `account` / `verification` tables are a
  **committed migration**
  (`database/migrations/20260825120000_admin_auth_schema.up.sql`), not generated
  at runtime by `getMigrations()` — this repo's convention is timestamped
  migration files applied by the Deno runner (`deno task migrate`), and
  better-auth's own migrator doesn't fit that (it wants to own its own migration
  lifecycle). The column names/casing in that file are copied verbatim from what
  `getMigrations()` actually created when pointed at a real Postgres —
  better-auth's Kysely adapter queries those exact camelCase names, so they must
  not be renamed.
- No self-service signup: `emailAndPassword.enabled: true` is only for
  **sign-in**. The only code path that calls `auth.api.signUpEmail` is
  `scripts/create-admin.ts`, run by hand/CI, not exposed as an app route.
  `main.ts` mounts `auth.handler` under `/api/auth/*` (better-auth's generic
  router still technically answers a raw `POST /api/auth/sign-up/email` if
  someone crafts one directly — there's no UI link to it and this is an
  internal-only Fly app, but a future hardening pass could add an explicit
  reject on that one path if that residual is ever a concern).
- Session cookie TTL is 12h (`session.expiresIn` in `src/lib/auth.ts`), shorter
  than better-auth's 7-day default — this app mints/revokes keys across every
  org, so sessions stay tight.

**2FA**: not built. If/when it's needed, evaluate `better-auth`'s official
`twoFactor` plugin first — the base library already proved compatible with Deno,
so the plugin is the natural next thing to actually test (not assume) before
reaching for a bespoke TOTP implementation.

## Features

### Feature 1 — cross-org usage visibility

`GET /usage` (HTML) and `GET /api/usage` (JSON) read `llm.usage_log` joined to
`llm.keys`/`llm.teams` directly via the owner pool (`config/db.ts`'s `adminSql`,
`search_path=llm,public`) — every org, no RLS, no `team_id` filter anywhere in
`routes/usage.tsx`. Shows per-org spend totals and the latest 200 raw requests
across the whole platform.

### Feature 2 — system-wide settings

**Scope, stated honestly:**

- **Built:** a read-only view of the current provider/model catalog
  (`proxy/src/catalog.ts`, imported directly — source of truth, no DB-copy-drift
  risk) at `GET /settings`, PLUS a new, small, genuinely runtime-editable table:
  `llm.settings` (migration `20260825130000_settings.up.sql`), a single-row
  singleton of _operator overrides_ — `disabled_models: text[]` and
  `default_budget_usd`. Full read/write through `GET/POST /settings` and
  `GET /api/settings`, backed by a real DB row (verified: see "Testing" below).
- **Deliberately NOT built:** making the catalog itself (`proxy/src/catalog.ts`)
  DB-backed. Reason: each model entry is wired to an env var name
  (`api_key_env_var`) resolved from Doppler/Fly secrets at request time — moving
  the catalog into the DB would mean either duplicating that secrets plumbing
  into a DB-editable form (a bigger, riskier change than "settings") or building
  a DB→env-var indirection layer. That's a deliberate, separate redesign, not a
  natural extension of "add a settings table."
  - **What a follow-up needs**, if full runtime editability of the catalog
    itself is wanted later: (1) decide whether model/provider _pricing_ needs to
    be admin-editable too, or just enable/disable (if just enable/disable,
    `llm.settings.disabled_models` already covers it — see next point); (2) if
    pricing needs to move to the DB, design how `proxy/`'s hot path loads it
    without adding a DB round-trip per request (probably: the same poller/cache
    pattern `api/src/lib/usage-poller.ts` already uses for usage, inverted —
    pull settings into an in-memory map on an interval); (3) decide the
    API-key-env-var problem above.
- **Also NOT built:** the proxy does not consult `llm.settings.disabled_models`
  on its hot path yet. An admin can record "glm-5 is disabled" through this UI
  and it is durably stored and correctly displayed, but `proxy/` still forwards
  requests for it — wiring the proxy to check this table (or a cache fed from
  it, same reasoning as above) is the follow-up. Shipping the DB-backed override
  table and the read-only catalog view, without also wiring the proxy, is the
  deliberately scoped slice for this task; wiring the proxy is a proxy/-side
  change with its own hot-path-latency considerations (ADR §10) that deserves
  its own pass, not a rushed add-on here.

### Feature 3 — cross-org key provisioning

`GET/POST /keys` (HTML) and `GET/POST /api/keys`, `POST /api/keys/:id/revoke`
(JSON). Mint inserts a `key_type='top'` row exactly like
`api/src/routes/keys.ts`'s `POST /keys` (same `generateTopLevelKey`/`hashKey`
shape, duplicated in `src/lib/keys.ts` rather than imported — see that file's
header comment for why). Revoke runs the identical cascade query
(`status='revoked' WHERE id = $1 OR root_key_id = $1`) as `api/`'s revoke route.

## Testing performed (2026-08-25, against a real local Postgres)

```
docker run -d --name kamu-llm-gateway-dev-pg -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=kamu-llm-gateway -p 55440:5432 postgres:16
# migrations applied (llm schema + admin_auth schema + settings table)
# test rows inserted into llm.teams / llm.keys / llm.usage_log

deno run ... scripts/create-admin.ts --email admin@kamuhub.dev --password supersecret123
# -> Created admin_auth.user: admin@kamuhub.dev (id=P52cgL6IDjBDLaW7zYWUuBvapw24nydp)

curl -c cookies.txt -i -X POST localhost:8302/login -d "email=...&password=..."
# -> 302, Set-Cookie: better-auth.session_token=...

curl -b cookies.txt -X POST localhost:8302/api/keys -d '{"team_id":"...","label":"studio service key","can_mint":true,"budget_usd":500}'
# -> 201 {"key":{"id":"7d2b...","prefix":"sk_live_4c56"},"secret":"sk_live_4c56..."}
psql ... "SELECT id, label, can_mint, status FROM llm.keys WHERE label='studio service key'"
# -> can_mint=t, status=active

# inserted a synthetic derived child under that parent to prove cascade
curl -b cookies.txt -X POST localhost:8302/api/keys/7d2b.../revoke
# -> {"ok":true,"revoked":2}
psql ... "SELECT id, status, revoked_at, revoked_by FROM llm.keys WHERE id IN (parent, child)"
# -> BOTH rows status=revoked, same revoked_at, revoked_by=admin:admin@kamuhub.dev

curl -b cookies.txt localhost:8302/api/usage
# -> real usage_log rows across org_alpha AND org_beta in one response

curl -o /dev/null -w '%{http_code}' localhost:8302/api/keys   # no cookie
# -> 302 (redirect to /login) -- unauth rejected
```

All three features' HTML pages (`/usage`, `/keys`, `/settings`) were also loaded
through the real session cookie and confirmed to render the actual DB rows (not
just the JSON API).

# kamu-llm-gateway

The platform's LLM gateway — a **resource server whose product is API keys**.
It is structured exactly like `kamusites` (sibling repo), with `keys` in the
role `sites` plays there: the key row is the product, the LLM proxy satellite
is the consumption path, and usage hangs off `key_id` the way analytics hang
off `site_id`. See `docs/adr/0001-llm-gateway-resource-server.md` for the full
design.

It is a bearer-only API (Deno + Hono), KamuID-native from day one. There is
**no UI** — the gateway is rendered through the unified **kamuhub** dashboard
(`app.kamuhub.com`) and consumed directly by internal services (studio,
builder-queue, the kamuhub agent) via `POST /api/keys/derive`.

## Architecture

- `api/` — Deno + Hono API, the key-management + usage endpoints. A
  **bearer-only resource server**: it validates the KamuID access token and the
  signed `X-Kamuhub-Authz` platform context (no browser login of its own).
  Postgres **RLS** scopes data by team/key; the API connects as `app_user`
  (BYPASSRLS) and runs authenticated requests via `SET LOCAL ROLE authenticated`
  + `app.current_user_id` (see `api/src/config/db.ts`).
- `shared/` — pure types shared across the api and (future) satellite.
- `database/migrations/` — timestamped `.up.sql`/`.down.sql` pairs applied with
  the Deno runner.
- `docs/adr/` — architecture decision records. `0001` is the spec.

## The key is the product

Two credential shapes, both first-class `keys` rows:

- **Top-level keys** — the product row, held by external developers and by
  internal services alike. An opaque secret (`sk_live_…`) on the
  wire, stored hashed. Verified on the hot path by an in-process key-metadata
  cache.
- **Derived sub-keys** — short-lived (1h), session/build-scoped children of any
  active top-level key (depth 1: they cannot derive further), minted via `POST /api/keys/derive`. A compact **Ed25519-signed
  JWT** on the wire whose `jti` is the DB row's PK, also backed by a DB row for
  management/lineage/revocation. Ed25519 (asymmetric) so the proxy holds only the
  public key and can never mint.

Usage is a gateway-owned ledger keyed by `key_id`, with `parent_key_id` +
`root_key_id` lineage columns so spend rolls up to a service's whole subtree.

## Identity & org model

- KamuID owns identity, orgs, and membership. A KamuID **org** projects into a
  local `teams` row (linked by `teams.kamuid_org_id`). Org membership is
  reconciled from the verified `X-Kamuhub-Authz` context (not the raw KamuID
  claim).
- Grants are enforced by `requireGrant` (`llm.keys.create`, `llm.keys.revoke`)
  reading the signed context. RLS scopes visibility; `requireGrant` is the
  explicit permission gate. Fail-closed.

## Database

Own database, but all objects live in an **`llm` schema** (search_path
`llm,public`), never `public`, and it does not reuse the `auth`/
`protected_functions` schema names. This keeps prod a clean separate instance,
and lets local dev optionally run everything in the shared `kotisivukamu` dev
DB as the `llm` schema with no collisions. Global roles
(`authenticated`/`anon`/`app_user`) are created with guards. Two-pool split:
`sql` (app_user, RLS) + `adminSql` (postgres, BYPASSRLS).

## Running locally

```bash
# 1. Apply migrations (own DB or the shared dev DB) via the Deno runner
createdb kamu-llm-gateway 2>/dev/null || true
cd database && cp .env.example .env   # owner (postgres) URL for DDL
deno task migrate                     # up; also: migrate:down, reset, new-migration <name>

# 2. API (:8300)
cd api && cp .env.example .env   # fill in the two DB pools + KAMUHUB_JWKS_URL +
                                 # the Ed25519 sub-key signing key
deno task dev
```

Drive it through the unified front door: the **kamuhub** dashboard at
`app.kamuhub.com`, which injects the `X-Kamuhub-Authz` context. Internal
services derive sub-keys at `POST /api/keys/derive` (parent-key auth, no BFF
context).

## Running tests

The regression suite (`api/src/tests/`, `proxy/src/tests/`) needs a real
Postgres — no mocking of the DB layer. `.github/workflows/ci.yml` starts one
per package as a service container; to run the same thing locally:

```bash
# 1. A throwaway test Postgres (any port; adjust the URLs below to match)
docker run -d --name kamu-llm-gateway-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=kamu_llm_gateway_test -p 5432:5432 postgres:16

# 2. app_user role (dev bootstrap normally does this once per box)
psql postgres://postgres:postgres@localhost:5432/kamu_llm_gateway_test \
  -c "CREATE ROLE app_user LOGIN PASSWORD 'app_user';" \
  -c "GRANT ALL ON DATABASE kamu_llm_gateway_test TO app_user;"

# 3. Migrate
cd database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/kamu_llm_gateway_test \
  deno run --allow-net --allow-read --allow-env migrate.ts up

# 4. Run each package's tests. Every env var the test process needs has a
#    default baked into src/tests/support/env.ts (throwaway Ed25519 test key
#    material + postgres://…/kamu_llm_gateway_test on localhost:5432) — set
#    a var explicitly only to point at a different DB/port, or when running
#    outside the support/env.ts bootstrap (e.g. CI's `env:` block, which sets
#    them explicitly so the workflow is self-documenting).
cd ../api && deno task test      # or `deno task validate` (fmt+lint+check+test)
cd ../proxy && deno task test    # proxy's `validate` task is fmt+lint+check only
```

The suite truncates and reseeds its own fixture rows per test file
(`support/db.ts`'s `resetDb`) — it's safe to point it at a scratch DB and
re-run repeatedly, but don't point it at a real dev/prod database.

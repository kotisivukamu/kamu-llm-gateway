You are working in the **kamu-llm-gateway** repository — the platform's LLM
gateway, a resource server whose **product is API keys**. It is a separate repo,
sibling to `kamusites`, `kamuid`, `studio`, and `kotisivukamu`. See `README.md`
for architecture and how to run it, and `docs/adr/0001-llm-gateway-resource-server.md`
for the full design (the spec). This file is the working agreement.

## What lives here (and what does not)

Keep only things strictly about **API keys as a resource**: the key row
(create, list, detail, revoke, derive), the usage ledger keyed by `key_id`,
and the LLM proxy satellite that consumes a key. Identity → KamuID;
authz/grants/billing → kamuhub; DNS/email → `kamudns.com`/`kamuemail`;
site repos → kamuforge; CDN → kamucdn; editing → studio. If a feature isn't
about an API key or the consumption of one, it does not belong here.

The gateway **owns no account model** — no signup, no approval queue, no
gateway-local user. Identity comes from KamuID; org membership and grants
come from the signed `X-Kamuhub-Authz` context the kamuhub BFF injects. The
gateway keys its rows on the shared, non-divergent `kamuid_org_id`, exactly
like every other satellite.

## The key is the product (load-bearing framing)

Hold the kamusites-with-`keys`-for-`sites` table from ADR 0001 in your head; it
is the whole design:

| kamusites                                  | kamu-llm-gateway                          |
|--------------------------------------------|-------------------------------------------|
| resource = `sites`                         | resource = `keys`                         |
| `teams` = projection of KamuID org         | `teams` = projection of KamuID org        |
| `sites.team_id → teams`                    | `keys.team_id → teams`                   |
| consumption = the builder                  | consumption = the LLM proxy satellite      |
| usage hangs off `site_id` (analytics)      | usage hangs off `key_id` (the spend ledger)|
| grants: `sites.create`, `sites.delete`     | grants: `llm.keys.create`, `llm.keys.revoke`|
| rendered through the kamuhub dashboard    | rendered through the kamuhub dashboard    |

Everything else — the proxy satellite, the usage ledger, the delegated-minting
capability — is machinery around the one `keys` product row, exactly as the
builder/analytics/journey machinery in kamusites hang off a `site_id`.

## Two credential shapes (both are `keys` rows)

- **Top-level keys** — the product row, held by external developers and by
  internal services alike. An opaque secret (`sk_live_…`) on the wire,
  stored hashed on the row. Verified on the hot path by an in-process
  key-metadata cache (the kamuhub `key_gate` pattern), so revocation takes
  effect within the cache TTL without a DB read per request.
- **Derived sub-keys** — short-lived (1h), session/build-scoped children of any
  active top-level key (derived keys cannot derive: depth 1), minted via `POST /api/keys/derive`. A compact
  **Ed25519-signed JWT** on the wire (the `jti` claim IS the DB row's PK),
  **also backed by a DB row** for management/lineage/revocation. Signed with
  Ed25519 (asymmetric) — the proxy holds only the public key and can never
  mint, even under full VM compromise.

Both are first-class `keys` rows, consumed and revoked identically.

## Identity & RLS (load-bearing — do not weaken)

- **KamuID-only identity.** There is no local signup; identity is the KamuID
  `sub` from `/userinfo` on the opaque bearer.
- **`team_members` = org membership, from the platform context.** The reconcile
  upserts orgs into `teams` (keyed on the shared `kamuid_org_id`) and fully
  reconciles `team_members` (insert/update/**delete**), as `app_user`
  (BYPASSRLS), touching only `team_members`.
- **Source per path (kamuhub ADR 0001):** every route via `authMiddleware`
  derives membership from the verified **`X-Kamuhub-Authz`** context the BFF
  injects, **not** the raw KamuID claim. Fail-closed: no verified context ⇒
  403. Dev included — the locally-run kamuhub BFF injects the signed context,
  so there is no dev bypass.
- **The local user id is the RLS principal.** Authenticated requests run via
  `withUserContext` (`SET LOCAL ROLE authenticated` + `set_config('app.current_user_id', …)`);
  `llm.uid()` reads it; RLS policies scope by `llm.user_teams()` / `llm.user_keys()`.
- **`keys.team_id → teams`** scopes a key to its owning org, exactly like
  `sites.team_id`. RLS scopes visibility; `requireGrant` is the explicit
  permission gate (`llm.keys.create`, `llm.keys.revoke`).

## Database (kamusites convention, schema = `llm`)

- Own database; **all objects in the `llm` schema** (search_path `llm,public`).
  Do not use `public`/`auth`/`protected_functions` schema names — that keeps the
  schema relocatable and collision-free in a shared dev DB.
- RLS helpers are namespaced into `llm`: `llm.uid()`, `llm.user_teams()`,
  `llm.user_keys()`.
- Migrations: timestamped pair in `database/migrations/`
  (`<UTC-stamp>_<name>.{up,down}.sql`). Schema only; seed/content rows go in
  `database/seeds/` (idempotent UPSERT). Grant new objects to `app_user` (and
  `authenticated`/`anon` as appropriate), guarding role refs with `pg_roles`/
  `duplicate_object` checks. Apply with the Deno runner from `database/`:
  `deno task migrate` (up), `deno task migrate:down`, `deno task reset` (local
  only); scaffold a pair with `deno task new-migration <name>`. The runner
  connects as the `postgres` owner (DATABASE_URL / BYPASSRLS_DATABASE_URL), runs
  DDL under `SET ROLE postgres`, and tracks applied files (with hashes) in
  `migrations.schema_migrations` — don't edit a migration after it's applied;
  add a new one. The assumed role is `MIGRATE_ROLE`, **defaulting to `postgres`**.

## Dev process management (tmux)

Run dev servers inside the shared `dev` tmux session — never as background
processes (`&` / `run_in_background`), which are invisible to the user. Use
`tmux send-keys` into named windows: `kamu-llm-gateway-api`. Check
`tmux list-windows -t dev` first to avoid duplicates/port conflicts. API is
`:8300`. There is **no UI here** — the gateway is driven through the kamuhub
front door (`app.kamuhub.com`) and (for internal callers) the `POST /api/keys/derive`
endpoint. Dev traffic must go through the locally-run kamuhub BFF, which
injects the `X-Kamuhub-Authz` context — the API rejects a bare KamuID bearer.

## Conventions

- Primary language English for service surfaces.
- No emojis in code or commit messages.
- Run `deno fmt` before committing; `cd api && deno task validate` runs
  fmt-check + lint + type-check.
- Commit directly to `main` — no branches or PRs. Commit often; don't sit on WIP.
- Don't use defensive programming — fail fast. Validate at system boundaries
  (user input, external APIs); trust internal code. No fallbacks for cases that
  can't happen.
- Don't add abstractions, options, or backwards-compat shims beyond what the
  task needs.

## Commit message bodies

We commit directly to `main` with no PRs, so the body is the only place design
rationale lives. Code documents *how*; the body documents *why* — the author's
reasoning, alternatives weighed, dead ends, non-obvious constraints. Omit the
agent's own exploration and process noise. Length is not the constraint, signal
is.

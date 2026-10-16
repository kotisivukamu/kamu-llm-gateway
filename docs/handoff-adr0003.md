# ADR 0003 handoff

Waves 1 (api + database) and 2 (proxy) of 4. Committed locally on `main`, not
pushed, not released.

## Wave 1: done

- **Migration**
  `database/migrations/20261016120000_pricing_at_ingest.{up,down}.sql`
  - `llm.model_prices`: append-only, created empty, index
    `model_prices_model_valid_from_idx (model, valid_from DESC)`. RLS on, no
    policies. `app_user`/`admin_role` get SELECT, INSERT only (UPDATE/DELETE
    revoked from the default privileges). Rates are `NUMERIC(12,6)`, all four
    token rates NOT NULL, `per_request_cost_usd` default 0. No long_context tier
    column.
  - `llm.usage_log` + `cache_read_tokens`, `cache_write_tokens` (int, default
    0), `provider_cost` numeric, `provider_cost_currency` text, `price_id` →
    `model_prices`. `llm_usage_reader` gets SELECT on the new columns.
  - `llm.keys.status` check (`keys_status_check`) allows `over_budget`. The down
    migration resets `over_budget` keys to `active`.
- **Pricing math** moved to `shared/pricing.ts` (`computeCostUsd`, `Rates`,
  `NormUsage`). `proxy/src/cost.ts` re-exports both, so `proxy.ts` is untouched.
  The proxy image now copies `shared/` (`proxy/Dockerfile`, `@shared/` in
  `proxy/deno.json`). The api image copies `proxy/src/catalog.ts` (as admin
  does) for the fallback prices. Both images build.
- **`api/src/lib/pricing.ts`**: `priceTable()` (whole `model_prices` table in
  memory, 30 s TTL), `pickPrice(table, model, at)`,
  `priceUsage(table, model,
  at, usage)` → `{ cost_usd, price_id }`. No DB row
  → catalog `getModel`, `price_id` null. Model in neither → `cost_usd` null.
  `clearPriceCache()` for tests.
- **`api/src/lib/usage-poller.ts` `pollOnce`**: prices every row by its
  `created_at`, stores `cost_usd`, `price_id`, cache buckets and (when the feed
  has them) `provider_cost`/`provider_cost_currency`. The feed's `cost_usd` is
  ignored. Insert and spend run in one transaction (`adminSql.begin`).
- **`chargeSpend`** (same file; behind `INGEST_KEY_SPEND` in wave 1,
  unconditional since wave 2): adds the inserted rows' stored `cost_usd` to
  `llm.key_spend` for `key_id` and `root_key_id` (once when they are equal),
  counting only rows with cost > 0. It then sets every charged `active` key with
  `spent_usd >= budget_usd` to `over_budget`. Only rows returned by
  `ON CONFLICT DO NOTHING ... RETURNING` are charged, so re-polls and two api
  machines polling the same proxy never double count.
- **Env flag** `INGEST_KEY_SPEND` (api `env.ts`, default `false`). Deleted in
  wave 2.
- `shared/types.ts` `KeyStatus` includes `over_budget`.
- Tests: `api/src/tests/pricing.test.ts` (pure), new ingest/budget cases in
  `api/src/tests/usage-poller.test.ts`. api 32/32 and proxy 50/50 pass against a
  throwaway Postgres 16 (README "Running tests" recipe, port 55441).

## Wave 2: done

Commits `3c03920` (proxy + api flag) and `9e82a5b` (reactivation trigger).

- **Proxy stops writing spend.** `recordSpend`, `getSpentUsd`, the per-request
  budget pre-check and `budget_usd` on `KeyMeta`/`KeyCredential` are gone (with
  `gateway-db.budget.test.ts` and `gateway-db.numeric.test.ts`). The proxy's
  only Postgres use is the key-meta read.
- **`INGEST_KEY_SPEND` deleted**, not flipped: ingest always charges `key_spend`
  and flips `over_budget`. Ship the proxy and api from this commit together (one
  release covers both). If an `INGEST_KEY_SPEND` Fly secret was set, it is now
  ignored; remove it.
- **Budgets by status.** The proxy reads `status` through the key-meta cache:
  `over_budget` → `402 {"error":"budget_exceeded"}` (was `402 budget_exhausted`
  from the spend read), revoked/expired/unknown → 401. A derived key also needs
  its root (one more cached lookup by `root_key_id`, `byId` map): root
  `over_budget` → 402, root revoked or gone → 401. `over_budget` rows are cached
  as rows (not DENY) so the reason survives, and an over-budget key may still
  read its own `GET /usage` and the catalog.
- **Feed.** SQLite migration `0006_provider_meter.sql` adds `provider_slug` and
  `provider_cost` to `usage_log`; `GET /usage` rows carry both. `provider_cost`
  = cortecs `usage.cost`, parsed from JSON and SSE (final chunk) in `cost.ts`
  (`MeteredUsage`). Unit undocumented (cortecs API docs list token counts only;
  cortecs prices in EUR; studio's comment calls it "provider-specific
  micro-USD", unverified), so the proxy sends no `provider_cost_currency` and
  the poller stores null. `provider_slug` is not stored in Postgres (no
  `llm.usage_log` column).
- **SQLite `cost_usd` is still computed** (catalog estimate) and served on
  `GET /usage`. Nothing in the gateway bills from it, but the builder reads it
  from the proxy for `builds.cost_usd`; it stays until readers move (§5).
- **Reactivation** is a trigger, `llm.reactivate_on_budget_raise` on
  `UPDATE OF budget_usd` (migration `20261016150000_budget_reactivation`): an
  `over_budget` key whose new budget is null or above its `key_spend` total
  becomes `active`. Never touches `revoked`. Lowering a budget does not flip
  anything; ingest does on the next charged request. Nothing edits `budget_usd`
  yet; any future editor gets this for free.
- Tests: api 34/34, proxy 52/52 against the wave-1 container (port 55441);
  `deno task validate` clean for both; both images build.

## What the next waves must know

- **Readers (§5)**: the builder (`builder/src/kamuagent.ts` UsagePoller) and
  anything else reading cost from the proxy's `GET /usage` must move to the
  api's usage endpoint. Then drop SQLite `cost_usd`, the `computeCostUsd`
  re-export in `proxy/src/cost.ts`, and the catalog estimate in `proxy.ts`.
- **Consumers must handle 402 `budget_exceeded`** (the old error string was
  `budget_exhausted`; grep callers that matched on it).
- **Admin budget edits**: just `UPDATE llm.keys SET budget_usd = ...`; the
  trigger reactivates. The proxy sees it within the 10 s cache TTL.
- A root key's `key_spend` starts at the release that ships wave 2 (earlier
  child spend was never charged to the root), so a budgeted root can run a
  little longer the first time.
- **Admin Prices page**: insert-only (the grants forbid UPDATE/DELETE for
  `app_user`/`admin_role`). A new row takes up to 30 s to reach ingest.
  `valid_from` in the past only affects rows ingested after it lands; it never
  reprices stored rows.

## Open questions

- `model_prices` has no long_context tier. A DB row for a tiered model
  (claude-haiku-5-5) prices every request at the base rate; until that is added,
  leave tiered models on the catalog fallback.
- `provider_cost` is stored as-is with no currency and an undocumented unit;
  confirm against a real cortecs response (and the cortecs dashboard) before any
  drift report compares it to `cost_usd`. If it is fixed per provider (e.g.
  EUR), the proxy can send `provider_cost_currency` from the catalog.
- `provider_slug` is in the feed but not in `llm.usage_log`; add a column if
  drift reports need it (routing can change which provider serves a model).
- Spend is charged for keys with no budget too (cheap, and a later budget then
  starts from real spend). Say so if only budgeted keys should be charged.

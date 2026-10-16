# ADR 0003 handoff

Wave 1 of 4 (api + database). Committed locally on `main`, not pushed, not
released.

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
- **`chargeSpend`** (same file), only when `INGEST_KEY_SPEND=true`: adds the
  inserted rows' stored `cost_usd` to `llm.key_spend` for `key_id` and
  `root_key_id` (once when they are equal), counting only rows with cost > 0. It
  then sets every charged `active` key with `spent_usd >= budget_usd` to
  `over_budget`. Only rows returned by `ON CONFLICT DO NOTHING ... RETURNING`
  are charged, so re-polls and two api machines polling the same proxy never
  double count.
- **Env flag** `INGEST_KEY_SPEND` (api `env.ts`, default `false`, also in
  `api/.env.example`).
- `shared/types.ts` `KeyStatus` includes `over_budget`.
- Tests: `api/src/tests/pricing.test.ts` (pure), new ingest/budget cases in
  `api/src/tests/usage-poller.test.ts`. api 32/32 and proxy 50/50 pass against a
  throwaway Postgres 16 (README "Running tests" recipe, port 55441).

## What the next waves must know

- **Wave 2 (proxy)**: when the proxy stops calling `recordSpend`, flip the
  `INGEST_KEY_SPEND` default to `true` in the same release (or set the Fly
  secret). Do not run both: with both on, budgeted keys' spend counts twice on
  the key. Note the proxy's `recordSpend` only charged the key itself; ingest
  also charges the root, so a root's `key_spend` starts from the moment the flag
  goes on (earlier child spend is not in it).
- The poller already reads `provider_cost` and `provider_cost_currency` from the
  feed as optional fields; add them to `GET /usage` with exactly those names.
  `cache_read_tokens`/`cache_write_tokens` were already in the feed and are
  stored now. The feed's `cost_usd` can be dropped once the proxy stops pricing
  (the poller does not read it).
- Once the proxy stops pricing, `proxy/src/cost.ts`'s re-export of
  `computeCostUsd` can go; the api imports `@shared/pricing.ts` directly.
- The proxy must treat `over_budget` as deny (it denies any non-`active` key
  today, as 401) and return 402 per ADR §4, and deny derived keys whose root is
  not `active`. Ingest flips the key itself; it does not touch children of an
  over-budget root.
- **Admin/api budget edits**: raising `budget_usd` must set an `over_budget` key
  back to `active` (ADR §4). Nothing does that yet.
- **Admin Prices page**: insert-only (the grants forbid UPDATE/DELETE for
  `app_user`/`admin_role`). A new row takes up to 30 s to reach ingest.
  `valid_from` in the past only affects rows ingested after it lands; it never
  reprices stored rows.

## Open questions

- `model_prices` has no long_context tier. A DB row for a tiered model
  (claude-haiku-5-5) prices every request at the base rate; until that is added,
  leave tiered models on the catalog fallback.
- `provider_cost` is stored as-is with no currency conversion; drift reports
  must compare in the same currency.
- Spend is charged for keys with no budget too (cheap, and a later budget then
  starts from real spend). Say so if only budgeted keys should be charged.

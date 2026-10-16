# ADR 0003 handoff

Waves 1 (api + database), 2 (proxy) and 3 (cost readers) of 4. Committed
locally on `main`, not pushed, not released. Wave 3 also touches the builder
repo.

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

## Wave 3: done

Gateway commit `425ae1e`, builder commit `73bd578` (builder repo `main`).

- **api `GET /usage`** (`api/src/routes/usage.ts` `keyUsage`, mounted at the
  root, outside `/api`, because `/api` is BFF-context authenticated). The
  proxy's key-holder contract served from `llm.usage_log`: same credential
  (`x-api-key` or bearer; `sk_live_` by hash, derived JWT by Ed25519 signature
  then its row; `active` or `over_budget`, unexpired, root too:
  `verifyGatewayCredential` in `api/src/lib/keys.ts`, one DB read, no cache),
  same scope (top key = its subtree by `root_key_id`, derived = itself;
  `key_id`/`jti`/`name` only narrow), same cursor (`id` = `cursorOf(usage_id)`,
  identical to the proxy's), same `{ rows, max_id, totals }`. Rows carry the
  ingest-priced `cost_usd`, both cache buckets, `price_id`, `provider_cost`,
  `provider_cost_currency`; no `provider_slug` (not stored). Rows sharing the
  last row's cursor stay in a full page, as on the proxy. The dashboard's
  `/api/usage*` aggregates are unchanged.
- **Ingest lag: an ingest barrier, not a watermark.** Each read first awaits
  `ingestNow()` (`api/src/lib/usage-poller.ts`): a full pass over every proxy
  machine that *started after* the request arrived. When it returns with no
  failed machine, every row any proxy wrote before the read is in Postgres, so
  the answer is complete with no clock comparison. Why not a watermark ("all
  rows before T ingested"): it needs either state shared between api machines
  or comparing proxy, api and builder wall clocks; the barrier needs neither.
  Multiple api machines are fine because each one polls every proxy machine
  itself (the existing design), and concurrent passes already dedupe on
  `usage_id` (a conflicting insert waits for the other machine's commit, then
  does nothing; only `RETURNING` rows are charged). Readers arriving during a
  pass share one queued pass behind it, and the interval loop uses the same
  runner, so a burst of readers costs at most one extra pass per api machine
  and passes never overlap on one machine. The wait is capped at 5 s.
- **Partial answers.** `pollAll` now returns the machines it could not poll
  (`"discovery"` if the TXT lookup failed); the route sends them in
  `X-Usage-Partial` (or `timeout` after 5 s), like the proxy does for a sibling
  that does not answer. Rows are still served.
- **Builder** (`builder/src/kamuagent.ts`, `process.ts`, `config.ts`): new
  optional env `LLM_GATEWAY_API_URL`; `usageBaseUrl()` = it, else
  `LLM_PROXY_URL` (the old proxy read, catalog estimate), so deploy order is
  safe. The end-of-step total is `UsagePoller.final()`: a recount from the
  step's baseline cursor (a mid-step read can move the cursor past a row that
  another proxy machine wrote a moment earlier but was ingested later; the
  running totals only drive the budget kill, the recount is what is billed),
  retried every 1 s while the answer is partial or the read fails, for up to
  15 s, then taken as is with a warning. Mid-step polls are unchanged.
- **Other readers of proxy `/usage`**: none. Workspace grep (`/usage?since`,
  `llm.kamuhub.com`, `kamu-llm-gateway-proxy`, `max_id`, `X-Usage-Partial`,
  excluding node_modules/.claude/sites) finds only the builder; the hostname
  hits are LLM call base URLs (kotisivukamu api/worker/internal-api/
  agent-service, studio, kamusites, kamudns, kamubox, kamuhub agent, kamukit).
  `kamukit/agent/HANDOFF.md` mentions the builder's read in prose only.
- Tests: api 40/40 (new `key-usage.test.ts`: ingest-on-read + priced cost,
  paging by `since`, scope and narrowing, credential checks incl. over_budget
  and revoked root, partial header; `ingestNow` coalescing in
  `usage-poller.test.ts`), proxy 52/52, `deno task validate` clean for both
  (container on 55441). Builder: `npm test` 51/51 (final recount + partial and
  error retry, give-up bound, source selection, end-to-end step reading usage
  from `LLM_GATEWAY_API_URL`), `npm run typecheck` clean.

### Prod changes for wave 3

1. **builder-queue (kotisivukamu repo, not done here)** must pass the URL into
   the build machine env, next to `LLM_PROXY_URL`, in
   `builder-queue/src/tasks/build_site.ts` and `update_site.ts`:
   `LLM_GATEWAY_API_URL: env.KAMU_LLM_API_URL`. `KAMU_LLM_API_URL` is already
   a builder-queue secret (`https://kamu-llm-gateway-api.fly.dev`, used for
   derive), so no new secret. Use the public URL, not
   `http://kamu-llm-gateway-api.internal:8300`: build machines reach the proxy
   publicly (`https://llm.kamuhub.com`) today and the api's 6PN reachability
   from the `kotisivukamu-builder` app is not established. For local builder
   mode (`LOCAL_BUILDER_URL`), set `LLM_GATEWAY_API_URL=http://localhost:8300`
   in the builder's own env.
2. No new gateway secrets or env. The api already has `LLM_PROXY_URL`
   (`http://kamu-llm-gateway-proxy.internal:8301`), `CONTROL_PLANE_POLL_TOKEN`
   and `ED25519_PUBLIC_KEY`, which is all the route needs.

### Release order

1. Gateway release with waves 1-3 (api + proxy + migrations; the proxy change
   in wave 3 is a comment only). Must come first: a builder pointed at an api
   without `GET /usage` gets 404 and records no cost.
2. Builder release (falls back to the proxy until the env var arrives).
3. kotisivukamu release with the builder-queue env line. 2 and 3 are safe in
   either order (an old builder ignores the extra env), but 3 is what switches
   billing to the api.

After 3 is live (check a build's `step_usage` lines against
`llm.usage_log` for its jti), wave 4 can drop the proxy's catalog estimate:
SQLite `cost_usd`, `cost_usd` in proxy `GET /usage`, the `computeCostUsd`
re-export in `proxy/src/cost.ts` and the call in `proxy.ts`. Not before: the
deployed builder reads it until then. The builder's proxy fallback can go at
the same time (make `LLM_GATEWAY_API_URL` required).

### Risks

- Every key-holder read now costs an ingest pass (per api machine: one TXT
  lookup, one `newestStored` query and one HTTP page per proxy machine), at
  most one queued pass however many readers. Builds read every 10 s per step,
  so this is small; a much larger reader population would want a short
  "recent pass" reuse window.
- Read latency includes the pass (normally tens of ms, capped at 5 s).
- A proxy machine that stays unreachable makes final totals short by its rows
  after the 15 s wait (logged); the rows still land in `llm.usage_log` and
  `key_spend` later, only `builds.cost_usd` misses them. Same failure mode as
  the proxy's sibling fan-out before.
- Clock skew only matters for the baseline (a step's first row would need a
  usage_id below the previous step's last row), which needs skew larger than
  the gap between steps.
- Cost per build changes from the proxy catalog estimate to the api price
  (`model_prices`, else the same catalog), so builds bill identically until a
  `model_prices` row is added.

## What the next waves must know

- **Readers (§5)**: done in wave 3 (the builder was the only one). Once the
  builder-queue env line is live, drop SQLite `cost_usd`, the `computeCostUsd`
  re-export in `proxy/src/cost.ts`, and the catalog estimate in `proxy.ts`
  (see "Release order" above).
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

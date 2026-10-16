# ADR 0003 — The proxy meters tokens, the api prices them

- **Status:** Accepted — 2026-10-16
- **Builds on:** ADR 0001 (usage ledger keyed by key_id, §7.6 lineage, §8/§9
  poller), ADR 0002 (catalog = routing)

## Context

On 2026-10-16 a kotisivukamu build recorded 4.05 USD. Cortecs' own dashboard
showed about half of that for the whole day's traffic. Cause: cortecs had cut
its prices and `proxy/src/catalog.ts` still carried the old ones (glm-5.3 was
1.8151 / 4.6667 / 0.4541 USD per Mtok against a live 0.9058 / 3.4292 /
0.2288). Every consumer that bills customers from gateway cost (kotisivukamu
build saldo, the builder's `builds.cost_usd`) overcharged by ~1.85x.

Three things made that possible and hard to see:

1. **Prices are code.** Correcting a price is a proxy release, so it does not
   happen, and nothing compares the catalog against the provider.
2. **The proxy prices at request time and the price is gone afterwards.**
   `llm.usage_log` keeps `tokens_in`, `tokens_out` and `cost_usd` only. The
   cache-read and cache-write counts exist in each machine's SQLite but are
   dropped on the way to Postgres, so a past period cannot be repriced, and
   finding the 6M cache-read tokens behind the 4.05 USD meant back-solving
   from cost.
3. **The provider's own figure is thrown away.** Cortecs returns
   `usage.cost` in every response. Nobody stores it, so drift between our
   price and theirs is invisible.

## Decision

### 1. The proxy meters, it does not price

The proxy keeps doing what only it can do: authenticate, route, forward, and
write one SQLite usage row per completed request with the raw buckets —
`model`, `provider_slug`, `input_tokens` (uncached), `cache_read_tokens`,
`cache_write_tokens`, `output_tokens` — plus the provider-reported cost when
the response carries one (`provider_cost`, raw number, and
`provider_cost_currency` when known). It no longer computes `cost_usd` and no
longer writes `llm.key_spend`.

`catalog.ts` stays the routing table (provider, upstream slug, overrides,
paths). Its price fields become the **fallback** price list only: used by the
api when a model has no row in `llm.model_prices`.

### 2. The api prices once, at ingest

The usage poller (`api/src/lib/usage-poller.ts`) already copies every proxy
row into `llm.usage_log` every 2 s. It now also prices each row, in the same
transaction that inserts it:

- price = the `llm.model_prices` row for that model with the greatest
  `valid_from <= row.created_at`; if none, the catalog price;
- `cost_usd` is stored on the row with `price_id` (null = catalog fallback);
- `llm.key_spend` is incremented for the key **and its root** (spend already
  rolls up by `root_key_id`).

Cost is computed once and never recomputed by a read. A price change applies
from its `valid_from` onward; old rows, `builds.cost_usd` and saldo already
charged keep their amount. A deliberate repricing (refunds) is an explicit
script over the stored buckets, not a side effect of editing a price.

`llm.usage_log` gains `cache_read_tokens`, `cache_write_tokens`,
`provider_cost`, `provider_cost_currency`, `price_id`.

### 3. Prices are an append-only table

`llm.model_prices(id, model, input/output/cache_read/cache_write
cost_per_mtok_usd, per_request_cost_usd, valid_from, source, note,
created_by, created_at)`. Rows are never updated; a change is a new row with a
later `valid_from`. The admin app gets a Prices page (current price per
model, history, add a row). Per the platform rule, the migration creates the
table empty: no price data in migrations. The catalog fallback covers every
model until a row exists.

### 4. Budgets: the api flips the key, the proxy obeys

`llm.keys.status` gains `over_budget`. When ingest pushes a key's (or its
root's) `spent_usd` to or past `budget_usd`, it sets that key to
`over_budget` in the same transaction. The proxy already denies any
non-`active` key through its key-meta cache (TTL 10 s); it returns
`402 {"error":"budget_exceeded"}` for `over_budget` instead of 401, and
denies a derived key whose root is not `active`. Raising the budget sets the
key back to `active`. `revoked` keeps meaning "deliberately killed, final".

Worst-case overrun: poll interval (2 s) + the in-flight request + cache TTL
(10 s), i.e. a few requests' worth. Budgets here are runaway protection,
not exact limits, so this is accepted.

### 5. Cost readers read the api

Consumers that read cost (builder's per-step usage, anything else polling
proxy `GET /usage`) move to the api's usage endpoint, which serves priced
rows from Postgres with the same cursor contract. Rows appear there after
ingest (~2 s); readers that need a final total wait for the key's rows to be
ingested (the api exposes how far ingest has got) instead of reading once.
The proxy's `/usage` stays as the internal feed for the poller.

## Consequences

- Price fixes are data, not deploys. The proxy release that fixed the
  2026-10-16 overcharge is the last one a price change needs.
- Repricing and reconciliation are possible from stored buckets, and
  `provider_cost` vs `cost_usd` shows drift directly. A later scheduled job
  (next step: a worker + cron) can propose new `model_prices` rows from the
  provider price lists and flag rows where the two disagree.
- The proxy loses its last Postgres write. Its only Postgres use is reading
  key metadata.
- Budget enforcement becomes a few seconds late. Accepted above.
- Studio (`studio.models`) still prices on its own and has the same stale
  prices plus a 2x billing multiplier. Out of scope here; converging it on
  gateway cost is a follow-up.

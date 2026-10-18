import { Hono } from "@hono/hono";
import type postgres from "postgres";
import { type AuthEnv, authMiddleware } from "../middleware/auth.ts";
import { adminSql, withUserContext } from "../config/db.ts";
import { ingestNow } from "../lib/usage-poller.ts";
import { extractCredential, verifyGatewayCredential } from "../lib/keys.ts";

// Usage ledger read API (ADR 0001 §9). All endpoints are RLS-scoped via
// withUserContext (usage_log_select: user_keys() — a user sees spend only for
// keys reachable through their teams). The ledger is keyed by key_id with
// lineage cols (parent_key_id, root_key_id) so spend rolls up to a service's
// whole subtree.

export const usage = new Hono<AuthEnv>();

usage.use("/usage", authMiddleware);
usage.use("/usage/*", authMiddleware);

// Per-day / per-key / per-model breakdown with filters.
usage.get("/usage", async (c) => {
  const user = c.get("user");
  const keyId = c.req.query("key_id");
  const model = c.req.query("model");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const rows = await withUserContext(user.id, (tx) =>
    tx<
      {
        day: string;
        key_id: string;
        model: string | null;
        cost_usd: string;
        tokens_in: number;
        tokens_out: number;
        request_count: number;
      }[]
    >`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             key_id,
             model,
             COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
             COALESCE(SUM(tokens_in), 0)::int AS tokens_in,
             COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
             COUNT(*)::int AS request_count
      FROM llm.usage_log
      WHERE 1=1
        ${keyId ? tx`AND key_id = ${keyId}::uuid` : tx``}
        ${model ? tx`AND model = ${model}` : tx``}
        ${from ? tx`AND created_at >= ${from}::timestamptz` : tx``}
        ${to ? tx`AND created_at < ${to}::timestamptz` : tx``}
      GROUP BY day, key_id, model
      ORDER BY day DESC, key_id, model
    `);
  return c.json({ usage: rows });
});

// Totals per key over a window (and overall if no window).
usage.get("/usage/totals", async (c) => {
  const user = c.get("user");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const rows = await withUserContext(user.id, (tx) =>
    tx<
      {
        key_id: string;
        cost_usd: string;
        tokens_in: number;
        tokens_out: number;
        request_count: number;
      }[]
    >`
      SELECT key_id,
             COALESCE(SUM(cost_usd), 0)::text AS cost_usd,
             COALESCE(SUM(tokens_in), 0)::int AS tokens_in,
             COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
             COUNT(*)::int AS request_count
      FROM llm.usage_log
      WHERE 1=1
        ${from ? tx`AND created_at >= ${from}::timestamptz` : tx``}
        ${to ? tx`AND created_at < ${to}::timestamptz` : tx``}
      GROUP BY key_id
      ORDER BY cost_usd DESC
    `);
  return c.json({ totals: rows });
});

// Distinct keys + models for filter UIs.
usage.get("/usage/facets", async (c) => {
  const user = c.get("user");
  const [keysRow, modelsRow] = await withUserContext(
    user.id,
    (tx) =>
      Promise.all([
        tx<{ key_id: string }[]>`
        SELECT DISTINCT key_id FROM llm.usage_log ORDER BY key_id
      `,
        tx<{ model: string }[]>`
        SELECT DISTINCT model FROM llm.usage_log
        WHERE model IS NOT NULL ORDER BY model
      `,
      ]),
  );
  return c.json({
    keys: keysRow.map((r) => r.key_id),
    models: modelsRow.map((r) => r.model),
  });
});

// --- Key-holder usage (ADR 0003 §5) ----------------------------------------
//
// GET /usage (mounted at the root, outside /api, like the proxy's) — the
// proxy's key-holder GET /usage contract, served from llm.usage_log with the
// cost the api priced at ingest. A key holder (the builder's per-build
// sub-key, any gateway key) reads its own rows with the credential it calls
// the proxy with, and gets the billed cost instead of the proxy's catalog
// estimate. Same auth, scope, cursor and response shape as the proxy
// (proxy/src/routes/usage.ts), so a reader switches by base URL:
//
//   GET /usage?since=<cursor>&limit=<n>&key_id=<id>&jti=<id>&name=<label>
//   Auth: x-api-key or Authorization: Bearer <gateway credential>
//     - top-level sk_live_ key: rows whose root_key_id is the key (its own
//       and every derived child's);
//     - derived sub-key JWT: only its own rows.
//   200: { rows, max_id, totals } as on the proxy. Rows add price_id and
//   provider_cost_currency and have no provider_slug (not stored). `id` is
//   the proxy's cross-machine cursor (cursorOf below), so a reader's `since`
//   means the same thing on both.
//
// Fresh by construction: before reading, the request waits for an ingest
// pass that started after it arrived (usage-poller ingestNow), so every row
// a proxy wrote before the request is in the answer. When a proxy machine
// could not be polled, or the pass took over INGEST_WAIT_MS ("timeout"), the
// answer may miss rows, and the response says so in X-Usage-Partial (the
// failed machines), as the proxy does for a sibling that does not answer. A
// reader that needs a final total retries until the header is gone.

const MAX_LIMIT = 5000;
const INGEST_WAIT_MS = 5000;
const CURSOR_EPOCH_MS = Date.UTC(2026, 0, 1);

// Same as the proxy's cursorOf: ms since 2026-01-01 * 4096 + the UUIDv7
// counter. Orders rows by time across proxy machines.
export function cursorOf(usageId: string): number {
  const hex = usageId.replaceAll("-", "");
  const ms = parseInt(hex.slice(0, 12), 16);
  const counter = parseInt(hex.slice(13, 16), 16);
  return (ms - CURSOR_EPOCH_MS) * 4096 + counter;
}

// The smallest UUIDv7 whose cursor is >= `cursor` (the proxy's
// usageIdAtLeast, padded to a whole UUID so it compares as one).
function usageIdAtLeast(cursor: number): string {
  const ms = Math.floor(cursor / 4096) + CURSOR_EPOCH_MS;
  const counter = cursor % 4096;
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${
    counter.toString(16).padStart(3, "0")
  }-0000-000000000000`;
}

interface KeyUsageRow {
  id: number;
  usage_id: string;
  machine_id: string | null;
  key_id: string;
  jti: string;
  name: string;
  parent_key_id: string | null;
  root_key_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  provider_cost: number | null;
  provider_cost_currency: string | null;
  cost_usd: number | null;
  price_id: string | null;
  created_at: string;
}

export const keyUsage = new Hono();

keyUsage.get("/usage", async (c) => {
  const scope = await verifyGatewayCredential(
    extractCredential(c.req.raw.headers),
  );
  if (!scope) return c.json({ error: "unauthorized" }, 401);

  // Bounded: a proxy machine that hangs (pollOnce allows 30 s a page) must
  // not hold the read past a caller's timeout; the answer is then partial.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failed = await Promise.race([
    ingestNow(),
    new Promise<string[]>((r) => {
      timer = setTimeout(() => r(["timeout"]), INGEST_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (failed.length > 0) c.header("X-Usage-Partial", failed.join(","));

  const q = (name: string) => c.req.query(name) || undefined;
  const since = Math.max(0, Number(q("since") ?? 0) || 0);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(q("limit") ?? MAX_LIMIT) || MAX_LIMIT),
  );
  // key_id and jti are the same column (jti is the poll-contract alias).
  const keyIds = [q("key_id"), q("jti")].filter((v) => v !== undefined);
  const name = q("name");

  const select = (range: postgres.PendingQuery<postgres.Row[]>, n: number) =>
    adminSql<
      (Omit<KeyUsageRow, "id" | "cost_usd"> & { cost_usd: string | null })[]
    >`
      SELECT u.usage_id::text AS usage_id, u.machine_id,
             u.key_id::text AS key_id, u.key_id::text AS jti, k.label AS name,
             u.parent_key_id::text AS parent_key_id,
             u.root_key_id::text AS root_key_id, u.model,
             u.tokens_in AS input_tokens, u.tokens_out AS output_tokens,
             u.cache_read_tokens, u.cache_write_tokens,
             u.provider_cost::float8 AS provider_cost,
             u.provider_cost_currency, u.cost_usd::text AS cost_usd,
             u.price_id::text AS price_id,
             to_char(u.created_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        FROM llm.usage_log u
        JOIN llm.keys k ON k.id = u.key_id
       WHERE ${
      scope.key_type === "top"
        ? adminSql`u.root_key_id = ${scope.key_id}::uuid`
        : adminSql`u.key_id = ${scope.key_id}::uuid`
    }
         AND ${range}
         ${
      keyIds.length > 0
        ? adminSql`AND u.key_id::text = ALL(${keyIds}::text[])`
        : adminSql``
    }
         ${name ? adminSql`AND k.label = ${name}` : adminSql``}
       ORDER BY u.usage_id
       LIMIT ${n}
    `;

  let rows: Awaited<ReturnType<typeof select>>[number][] = await select(
    adminSql`u.usage_id >= ${usageIdAtLeast(since + 1)}::uuid`,
    limit,
  );
  // Rows sharing the last row's cursor (same ms and counter, different proxy
  // machines) stay in the page: a next page from `since` = that id would
  // skip them.
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    const tail = await select(
      adminSql`u.usage_id > ${last.usage_id}::uuid
           AND u.usage_id < ${
        usageIdAtLeast(cursorOf(last.usage_id) + 1)
      }::uuid`,
      MAX_LIMIT,
    );
    rows = rows.concat(tail);
  }

  const out: KeyUsageRow[] = rows.map((r) => ({
    ...r,
    id: cursorOf(r.usage_id),
    cost_usd: r.cost_usd === null ? null : Number(r.cost_usd),
  }));
  const totals = {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
  };
  for (const r of out) {
    totals.requests += 1;
    totals.input_tokens += r.input_tokens;
    totals.output_tokens += r.output_tokens;
    totals.cache_read_tokens += r.cache_read_tokens;
    totals.cache_write_tokens += r.cache_write_tokens;
    if (r.cost_usd !== null) totals.cost_usd += r.cost_usd;
  }
  return c.json({
    rows: out,
    max_id: out.length > 0 ? out[out.length - 1].id : null,
    totals,
  });
});

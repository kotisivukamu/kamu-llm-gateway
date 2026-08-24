import { Hono } from "@hono/hono";
import { type AuthEnv, authMiddleware } from "../middleware/auth.ts";
import { withUserContext } from "../config/db.ts";

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

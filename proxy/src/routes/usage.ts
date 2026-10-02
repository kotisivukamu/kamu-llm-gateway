// SATELLITE SIDE — stays on the proxy satellite forever.
//
// Exposes the local SQLite usage_log so the control plane (the gateway api's
// poller) can pull completed-request rows into durable storage. The satellite
// itself is stateless beyond this local buffer: the file is destroyed on
// deploy/restart, which is exactly why the control plane polls it.
//
// CONTRACT — the JSON shape returned by GET /usage is the public API between
// the satellite and the control plane. It is duplicated as a TypeScript
// interface on both sides on purpose (they ship in different container images
// and must not share an import). If you change it here, change the mirror in
// the gateway api's poller contract in the same release.
//
//   GET /usage?since=<id>&limit=<n>&key_id=<id>&jti=<id>&name=<label>
//   Auth: Authorization: Bearer <CONTROL_PLANE_POLL_TOKEN>
//         (a shared internal service-to-service secret — NOT a user credential.
//          The legacy HMAC-JWT path is retired; there is no SESSION_JWT_SECRET.)
//         Sees every row.
//     OR  a gateway credential (x-api-key or Authorization: Bearer), verified
//         exactly like the /llm routes (auth.ts verifyCredential):
//           - top-level `sk_live_` key: rows whose root_key_id = its own id,
//             i.e. its own rows and every derived sub-key's rows;
//           - derived sub-key JWT: only rows whose key_id = its own id.
//         This lets a key holder (the builder's per-job key, studio's key)
//         read its own spend in near real time. Filters only ever narrow
//         this scope, never widen it.
//   Response 200:
//     {
//       "rows": [
//         {
//           "id": number,            // monotonic PK, the poller's cursor
//           "key_id": string,        // the gateway row PK (ADR 0001 §8)
//           "jti": string,           // alias = key_id (poll-contract parity)
//           "name": string,          // human label set at mint time
//           "parent_key_id": string | null,  // lineage (ADR 0001 §7.6)
//           "root_key_id": string | null,
//           "model": string,
//           "input_tokens": number,
//           "output_tokens": number,
//           "cache_read_tokens": number,
//           "cache_write_tokens": number,
//           "cost_usd": number | null,
//           "created_at": string     // ISO 8601 UTC
//         }
//       ],
//       "max_id": number | null,     // highest id in this page, null if empty
//       "totals": {                  // summed over the returned `rows` only
//         "requests": number,
//         "input_tokens": number,
//         "output_tokens": number,
//         "cache_read_tokens": number,
//         "cache_write_tokens": number,
//         "cost_usd": number         // sums non-null cost_usd rows only
//       }
//     }
//
// `since` defaults to 0 (all rows). `limit` defaults to 5000, capped at 5000.
// `key_id`, `jti` (alias of key_id — same column) and `name` are optional
// equality filters, combinable with each other and with `since`/`limit`.
// Rows are returned ascending by id so the poller can stream through the
// whole backlog in a loop using max_id as the next `since`.

import { Hono } from "@hono/hono";
import { env } from "../env.ts";
import { db } from "../db.ts";
import { extractCredential, verifyCredential } from "../auth.ts";

export const usage = new Hono();

usage.all("/", async (c) => {
  // Two callers. The control-plane poller presents the service-to-service
  // secret and sees everything. A key holder presents its own gateway
  // credential and sees only its own subtree (top-level key) or itself
  // (derived key). The data is not secret (key labels + token counts +
  // estimated cost, no payloads), but it does not go out unauthenticated.
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();

  const url = new URL(c.req.url);
  const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 5000) || 5000;
  const limit = Math.min(5000, Math.max(1, requestedLimit));

  const conditions = ["id > ?"];
  const params: Array<string | number> = [since];

  if (!presented || presented !== env.CONTROL_PLANE_POLL_TOKEN) {
    const cred = await verifyCredential(extractCredential(c.req.raw.headers));
    if (!cred) return c.json({ error: "unauthorized" }, 401);
    // A top-level key's root_key_id is its own id (set at mint), so this is
    // its own rows plus every derived child's. A derived key cannot derive
    // (depth 1), so it only ever sees its own rows.
    if (cred.key_type === "top") {
      conditions.push("root_key_id = ?");
    } else {
      conditions.push("key_id = ?");
    }
    params.push(cred.key_id);
  }

  // key_id and jti are the same column (jti is the poll-contract alias).
  for (const param of ["key_id", "jti"]) {
    const v = url.searchParams.get(param);
    if (v) {
      conditions.push("key_id = ?");
      params.push(v);
    }
  }
  const name = url.searchParams.get("name");
  if (name) {
    conditions.push("name = ?");
    params.push(name);
  }
  params.push(limit);

  const rows = db()
    .prepare(
      `SELECT id, key_id, jti, name, parent_key_id, root_key_id, model,
              input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens,
              cost_usd, created_at
         FROM usage_log
        WHERE ${conditions.join(" AND ")}
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(...params) as Array<{
      id: number;
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
      cost_usd: number | null;
      // SQLite datetime('now') is a naive string; tag it as UTC ISO.
      created_at: string;
    }>;

  const max_id = rows.length > 0 ? rows[rows.length - 1].id : null;

  // Summed over the returned page only (not the whole filtered set beyond
  // `limit`) — same scope the caller sees in `rows`, so the two never drift.
  const totals = {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
  };
  for (const r of rows) {
    totals.requests += 1;
    totals.input_tokens += r.input_tokens;
    totals.output_tokens += r.output_tokens;
    totals.cache_read_tokens += r.cache_read_tokens;
    totals.cache_write_tokens += r.cache_write_tokens;
    if (r.cost_usd !== null) totals.cost_usd += r.cost_usd;
  }

  return c.json({
    rows: rows.map((r) => ({
      ...r,
      // usage_log.created_at is `datetime('now')` → "YYYY-MM-DD HH:MM:SS".
      // Treat as UTC and emit ISO 8601 with a Z so the control plane stores
      // a real timestamptz without a timezone-interpretation footgun.
      created_at: `${r.created_at.replace(" ", "T")}Z`,
    })),
    max_id,
    totals,
  });
});

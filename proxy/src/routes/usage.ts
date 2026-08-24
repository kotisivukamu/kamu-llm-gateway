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
//   GET /usage?since=<id>&limit=<n>
//   Auth: Authorization: Bearer <CONTROL_PLANE_POLL_TOKEN>
//         (a shared internal service-to-service secret — NOT a user credential.
//          The legacy HMAC-JWT path is retired; there is no SESSION_JWT_SECRET.)
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
//       "max_id": number | null      // highest id in this page, null if empty
//     }
//
// `since` defaults to 0 (all rows). `limit` defaults to 5000, capped at 5000.
// Rows are returned ascending by id so the poller can stream through the
// whole backlog in a loop using max_id as the next `since`.

import { Hono } from "@hono/hono";
import { env } from "../env.ts";
import { db } from "../db.ts";

export const usage = new Hono();

usage.all("/", (c) => {
  // Service-to-service secret, NOT a user credential. The poller presents it
  // as `Authorization: Bearer`. The data is not secret (key labels + token
  // counts + estimated cost, no payloads), but it does not go out
  // unauthenticated.
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();
  if (!presented || presented !== env.CONTROL_PLANE_POLL_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const url = new URL(c.req.url);
  const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
  const requestedLimit = Number(url.searchParams.get("limit") ?? 5000) || 5000;
  const limit = Math.min(5000, Math.max(1, requestedLimit));

  const rows = db()
    .prepare(
      `SELECT id, key_id, jti, name, parent_key_id, root_key_id, model,
              input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens,
              cost_usd, created_at
         FROM usage_log
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(since, limit) as Array<{
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

  return c.json({
    rows: rows.map((r) => ({
      ...r,
      // usage_log.created_at is `datetime('now')` → "YYYY-MM-DD HH:MM:SS".
      // Treat as UTC and emit ISO 8601 with a Z so the control plane stores
      // a real timestamptz without a timezone-interpretation footgun.
      created_at: `${r.created_at.replace(" ", "T")}Z`,
    })),
    max_id,
  });
});

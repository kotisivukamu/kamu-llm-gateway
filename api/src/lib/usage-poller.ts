// CONTROL-PLANE SIDE — polls the proxy satellite's local usage buffer into
// durable Postgres (ADR 0001 §8/§9).
//
// The proxy meters every request into a local SQLite usage_log that is wiped
// on every deploy (proxy/src/routes/usage.ts). This is the durable memory
// the satellite lacks: pull completed-request rows into llm.usage_log, keyed
// by key_id + the lineage columns (parent_key_id, root_key_id), so spend
// survives restarts and rolls up per subtree (§7.6).
//
// Adapted from the legacy graphile-worker task
// (kotisivukamu/worker/src/llm_usage/poll.ts) that did the same pull-and-
// insert against the pre-ADR SESSION_JWT_SECRET-token scheme. This repo has
// no graphile-worker (no job queue, no shared Postgres to host one) — a
// small Deno process running a setInterval loop is simpler and matches the
// "resource server, not a platform" shape of this service. The mechanism
// changes; the idempotency contract (id-keyed cursor, upsert-safe re-polls)
// is preserved.
//
// Idempotent by construction: rows are inserted with the satellite's row id
// as the conflict key (ON CONFLICT DO NOTHING), so re-polling after a partial
// run or a process restart inserts nothing twice. The cursor (last polled id)
// is kept in-memory and only advanced after a successful page insert, so a
// crash mid-page restarts from the same point on next boot (re-derives from
// MAX(id) already present, see `loadCursor`).

import { adminSql } from "../config/db.ts";
import { env } from "../env.ts";
import { log } from "./logger.ts";

const PAGE_LIMIT = 5000;

// Mirrors the satellite's GET /usage response contract (proxy/src/routes/usage.ts).
// Duplicated on purpose — the two sides ship in different container images and
// must not share an import. Keep in sync with the satellite if the shape changes.
interface UsageRow {
  id: number;
  key_id: string;
  parent_key_id: string | null;
  root_key_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  created_at: string;
}

interface UsageResponse {
  rows: UsageRow[];
  max_id: number | null;
}

// Resume from where the durable ledger already is, so a process restart
// doesn't re-fetch the whole backlog. `id` here is llm.usage_log's own
// BIGSERIAL PK, which we set explicitly from the satellite's row id on
// insert (see below) so the two ids stay aligned and MAX(id) is a valid
// cursor.
async function loadCursor(): Promise<number> {
  const [row] = await adminSql<{ max_id: number | null }[]>`
    SELECT MAX(id)::bigint AS max_id FROM llm.usage_log
  `;
  return row?.max_id ?? 0;
}

// Exported for tests only (see src/tests/usage-poller.test.ts): lets a test
// drive a single poll pass deterministically (mocked fetch, real Postgres)
// instead of racing the setInterval loop in startUsagePoller.
export async function pollOnce(since: number): Promise<number> {
  const base = env.LLM_PROXY_URL.replace(/\/$/, "");
  let cursor = since;
  let pages = 0;

  for (;;) {
    const res = await fetch(
      `${base}/usage?since=${cursor}&limit=${PAGE_LIMIT}`,
      {
        headers: { authorization: `Bearer ${env.CONTROL_PLANE_POLL_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) {
      log.error("usage_poll: satellite returned non-200", {
        status: res.status,
      });
      return cursor;
    }
    const page = (await res.json()) as UsageResponse;

    if (page.rows.length > 0) {
      // Bulk insert via jsonb_populate_recordset: one JSON parameter carries
      // the whole page. id is the satellite's own row id — explicit, not
      // generated — so the cursor (MAX(id)) stays aligned across restarts.
      // ON CONFLICT (id) DO NOTHING makes re-polling idempotent.
      //
      // Pass the page through sql.json() (postgres.js's jsonb Parameter
      // helper), NOT `JSON.stringify(...)` + `${…}::json`: postgres.js
      // JSON-encodes any plain JS value bound where the driver infers a
      // json/jsonb parameter, so handing it an already-stringified JSON
      // string double-encodes it into a JSON *string scalar* instead of an
      // array — `jsonb_populate_recordset` then fails with "cannot call
      // ... on a scalar". sql.json() sends the value with the jsonb OID
      // directly, so it round-trips as a real array.
      const rows = page.rows.map((r) => ({
        id: r.id,
        key_id: r.key_id,
        parent_key_id: r.parent_key_id,
        root_key_id: r.root_key_id,
        model: r.model,
        cost_usd: r.cost_usd,
        tokens_in: r.input_tokens,
        tokens_out: r.output_tokens,
        created_at: r.created_at,
      }));

      // Explicit column list on BOTH sides: llm.usage_log has 10 columns
      // (id, key_id, parent_key_id, root_key_id, model, cost_usd, tokens_in,
      // tokens_out, metadata, created_at). `SELECT *` from
      // jsonb_populate_recordset(null::llm.usage_log, …) yields all 10 in
      // table-declaration order, including `metadata`, which the satellite's
      // /usage contract doesn't carry (proxy/src/routes/usage.ts's UsageRow
      // has no metadata field to poll). Selecting `*` against a 9-column
      // INSERT list was an arity mismatch that made every poll fail and the
      // ledger stay empty. Naming the same 9 columns on both sides fixes the
      // arity without inventing metadata the satellite doesn't send; the
      // column defaults to NULL on insert, same as before this fix.
      //
      // Rows whose key no longer exists are skipped, not inserted: key_id is
      // a foreign key, so one such row would fail the whole page and the
      // cursor would never advance past it, stalling the ledger for every
      // key. A key is only hard-deleted when its team is (cascade), at which
      // point its spend has no one to attribute to.
      const result = await adminSql`
        INSERT INTO llm.usage_log
          (id, key_id, parent_key_id, root_key_id, model, cost_usd,
           tokens_in, tokens_out, created_at)
        SELECT r.id, r.key_id, r.parent_key_id, r.root_key_id, r.model,
               r.cost_usd, r.tokens_in, r.tokens_out, r.created_at
        FROM jsonb_populate_recordset(null::llm.usage_log, ${
        adminSql.json(rows)
      }) r
        WHERE EXISTS (SELECT 1 FROM llm.keys k WHERE k.id = r.key_id)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      const orphans = await adminSql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        FROM jsonb_to_recordset(${adminSql.json(rows)}) AS r(key_id uuid)
        WHERE NOT EXISTS (SELECT 1 FROM llm.keys k WHERE k.id = r.key_id)
      `;
      if (orphans[0].n > 0) {
        log.warn("usage_poll: skipped rows for deleted keys", {
          skipped: orphans[0].n,
          inserted: result.count,
        });
      }
    }

    if (page.max_id === null || page.max_id <= cursor) break;
    cursor = page.max_id;
    pages++;
    if (page.rows.length < PAGE_LIMIT) break;
  }

  if (pages > 0) {
    log.info("usage_poll: advanced cursor", { cursor, pages });
  }
  return cursor;
}

/**
 * Start the background usage poller: pulls the proxy satellite's local
 * usage buffer into llm.usage_log on a fixed interval, streaming through the
 * whole backlog each run (so a long outage catches up in one run, not one
 * page per tick — mirrors the legacy poller's loop). Returns a stop function.
 */
export async function startUsagePoller(): Promise<() => void> {
  let cursor = 0;
  let polling = false;

  try {
    cursor = await loadCursor();
    log.info("usage_poll: starting", { cursor });
  } catch (err) {
    log.error("usage_poll: failed to load cursor, starting from 0", {
      err: String(err),
    });
  }

  const timer = setInterval(async () => {
    // Skip overlapping runs if a previous poll is still in flight (a slow
    // upstream or a big backlog shouldn't stack concurrent polls).
    if (polling) return;
    polling = true;
    try {
      cursor = await pollOnce(cursor);
    } catch (err) {
      log.error("usage_poll: run failed", { err: String(err) });
    } finally {
      polling = false;
    }
  }, env.USAGE_POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}

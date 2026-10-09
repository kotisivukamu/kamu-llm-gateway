// CONTROL-PLANE SIDE — polls the proxy satellites' local usage buffers into
// durable Postgres (ADR 0001 §8/§9).
//
// Each proxy machine meters every request into its own SQLite usage_log, on
// its own volume (proxy/src/routes/usage.ts). This pulls completed-request
// rows into llm.usage_log, keyed by key_id + the lineage columns
// (parent_key_id, root_key_id), so spend rolls up per subtree (§7.6).
//
// More than one machine: every machine numbers its rows from 1, so a row is
// identified by (store_id, source_id), where store_id is the random id of the
// machine's SQLite file (proxy migration 0004) and source_id its row id there.
// When LLM_PROXY_URL is a Fly private name (*.internal), each tick resolves it
// to every running machine and polls each one directly; any other URL (local
// dev, tests) is polled as the single satellite. One cursor per store, kept in
// memory and re-derived from MAX(source_id) on boot.
//
// Idempotent by construction: ON CONFLICT (store_id, source_id) DO NOTHING,
// so re-polling after a partial run, a restart, or a second api machine
// polling the same store inserts nothing twice.
//
// Adapted from the legacy graphile-worker task
// (kotisivukamu/worker/src/llm_usage/poll.ts). This repo has no job queue, so
// a setInterval loop in the api process does the same job.

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
  store_id: string;
  max_id: number | null;
}

// Resume a store from where the durable ledger already is, so a restart
// doesn't re-fetch its whole backlog.
async function loadCursor(storeId: string): Promise<number> {
  const [row] = await adminSql<{ max_id: string | null }[]>`
    SELECT MAX(source_id)::text AS max_id FROM llm.usage_log
     WHERE store_id = ${storeId}
  `;
  return row?.max_id ? Number(row.max_id) : 0;
}

function fetchUsage(origin: string, since: number, limit: number) {
  return fetch(`${origin}/usage?since=${since}&limit=${limit}`, {
    headers: { authorization: `Bearer ${env.CONTROL_PLANE_POLL_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
}

// The proxy origins to poll this tick. A *.internal name resolves to one
// address per running machine; a machine that is down is skipped and caught
// up later from its volume.
async function satelliteOrigins(): Promise<string[]> {
  const url = new URL(env.LLM_PROXY_URL);
  if (!url.hostname.endsWith(".internal")) return [url.origin];
  const ips = await Deno.resolveDns(url.hostname, "AAAA");
  return ips.map((ip) => `${url.protocol}//[${ip}]:${url.port || "80"}`);
}

// Which store answers at an origin. One cheap request past any real id
// returns an empty page plus the store_id.
async function probeStore(origin: string): Promise<string> {
  const res = await fetchUsage(origin, Number.MAX_SAFE_INTEGER, 1);
  if (!res.ok) throw new Error(`${origin}/usage returned ${res.status}`);
  const { store_id } = (await res.json()) as UsageResponse;
  // A proxy older than migration 0004 sends none. Polling it would insert
  // rows with a NULL store_id, which the unique index cannot dedupe.
  if (!store_id) throw new Error(`${origin}/usage sent no store_id`);
  return store_id;
}

// Exported for tests only (see src/tests/usage-poller.test.ts): lets a test
// drive a single poll pass deterministically (mocked fetch, real Postgres)
// instead of racing the setInterval loop in startUsagePoller.
export async function pollOnce(
  origin: string,
  storeId: string,
  since: number,
): Promise<number> {
  let cursor = since;
  let pages = 0;

  for (;;) {
    const res = await fetchUsage(origin, cursor, PAGE_LIMIT);
    if (!res.ok) {
      log.error("usage_poll: satellite returned non-200", {
        origin,
        status: res.status,
      });
      return cursor;
    }
    const page = (await res.json()) as UsageResponse;
    // A different file now answers at this address (machine replaced).
    // Throwing makes the caller forget the mapping and re-probe next tick.
    if (page.store_id !== storeId) {
      throw new Error(
        `store at ${origin} changed from ${storeId} to ${page.store_id}`,
      );
    }

    if (page.rows.length > 0) {
      // Bulk insert via jsonb_populate_recordset: one JSON parameter carries
      // the whole page. The satellite's row id goes into source_id next to
      // its store_id; llm.usage_log.id is our own BIGSERIAL.
      // ON CONFLICT (store_id, source_id) DO NOTHING makes re-polling
      // idempotent.
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
        store_id: storeId,
        source_id: r.id,
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
          (store_id, source_id, key_id, parent_key_id, root_key_id, model,
           cost_usd, tokens_in, tokens_out, created_at)
        SELECT r.store_id, r.source_id, r.key_id, r.parent_key_id,
               r.root_key_id, r.model, r.cost_usd, r.tokens_in, r.tokens_out,
               r.created_at
        FROM jsonb_populate_recordset(null::llm.usage_log, ${
        adminSql.json(rows)
      }) r
        WHERE EXISTS (SELECT 1 FROM llm.keys k WHERE k.id = r.key_id)
        ON CONFLICT (store_id, source_id) DO NOTHING
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
    log.info("usage_poll: advanced cursor", {
      store_id: storeId,
      cursor,
      pages,
    });
  }
  return cursor;
}

// Per-process poll state: which store answers at each origin, and each
// store's cursor.
export interface PollState {
  storeAt: Map<string, string>;
  cursors: Map<string, number>;
}

// One tick: every running proxy machine, each from its own store's cursor.
// A failing machine is logged and skipped; the others still advance.
export async function pollAll(state: PollState): Promise<void> {
  for (const origin of await satelliteOrigins()) {
    try {
      let storeId = state.storeAt.get(origin);
      if (!storeId) {
        storeId = await probeStore(origin);
        state.storeAt.set(origin, storeId);
      }
      const since = state.cursors.get(storeId) ?? await loadCursor(storeId);
      state.cursors.set(storeId, await pollOnce(origin, storeId, since));
    } catch (err) {
      state.storeAt.delete(origin);
      log.error("usage_poll: satellite failed", { origin, err: String(err) });
    }
  }
}

/**
 * Start the background usage poller: pulls the proxy satellite's local
 * usage buffer into llm.usage_log on a fixed interval, streaming through the
 * whole backlog each run (so a long outage catches up in one run, not one
 * page per tick — mirrors the legacy poller's loop). Returns a stop function.
 */
export function startUsagePoller(): () => void {
  const state: PollState = { storeAt: new Map(), cursors: new Map() };
  let polling = false;
  log.info("usage_poll: starting", { satellite: env.LLM_PROXY_URL });

  const timer = setInterval(async () => {
    // Skip overlapping runs if a previous poll is still in flight (a slow
    // upstream or a big backlog shouldn't stack concurrent polls).
    if (polling) return;
    polling = true;
    try {
      await pollAll(state);
    } catch (err) {
      log.error("usage_poll: run failed", { err: String(err) });
    } finally {
      polling = false;
    }
  }, env.USAGE_POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}

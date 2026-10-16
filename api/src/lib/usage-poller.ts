// CONTROL-PLANE SIDE — polls the proxy machines' local usage buffers into
// durable Postgres (ADR 0001 §8/§9).
//
// Each proxy machine meters every request into its own SQLite usage_log, on
// its own volume (proxy/src/routes/usage.ts). This pulls completed-request
// rows into llm.usage_log, keyed by key_id + the lineage columns
// (parent_key_id, root_key_id), so spend rolls up per subtree (§7.6).
//
// Every row carries a usage_id (UUIDv7 the proxy assigns: unique across
// machines, ordered by time) and the machine_id that served it. usage_id is
// the dedupe key, so re-polling, a restart, or both api machines polling the
// same proxy machine never insert a row twice.
//
// When LLM_PROXY_URL is a Fly private name (<app>.internal), each tick reads
// the machine list from the `vms.<app>.internal` TXT record and polls every
// machine directly at <id>.vm.<app>.internal. For each one it asks for rows
// newer than the newest usage_id Postgres already has from that machine,
// minus a 10 s overlap so a row stamped just before a clock step is not
// skipped. Any other URL (local dev, tests) is polled as the single proxy.
//
// Every inserted row is priced here, once (ADR 0003 §2): see lib/pricing.ts
// for which price applies. The feed's own cost_usd (the proxy's catalog
// estimate for key holders) is ignored. The same transaction adds the new
// rows' cost to llm.key_spend for each row's key and root and flips keys that
// reached their budget to 'over_budget' (§4); this is the only place spend is
// charged (the proxy stopped writing it), and the proxy denies over_budget
// keys with 402. Only rows this poll actually inserted count, so a re-poll of
// the overlap never charges a row twice.
//
// Adapted from the legacy graphile-worker task
// (kotisivukamu/worker/src/llm_usage/poll.ts). This repo has no job queue, so
// a setInterval loop in the api process does the same job.

import type postgres from "postgres";
import { adminSql } from "../config/db.ts";
import { env } from "../env.ts";
import { log } from "./logger.ts";
import { priceTable, priceUsage } from "./pricing.ts";

const PAGE_LIMIT = 5000;
const OVERLAP_MS = 10_000;

// Mirrors the proxy's GET /usage response contract (proxy/src/routes/usage.ts).
// Duplicated on purpose: the wire shape is the contract, not a shared type.
// Keep in sync with the proxy if the shape changes. Only the fields the
// poller reads are listed: not the feed's cost_usd (the api prices), and not
// provider_slug (llm.usage_log has no column for it; the model names the
// route). provider_cost is the provider's raw figure (cortecs usage.cost);
// the proxy sends no provider_cost_currency yet, so it is stored as null.
interface UsageRow {
  usage_id: string;
  machine_id: string;
  key_id: string;
  parent_key_id: string | null;
  root_key_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  provider_cost?: number | null;
  provider_cost_currency?: string | null;
  created_at: string;
}

interface UsageResponse {
  rows: UsageRow[];
}

// A proxy to poll. machineId is null for a plain URL (dev, tests).
export interface Satellite {
  origin: string;
  machineId: string | null;
}

// The machines to poll this tick. The TXT record lists every machine of the
// app as "<id> <region>" pairs, comma separated.
async function satellites(): Promise<Satellite[]> {
  const url = new URL(env.LLM_PROXY_URL);
  if (!url.hostname.endsWith(".internal")) {
    return [{ origin: url.origin, machineId: null }];
  }
  const app = url.hostname.slice(0, -".internal".length);
  const records = await Deno.resolveDns(`vms.${app}.internal`, "TXT");
  return records.flat().join(",").split(",").filter(Boolean).map((entry) => {
    const machineId = entry.trim().split(" ")[0];
    return {
      origin: `${url.protocol}//${machineId}.vm.${app}.internal:${
        url.port || "80"
      }`,
      machineId,
    };
  });
}

// The newest usage_id already stored from this machine ("0" sorts before any
// UUID, so a new machine starts from its first row).
async function newestStored(machineId: string | null): Promise<string> {
  // ORDER BY + LIMIT rather than MAX(): Postgres 16 has no max(uuid), and
  // this walks usage_log_machine_usage_idx / usage_log_usage_id_idx.
  const [row] = machineId
    ? await adminSql<{ newest: string }[]>`
        SELECT usage_id::text AS newest FROM llm.usage_log
         WHERE machine_id = ${machineId} AND usage_id IS NOT NULL
         ORDER BY usage_id DESC LIMIT 1`
    : await adminSql<{ newest: string }[]>`
        SELECT usage_id::text AS newest FROM llm.usage_log
         WHERE usage_id IS NOT NULL
         ORDER BY usage_id DESC LIMIT 1`;
  return row?.newest ?? "0";
}

// The smallest UUIDv7 string for a moment OVERLAP_MS before `usageId`'s
// timestamp. UUIDv7 strings sort by time, so this re-reads the overlap.
function withOverlap(usageId: string): string {
  if (usageId === "0") return usageId;
  const ms = parseInt(usageId.replace("-", "").slice(0, 12), 16) - OVERLAP_MS;
  const hex = Math.max(0, ms).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-0000-0000-000000000000`;
}

// Exported for tests (src/tests/usage-poller.test.ts): one machine, all pages
// newer than `after`. Returns how many rows were inserted.
export async function pollOnce(
  origin: string,
  after: string,
): Promise<number> {
  let cursor = after;
  let inserted = 0;

  for (;;) {
    const res = await fetch(
      `${origin}/usage?after=${cursor}&limit=${PAGE_LIMIT}`,
      {
        headers: { authorization: `Bearer ${env.CONTROL_PLANE_POLL_TOKEN}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new Error(`${origin}/usage returned ${res.status}`);
    const page = (await res.json()) as UsageResponse;
    if (page.rows.length === 0) break;
    // A proxy from before usage_id ignores `after` and sends rows without
    // one; inserting those would add NULL-keyed duplicates on every tick.
    if (page.rows.some((r) => !r.usage_id)) {
      throw new Error(`${origin}/usage sent rows without usage_id`);
    }

    const prices = await priceTable();
    const rows = page.rows.map((r) => {
      const priced = priceUsage(prices, r.model, new Date(r.created_at), r);
      return {
        usage_id: r.usage_id,
        machine_id: r.machine_id,
        key_id: r.key_id,
        parent_key_id: r.parent_key_id,
        root_key_id: r.root_key_id,
        model: r.model,
        cost_usd: priced.cost_usd,
        price_id: priced.price_id,
        tokens_in: r.input_tokens,
        tokens_out: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        provider_cost: r.provider_cost ?? null,
        provider_cost_currency: r.provider_cost_currency ?? null,
        created_at: r.created_at,
      };
    });

    // Bulk insert via jsonb_populate_recordset: one JSON parameter carries
    // the whole page. Pass it through sql.json() (postgres.js's jsonb
    // Parameter helper), NOT `JSON.stringify(...)` + `${…}::json`:
    // postgres.js JSON-encodes any plain JS value bound where the driver
    // infers a json/jsonb parameter, so an already-stringified page
    // double-encodes into a JSON *string scalar* and
    // `jsonb_populate_recordset` fails with "cannot call ... on a scalar".
    inserted += await adminSql.begin(async (tx) => {
      // Explicit column list on both sides: populate_recordset yields the
      // table's full rowtype (including id and metadata, which the proxy
      // does not send), so `SELECT *` would not match the INSERT list.
      //
      // Rows whose key no longer exists are skipped, not inserted: key_id is
      // a foreign key, so one such row would fail the whole page and stall
      // the ledger for every key. A key is only hard-deleted when its team is
      // (cascade), at which point its spend has no one to attribute to.
      const ins = await tx<{ usage_id: string }[]>`
        INSERT INTO llm.usage_log
          (usage_id, machine_id, key_id, parent_key_id, root_key_id, model,
           cost_usd, price_id, tokens_in, tokens_out, cache_read_tokens,
           cache_write_tokens, provider_cost, provider_cost_currency,
           created_at)
        SELECT r.usage_id, r.machine_id, r.key_id, r.parent_key_id,
               r.root_key_id, r.model, r.cost_usd, r.price_id, r.tokens_in,
               r.tokens_out, r.cache_read_tokens, r.cache_write_tokens,
               r.provider_cost, r.provider_cost_currency, r.created_at
        FROM jsonb_populate_recordset(null::llm.usage_log, ${tx.json(rows)}) r
        WHERE EXISTS (SELECT 1 FROM llm.keys k WHERE k.id = r.key_id)
        ON CONFLICT (usage_id) DO NOTHING
        RETURNING usage_id::text
      `;
      if (ins.length > 0) {
        await chargeSpend(tx, ins.map((r) => r.usage_id));
      }
      return ins.length;
    });

    cursor = page.rows[page.rows.length - 1].usage_id;
    if (page.rows.length < PAGE_LIMIT) break;
  }

  if (inserted > 0) {
    log.info("usage_poll: inserted rows", { origin, inserted });
  }
  return inserted;
}

// Adds the cost of the just-inserted rows to llm.key_spend for each row's key
// and its root (once per row when the two are the same key, as on a
// top-level key's own rows), then sets every charged key that is now at or
// past its budget to 'over_budget'. Summed from the stored cost_usd so the
// ledger matches usage_log to the cent. Unpriced and zero-cost rows are not
// counted, which keeps request_count meaning "billed requests".
async function chargeSpend(
  tx: postgres.TransactionSql,
  usageIds: string[],
): Promise<void> {
  const charged = await tx<{ key_id: string }[]>`
    INSERT INTO llm.key_spend (key_id, spent_usd, request_count)
    SELECT t.key_id, SUM(u.cost_usd), COUNT(*)
      FROM llm.usage_log u
      CROSS JOIN LATERAL (
        SELECT DISTINCT k AS key_id FROM unnest(ARRAY[u.key_id, u.root_key_id]) k
         WHERE k IS NOT NULL
      ) t
     WHERE u.usage_id = ANY(${usageIds}::uuid[])
       AND u.cost_usd > 0
       AND EXISTS (SELECT 1 FROM llm.keys k WHERE k.id = t.key_id)
     GROUP BY t.key_id
    ON CONFLICT (key_id) DO UPDATE SET
      spent_usd     = llm.key_spend.spent_usd + excluded.spent_usd,
      request_count = llm.key_spend.request_count + excluded.request_count,
      updated_at    = now()
    RETURNING key_id::text
  `;
  if (charged.length === 0) return;
  const flipped = await tx<{ id: string }[]>`
    UPDATE llm.keys k
       SET status = 'over_budget', updated_at = now()
      FROM llm.key_spend s
     WHERE s.key_id = k.id
       AND k.id = ANY(${charged.map((r) => r.key_id)}::uuid[])
       AND k.status = 'active'
       AND k.budget_usd IS NOT NULL
       AND s.spent_usd >= k.budget_usd
    RETURNING k.id::text
  `;
  for (const { id } of flipped) {
    log.info("usage_poll: key over budget", { key_id: id });
  }
}

// One tick: every proxy machine. A failing machine is logged and skipped;
// the others still get polled, and it catches up from its volume later.
export async function pollAll(): Promise<void> {
  for (const s of await satellites()) {
    try {
      await pollOnce(s.origin, withOverlap(await newestStored(s.machineId)));
    } catch (err) {
      log.error("usage_poll: machine failed", {
        origin: s.origin,
        err: String(err),
      });
    }
  }
}

/**
 * Start the background usage poller: pulls every proxy machine's local usage
 * buffer into llm.usage_log on a fixed interval. Returns a stop function.
 */
export function startUsagePoller(): () => void {
  let polling = false;
  log.info("usage_poll: starting", { proxy: env.LLM_PROXY_URL });

  const timer = setInterval(async () => {
    // Skip overlapping runs if a previous poll is still in flight (a slow
    // upstream or a big backlog shouldn't stack concurrent polls).
    if (polling) return;
    polling = true;
    try {
      await pollAll();
    } catch (err) {
      log.error("usage_poll: run failed", { err: String(err) });
    } finally {
      polling = false;
    }
  }, env.USAGE_POLL_INTERVAL_MS);

  return () => clearInterval(timer);
}

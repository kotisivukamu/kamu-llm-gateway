// SQLite persistence for LLM usage accounting. Two tables:
//   - token_spend: running USD total per budgeted key, used to enforce spend
//     caps (uncapped keys never touch it). Keyed by `key_id` (ADR 0001 §8).
//   - usage_log: one row per completed request for EVERY key, storing the raw
//     token buckets + computed cost so spend can be aggregated per `key_id`
//     and per label. Carries the lineage columns (`parent_key_id`,
//     `root_key_id`) so the gateway's durable ledger can roll spend up to a
//     service's whole subtree (ADR 0001 §7.6).
//
// `jti` is kept as an alias = key_id for the poll contract (the control-plane
// poller still reads `jti`); the authority column is `key_id`.
//
// We use node:sqlite (built into Deno 2.x) rather than an FFI/WASM binding so
// there is no extra dependency, no --allow-ffi, and it works unchanged in the
// alpine Deno image. DatabaseSync is synchronous, which is fine: writes are
// single-statement and Deno's event loop serialises them between awaits.

import { DatabaseSync } from "node:sqlite";

const DEFAULT_DB_PATH = "llm-proxy.db";

let handle: DatabaseSync | null = null;

// Lazily opens (and migrates) the database on first use. Reads DB_PATH from the
// environment at call time so tests can point it at a temp file before the
// first query.
export function db(): DatabaseSync {
  if (handle) return handle;
  const path = Deno.env.get("DB_PATH") ?? DEFAULT_DB_PATH;
  const database = new DatabaseSync(path);
  // WAL keeps readers from blocking the single writer; busy_timeout absorbs the
  // rare concurrent-write contention without throwing.
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 5000;");
  runMigrations(database);
  handle = database;
  return handle;
}

// Applies every not-yet-applied .sql file in src/migrations, in filename order,
// recording each in a bookkeeping table. Files ship inside the image because
// they live under src/ (which the Dockerfile copies) and are resolved relative
// to this module.
function runMigrations(database: DatabaseSync): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     );`,
  );

  const dir = new URL("./migrations/", import.meta.url);
  const files = [...Deno.readDirSync(dir)]
    .filter((e) => e.isFile && e.name.endsWith(".sql"))
    .map((e) => e.name)
    .sort();

  const applied = new Set(
    (database.prepare("SELECT name FROM _migrations").all() as Array<
      { name: string }
    >).map((r) => r.name),
  );

  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = Deno.readTextFileSync(new URL(name, dir));
    database.exec(sql);
    database.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
    console.log(`[proxy] applied migration ${name}`);
  }
}

// Trivial round-trip for /health/deep. Opens (and on the very first call
// migrates) the database and reads a row back, so it proves the file is
// present and writable, not just that the process is alive. Throws on failure.
export function probe(): void {
  db().prepare("SELECT 1 AS ok").get();
}

// Cumulative USD already spent by a key. 0 when the key has no ledger row yet
// (i.e. it has never completed a metered request). Keyed by `key_id` (the
// gateway row PK — ADR 0001 §8); `jti` is the legacy alias kept in the column.
export function getSpentUsd(key_id: string): number {
  const row = db()
    .prepare("SELECT spent_usd FROM token_spend WHERE key_id = ?")
    .get(key_id) as { spent_usd: number } | undefined;
  return row?.spent_usd ?? 0;
}

// Adds one request's cost to a key's running total, creating the ledger row on
// first use. No-op for non-positive costs (e.g. a response we couldn't price),
// which keeps request_count meaningful as "number of billed requests". Carries
// the lineage columns so the gateway's durable ledger can roll spend up to a
// service's whole subtree without a join (ADR 0001 §7.6).
export function recordSpend(
  key_id: string,
  name: string,
  budgetUsd: number,
  costUsd: number,
  parent_key_id: string | null,
  root_key_id: string | null,
): void {
  if (!(costUsd > 0)) return;
  db()
    .prepare(
      `INSERT INTO token_spend
         (key_id, jti, name, budget_usd, spent_usd, request_count,
          parent_key_id, root_key_id)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(key_id) DO UPDATE SET
         spent_usd     = spent_usd + excluded.spent_usd,
         request_count = request_count + 1,
         updated_at    = datetime('now')`,
    )
    .run(key_id, key_id, name, budgetUsd, costUsd, parent_key_id, root_key_id);
}

// One completed upstream request's usage. cost_usd is null when the model had
// no catalog price — token counts are still recorded so the gap is visible.
export interface UsageRecord {
  key_id: string;
  // jti is kept as an alias = key_id for the poll contract.
  name: string;
  parent_key_id: string | null;
  root_key_id: string | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
}

// Appends one row to the usage log. Called from the background metering tee
// for every request whose response carried a usage block, budgeted or not.
export function recordUsage(r: UsageRecord): void {
  db()
    .prepare(
      `INSERT INTO usage_log
         (key_id, jti, name, parent_key_id, root_key_id,
          model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.key_id,
      r.key_id,
      r.name,
      r.parent_key_id,
      r.root_key_id,
      r.model,
      r.input_tokens,
      r.output_tokens,
      r.cache_read_tokens,
      r.cache_write_tokens,
      r.cost_usd,
    );
}

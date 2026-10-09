// SQLite persistence for LLM usage accounting, one file per proxy machine on
// that machine's volume:
//   - usage_log: one row per completed request for EVERY key, storing the raw
//     token buckets + computed cost so spend can be aggregated per `key_id`
//     and per label. Carries the lineage columns (`parent_key_id`,
//     `root_key_id`) so the gateway's durable ledger can roll spend up to a
//     service's whole subtree (ADR 0001 §7.6). Each row carries a usage_id
//     (UUIDv7, unique across machines and time-ordered) and the machine_id
//     that served it; the api's poller copies rows into Postgres
//     (llm.usage_log) keyed by usage_id.
//   - token_spend: the pre-2026-10 per-key spend ledger. No longer read or
//     written: with more than one machine a local total only saw that
//     machine's share, so budgets now live in Postgres (llm.key_spend, see
//     gateway-db.ts). Left in place rather than dropped.
//
// `jti` is kept as an alias = key_id for the poll contract (the control-plane
// poller still reads `jti`); the authority column is `key_id`.
//
// We use node:sqlite (built into Deno 2.x) rather than an FFI/WASM binding so
// there is no extra dependency, no --allow-ffi, and it works unchanged in the
// alpine Deno image. DatabaseSync is synchronous, which is fine: writes are
// single-statement and Deno's event loop serialises them between awaits.

import { DatabaseSync, type StatementSync } from "node:sqlite";

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

// Prepared statements, memoised by SQL text. Preparing per call leaked: each
// StatementSync holds native SQLite memory that V8 does not see, so with a
// small JS heap the GC almost never ran to finalize them. The api's usage
// poller hits /usage every 2 s, and RSS grew ~7 KB per call until the 256 MB
// machine was OOM-killed every ~7 h (2026-10-08 23:50, 2026-10-09 07:00).
// The SQL set is small and fixed (/usage varies only by which filters are
// present), so the cache stays bounded.
const statements = new Map<string, StatementSync>();

export function stmt(sql: string): StatementSync {
  let s = statements.get(sql);
  if (!s) {
    s = db().prepare(sql);
    statements.set(sql, s);
  }
  return s;
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
  stmt("SELECT 1 AS ok").get();
}

// The Fly machine this process runs on; "local" outside Fly.
const MACHINE_ID = Deno.env.get("FLY_MACHINE_ID") ?? "local";

// UUIDv7: 48-bit Unix ms timestamp, a 12-bit counter, then random bits.
// Sorts by time as a string, which is how the poller pages a machine
// (`usage_id > ?`). The counter keeps ids from this process strictly
// increasing even within one millisecond (RFC 9562 §6.2 method 1), so a page
// boundary never falls between two rows of the same ms in the wrong order.
let lastMs = 0;
let seq = 0;

export function uuidv7(now = Date.now()): string {
  let ms = now;
  if (ms <= lastMs) {
    ms = lastMs;
    seq++;
    if (seq > 0xfff) {
      ms++;
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastMs = ms;

  const b = crypto.getRandomValues(new Uint8Array(16));
  let ts = ms;
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  b[6] = 0x70 | (seq >> 8); // version 7 + counter high bits
  b[7] = seq & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 9562 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${
    h.slice(16, 20)
  }-${h.slice(20)}`;
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
  stmt(
    `INSERT INTO usage_log
         (usage_id, machine_id, key_id, jti, name, parent_key_id, root_key_id,
          model, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv7(),
    MACHINE_ID,
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

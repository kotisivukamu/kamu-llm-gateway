// SATELLITE SIDE — stays on the proxy satellite forever.
//
// Exposes the local SQLite usage_log so the control plane (the gateway api's
// poller) can pull completed-request rows into durable storage, and so a key
// holder can read its own spend. Every proxy machine has its own file on its
// own volume. Rows carry a usage_id (UUIDv7, unique across machines,
// time-ordered) and the machine_id that served them.
//
// Two readers, two views:
//   - The poller (CONTROL_PLANE_POLL_TOKEN) reads ONE machine: it polls every
//     machine itself (vms.<app>.internal) and asks each for rows `after` the
//     newest usage_id it has. This path never fans out, so no row is read twice.
//   - A key holder reads through whichever machine Fly routes it to, but its
//     calls may have been served by any machine. That machine answers from its
//     own file and asks every sibling over 6PN (GET /usage/local, below), then
//     merges. A sibling that does not answer within 2 s is left out, logged,
//     and named in the X-Usage-Partial response header.
//
// CONTRACT — the JSON shape returned by GET /usage is the public API between
// the satellite and the control plane. It is duplicated as a TypeScript
// interface on both sides on purpose (they ship in different container images
// and must not share an import). If you change it here, change the mirror in
// the gateway api's poller contract in the same release.
//
//   GET /usage?since=<id>&after=<usage_id>&limit=<n>&key_id=<id>&jti=<id>&name=<label>
//   Auth: Authorization: Bearer <CONTROL_PLANE_POLL_TOKEN>
//         (a shared internal service-to-service secret — NOT a user credential.
//          The legacy HMAC-JWT path is retired; there is no SESSION_JWT_SECRET.)
//         Sees every row of THIS machine.
//     OR  a gateway credential (x-api-key or Authorization: Bearer), verified
//         exactly like the /llm routes (auth.ts verifyCredential):
//           - top-level `sk_live_` key: rows whose root_key_id = its own id,
//             i.e. its own rows and every derived sub-key's rows;
//           - derived sub-key JWT: only rows whose key_id = its own id.
//         Sees those rows on EVERY machine. This lets a key holder read its
//         own usage in near real time. Filters only ever narrow this scope,
//         never widen it. Cost readers use the api's GET /usage instead (same
//         contract, ingest-priced cost; ADR 0003 §5): cost_usd here is only
//         the catalog estimate.
//   Response 200:
//     {
//       "rows": [
//         {
//           "id": number,            // the paging cursor (`since`), see below
//           "usage_id": string | null, // UUIDv7, unique everywhere (poller's
//                                    //  key; null on rows from before 0005)
//           "machine_id": string | null, // Fly machine that served the call
//           "key_id": string,        // the gateway row PK (ADR 0001 §8)
//           "jti": string,           // alias = key_id (poll-contract parity)
//           "name": string,          // human label set at mint time
//           "parent_key_id": string | null,  // lineage (ADR 0001 §7.6)
//           "root_key_id": string | null,
//           "model": string,
//           "provider_slug": string | null, // upstream that served it (null
//                                    //  on rows from before 0006)
//           "input_tokens": number,  // uncached prompt tokens
//           "output_tokens": number,
//           "cache_read_tokens": number,
//           "cache_write_tokens": number,
//           "provider_cost": number | null, // provider-reported, raw (cortecs
//                                    //  usage.cost; unit undocumented, so
//                                    //  no provider_cost_currency is sent)
//           "cost_usd": number | null, // catalog estimate for key holders;
//                                    //  the api re-prices and bills (ADR 0003)
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
// `id` and `since`:
//   - poll token: `id` is this machine's SQLite row id. `after` returns rows
//     with usage_id > after, ordered by usage_id; without it rows come ordered
//     by id from `since`.
//   - key holder: a row id only means something on one machine, so `id` is a
//     number derived from usage_id instead (cursorOf: milliseconds since
//     2026-01-01 * 4096 + the UUIDv7 counter). It orders rows by time across
//     machines, and clients use it exactly as before: pass max_id back as
//     `since`. Rows from before usage_id existed (NULL usage_id) are not in
//     this view. A page stops at the lowest point every answering machine has
//     fully written (db.ts usageFloor), so a later read never finds a row
//     below a cursor it already handed out.
// `since` defaults to 0 (all rows). `limit` defaults to 5000, capped at 5000;
// a merged page can exceed it by rows that share the last row's id (one per
// machine at most), so the next `since` never splits them.
// `key_id`, `jti` (alias of key_id — same column) and `name` are optional
// equality filters, combinable with each other and with `since`/`limit`.
// Rows are returned ascending by id so a client can stream through the whole
// backlog in a loop using max_id as the next `since`.
//
//   GET /usage/local — internal, sibling-to-sibling only. Poll token auth.
//   Same `since`/`limit`/filter params as a key-holder read plus the caller's
//   scope (`scope_root=<id>` or `scope_key=<id>`); answers from this machine
//   only (never fans out) with { rows, floor } where `floor` is this
//   machine's usageFloor as a cursor.

import { Hono } from "@hono/hono";
import { env } from "../env.ts";
import { stmt, usageFloor } from "../db.ts";
import { extractCredential, verifyCredential } from "../auth.ts";

export const usage = new Hono();

const MAX_LIMIT = 5000;
const SIBLING_TIMEOUT_MS = 2000;
const CURSOR_EPOCH_MS = Date.UTC(2026, 0, 1);

interface UsageRow {
  id: number;
  usage_id: string | null;
  machine_id: string | null;
  key_id: string;
  jti: string;
  name: string;
  parent_key_id: string | null;
  root_key_id: string | null;
  model: string;
  provider_slug: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  provider_cost: number | null;
  cost_usd: number | null;
  created_at: string;
}

// What GET /usage/local answers with.
interface LocalPage {
  rows: UsageRow[];
  floor: number;
}

// The cursor for a UUIDv7: ms since CURSOR_EPOCH_MS, times 4096, plus the
// 12-bit counter. Fits a JS safe integer until ~2095.
export function cursorOf(usageId: string): number {
  const hex = usageId.replaceAll("-", "");
  const ms = parseInt(hex.slice(0, 12), 16);
  const counter = parseInt(hex.slice(13, 16), 16);
  return (ms - CURSOR_EPOCH_MS) * 4096 + counter;
}

// The smallest usage_id string whose cursor is >= `cursor`: the timestamp and
// version+counter groups. Any id with a larger cursor sorts after it as a
// string; any id with a smaller one sorts before.
function usageIdAtLeast(cursor: number): string {
  const ms = Math.floor(cursor / 4096) + CURSOR_EPOCH_MS;
  const counter = cursor % 4096;
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${
    counter.toString(16).padStart(3, "0")
  }`;
}

function intParam(url: URL, name: string, fallback: number): number {
  return Number(url.searchParams.get(name) ?? fallback) || fallback;
}

function limitOf(url: URL): number {
  return Math.min(MAX_LIMIT, Math.max(1, intParam(url, "limit", MAX_LIMIT)));
}

// key_id/jti/name: equality filters, appended to whatever scope is there.
function addFilters(
  url: URL,
  conditions: string[],
  params: Array<string | number>,
) {
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
}

function select(
  conditions: string[],
  params: Array<string | number>,
  orderBy: string,
  limit: number,
): UsageRow[] {
  const rows = stmt(
    `SELECT id, usage_id, machine_id, key_id, jti, name, parent_key_id, root_key_id, model,
              provider_slug, input_tokens, output_tokens,
              cache_read_tokens, cache_write_tokens,
              provider_cost,
              cost_usd, created_at
         FROM usage_log
        WHERE ${conditions.join(" AND ")}
        ORDER BY ${orderBy} ASC
        LIMIT ?`,
  ).all(...params, limit) as unknown as UsageRow[];
  return rows.map((r) => ({
    ...r,
    // usage_log.created_at is `datetime('now')` → "YYYY-MM-DD HH:MM:SS".
    // Treat as UTC and emit ISO 8601 with a Z so the control plane stores
    // a real timestamptz without a timezone-interpretation footgun.
    created_at: `${r.created_at.replace(" ", "T")}Z`,
  }));
}

// Rows, max_id and totals. Totals are summed over the returned page only (not
// the whole filtered set beyond `limit`) — same scope the caller sees in
// `rows`, so the two never drift.
function page(rows: UsageRow[]) {
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
  return {
    rows,
    max_id: rows.length > 0 ? rows[rows.length - 1].id : null,
    totals,
  };
}

// The scope a key holder's credential allows: a top-level key's root_key_id
// is its own id (set at mint), so `root` is its own rows plus every derived
// child's. A derived key cannot derive (depth 1), so `key` is only itself.
type Scope = { root: string } | { key: string };

// This machine's share of a key-holder read, with `id` as the cross-machine
// cursor. The floor is taken first: every row under it is already written.
function localPage(scope: Scope, url: URL): LocalPage {
  const f = usageFloor();
  const floor = (f.ms - CURSOR_EPOCH_MS) * 4096 + f.seq;
  const since = Math.max(0, intParam(url, "since", 0));
  const conditions = [
    "usage_id >= ?",
    "root" in scope ? "root_key_id = ?" : "key_id = ?",
  ];
  const params: Array<string | number> = [
    usageIdAtLeast(since + 1),
    "root" in scope ? scope.root : scope.key,
  ];
  // `after` (a usage_id) is the poller's cursor, but narrowing by it is
  // harmless for a key holder too.
  const after = url.searchParams.get("after");
  if (after) {
    conditions.push("usage_id > ?");
    params.push(after);
  }
  addFilters(url, conditions, params);
  const rows = select(conditions, params, "usage_id", limitOf(url))
    .map((r) => ({ ...r, id: cursorOf(r.usage_id!) }));
  return { rows, floor };
}

// The other machines of this Fly app, as 6PN origins. Outside Fly (local
// dev, tests) there are none. Replaceable for tests.
export const siblings = {
  discover: async (): Promise<string[]> => {
    const app = Deno.env.get("FLY_APP_NAME");
    const self = Deno.env.get("FLY_MACHINE_ID");
    if (!app) return [];
    // "<id> <region>" pairs, comma separated (same record as the api poller).
    const records = await Deno.resolveDns(`vms.${app}.internal`, "TXT");
    return records.flat().join(",").split(",").map((e) => e.trim())
      .filter(Boolean).map((e) => e.split(" ")[0])
      .filter((id) => id !== self)
      .map((id) => `http://${id}.vm.${app}.internal:${env.PORT}`);
  },
};

async function fetchSibling(origin: string, query: URLSearchParams) {
  const res = await fetch(`${origin}/usage/local?${query}`, {
    headers: { authorization: `Bearer ${env.CONTROL_PLANE_POLL_TOKEN}` },
    signal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as LocalPage;
}

// A key holder's read across all machines.
async function mergedPage(scope: Scope, url: URL) {
  const query = new URLSearchParams(url.searchParams);
  query.delete("scope_root");
  query.delete("scope_key");
  if ("root" in scope) query.set("scope_root", scope.root);
  else query.set("scope_key", scope.key);

  const answers = [localPage(scope, url)];
  const missing: string[] = [];
  let origins: string[] = [];
  try {
    origins = await siblings.discover();
  } catch (err) {
    console.warn(`[usage] sibling discovery failed: ${err}`);
    missing.push("discovery");
  }
  const results = await Promise.allSettled(
    origins.map((o) => fetchSibling(o, query)),
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled") return answers.push(r.value);
    console.warn(`[usage] sibling ${origins[i]} unavailable: ${r.reason}`);
    missing.push(new URL(origins[i]).hostname.split(".")[0]);
  });

  // Only rows under every answering machine's floor: above it a machine may
  // still write a row that sorts before ones we would hand out now. A row
  // reported twice counts once (first copy wins; this machine's comes first).
  const floor = Math.min(...answers.map((a) => a.floor));
  const byUsageId = new Map<string, UsageRow>();
  for (const a of answers) {
    for (const r of a.rows) {
      if (r.id < floor && !byUsageId.has(r.usage_id!)) {
        byUsageId.set(r.usage_id!, r);
      }
    }
  }
  const rows = [...byUsageId.values()].sort((a, b) =>
    a.id - b.id || (a.usage_id! < b.usage_id! ? -1 : 1)
  );

  // Each machine sent at most `limit` rows, so the first `limit` merged rows
  // are complete. Rows sharing the last one's id stay in: a next page from
  // `since` = that id would skip them.
  const limit = limitOf(url);
  let end = Math.min(limit, rows.length);
  while (end < rows.length && rows[end].id === rows[end - 1].id) end++;
  return { body: page(rows.slice(0, end)), missing };
}

usage.get("/local", (c) => {
  const presented = (c.req.header("authorization") ?? "")
    .replace(/^Bearer\s+/i, "").trim();
  if (presented !== env.CONTROL_PLANE_POLL_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const url = new URL(c.req.url);
  const root = url.searchParams.get("scope_root");
  const key = url.searchParams.get("scope_key");
  if (!root === !key) {
    return c.json({ error: "exactly one of scope_root, scope_key" }, 400);
  }
  return c.json(localPage(root ? { root } : { key: key! }, url));
});

usage.all("/", async (c) => {
  // Two callers. The control-plane poller presents the service-to-service
  // secret and sees everything on this machine. A key holder presents its own
  // gateway credential and sees only its own subtree (top-level key) or itself
  // (derived key), on every machine. The data is not secret (key labels +
  // token counts + estimated cost, no payloads), but it does not go out
  // unauthenticated.
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.replace(/^Bearer\s+/i, "").trim();
  const url = new URL(c.req.url);

  if (!presented || presented !== env.CONTROL_PLANE_POLL_TOKEN) {
    const cred = await verifyCredential(extractCredential(c.req.raw.headers));
    if (!cred) return c.json({ error: "unauthorized" }, 401);
    const { body, missing } = await mergedPage(
      cred.key_type === "top" ? { root: cred.key_id } : { key: cred.key_id },
      url,
    );
    if (missing.length > 0) c.header("X-Usage-Partial", missing.join(","));
    return c.json(body);
  }

  // The poller pages by usage_id; without `after`, by this machine's row id.
  const after = url.searchParams.get("after");
  const since = Math.max(0, intParam(url, "since", 0));
  const conditions = [after ? "usage_id > ?" : "id > ?"];
  const params: Array<string | number> = [after ?? since];
  addFilters(url, conditions, params);
  return c.json(
    page(select(conditions, params, after ? "usage_id" : "id", limitOf(url))),
  );
});

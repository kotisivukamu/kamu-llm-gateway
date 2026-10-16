import { Hono } from "@hono/hono";
import type { PriceTable } from "@shared/pricing.ts";
import { requireSession, type SessionEnv } from "../middleware/session.ts";
import { adminSql } from "../config/db.ts";
import { Layout } from "../views/layout.tsx";
import { MODELS } from "../../../proxy/src/catalog.ts";
import {
  type Effective,
  effectivePrice,
  type FullRates,
  parsePriceForm,
  type StoredPrice,
} from "@shared/prices.ts";

// Prices (ADR 0003 §3). llm.model_prices is append-only: this page adds rows
// and never edits or deletes one (the table's grants forbid it for
// app_user/admin_role anyway). The "current" column is what ingest charges for
// a request made now: the same pickPrice the api poller uses, else the code
// catalog. The api caches the table for 30 s, so a new row reaches ingest
// within that.

export const pricesRoutes = new Hono<SessionEnv>();
pricesRoutes.use("/prices", requireSession);

async function loadTable(): Promise<PriceTable<StoredPrice>> {
  const rows = await adminSql<
    {
      id: string;
      model: string;
      input: string;
      output: string;
      cache_read: string;
      cache_write: string;
      per_request: string;
      valid_from: Date;
      source: string;
      note: string | null;
      created_by: string | null;
      created_at: Date;
    }[]
  >`
    SELECT id::text, model,
           input_cost_per_mtok_usd       AS input,
           output_cost_per_mtok_usd      AS output,
           cache_read_cost_per_mtok_usd  AS cache_read,
           cache_write_cost_per_mtok_usd AS cache_write,
           per_request_cost_usd          AS per_request,
           valid_from, source, note, created_by, created_at
      FROM llm.model_prices
     ORDER BY model, valid_from DESC, created_at DESC
  `;
  const table: PriceTable<StoredPrice> = new Map();
  for (const r of rows) {
    const list = table.get(r.model) ?? [];
    list.push({
      id: r.id,
      model: r.model,
      valid_from: r.valid_from,
      input_cost_per_mtok_usd: Number(r.input),
      output_cost_per_mtok_usd: Number(r.output),
      cache_read_cost_per_mtok_usd: Number(r.cache_read),
      cache_write_cost_per_mtok_usd: Number(r.cache_write),
      per_request_cost_usd: Number(r.per_request),
      source: r.source,
      note: r.note,
      created_by: r.created_by,
      created_at: r.created_at,
    });
    table.set(r.model, list);
  }
  return table;
}

const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

const RATE_COLUMNS: [keyof FullRates, string][] = [
  ["input_cost_per_mtok_usd", "Input $/Mtok"],
  ["output_cost_per_mtok_usd", "Output $/Mtok"],
  ["cache_read_cost_per_mtok_usd", "Cache read $/Mtok"],
  ["cache_write_cost_per_mtok_usd", "Cache write $/Mtok"],
  ["per_request_cost_usd", "Per request $"],
];

function AddForm({ eff }: { eff: Effective }) {
  if (eff.long_context) {
    return (
      <div class="err">
        {eff.model}{" "}
        has a long-context tier in the catalog. model_prices has no tier
        columns, so a DB row would bill every request at the base rate and
        override the tier. Adding rows for this model is blocked; it stays on
        the catalog price.
      </div>
    );
  }
  return (
    <form method="post" action="/prices">
      <input type="hidden" name="model" value={eff.model} />
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
        {RATE_COLUMNS.map(([name, label]) => (
          <div>
            <label class="muted">{label}</label>
            <br />
            <input
              name={name}
              value={String(eff.rates[name])}
              inputmode="decimal"
              size={10}
              required={name !== "per_request_cost_usd"}
            />
          </div>
        ))}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px">
        <div>
          <label class="muted">valid_from (UTC, blank = now)</label>
          <br />
          <input type="datetime-local" name="valid_from" />
        </div>
        <div>
          <label class="muted">source</label>
          <br />
          <input name="source" value="manual" required />
        </div>
        <div style="flex:1">
          <label class="muted">note</label>
          <br />
          <input name="note" style="width:100%;box-sizing:border-box" />
        </div>
        <button type="submit">Add price row</button>
      </div>
      <p class="muted">
        Prefilled with the current price. Rows are append-only: a correction is
        a new row. Ingest picks the row up within 30 s; it prices usage ingested
        after that and never reprices stored rows.
      </p>
    </form>
  );
}

pricesRoutes.get("/prices", async (c) => {
  const table = await loadTable();
  const now = new Date();
  const slugs = Object.keys(MODELS);
  const selected = c.req.query("model");
  const sel = selected && MODELS[selected]
    ? effectivePrice(table, selected, now)
    : null;
  const history = sel ? table.get(sel.model) ?? [] : [];
  const current = sel?.kind === "db" ? sel.row.id : null;
  const err = c.req.query("err");
  const ok = c.req.query("ok");

  return c.html(
    <Layout title="Prices" admin={c.get("admin").email}>
      {ok ? <div class="flash">Price row added.</div> : null}
      {err ? <div class="err">{err}</div> : null}

      <div class="card">
        <h3 style="margin-top:0">Add a price row</h3>
        <form method="get" action="/prices">
          <select name="model">
            {slugs.map((s) => (
              <option value={s} selected={s === sel?.model}>{s}</option>
            ))}
          </select>{" "}
          <button type="submit">Load</button>
        </form>
        {sel
          ? (
            <div style="margin-top:12px">
              <AddForm eff={sel} />
            </div>
          )
          : null}
      </div>

      {sel
        ? (
          <>
            <h2>History: {sel.model}</h2>
            {history.length === 0
              ? (
                <p class="muted">
                  No model_prices rows; ingest uses the catalog price.
                </p>
              )
              : (
                <table>
                  <thead>
                    <tr>
                      <th>valid_from</th>
                      {RATE_COLUMNS.map(([, label]) => (
                        <th key={label}>{label}</th>
                      ))}
                      <th>Source</th>
                      <th>Note</th>
                      <th>Created</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((p) => (
                      <tr>
                        <td>{iso(p.valid_from)}</td>
                        {RATE_COLUMNS.map(([name]) => (
                          <td key={name}>{p[name]}</td>
                        ))}
                        <td>{p.source}</td>
                        <td>{p.note ?? "-"}</td>
                        <td class="muted">
                          {iso(p.created_at)} by {p.created_by ?? "-"}
                        </td>
                        <td>
                          {p.id === current
                            ? "current"
                            : p.valid_from > now
                            ? "scheduled"
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
          </>
        )
        : null}

      <h2>Current prices (what ingest charges now)</h2>
      <p class="muted">
        Latest llm.model_prices row with valid_from &lt;= now, else the code
        catalog (proxy/src/catalog.ts). "derived" cache rates are the 0.1x /
        1.25x input fallback for catalog entries without cache rates.
      </p>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Price from</th>
            {RATE_COLUMNS.map(([, label]) => <th key={label}>{label}</th>)}
            <th>Source</th>
            <th>valid_from</th>
            <th>Rows</th>
          </tr>
        </thead>
        <tbody>
          {slugs.map((s) => {
            const e = effectivePrice(table, s, now);
            const derived = e.kind === "catalog" && e.cache_derived;
            return (
              <tr>
                <td>
                  <a href={`/prices?model=${encodeURIComponent(s)}`}>{s}</a>
                  {e.long_context
                    ? (
                      <span class="muted" style="margin-left:6px">
                        long-context tier
                      </span>
                    )
                    : null}
                </td>
                <td>{e.kind === "db" ? "DB row" : "catalog"}</td>
                {RATE_COLUMNS.map(([name]) => (
                  <td>
                    {e.rates[name]}
                    {derived && name.startsWith("cache_")
                      ? (
                        <span class="muted" style="margin-left:4px">
                          derived
                        </span>
                      )
                      : null}
                  </td>
                ))}
                <td>{e.kind === "db" ? e.row.source : "-"}</td>
                <td class="muted">
                  {e.kind === "db" ? iso(e.row.valid_from) : "-"}
                </td>
                <td>{table.get(s)?.length ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Layout>,
  );
});

pricesRoutes.post("/prices", async (c) => {
  const admin = c.get("admin");
  const form = Object.fromEntries(
    [...(await c.req.formData()).entries()].map(([k, v]) => [k, String(v)]),
  );
  const parsed = parsePriceForm(form);
  const back = (q: string) =>
    c.redirect(
      `/prices?model=${encodeURIComponent(form.model ?? "")}&${q}`,
    );
  if (typeof parsed === "string") {
    return back(`err=${encodeURIComponent(parsed)}`);
  }

  await adminSql`
    INSERT INTO llm.model_prices
      (model, input_cost_per_mtok_usd, output_cost_per_mtok_usd,
       cache_read_cost_per_mtok_usd, cache_write_cost_per_mtok_usd,
       per_request_cost_usd, valid_from, source, note, created_by)
    VALUES
      (${parsed.model}, ${parsed.input_cost_per_mtok_usd},
       ${parsed.output_cost_per_mtok_usd},
       ${parsed.cache_read_cost_per_mtok_usd},
       ${parsed.cache_write_cost_per_mtok_usd},
       ${parsed.per_request_cost_usd}, COALESCE(${parsed.valid_from}::timestamptz, now()),
       ${parsed.source}, ${parsed.note}, ${"admin:" + admin.email})
  `;
  return back("ok=1");
});

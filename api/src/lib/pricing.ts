// Price resolution at ingest (ADR 0003 §2/§3).
//
// A usage row is priced with the llm.model_prices row for its model that has
// the greatest valid_from <= the usage row's created_at. A model with no such
// row falls back to the proxy catalog's price (proxy/src/catalog.ts, copied
// into the api image), with price_id null. A model in neither is unpriced:
// cost_usd null, tokens still stored so it can be repriced later.
//
// model_prices is append-only and changes rarely, so the poller reads the
// whole table into memory and re-reads it at most every PRICE_CACHE_TTL_MS. A
// new row therefore applies to rows ingested up to that long after it was
// added; rows already ingested keep their cost (no recompute on read).

import { computeCostUsd, type NormUsage, type Rates } from "@shared/pricing.ts";
import { getModel } from "../../../proxy/src/catalog.ts";
import { adminSql } from "../config/db.ts";

const PRICE_CACHE_TTL_MS = 30_000;

export interface PriceRow extends Rates {
  id: string;
  model: string;
  valid_from: Date;
}

export interface Priced {
  cost_usd: number | null;
  price_id: string | null;
}

// Rows per model, newest valid_from first.
export type PriceTable = Map<string, PriceRow[]>;

let cache: { table: PriceTable; loadedAt: number } | null = null;

async function loadPrices(): Promise<PriceTable> {
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
    }[]
  >`
    SELECT id::text, model,
           input_cost_per_mtok_usd       AS input,
           output_cost_per_mtok_usd      AS output,
           cache_read_cost_per_mtok_usd  AS cache_read,
           cache_write_cost_per_mtok_usd AS cache_write,
           per_request_cost_usd          AS per_request,
           valid_from
      FROM llm.model_prices
     ORDER BY model, valid_from DESC
  `;
  const table: PriceTable = new Map();
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
    });
    table.set(r.model, list);
  }
  return table;
}

// The price table, from memory while it is fresh.
export async function priceTable(): Promise<PriceTable> {
  if (!cache || Date.now() - cache.loadedAt > PRICE_CACHE_TTL_MS) {
    cache = { table: await loadPrices(), loadedAt: Date.now() };
  }
  return cache.table;
}

// Drops the cached table so the next priceTable() reads the DB. Tests use it
// after inserting price rows.
export function clearPriceCache(): void {
  cache = null;
}

// The DB price row in effect for `model` at `at`, or null.
export function pickPrice(
  table: PriceTable,
  model: string,
  at: Date,
): PriceRow | null {
  return table.get(model)?.find((p) => p.valid_from <= at) ?? null;
}

// Cost and price_id for one usage row.
export function priceUsage(
  table: PriceTable,
  model: string,
  at: Date,
  usage: NormUsage,
): Priced {
  const row = pickPrice(table, model, at);
  if (row) return { cost_usd: computeCostUsd(row, usage), price_id: row.id };
  const entry = getModel(model);
  return {
    cost_usd: entry ? computeCostUsd(entry, usage) : null,
    price_id: null,
  };
}

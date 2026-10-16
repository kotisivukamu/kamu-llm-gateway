// Prices page logic (ADR 0003 §3) that needs no DB: what ingest charges per
// model right now, and validation of a new llm.model_prices row.
//
// Resolution is the api's: pickPrice from shared/pricing.ts (the same function
// api/src/lib/pricing.ts priceUsage calls), else the catalog entry. The only
// difference is the clock: ingest prices a usage row at its created_at, this
// page at now().

import { pickPrice, type PriceRow, type PriceTable } from "@shared/pricing.ts";
import { MODELS } from "../../../proxy/src/catalog.ts";

export interface StoredPrice extends PriceRow {
  source: string;
  note: string | null;
  created_by: string | null;
  created_at: Date;
}

// Four token rates and the flat charge, all resolved to numbers.
export interface FullRates {
  input_cost_per_mtok_usd: number;
  output_cost_per_mtok_usd: number;
  cache_read_cost_per_mtok_usd: number;
  cache_write_cost_per_mtok_usd: number;
  per_request_cost_usd: number;
}

export type Effective =
  & { model: string; rates: FullRates; long_context: boolean }
  & (
    | { kind: "db"; row: StoredPrice }
    // cache_derived: the catalog entry has no cache rates, so computeCostUsd
    // uses read = 0.1x input, write = 1.25x input; the rates shown are those.
    | { kind: "catalog"; cache_derived: boolean }
  );

export function effectivePrice(
  table: PriceTable<StoredPrice>,
  model: string,
  at: Date,
): Effective {
  const entry = MODELS[model];
  const long_context = entry.long_context !== undefined;
  const row = pickPrice(table, model, at);
  if (row) {
    return {
      model,
      long_context,
      kind: "db",
      row,
      rates: {
        input_cost_per_mtok_usd: row.input_cost_per_mtok_usd,
        output_cost_per_mtok_usd: row.output_cost_per_mtok_usd,
        cache_read_cost_per_mtok_usd: row.cache_read_cost_per_mtok_usd!,
        cache_write_cost_per_mtok_usd: row.cache_write_cost_per_mtok_usd!,
        per_request_cost_usd: row.per_request_cost_usd ?? 0,
      },
    };
  }
  return {
    model,
    long_context,
    kind: "catalog",
    cache_derived: entry.cache_read_cost_per_mtok_usd === undefined ||
      entry.cache_write_cost_per_mtok_usd === undefined,
    rates: {
      input_cost_per_mtok_usd: entry.input_cost_per_mtok_usd,
      output_cost_per_mtok_usd: entry.output_cost_per_mtok_usd,
      cache_read_cost_per_mtok_usd: entry.cache_read_cost_per_mtok_usd ??
        entry.input_cost_per_mtok_usd * 0.1,
      cache_write_cost_per_mtok_usd: entry.cache_write_cost_per_mtok_usd ??
        entry.input_cost_per_mtok_usd * 1.25,
      per_request_cost_usd: entry.per_request_cost_usd ?? 0,
    },
  };
}

export interface NewPrice extends FullRates {
  model: string;
  // null = now() at insert.
  valid_from: Date | null;
  source: string;
  note: string | null;
}

const RATE_FIELDS = [
  "input_cost_per_mtok_usd",
  "output_cost_per_mtok_usd",
  "cache_read_cost_per_mtok_usd",
  "cache_write_cost_per_mtok_usd",
] as const;

// NUMERIC(12, 6): at most 6 integer digits.
const MAX_RATE = 999_999;

function parseRate(name: string, raw: string): number | string {
  if (raw === "") return `${name} is required`;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > MAX_RATE) {
    return `${name} must be a number from 0 to ${MAX_RATE}`;
  }
  return n;
}

// Validates the add-a-row form. Returns the row, or an error message.
// valid_from is a datetime-local value read as UTC; blank means now.
export function parsePriceForm(
  form: Record<string, string>,
): NewPrice | string {
  const model = (form.model ?? "").trim();
  const entry = MODELS[model];
  if (!entry) return "model must be a catalog model";
  if (entry.long_context) {
    return `${model} has a long-context tier in the catalog; a model_prices row has no tier columns and would bill every request at the base rate`;
  }

  const rates: Partial<FullRates> = {};
  for (const f of RATE_FIELDS) {
    const v = parseRate(f, (form[f] ?? "").trim());
    if (typeof v === "string") return v;
    rates[f] = v;
  }
  const perReqRaw = (form.per_request_cost_usd ?? "").trim();
  let perRequest = 0;
  if (perReqRaw !== "") {
    const v = parseRate("per_request_cost_usd", perReqRaw);
    if (typeof v === "string") return v;
    perRequest = v;
  }

  const vfRaw = (form.valid_from ?? "").trim();
  let validFrom: Date | null = null;
  if (vfRaw !== "") {
    validFrom = new Date(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(vfRaw)
        ? `${vfRaw}Z`
        : vfRaw,
    );
    if (Number.isNaN(validFrom.getTime())) {
      return "valid_from must be a date and time (UTC)";
    }
  }

  const source = (form.source ?? "").trim();
  if (!source) return "source is required";
  const note = (form.note ?? "").trim();

  return {
    model,
    ...(rates as Omit<FullRates, "per_request_cost_usd">),
    per_request_cost_usd: perRequest,
    valid_from: validFrom,
    source,
    note: note || null,
  };
}

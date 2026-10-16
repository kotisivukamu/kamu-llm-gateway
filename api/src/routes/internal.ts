import { Hono } from "@hono/hono";
import type { Context, Next } from "@hono/hono";
import {
  effectivePrice,
  type FullRates,
  parsePriceForm,
} from "@shared/prices.ts";
import type { KeyScope } from "@shared/types.ts";
import { MODELS } from "../../../proxy/src/catalog.ts";
import { adminSql } from "../config/db.ts";
import {
  extractCredential,
  type UsageScope,
  verifyGatewayCredential,
} from "../lib/keys.ts";
import { clearPriceCache, reloadPriceTable } from "../lib/pricing.ts";

// Internal price API (ADR 0003 §3 follow-up): the kamuhub billing worker
// syncs llm.model_prices from the providers' price lists once a day. It reads
// what ingest charges per catalog model now and appends a row when a
// provider's price differs.
//
// Authenticated like the key-holder GET /usage (the gateway key itself, not
// the BFF context, so it lives outside /api), and gated on a scope: only an
// active top-level key holding `prices:write` passes. Unknown, revoked or
// expired credentials are 401; a valid key without the right is 403
// (derived keys never carry scopes, over_budget keys are not active).

type InternalEnv = { Variables: { gatewayKey: UsageScope } };

export const internal = new Hono<InternalEnv>();

function requireScope(scope: KeyScope) {
  return async (c: Context<InternalEnv>, next: Next) => {
    const key = await verifyGatewayCredential(
      extractCredential(c.req.raw.headers),
    );
    if (!key) return c.json({ error: "unauthorized" }, 401);
    if (
      key.key_type !== "top" || key.status !== "active" ||
      !key.scopes.includes(scope)
    ) {
      return c.json({ error: `forbidden: requires ${scope}` }, 403);
    }
    c.set("gatewayKey", key);
    await next();
  };
}

internal.use("/internal/prices", requireScope("prices:write"));

const RATE_KEYS: (keyof FullRates)[] = [
  "input_cost_per_mtok_usd",
  "output_cost_per_mtok_usd",
  "cache_read_cost_per_mtok_usd",
  "cache_write_cost_per_mtok_usd",
  "per_request_cost_usd",
];

// The columns are NUMERIC(12, 6): compare and store at that precision, so a
// provider rate with more decimals does not look changed on every sync.
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function priceView(
  table: Awaited<ReturnType<typeof reloadPriceTable>>,
  model: string,
  at: Date,
) {
  const e = effectivePrice(table, model, at);
  return e.kind === "db"
    ? {
      kind: "db" as const,
      id: e.row.id,
      valid_from: e.row.valid_from.toISOString(),
      source: e.row.source,
      note: e.row.note,
      created_by: e.row.created_by,
      ...e.rates,
    }
    : { kind: "catalog" as const, cache_derived: e.cache_derived, ...e.rates };
}

// Every catalog model with its routing and the price ingest charges now.
// upstream_model is what the proxy sends the provider (ADR 0002:
// upstream_model_slug, else the client slug; nothing splits on "@").
internal.get("/internal/prices", async (c) => {
  const table = await reloadPriceTable();
  const now = new Date();
  return c.json({
    models: Object.entries(MODELS).map(([model, entry]) => ({
      model,
      provider_slug: entry.provider_slug,
      upstream_model: entry.upstream_model_slug ?? model,
      long_context: entry.long_context !== undefined,
      price: priceView(table, model, now),
    })),
  });
});

// Appends a price row, unless the price in effect at its valid_from (now when
// omitted) already has these exact rates: then 200 {unchanged: true} and no
// row, so a daily sync only writes when a provider's price moved. Validation
// is the admin Prices page's (shared/prices.ts), long-context models included.
internal.post("/internal/prices", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "body must be a JSON object" }, 400);
  }
  const parsed = parsePriceForm(
    Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map((
        [k, v],
      ) => [k, v == null ? "" : String(v)]),
    ),
  );
  if (typeof parsed === "string") return c.json({ error: parsed }, 400);
  for (const k of RATE_KEYS) parsed[k] = round6(parsed[k]);

  const table = await reloadPriceTable();
  const current = effectivePrice(
    table,
    parsed.model,
    parsed.valid_from ?? new Date(),
  );
  if (RATE_KEYS.every((k) => round6(current.rates[k]) === parsed[k])) {
    return c.json({
      unchanged: true,
      price: priceView(table, parsed.model, parsed.valid_from ?? new Date()),
    });
  }

  const key = c.get("gatewayKey");
  const [row] = await adminSql<{ id: string; valid_from: Date }[]>`
    INSERT INTO llm.model_prices
      (model, input_cost_per_mtok_usd, output_cost_per_mtok_usd,
       cache_read_cost_per_mtok_usd, cache_write_cost_per_mtok_usd,
       per_request_cost_usd, valid_from, source, note, created_by)
    VALUES
      (${parsed.model}, ${parsed.input_cost_per_mtok_usd},
       ${parsed.output_cost_per_mtok_usd}, ${parsed.cache_read_cost_per_mtok_usd},
       ${parsed.cache_write_cost_per_mtok_usd}, ${parsed.per_request_cost_usd},
       COALESCE(${parsed.valid_from}::timestamptz, now()), ${parsed.source},
       ${parsed.note}, ${"key:" + key.label})
    RETURNING id::text, valid_from
  `;
  clearPriceCache();
  return c.json({
    unchanged: false,
    price: {
      kind: "db",
      id: row.id,
      model: parsed.model,
      valid_from: row.valid_from.toISOString(),
      source: parsed.source,
      note: parsed.note,
      created_by: "key:" + key.label,
      ...Object.fromEntries(RATE_KEYS.map((k) => [k, parsed[k]])),
    },
  }, 201);
});

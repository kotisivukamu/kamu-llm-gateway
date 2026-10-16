import "./support/env.ts";
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { computeCostUsd } from "@shared/pricing.ts";
import { MODELS } from "../../../proxy/src/catalog.ts";
import {
  pickPrice,
  type PriceRow,
  type PriceTable,
  priceUsage,
} from "../lib/pricing.ts";

// Price resolution at ingest (ADR 0003 §2): the model_prices row with the
// greatest valid_from <= the usage row's created_at, else the catalog.

function price(
  id: string,
  validFrom: string,
  input: number,
  over: Partial<PriceRow> = {},
): PriceRow {
  return {
    id,
    model: "glm-5.3",
    valid_from: new Date(validFrom),
    input_cost_per_mtok_usd: input,
    output_cost_per_mtok_usd: 2,
    cache_read_cost_per_mtok_usd: 0.1,
    cache_write_cost_per_mtok_usd: 1,
    per_request_cost_usd: 0,
    ...over,
  };
}

// Newest first, as loadPrices orders them.
const table: PriceTable = new Map([[
  "glm-5.3",
  [
    price("p3", "2026-10-16T00:00:00Z", 0.9),
    price("p2", "2026-10-01T00:00:00Z", 1.5),
    price("p1", "2026-09-01T00:00:00Z", 1.8),
  ],
]]);

const usage = {
  input_tokens: 1_000_000,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

Deno.test("pickPrice: the latest valid_from at or before the row wins", () => {
  const at = (iso: string) => pickPrice(table, "glm-5.3", new Date(iso))?.id;
  assertEquals(at("2026-10-15T23:59:59Z"), "p2");
  assertEquals(at("2026-10-16T00:00:00Z"), "p3"); // valid_from is inclusive
  assertEquals(at("2026-12-01T00:00:00Z"), "p3");
  assertEquals(at("2026-09-15T00:00:00Z"), "p1");
});

Deno.test("pickPrice: a row older than every price has none", () => {
  assertEquals(
    pickPrice(table, "glm-5.3", new Date("2026-08-31T00:00:00Z")),
    null,
  );
  assertEquals(pickPrice(table, "other", new Date()), null);
});

Deno.test("priceUsage: a DB price is used with its id", () => {
  const got = priceUsage(
    table,
    "glm-5.3",
    new Date("2026-10-05T00:00:00Z"),
    usage,
  );
  assertEquals(got.price_id, "p2");
  assertAlmostEquals(got.cost_usd!, 1.5, 1e-12);
});

Deno.test("priceUsage: no DB price falls back to the catalog, price_id null", () => {
  const u = {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 20_000,
    cache_write_tokens: 0,
  };
  const at = new Date("2026-08-01T00:00:00Z"); // before p1
  const got = priceUsage(table, "glm-5.3", at, u);
  assertEquals(got.price_id, null);
  assertAlmostEquals(
    got.cost_usd!,
    computeCostUsd(MODELS["glm-5.3"], u),
    1e-12,
  );
  assertEquals(
    priceUsage(new Map(), "claude-haiku-5-5", at, u).cost_usd,
    computeCostUsd(MODELS["claude-haiku-5-5"], u),
  );
});

Deno.test("priceUsage: a model in neither is unpriced", () => {
  assertEquals(priceUsage(table, "no-such-model", new Date(), usage), {
    cost_usd: null,
    price_id: null,
  });
});

Deno.test("priceUsage: a DB price's per-request charge is added", () => {
  const t: PriceTable = new Map([[
    "jev-latest",
    [price("j1", "2026-10-01T00:00:00Z", 0, { per_request_cost_usd: 0.003 })],
  ]]);
  const got = priceUsage(t, "jev-latest", new Date("2026-10-02T00:00:00Z"), {
    ...usage,
    input_tokens: 0,
  });
  assertEquals(got.price_id, "j1");
  assertAlmostEquals(got.cost_usd!, 0.003, 1e-12);
});

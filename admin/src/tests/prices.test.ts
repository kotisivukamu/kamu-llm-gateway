import { assertEquals } from "@std/assert";
import type { PriceTable } from "@shared/pricing.ts";
import { MODELS } from "../../../proxy/src/catalog.ts";
import {
  effectivePrice,
  type NewPrice,
  parsePriceForm,
  type StoredPrice,
} from "@shared/prices.ts";

// The Prices page shows what ingest charges: the latest model_prices row with
// valid_from <= now, else the catalog (ADR 0003 §3).

function row(id: string, validFrom: string, input: number): StoredPrice {
  return {
    id,
    model: "glm-5.3",
    valid_from: new Date(validFrom),
    input_cost_per_mtok_usd: input,
    output_cost_per_mtok_usd: 2,
    cache_read_cost_per_mtok_usd: 0.1,
    cache_write_cost_per_mtok_usd: 1,
    per_request_cost_usd: 0,
    source: "manual",
    note: null,
    created_by: "admin:a@b",
    created_at: new Date(validFrom),
  };
}

const now = new Date("2026-10-16T12:00:00Z");

Deno.test("effectivePrice: no rows is the catalog price", () => {
  const e = effectivePrice(new Map(), "glm-5.3", now);
  const m = MODELS["glm-5.3"];
  assertEquals(e.kind, "catalog");
  assertEquals(e.rates.input_cost_per_mtok_usd, m.input_cost_per_mtok_usd);
  assertEquals(
    e.rates.cache_read_cost_per_mtok_usd,
    m.cache_read_cost_per_mtok_usd,
  );
});

Deno.test("effectivePrice: latest past row wins, future rows wait", () => {
  const table: PriceTable<StoredPrice> = new Map([[
    "glm-5.3",
    [
      row("future", "2026-11-01T00:00:00Z", 3),
      row("now", "2026-10-01T00:00:00Z", 2),
      row("old", "2026-09-01T00:00:00Z", 1),
    ],
  ]]);
  const e = effectivePrice(table, "glm-5.3", now);
  assertEquals(e.kind === "db" ? e.row.id : null, "now");
  assertEquals(e.rates.input_cost_per_mtok_usd, 2);

  const onlyFuture: PriceTable<StoredPrice> = new Map([[
    "glm-5.3",
    [row("future", "2026-11-01T00:00:00Z", 3)],
  ]]);
  assertEquals(effectivePrice(onlyFuture, "glm-5.3", now).kind, "catalog");
});

Deno.test("effectivePrice: flags long-context models", () => {
  assertEquals(
    effectivePrice(new Map(), "claude-haiku-5-5", now).long_context,
    true,
  );
  assertEquals(effectivePrice(new Map(), "glm-5.3", now).long_context, false);
});

const valid = {
  model: "glm-5.3",
  input_cost_per_mtok_usd: "1.5",
  output_cost_per_mtok_usd: "3",
  cache_read_cost_per_mtok_usd: "0.15",
  cache_write_cost_per_mtok_usd: "1.5",
  per_request_cost_usd: "",
  valid_from: "",
  source: "manual",
  note: "",
};

Deno.test("parsePriceForm: a valid form", () => {
  const p = parsePriceForm(valid) as NewPrice;
  assertEquals(p.input_cost_per_mtok_usd, 1.5);
  assertEquals(p.per_request_cost_usd, 0);
  assertEquals(p.valid_from, null);
  assertEquals(p.note, null);
  const future = parsePriceForm({ ...valid, valid_from: "2026-11-01T08:30" });
  assertEquals(
    (future as NewPrice).valid_from?.toISOString(),
    "2026-11-01T08:30:00.000Z",
  );
});

Deno.test("parsePriceForm: rejects bad input", () => {
  const bad = (over: Record<string, string>) =>
    typeof parsePriceForm({ ...valid, ...over }) === "string";
  assertEquals(bad({ model: "nope" }), true);
  assertEquals(bad({ model: "claude-haiku-5-5" }), true);
  assertEquals(bad({ input_cost_per_mtok_usd: "-1" }), true);
  assertEquals(bad({ output_cost_per_mtok_usd: "" }), true);
  assertEquals(bad({ cache_read_cost_per_mtok_usd: "abc" }), true);
  assertEquals(bad({ per_request_cost_usd: "-0.01" }), true);
  assertEquals(bad({ valid_from: "tomorrow" }), true);
  assertEquals(bad({ source: " " }), true);
});

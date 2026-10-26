// catalogView: GET /catalog serves the price ingest bills with. A model with
// a model_prices row takes the DB rates; one without keeps the compiled-in
// catalog price.

import assert from "node:assert/strict";

const { catalogView } = await import("../routes/catalog.ts");
const { MODELS } = await import("../catalog.ts");

Deno.test("catalogView: a DB price overrides the compiled-in price", () => {
  const view = catalogView(
    new Map([["glm-5.3", {
      input_cost_per_mtok_usd: 0.530329,
      output_cost_per_mtok_usd: 2.121314,
      cache_read_cost_per_mtok_usd: 0.159445,
      cache_write_cost_per_mtok_usd: 0.530329,
      per_request_cost_usd: 0,
    }]]),
  );
  const glm = view.models.find((m) => m.slug === "glm-5.3")!;
  assert.equal(glm.input_cost_per_mtok_usd, 0.530329);
  assert.equal(glm.output_cost_per_mtok_usd, 2.121314);
  assert.equal(glm.cache_read_cost_per_mtok_usd, 0.159445);
  assert.equal(glm.cache_write_cost_per_mtok_usd, 0.530329);
  assert.equal(glm.provider_slug, MODELS["glm-5.3"].provider_slug);
});

Deno.test("catalogView: a model without a DB price keeps the catalog price", () => {
  const view = catalogView(new Map());
  const glm = view.models.find((m) => m.slug === "glm-5.3")!;
  assert.equal(
    glm.input_cost_per_mtok_usd,
    MODELS["glm-5.3"].input_cost_per_mtok_usd,
  );
  assert.equal(
    glm.cache_read_cost_per_mtok_usd,
    MODELS["glm-5.3"].cache_read_cost_per_mtok_usd ?? null,
  );
  assert.equal(view.models.length, Object.keys(MODELS).length);
});

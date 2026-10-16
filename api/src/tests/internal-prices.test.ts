import "./support/env.ts";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { computeCostUsd } from "@shared/pricing.ts";
import { MODELS } from "../../../proxy/src/catalog.ts";
import { hashKey } from "../lib/keys.ts";
import { priceTable } from "../lib/pricing.ts";
import { pollOnce } from "../lib/usage-poller.ts";
import { buildTestApp, testRequest } from "./support/app.ts";
import { adminSql, resetDb, seedKey, seedTeam } from "./support/db.ts";

// Internal price API (/internal/prices): scope gate, the GET shape, append-only
// POST with its unchanged check and validation, and that ingest prices with a
// row added through it straight away.

const T = { sanitizeOps: false, sanitizeResources: false };

async function fixture(scopes: string[] = ["prices:write"]) {
  await resetDb();
  const team = await seedTeam();
  const secret = `sk_live_${crypto.randomUUID().replaceAll("-", "")}`;
  const key = await seedKey({
    teamId: team.id,
    label: "kamuhub-billing-worker",
    keyHash: await hashKey(secret),
    scopes,
  });
  return { team, key, secret };
}

const body = {
  // Not the catalog price (that would be "unchanged").
  model: "glm-5.3",
  input_cost_per_mtok_usd: 0.8123,
  output_cost_per_mtok_usd: 3.1,
  cache_read_cost_per_mtok_usd: 0.2,
  cache_write_cost_per_mtok_usd: 0.8123,
  source: "cortecs",
};

function post(token: string, b: unknown) {
  return testRequest(buildTestApp(), "POST", "/internal/prices", {
    token,
    body: b,
  });
}

function get(token: string) {
  return testRequest(buildTestApp(), "GET", "/internal/prices", { token });
}

Deno.test("internal prices: scope gate", T, async () => {
  const k = await fixture([]);
  assertEquals((await get(k.secret)).status, 403);
  assertEquals((await post(k.secret, body)).status, 403);
  assertEquals((await get("sk_live_nope")).status, 401);
  assertEquals((await get("")).status, 401);

  // A scoped parent's derived key gets no scopes and is refused.
  await adminSql`UPDATE llm.keys SET scopes = '{prices:write}' WHERE id = ${k.key}`;
  assertEquals((await get(k.secret)).status, 200);
  const res = await testRequest(buildTestApp(), "POST", "/api/keys/derive", {
    token: k.secret,
    body: { label: "build" },
  });
  assertEquals(res.status, 201);
  const derived = await res.json();
  const [row] = await adminSql<{ scopes: string[] }[]>`
    SELECT scopes FROM llm.keys WHERE id = ${derived.key.id}
  `;
  assertEquals(row.scopes, []);
  assertEquals((await get(derived.sub_key)).status, 403);

  // The DB refuses scopes on a derived row whatever the writer.
  let refused = false;
  try {
    await adminSql`UPDATE llm.keys SET scopes = '{prices:write}' WHERE id = ${derived.key.id}`;
  } catch {
    refused = true;
  }
  assert(refused);

  // over_budget is not active: 403. Revoked: 401.
  await adminSql`UPDATE llm.keys SET status = 'over_budget' WHERE id = ${k.key}`;
  assertEquals((await get(k.secret)).status, 403);
  await adminSql`UPDATE llm.keys SET status = 'revoked' WHERE id = ${k.key}`;
  assertEquals((await get(k.secret)).status, 401);
  assertEquals((await post(k.secret, body)).status, 401);
});

Deno.test("internal prices: GET lists every catalog model", T, async () => {
  const k = await fixture();
  const res = await get(k.secret);
  assertEquals(res.status, 200);
  const { models } = await res.json();
  assertEquals(models.length, Object.keys(MODELS).length);

  const glm = models.find((m: { model: string }) => m.model === "glm-5.3");
  assertEquals(glm.provider_slug, MODELS["glm-5.3"].provider_slug);
  assertEquals(
    glm.upstream_model,
    MODELS["glm-5.3"].upstream_model_slug ?? "glm-5.3",
  );
  assertEquals(glm.long_context, false);
  assertEquals(glm.price.kind, "catalog");
  assertEquals(
    glm.price.input_cost_per_mtok_usd,
    MODELS["glm-5.3"].input_cost_per_mtok_usd,
  );

  // A pinned variant reports the upstream slug the proxy sends.
  const variant = Object.entries(MODELS).find(([s]) => s.includes("@"))!;
  const v = models.find((m: { model: string }) => m.model === variant[0]);
  assertEquals(v.upstream_model, variant[1].upstream_model_slug ?? variant[0]);
  assert(!v.upstream_model.includes("@"));

  const haiku = models.find((m: { model: string }) =>
    m.model === "claude-haiku-5-5"
  );
  assertEquals(haiku.long_context, true);

  // A DB row shows as the effective price with its id/valid_from/source.
  const created = await (await post(k.secret, body)).json();
  const after = (await (await get(k.secret)).json()).models.find((
    m: { model: string },
  ) => m.model === "glm-5.3");
  assertEquals(after.price.kind, "db");
  assertEquals(after.price.id, created.price.id);
  assertEquals(after.price.source, "cortecs");
  assertEquals(after.price.created_by, "key:kamuhub-billing-worker");
  assertEquals(after.price.input_cost_per_mtok_usd, 0.8123);
  assertEquals(typeof after.price.valid_from, "string");
});

Deno.test(
  "internal prices: POST inserts, then reports unchanged",
  T,
  async () => {
    const k = await fixture();
    const first = await post(k.secret, { ...body, note: "daily sync" });
    assertEquals(first.status, 201);
    const created = await first.json();
    assertEquals(created.unchanged, false);

    const [row] = await adminSql<
      { created_by: string; note: string; per_request: string }[]
    >`
    SELECT created_by, note, per_request_cost_usd::text AS per_request
      FROM llm.model_prices WHERE id = ${created.price.id}
  `;
    assertEquals(row.created_by, "key:kamuhub-billing-worker");
    assertEquals(row.note, "daily sync");
    assertEquals(Number(row.per_request), 0);

    // Same rates again (extra decimals beyond NUMERIC(12,6) included): no row.
    const again = await post(k.secret, {
      ...body,
      input_cost_per_mtok_usd: 0.8123001,
    });
    assertEquals(again.status, 200);
    assertEquals((await again.json()).unchanged, true);

    // The catalog price of a model with no row counts as current too.
    const [slug, entry] = Object.entries(MODELS).find(([, m]) =>
      !m.long_context && m.cache_read_cost_per_mtok_usd !== undefined &&
      m.cache_write_cost_per_mtok_usd !== undefined && m !== MODELS["glm-5.3"]
    )!;
    const catalogMatch = await post(k.secret, {
      model: slug,
      input_cost_per_mtok_usd: entry.input_cost_per_mtok_usd,
      output_cost_per_mtok_usd: entry.output_cost_per_mtok_usd,
      cache_read_cost_per_mtok_usd: entry.cache_read_cost_per_mtok_usd,
      cache_write_cost_per_mtok_usd: entry.cache_write_cost_per_mtok_usd,
      per_request_cost_usd: entry.per_request_cost_usd,
      source: "cortecs",
    });
    assertEquals(catalogMatch.status, 200);
    assertEquals((await catalogMatch.json()).unchanged, true);

    // A changed rate appends a second row.
    const moved = await post(k.secret, {
      ...body,
      output_cost_per_mtok_usd: 3,
    });
    assertEquals(moved.status, 201);
    const [{ n }] = await adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM llm.model_prices WHERE model = 'glm-5.3'
  `;
    assertEquals(n, 2);
  },
);

Deno.test("internal prices: POST validation", T, async () => {
  const k = await fixture();
  const bad = async (b: unknown) => {
    const res = await post(k.secret, b);
    assertEquals(res.status, 400, JSON.stringify(b));
    return (await res.json()).error as string;
  };
  await bad([1]);
  await bad({ ...body, model: "no-such-model" });
  await bad({ ...body, input_cost_per_mtok_usd: -1 });
  await bad({ ...body, output_cost_per_mtok_usd: "abc" });
  await bad({ ...body, cache_read_cost_per_mtok_usd: null });
  await bad({ ...body, cache_write_cost_per_mtok_usd: 1e7 });
  await bad({ ...body, source: "" });
  await bad({ ...body, valid_from: "not a date" });
  assert(
    (await bad({ ...body, model: "claude-haiku-5-5" })).includes(
      "long-context",
    ),
  );
  const [{ n }] = await adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM llm.model_prices
  `;
  assertEquals(n, 0);
});

Deno.test("internal prices: ingest uses a posted row at once", T, async () => {
  const k = await fixture();
  // Warm this machine's 30 s price cache with the empty table.
  assertEquals((await priceTable()).size, 0);

  const res = await post(k.secret, {
    ...body,
    valid_from: "2026-10-01T00:00:00Z",
  });
  assertEquals(res.status, 201);
  const priceId = (await res.json()).price.id;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({
      rows: [{
        usage_id: "019a0000-0000-7000-8000-000000000001",
        machine_id: "m-arn",
        key_id: k.key,
        parent_key_id: null,
        root_key_id: k.key,
        model: "glm-5.3",
        provider_slug: "cortecs",
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_tokens: 5000,
        cache_write_tokens: 0,
        cost_usd: 999,
        created_at: "2026-10-16T10:00:00.000Z",
      }],
    }))) as typeof fetch;
  try {
    assertEquals(await pollOnce("http://proxy.test", "0"), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const [row] = await adminSql<{ price_id: string; cost_usd: string }[]>`
    SELECT price_id::text, cost_usd::text FROM llm.usage_log WHERE key_id = ${k.key}
  `;
  assertEquals(row.price_id, priceId);
  assertAlmostEquals(
    Number(row.cost_usd),
    computeCostUsd(body, {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_tokens: 5000,
      cache_write_tokens: 0,
    }),
    1e-6,
  );
});

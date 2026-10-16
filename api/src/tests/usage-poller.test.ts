import "./support/env.ts";
import { assertAlmostEquals, assertEquals, assertRejects } from "@std/assert";
import { computeCostUsd } from "@shared/pricing.ts";
import { MODELS } from "../../../proxy/src/catalog.ts";
import { env } from "../env.ts";
import { clearPriceCache } from "../lib/pricing.ts";
import { pollAll, pollOnce } from "../lib/usage-poller.ts";
import { adminSql, resetDb, seedKey, seedTeam } from "./support/db.ts";

// Regression for commit f840311 ("correct usage-poller INSERT/SELECT column
// arity and JSON binding") — api/src/lib/usage-poller.ts. Before the fix, the
// poller's INSERT selected `*` from jsonb_populate_recordset(null::llm.usage_log, …),
// which yields all 10 declared columns (including `metadata`, which the
// satellite's /usage page never sends) against an explicit 9-column INSERT
// list — an arity mismatch that made every poll fail and the durable ledger
// stay permanently empty. This test seeds a fake satellite response (mocking
// `fetch`) and asserts the row actually lands in llm.usage_log with the right
// values, including a unicode model name. Pricing at ingest (ADR 0003) is
// covered at the end of the file.

const originalFetch = globalThis.fetch;
let requested: string[] = [];

function mockUsageEndpoint(rows: unknown[]) {
  requested = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/usage")) {
      requested.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ rows }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

const ORIGIN = "http://proxy.test";

// A UUIDv7-shaped id for a given ms timestamp, unique per call.
function usageId(ms: number): string {
  const ts = ms.toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replaceAll("-", "").slice(12);
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${rand.slice(1, 4)}-8${
    rand.slice(5, 8)
  }-${rand.slice(8, 20)}`;
}

function usageRow(
  key: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    usage_id: usageId(Date.parse("2026-10-09T12:00:00Z")),
    machine_id: "m-arn",
    key_id: key,
    parent_key_id: null,
    root_key_id: key,
    model: "glm-5.3",
    input_tokens: 1,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.001,
    created_at: "2026-10-09T12:00:00.000Z",
    ...over,
  };
}

Deno.test("pollOnce: a row round-trips into llm.usage_log", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, label: "poller test key" });
  const row = usageRow(keyId, {
    model: "kimi-k2.7-日本語", // unicode in the model name
    input_tokens: 1000,
    output_tokens: 250,
    cache_read_tokens: 4000,
    cache_write_tokens: 50,
    cost_usd: 0.0123,
  });
  mockUsageEndpoint([row]);
  try {
    assertEquals(await pollOnce(ORIGIN, "0"), 1);
  } finally {
    restoreFetch();
  }
  const [got] = await adminSql<{
    machine_id: string;
    key_id: string;
    model: string;
    cost_usd: string;
    tokens_in: number;
    tokens_out: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    metadata: unknown;
  }[]>`
    SELECT machine_id, key_id::text, model, cost_usd::text, tokens_in,
           tokens_out, cache_read_tokens, cache_write_tokens, metadata
    FROM llm.usage_log WHERE usage_id = ${row.usage_id as string}
  `;
  if (!got) throw new Error("expected the poller to have inserted the row");
  assertEquals(got.machine_id, "m-arn");
  assertEquals(got.key_id, keyId);
  assertEquals(got.model, "kimi-k2.7-日本語");
  assertEquals(got.tokens_in, 1000);
  assertEquals(got.tokens_out, 250);
  assertEquals(got.cache_read_tokens, 4000);
  assertEquals(got.cache_write_tokens, 50);
  // The model has no price anywhere, and the feed's cost_usd is not used.
  assertEquals(got.cost_usd, null);
  assertEquals(got.metadata, null);
});

Deno.test("pollOnce: re-polling the same rows inserts nothing twice", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, label: "idempotent" });
  mockUsageEndpoint([usageRow(keyId)]);
  try {
    assertEquals(await pollOnce(ORIGIN, "0"), 1);
    assertEquals(await pollOnce(ORIGIN, "0"), 0);
  } finally {
    restoreFetch();
  }
  const [{ n }] = await adminSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM llm.usage_log
  `;
  assertEquals(n, 1);
});

Deno.test(
  "pollOnce: rows from two machines in the same millisecond both land",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  async () => {
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id, label: "two machines" });
    mockUsageEndpoint([
      usageRow(keyId, { machine_id: "m-arn" }),
      usageRow(keyId, { machine_id: "m-fra" }),
    ]);
    try {
      assertEquals(await pollOnce(ORIGIN, "0"), 2);
    } finally {
      restoreFetch();
    }
    const rows = await adminSql<{ machine_id: string }[]>`
    SELECT machine_id FROM llm.usage_log ORDER BY machine_id
  `;
    assertEquals(rows.map((r) => r.machine_id), ["m-arn", "m-fra"]);
  },
);

Deno.test("pollOnce: a row for a deleted key is skipped, the rest land", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // key_id is a foreign key: one such row used to fail the whole page and
  // stall the ledger for every key.
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, label: "live key" });
  mockUsageEndpoint([usageRow(crypto.randomUUID()), usageRow(keyId)]);
  try {
    assertEquals(await pollOnce(ORIGIN, "0"), 1);
  } finally {
    restoreFetch();
  }
});

Deno.test("pollOnce: rows without usage_id (an old proxy) are refused", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, label: "old proxy" });
  mockUsageEndpoint([usageRow(keyId, { usage_id: undefined })]);
  try {
    await assertRejects(() => pollOnce(ORIGIN, "0"));
  } finally {
    restoreFetch();
  }
  const [{ n }] = await adminSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM llm.usage_log
  `;
  assertEquals(n, 0);
});

Deno.test("pollAll: asks from the newest stored usage_id minus 10 s", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // LLM_PROXY_URL in tests is not a *.internal name, so pollAll polls it as
  // the single proxy.
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, label: "poll all" });
  const ms = Date.parse("2026-10-09T12:00:00Z");
  mockUsageEndpoint([usageRow(keyId, { usage_id: usageId(ms) })]);
  try {
    await pollAll(); // empty ledger: from the start
    assertEquals(requested[0].includes("after=0&"), true);
    requested.length = 0;
    await pollAll(); // now from the stored row, minus the overlap
    const floor = (ms - 10_000).toString(16).padStart(12, "0");
    assertEquals(
      requested[0].includes(
        `after=${floor.slice(0, 8)}-${floor.slice(8)}-0000-0000-000000000000&`,
      ),
      true,
    );
  } finally {
    restoreFetch();
  }
});

// --- Pricing at ingest (ADR 0003 §2) ---------------------------------------

const T = { sanitizeOps: false, sanitizeResources: false };

async function addPrice(validFrom: string, input: number): Promise<string> {
  const [row] = await adminSql<{ id: string }[]>`
    INSERT INTO llm.model_prices
      (model, input_cost_per_mtok_usd, output_cost_per_mtok_usd,
       cache_read_cost_per_mtok_usd, cache_write_cost_per_mtok_usd,
       valid_from, source)
    VALUES ('glm-5.3', ${input}, 2, 0.1, 1, ${validFrom}, 'test')
    RETURNING id::text
  `;
  clearPriceCache();
  return row.id;
}

async function poll(rows: unknown[]): Promise<number> {
  mockUsageEndpoint(rows);
  try {
    return await pollOnce(ORIGIN, "0");
  } finally {
    restoreFetch();
  }
}

async function stored(usage_id: unknown) {
  const [row] = await adminSql<{
    cost_usd: string | null;
    price_id: string | null;
    provider_cost: string | null;
    provider_cost_currency: string | null;
  }[]>`
    SELECT cost_usd::text, price_id::text, provider_cost::text,
           provider_cost_currency
      FROM llm.usage_log WHERE usage_id = ${usage_id as string}
  `;
  return row;
}

async function spentUsd(keyId: string): Promise<number | null> {
  const [row] = await adminSql<{ spent_usd: string }[]>`
    SELECT spent_usd::text FROM llm.key_spend WHERE key_id = ${keyId}
  `;
  return row ? Number(row.spent_usd) : null;
}

async function keyStatus(keyId: string): Promise<string> {
  const [row] = await adminSql<{ status: string }[]>`
    SELECT status FROM llm.keys WHERE id = ${keyId}
  `;
  return row.status;
}

Deno.test(
  "ingest: priced by the model_prices row in effect at created_at",
  T,
  async () => {
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id });
    const older = await addPrice("2026-10-01T00:00:00Z", 1);
    await addPrice("2026-10-10T00:00:00Z", 3); // after the row: not used
    const row = usageRow(keyId, {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cost_usd: 99, // the proxy's own figure: ignored
    });
    assertEquals(await poll([row]), 1);
    const got = await stored(row.usage_id);
    assertEquals(got.price_id, older);
    assertEquals(Number(got.cost_usd), 1);
  },
);

Deno.test(
  "ingest: no price row falls back to the catalog, price_id null",
  T,
  async () => {
    await resetDb();
    clearPriceCache();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id });
    const row = usageRow(keyId, {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 200_000,
    });
    await poll([row]);
    const got = await stored(row.usage_id);
    assertEquals(got.price_id, null);
    assertAlmostEquals(
      Number(got.cost_usd),
      computeCostUsd(MODELS["glm-5.3"], {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_tokens: 200_000,
        cache_write_tokens: 0,
      }),
      1e-6,
    );
  },
);

Deno.test(
  "ingest: provider_cost is stored when the feed carries it",
  T,
  async () => {
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id });
    const withCost = usageRow(keyId, {
      provider_cost: 0.00042,
      provider_cost_currency: "EUR",
    });
    const without = usageRow(keyId);
    await poll([withCost, without]);
    const a = await stored(withCost.usage_id);
    assertEquals(Number(a.provider_cost), 0.00042);
    assertEquals(a.provider_cost_currency, "EUR");
    const b = await stored(without.usage_id);
    assertEquals(b.provider_cost, null);
    assertEquals(b.provider_cost_currency, null);
  },
);

// --- Budgets at ingest (ADR 0003 §4), behind INGEST_KEY_SPEND --------------

async function withSpendFlag(on: boolean, fn: () => Promise<void>) {
  const before = env.INGEST_KEY_SPEND;
  env.INGEST_KEY_SPEND = on;
  try {
    await fn();
  } finally {
    env.INGEST_KEY_SPEND = before;
  }
}

// One row costing exactly 1 USD at the test price.
function dollarRow(keyId: string, rootKeyId: string, parentKeyId?: string) {
  return usageRow(keyId, {
    root_key_id: rootKeyId,
    parent_key_id: parentKeyId ?? null,
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
}

Deno.test(
  "ingest: INGEST_KEY_SPEND off leaves key_spend alone",
  T,
  async () => {
    await resetDb();
    await addPrice("2026-01-01T00:00:00Z", 1);
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id, budgetUsd: 0.5 });
    await withSpendFlag(false, async () => {
      await poll([dollarRow(keyId, keyId)]);
    });
    assertEquals(await spentUsd(keyId), null);
    assertEquals(await keyStatus(keyId), "active");
  },
);

Deno.test(
  "ingest: spend goes to the key and its root, once each, never twice on re-poll",
  T,
  async () => {
    await resetDb();
    await addPrice("2026-01-01T00:00:00Z", 1);
    const team = await seedTeam();
    const root = await seedKey({ teamId: team.id });
    const child = await seedKey({
      teamId: team.id,
      keyType: "derived",
      parentKeyId: root,
      rootKeyId: root,
    });
    const rows = [dollarRow(child, root, root), dollarRow(root, root)];
    await withSpendFlag(true, async () => {
      assertEquals(await poll(rows), 2);
      assertEquals(await poll(rows), 0); // the overlap re-read
    });
    assertEquals(await spentUsd(child), 1);
    assertEquals(await spentUsd(root), 2); // child's row + its own, not 3
    const [{ request_count }] = await adminSql<{ request_count: number }[]>`
    SELECT request_count FROM llm.key_spend WHERE key_id = ${root}
  `;
    assertEquals(request_count, 2);
  },
);

Deno.test("ingest: unpriced rows charge nothing", T, async () => {
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, budgetUsd: 1 });
  await withSpendFlag(true, async () => {
    await poll([usageRow(keyId, { model: "no-such-model" })]);
  });
  assertEquals(await spentUsd(keyId), null);
});

Deno.test(
  "ingest: a key and a root reaching their budget go over_budget",
  T,
  async () => {
    await resetDb();
    await addPrice("2026-01-01T00:00:00Z", 1);
    const team = await seedTeam();
    const root = await seedKey({ teamId: team.id, budgetUsd: 2 });
    const child = await seedKey({
      teamId: team.id,
      keyType: "derived",
      parentKeyId: root,
      rootKeyId: root,
      budgetUsd: 1,
    });
    const sibling = await seedKey({
      teamId: team.id,
      keyType: "derived",
      parentKeyId: root,
      rootKeyId: root,
    });
    await withSpendFlag(true, async () => {
      await poll([dollarRow(sibling, root, root)]);
      assertEquals(await keyStatus(root), "active"); // 1 of 2
      await poll([dollarRow(child, root, root)]);
    });
    assertEquals(await keyStatus(child), "over_budget"); // 1 >= 1
    assertEquals(await keyStatus(root), "over_budget"); // 2 >= 2
    assertEquals(await keyStatus(sibling), "active"); // no budget of its own
  },
);

Deno.test(
  "ingest: a revoked key stays revoked when it passes its budget",
  T,
  async () => {
    await resetDb();
    await addPrice("2026-01-01T00:00:00Z", 1);
    const team = await seedTeam();
    const keyId = await seedKey({
      teamId: team.id,
      budgetUsd: 0.5,
      status: "revoked",
    });
    await withSpendFlag(true, async () => {
      await poll([dollarRow(keyId, keyId)]);
    });
    assertEquals(await spentUsd(keyId), 1);
    assertEquals(await keyStatus(keyId), "revoked");
  },
);

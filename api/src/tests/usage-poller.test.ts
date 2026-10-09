import "./support/env.ts";
import { assertEquals, assertRejects } from "@std/assert";
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
// values, including a unicode model name and a null cost_usd.

const originalFetch = globalThis.fetch;

const ORIGIN = "http://proxy.test";
const STORE = "store-a";

function mockUsageEndpoint(
  rows: unknown[],
  maxId: number | null,
  storeId = STORE,
) {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/usage")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ rows, store_id: storeId, max_id: maxId }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

Deno.test("pollOnce: a seeded usage row round-trips into llm.usage_log", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, label: "poller test key" });

  mockUsageEndpoint(
    [
      {
        id: 42,
        key_id: keyId,
        parent_key_id: null,
        root_key_id: keyId,
        model: "kimi-k2.7-日本語", // unicode in the model name
        input_tokens: 1000,
        output_tokens: 250,
        cost_usd: 0.0123,
        created_at: "2026-08-20T12:00:00.000Z",
      },
    ],
    42,
  );
  try {
    const cursor = await pollOnce(ORIGIN, STORE, 0);
    assertEquals(cursor, 42);
  } finally {
    restoreFetch();
  }

  const [row] = await adminSql<{
    id: string;
    key_id: string;
    root_key_id: string;
    model: string;
    cost_usd: string;
    tokens_in: number;
    tokens_out: number;
    metadata: unknown;
  }[]>`
    SELECT id::text, key_id::text, root_key_id::text, model, cost_usd::text,
           tokens_in, tokens_out, metadata
    FROM llm.usage_log WHERE store_id = ${STORE} AND source_id = 42
  `;
  if (!row) {
    throw new Error("expected the poller to have inserted source row 42");
  }
  assertEquals(row.key_id, keyId);
  assertEquals(row.root_key_id, keyId);
  assertEquals(row.model, "kimi-k2.7-日本語");
  assertEquals(row.tokens_in, 1000);
  assertEquals(row.tokens_out, 250);
  assertEquals(Number(row.cost_usd), 0.0123);
  assertEquals(row.metadata, null);
});

Deno.test("pollOnce: a null cost_usd round-trips as null, not an error", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({
    teamId: team.id,
    label: "poller null-cost key",
  });

  mockUsageEndpoint(
    [
      {
        id: 43,
        key_id: keyId,
        parent_key_id: null,
        root_key_id: keyId,
        model: "some-model",
        input_tokens: 5,
        output_tokens: 5,
        cost_usd: null,
        created_at: "2026-08-20T12:00:01.000Z",
      },
    ],
    43,
  );
  try {
    await pollOnce(ORIGIN, STORE, 0);
  } finally {
    restoreFetch();
  }

  const [row] = await adminSql<{ cost_usd: string | null }[]>`
    SELECT cost_usd::text FROM llm.usage_log WHERE source_id = 43
  `;
  if (!row) {
    throw new Error("expected the poller to have inserted source row 43");
  }
  assertEquals(row.cost_usd, null);
});

Deno.test(
  "pollOnce: re-polling the same page is idempotent (ON CONFLICT DO NOTHING)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({
      teamId: team.id,
      label: "poller idempotency key",
    });

    const page = [
      {
        id: 44,
        key_id: keyId,
        parent_key_id: null,
        root_key_id: keyId,
        model: "m",
        input_tokens: 1,
        output_tokens: 1,
        cost_usd: 0.01,
        created_at: "2026-08-20T12:00:02.000Z",
      },
    ];
    mockUsageEndpoint(page, 44);
    try {
      await pollOnce(ORIGIN, STORE, 0);
      await pollOnce(ORIGIN, STORE, 0); // re-poll from the same `since` — must not throw or duplicate
    } finally {
      restoreFetch();
    }

    const [{ n }] = await adminSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM llm.usage_log WHERE source_id = 44
  `;
    assertEquals(n, 1);
  },
);

Deno.test("pollOnce: no rows / max_id null returns the same cursor", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  mockUsageEndpoint([], null);
  try {
    const cursor = await pollOnce(ORIGIN, STORE, 7);
    assertEquals(cursor, 7);
  } finally {
    restoreFetch();
  }
});

Deno.test(
  "pollOnce: a row for a deleted key is skipped, the rest land, the cursor advances",
  {
    sanitizeOps: false,
    sanitizeResources: false,
  },
  async () => {
    // key_id is a foreign key: before the fix one such row failed the whole
    // page, the cursor never advanced, and the ledger stalled for every key.
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id, label: "live key" });
    const row = (id: number, key: string) => ({
      id,
      key_id: key,
      parent_key_id: null,
      root_key_id: key,
      model: "glm-5",
      input_tokens: 1,
      output_tokens: 1,
      cost_usd: 0.000001,
      created_at: "2026-09-23T12:00:00.000Z",
    });
    mockUsageEndpoint([row(1, crypto.randomUUID()), row(2, keyId)], 2);
    try {
      const cursor = await pollOnce(ORIGIN, STORE, 0);
      assertEquals(cursor, 2);
      const rows = await adminSql<{ source_id: number }[]>`
      SELECT source_id::int FROM llm.usage_log ORDER BY source_id
    `;
      assertEquals(rows.map((r) => r.source_id), [2]);
    } finally {
      restoreFetch();
    }
  },
);

const usageRow = (id: number, key: string) => ({
  id,
  key_id: key,
  parent_key_id: null,
  root_key_id: key,
  model: "glm-5.3",
  input_tokens: 1,
  output_tokens: 1,
  cost_usd: 0.001,
  created_at: "2026-10-09T12:00:00.000Z",
});

Deno.test(
  "pollOnce: two machines' rows with the same local id both land",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // Every proxy machine numbers its SQLite rows from 1. Keyed on the local
    // id alone, the second machine's row 1 was dropped as a conflict.
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id, label: "two stores" });
    try {
      mockUsageEndpoint([usageRow(1, keyId)], 1, "store-arn");
      await pollOnce(ORIGIN, "store-arn", 0);
      mockUsageEndpoint([usageRow(1, keyId)], 1, "store-fra");
      await pollOnce(ORIGIN, "store-fra", 0);
    } finally {
      restoreFetch();
    }
    const rows = await adminSql<{ store_id: string; source_id: number }[]>`
      SELECT store_id, source_id::int FROM llm.usage_log ORDER BY store_id
    `;
    assertEquals([...rows], [
      { store_id: "store-arn", source_id: 1 },
      { store_id: "store-fra", source_id: 1 },
    ]);
  },
);

Deno.test(
  "pollOnce: a different store answering at the origin throws, inserts nothing",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id, label: "store swap" });
    mockUsageEndpoint([usageRow(5, keyId)], 5, "store-new");
    try {
      await assertRejects(() => pollOnce(ORIGIN, "store-old", 0));
    } finally {
      restoreFetch();
    }
    const [{ n }] = await adminSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM llm.usage_log
    `;
    assertEquals(n, 0);
  },
);

Deno.test(
  "pollAll: probes the store, resumes from its MAX(source_id), keeps the cursor",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // LLM_PROXY_URL in tests is not a *.internal name, so pollAll polls it as
    // the single satellite.
    await resetDb();
    const team = await seedTeam();
    const keyId = await seedKey({ teamId: team.id, label: "poll all" });
    mockUsageEndpoint([usageRow(3, keyId)], 3, "store-x");
    const state = { storeAt: new Map(), cursors: new Map() };
    try {
      await pollAll(state);
    } finally {
      restoreFetch();
    }
    assertEquals([...state.storeAt.values()], ["store-x"]);
    assertEquals(state.cursors.get("store-x"), 3);
    const [{ n }] = await adminSql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM llm.usage_log WHERE store_id = 'store-x'
    `;
    assertEquals(n, 1);
  },
);

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
    metadata: unknown;
  }[]>`
    SELECT machine_id, key_id::text, model, cost_usd::text, tokens_in,
           tokens_out, metadata
    FROM llm.usage_log WHERE usage_id = ${row.usage_id as string}
  `;
  if (!got) throw new Error("expected the poller to have inserted the row");
  assertEquals(got.machine_id, "m-arn");
  assertEquals(got.key_id, keyId);
  assertEquals(got.model, "kimi-k2.7-日本語");
  assertEquals(got.tokens_in, 1000);
  assertEquals(got.tokens_out, 250);
  assertEquals(Number(got.cost_usd), 0.0123);
  assertEquals(got.metadata, null);
});

Deno.test("pollOnce: a null cost_usd round-trips as null", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const keyId = await seedKey({ teamId: team.id, label: "null cost" });
  const row = usageRow(keyId, { cost_usd: null });
  mockUsageEndpoint([row]);
  try {
    await pollOnce(ORIGIN, "0");
  } finally {
    restoreFetch();
  }
  const [got] = await adminSql<{ cost_usd: string | null }[]>`
    SELECT cost_usd::text FROM llm.usage_log
     WHERE usage_id = ${row.usage_id as string}
  `;
  assertEquals(got.cost_usd, null);
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

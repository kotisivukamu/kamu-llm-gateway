import "./support/env.ts";
import { assertAlmostEquals, assertEquals } from "@std/assert";
import { computeCostUsd } from "@shared/pricing.ts";
import { MODELS } from "../../../proxy/src/catalog.ts";
import { hashKey, signSubKeyJwt } from "../lib/keys.ts";
import { cursorOf } from "../routes/usage.ts";
import { buildTestApp } from "./support/app.ts";
import { adminSql, resetDb, seedKey, seedTeam } from "./support/db.ts";

// Key-holder GET /usage on the api (ADR 0003 §5): the proxy's contract, served
// from llm.usage_log with the ingest-priced cost, after an ingest pass that
// started with the request.

const T = { sanitizeOps: false, sanitizeResources: false };
const originalFetch = globalThis.fetch;

// The proxy feed (LLM_PROXY_URL in tests is one plain URL): answers the
// poller's `after=` reads from `feed`, or fails when `down`.
let feed: Record<string, unknown>[] = [];
let down = false;
function mockProxy() {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (down) return Promise.resolve(new Response("down", { status: 503 }));
    const after = url.searchParams.get("after") ?? "0";
    const rows = feed.filter((r) => (r.usage_id as string) > after);
    return Promise.resolve(Response.json({ rows }));
  }) as typeof fetch;
}

let seq = 0;
function usageId(ms: number): string {
  const ts = ms.toString(16).padStart(12, "0");
  const counter = (seq++ % 4096).toString(16).padStart(3, "0");
  const rand = crypto.randomUUID().replaceAll("-", "");
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${counter}-8${rand.slice(0, 3)}-${
    rand.slice(3, 15)
  }`;
}

function feedRow(
  key: string,
  root: string,
  ms: number,
): Record<string, unknown> {
  return {
    usage_id: usageId(ms),
    machine_id: "m-arn",
    key_id: key,
    parent_key_id: key === root ? null : root,
    root_key_id: root,
    model: "glm-5.3",
    provider_slug: "cortecs",
    input_tokens: 1000,
    output_tokens: 200,
    cache_read_tokens: 5000,
    cache_write_tokens: 0,
    cost_usd: 999, // the proxy's estimate: never what the api serves
    created_at: new Date(ms).toISOString(),
  };
}

const glm = MODELS["glm-5.3"];
const rowCost = computeCostUsd(glm, {
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_tokens: 5000,
  cache_write_tokens: 0,
});

async function fixture() {
  await resetDb();
  const team = await seedTeam();
  const secret = `sk_live_${crypto.randomUUID().replaceAll("-", "")}`;
  const top = await seedKey({
    teamId: team.id,
    label: "builder-queue",
    keyHash: await hashKey(secret),
  });
  const child = await seedKey({
    teamId: team.id,
    label: "build 1",
    keyType: "derived",
    parentKeyId: top,
    rootKeyId: top,
  });
  const other = await seedKey({ teamId: team.id, label: "other" });
  const jwt = await signSubKeyJwt(
    { jti: child, sub: top, models: ["*"], budget_usd: null, metadata: null },
    Math.floor(Date.now() / 1000) + 3600,
  );
  return { top, child, other, secret, jwt };
}

async function get(token: string, query = "") {
  const res = await buildTestApp().request(`/usage${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { res, body: res.status === 200 ? await res.json() : null };
}

Deno.test(
  "key usage: a read ingests first and serves the api-priced cost",
  T,
  async () => {
    const k = await fixture();
    const ms = Date.parse("2026-10-16T10:00:00Z");
    feed = [feedRow(k.child, k.top, ms), feedRow(k.child, k.top, ms + 1)];
    mockProxy();
    try {
      // Nothing is in Postgres yet: the read's own ingest pass brings it in.
      const { res, body } = await get(k.jwt, `?jti=${k.child}`);
      assertEquals(res.headers.get("x-usage-partial"), null);
      assertEquals(body.rows.length, 2);
      const [r] = body.rows;
      assertEquals(r.id, cursorOf(r.usage_id));
      assertEquals(r.jti, k.child);
      assertEquals(r.name, "build 1");
      assertEquals(r.cache_read_tokens, 5000);
      assertAlmostEquals(r.cost_usd, rowCost!, 1e-6);
      assertEquals(body.max_id, body.rows[1].id);
      assertEquals(body.totals.requests, 2);
      assertEquals(body.totals.input_tokens, 2000);
      assertEquals(body.totals.cache_read_tokens, 10000);
      assertAlmostEquals(body.totals.cost_usd, 2 * rowCost!, 1e-6);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("key usage: `since` pages by the cursor", T, async () => {
  const k = await fixture();
  const ms = Date.parse("2026-10-16T10:00:00Z");
  feed = [0, 1, 2].map((i) => feedRow(k.child, k.top, ms + i));
  mockProxy();
  try {
    const first = await get(k.jwt, "?limit=2");
    assertEquals(first.body.rows.length, 2);
    const next = await get(k.jwt, `?since=${first.body.max_id}`);
    assertEquals(next.body.rows.length, 1);
    assertEquals(next.body.rows[0].usage_id, feed[2].usage_id);
    const after = await get(k.jwt, `?since=${next.body.max_id}`);
    assertEquals(after.body.rows, []);
    assertEquals(after.body.max_id, null);
    assertEquals(after.body.totals.cost_usd, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  "key usage: a derived key sees only its rows, a top key its subtree",
  T,
  async () => {
    const k = await fixture();
    const ms = Date.parse("2026-10-16T10:00:00Z");
    feed = [
      feedRow(k.child, k.top, ms),
      feedRow(k.top, k.top, ms + 1),
      feedRow(k.other, k.other, ms + 2),
    ];
    mockProxy();
    try {
      const derived = await get(k.jwt);
      assertEquals(derived.body.rows.map((r: { key_id: string }) => r.key_id), [
        k.child,
      ]);
      // A filter narrows, never widens.
      const widened = await get(k.jwt, `?key_id=${k.other}`);
      assertEquals(widened.body.rows, []);
      const top = await get(k.secret);
      assertEquals(top.body.rows.map((r: { key_id: string }) => r.key_id), [
        k.child,
        k.top,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("key usage: credentials are checked like the proxy", T, async () => {
  const k = await fixture();
  feed = [];
  mockProxy();
  try {
    assertEquals((await get("nope")).res.status, 401);
    assertEquals((await get(`${k.jwt.slice(0, -2)}xx`)).res.status, 401);
    // Over budget may still read its usage.
    await adminSql`UPDATE llm.keys SET status = 'over_budget' WHERE id = ${k.child}`;
    assertEquals((await get(k.jwt)).res.status, 200);
    // A revoked root denies its derived keys.
    await adminSql`UPDATE llm.keys SET status = 'revoked' WHERE id = ${k.top}`;
    assertEquals((await get(k.jwt)).res.status, 401);
    assertEquals((await get(k.secret)).res.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test(
  "key usage: a proxy that cannot be polled is named in X-Usage-Partial",
  T,
  async () => {
    const k = await fixture();
    down = true;
    mockProxy();
    try {
      const { res, body } = await get(k.jwt);
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("x-usage-partial"), "http://localhost:8301");
      assertEquals(body.rows, []);
    } finally {
      down = false;
      globalThis.fetch = originalFetch;
    }
  },
);

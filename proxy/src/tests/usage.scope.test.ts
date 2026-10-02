import "./support/env.ts";
import { assertEquals } from "@std/assert";
import postgres from "postgres";
import { importJWK, SignJWT } from "jose";
import { gateway } from "../gateway-db.ts";
import { recordUsage } from "../db.ts";
import { usage } from "../routes/usage.ts";

// GET /usage scoping (routes/usage.ts). The poll secret sees every row; a
// gateway credential sees only its own tree (top-level key: root_key_id =
// self) or itself (derived key: key_id = self). Filters narrow, never widen.
// Keys are real llm.keys rows in Postgres (verified through auth.ts exactly as
// the /llm routes do); usage rows go into the in-memory SQLite ledger
// (DB_PATH=:memory: from support/env.ts) via the same recordUsage the metering
// tee uses.

const admin = postgres(
  Deno.env.get("GATEWAY_DATABASE_URL")!.replace(
    /\/\/[^@]+@/,
    "//postgres:postgres@",
  ),
  { connection: { search_path: "llm,public" }, onnotice: () => {} },
);

// Whatever the environment set (CI sets its own; support/env.ts defaults it
// otherwise) — the same value routes/usage.ts compares against.
const POLL_TOKEN = Deno.env.get("CONTROL_PLANE_POLL_TOKEN")!;

// Throwaway Ed25519 test key pair: the private half matches the test
// ED25519_PUBLIC_KEY in support/env.ts (same pair as api/src/tests and CI).
const TEST_PRIVATE_KEY = "9eoI/HkwmmgkmKzs9yu8drtLyeglFbz5FIulBSRHXrk=";

function b64url(b64: string): string {
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function signSubKey(jti: string, expEpochSeconds: number) {
  const key = await importJWK({
    kty: "OKP",
    crv: "Ed25519",
    d: b64url(TEST_PRIVATE_KEY),
    x: b64url(Deno.env.get("ED25519_PUBLIC_KEY")!),
  }, "EdDSA");
  return await new SignJWT({ jti, sub: "root" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-ed25519-1" })
    .setIssuedAt()
    .setExpirationTime(expEpochSeconds)
    .sign(key);
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function seedTeam(): Promise<string> {
  const org = `org_usage_${crypto.randomUUID()}`;
  const [team] = await admin<{ id: string }[]>`
    INSERT INTO llm.teams (kamuid_org_id, name, slug)
    VALUES (${org}, 'Usage Scope Test', ${org})
    RETURNING id
  `;
  return team.id;
}

async function seedTop(
  teamId: string,
  opts: { expiresAt?: string } = {},
): Promise<{ id: string; secret: string }> {
  const secret = `sk_live_${crypto.randomUUID().replaceAll("-", "")}`;
  const [key] = await admin<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, status, expires_at)
    VALUES (${teamId}, 'top', ${await sha256Hex(secret)}, 'sk_live_test',
            'top', '{"*"}', 'active', ${opts.expiresAt ?? null})
    RETURNING id
  `;
  await admin`UPDATE llm.keys SET root_key_id = id WHERE id = ${key.id}`;
  return { id: key.id, secret };
}

async function seedChild(
  teamId: string,
  parentId: string,
): Promise<{ id: string; jwt: string }> {
  const [key] = await admin<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_type, models, status, parent_key_id, root_key_id,
       expires_at)
    VALUES (${teamId}, 'child', 'derived', '{"*"}', 'active', ${parentId},
            ${parentId}, now() + interval '1 hour')
    RETURNING id
  `;
  const jwt = await signSubKey(key.id, Math.floor(Date.now() / 1000) + 3600);
  return { id: key.id, jwt };
}

function use(
  key_id: string,
  root_key_id: string,
  parent_key_id: string | null,
  name: string,
  cost_usd: number | null,
) {
  recordUsage({
    key_id,
    name,
    parent_key_id,
    root_key_id,
    model: "glm-5.3",
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 5,
    cache_write_tokens: 1,
    cost_usd,
  });
}

interface Page {
  rows: Array<{ id: number; key_id: string; jti: string; name: string }>;
  max_id: number | null;
  totals: {
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    cost_usd: number;
  };
}

async function get(
  bearer: string,
  query = "",
): Promise<{ status: number; body: Page }> {
  const res = await usage.request(`/${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  return { status: res.status, body: await res.json() };
}

// One fixture for the whole file: tree A (top + two children) and an
// unrelated tree B in another team.
const teamA = await seedTeam();
const topA = await seedTop(teamA);
const childA1 = await seedChild(teamA, topA.id);
const childA2 = await seedChild(teamA, topA.id);
const teamB = await seedTeam();
const topB = await seedTop(teamB);
const childB = await seedChild(teamB, topB.id);

use(topA.id, topA.id, null, "top-a", 0.5);
use(childA1.id, topA.id, topA.id, "build-1", 0.25);
use(childA1.id, topA.id, topA.id, "build-1", null);
use(childA2.id, topA.id, topA.id, "build-2", 1);
use(topB.id, topB.id, null, "top-b", 2);
use(childB.id, topB.id, topB.id, "build-1", 4);

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "poll secret: sees every row, shape unchanged plus totals",
  fn: async () => {
    const { status, body } = await get(POLL_TOKEN);
    assertEquals(status, 200);
    assertEquals(body.rows.length, 6);
    assertEquals(body.max_id, body.rows[5].id);
    assertEquals(body.totals.requests, 6);
    assertEquals(body.totals.cost_usd, 7.75);
  },
  ...opts,
});

Deno.test({
  name: "top-level key: own rows + its children's, nothing of another tree",
  fn: async () => {
    const { status, body } = await get(topA.secret);
    assertEquals(status, 200);
    assertEquals(
      body.rows.map((r) => r.key_id),
      [topA.id, childA1.id, childA1.id, childA2.id],
    );
    assertEquals(body.totals, {
      requests: 4,
      input_tokens: 400,
      output_tokens: 40,
      cache_read_tokens: 20,
      cache_write_tokens: 4,
      cost_usd: 1.75, // the null-cost row is counted, not priced
    });
  },
  ...opts,
});

Deno.test({
  name: "top-level key: x-api-key header works too",
  fn: async () => {
    const res = await usage.request("/", {
      headers: { "x-api-key": topB.secret },
    });
    assertEquals(res.status, 200);
    const body = await res.json() as Page;
    assertEquals(body.rows.map((r) => r.key_id), [topB.id, childB.id]);
  },
  ...opts,
});

Deno.test({
  name: "derived key: only its own rows",
  fn: async () => {
    const { status, body } = await get(childA1.jwt);
    assertEquals(status, 200);
    assertEquals(body.rows.map((r) => r.key_id), [childA1.id, childA1.id]);
    assertEquals(body.rows.every((r) => r.jti === childA1.id), true);
    assertEquals(body.totals.requests, 2);
    assertEquals(body.totals.cost_usd, 0.25);
  },
  ...opts,
});

Deno.test({
  name: "filters: jti/key_id/name narrow within scope",
  fn: async () => {
    const byJti = await get(topA.secret, `?jti=${childA2.id}`);
    assertEquals(byJti.body.rows.map((r) => r.key_id), [childA2.id]);
    assertEquals(byJti.body.totals.cost_usd, 1);

    const byKeyId = await get(topA.secret, `?key_id=${childA1.id}`);
    assertEquals(byKeyId.body.rows.length, 2);

    // name=build-1 exists in both trees; a key holder sees only its own.
    const byName = await get(topA.secret, "?name=build-1");
    assertEquals(byName.body.rows.map((r) => r.key_id), [
      childA1.id,
      childA1.id,
    ]);
    const pollByName = await get(POLL_TOKEN, "?name=build-1");
    assertEquals(pollByName.body.rows.length, 3);

    // since + limit still page as before.
    const first = byName.body.rows[0].id;
    const after = await get(topA.secret, `?name=build-1&since=${first}`);
    assertEquals(after.body.rows.length, 1);
    const limited = await get(POLL_TOKEN, "?limit=2");
    assertEquals(limited.body.rows.length, 2);
    assertEquals(limited.body.totals.requests, 2);
  },
  ...opts,
});

Deno.test({
  name:
    "filters never widen: another tree's key_id or a sibling's jti is empty",
  fn: async () => {
    const other = await get(topA.secret, `?key_id=${childB.id}`);
    assertEquals(other.status, 200);
    assertEquals(other.body.rows, []);
    assertEquals(other.body.max_id, null);
    assertEquals(other.body.totals.requests, 0);
    assertEquals(other.body.totals.cost_usd, 0);

    const sibling = await get(childA1.jwt, `?jti=${childA2.id}`);
    assertEquals(sibling.body.rows, []);
    const parent = await get(childA1.jwt, `?key_id=${topA.id}`);
    assertEquals(parent.body.rows, []);
  },
  ...opts,
});

Deno.test({
  name: "bad, expired, or revoked credential: 401",
  fn: async () => {
    assertEquals((await usage.request("/")).status, 401);
    assertEquals((await get("not-a-key")).status, 401);
    assertEquals((await get("sk_live_doesnotexist")).status, 401);

    const expiredJwt = await signSubKey(
      childA1.id,
      Math.floor(Date.now() / 1000) - 60,
    );
    assertEquals((await get(expiredJwt)).status, 401);

    const expiredTop = await seedTop(teamA, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assertEquals((await get(expiredTop.secret)).status, 401);

    // Revoked derived row: a fresh id so the key-meta cache has no entry.
    const revoked = await seedChild(teamA, topA.id);
    await admin`UPDATE llm.keys SET status = 'revoked' WHERE id = ${revoked.id}`;
    assertEquals((await get(revoked.jwt)).status, 401);

    // A JWT signed by some other key.
    const forged = childA1.jwt.slice(0, -4) + "AAAA";
    assertEquals((await get(forged)).status, 401);
  },
  ...opts,
});

Deno.test({
  name: "cleanup: close pools",
  fn: async () => {
    await admin.end();
    await gateway.end();
  },
  ...opts,
});

import "./support/env.ts";
import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import { importJWK, SignJWT } from "jose";
import { gateway } from "../gateway-db.ts";
import { recordUsage } from "../db.ts";
import { cursorOf, siblings, usage } from "../routes/usage.ts";

// A key holder's GET /usage merges every proxy machine (routes/usage.ts):
// this machine's SQLite plus GET /usage/local on each sibling. Siblings here
// are tiny local HTTP servers answering with canned rows; discovery is
// swapped for their origins. Keys are real llm.keys rows (verified through
// auth.ts like the /llm routes), local rows go through recordUsage.

const admin = postgres(
  Deno.env.get("GATEWAY_DATABASE_URL")!.replace(
    /\/\/[^@]+@/,
    "//postgres:postgres@",
  ),
  { connection: { search_path: "llm,public" }, onnotice: () => {} },
);

const POLL_TOKEN = Deno.env.get("CONTROL_PLANE_POLL_TOKEN")!;

// Throwaway Ed25519 test key pair (same as usage.scope.test.ts and CI).
const TEST_PRIVATE_KEY = "9eoI/HkwmmgkmKzs9yu8drtLyeglFbz5FIulBSRHXrk=";

function b64url(b64: string): string {
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const org = `org_merge_${crypto.randomUUID()}`;
const [team] = await admin<{ id: string }[]>`
  INSERT INTO llm.teams (kamuid_org_id, name, slug)
  VALUES (${org}, 'Usage Merge Test', ${org})
  RETURNING id
`;
const topSecret = `sk_live_${crypto.randomUUID().replaceAll("-", "")}`;
const [top] = await admin<{ id: string }[]>`
  INSERT INTO llm.keys
    (team_id, label, key_hash, prefix, key_type, models, status)
  VALUES (${team.id}, 'top', ${await sha256Hex(topSecret)}, 'sk_live_test',
          'top', '{"*"}', 'active')
  RETURNING id
`;
await admin`UPDATE llm.keys SET root_key_id = id WHERE id = ${top.id}`;

async function seedChild(): Promise<{ id: string; jwt: string }> {
  const [key] = await admin<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_type, models, status, parent_key_id, root_key_id,
       expires_at)
    VALUES (${team.id}, 'child', 'derived', '{"*"}', 'active', ${top.id},
            ${top.id}, now() + interval '1 hour')
    RETURNING id
  `;
  const signing = await importJWK({
    kty: "OKP",
    crv: "Ed25519",
    d: b64url(TEST_PRIVATE_KEY),
    x: b64url(Deno.env.get("ED25519_PUBLIC_KEY")!),
  }, "EdDSA");
  const jwt = await new SignJWT({ jti: key.id, sub: "root" })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-ed25519-1" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(signing);
  return { id: key.id, jwt };
}

function use(keyId: string, inputTokens: number, cost: number) {
  recordUsage({
    key_id: keyId,
    name: "build",
    parent_key_id: top.id,
    root_key_id: top.id,
    model: "glm-5.3",
    provider_slug: "cortecs",
    input_tokens: inputTokens,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    provider_cost: null,
    cost_usd: cost,
  });
}

// A UUIDv7 for a given ms + counter (random tail), like db.ts uuidv7 makes.
function idAt(ms: number, counter: number): string {
  const t = ms.toString(16).padStart(12, "0");
  const c = counter.toString(16).padStart(3, "0");
  const tail = crypto.randomUUID().slice(19);
  return `${t.slice(0, 8)}-${t.slice(8)}-7${c}-${tail}`;
}

function siblingRow(keyId: string, usageId: string, inputTokens: number) {
  return {
    id: cursorOf(usageId),
    usage_id: usageId,
    machine_id: "sibling",
    key_id: keyId,
    jti: keyId,
    name: "build",
    parent_key_id: top.id,
    root_key_id: top.id,
    model: "glm-5.3",
    provider_slug: "cortecs",
    input_tokens: inputTokens,
    output_tokens: 1,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    provider_cost: null,
    cost_usd: 0.5,
    created_at: new Date().toISOString(),
  };
}

const FAR_FLOOR = Number.MAX_SAFE_INTEGER;

// A fake sibling: answers GET /usage/local with whatever `respond` returns
// and records each request URL + auth header.
function fakeSibling(
  respond: (url: URL) => Response | Promise<Response>,
) {
  const seen: Array<{ url: URL; auth: string | null }> = [];
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    const url = new URL(req.url);
    seen.push({ url, auth: req.headers.get("authorization") });
    return respond(url);
  });
  return { origin: `http://127.0.0.1:${server.addr.port}`, seen, server };
}

interface Page {
  rows: Array<
    { id: number; usage_id: string; key_id: string; input_tokens: number }
  >;
  max_id: number | null;
  totals: { requests: number; input_tokens: number; cost_usd: number };
}

async function get(bearer: string, query: string) {
  const res = await usage.request(`/${query}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  return {
    status: res.status,
    partial: res.headers.get("x-usage-partial"),
    body: await res.json() as Page,
  };
}

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "merge: local + two siblings, deduped by usage_id, ordered by id",
  fn: async () => {
    const child = await seedChild();
    use(child.id, 1, 0.25);
    use(child.id, 2, 0.25);
    // Find the local rows' usage_ids (the poll path still sees only them).
    const local = await get(POLL_TOKEN, `?jti=${child.id}`);
    assertEquals(local.body.rows.length, 2);
    const [l1, l2] = local.body.rows;

    const now = Date.now();
    const early = idAt(now - 60_000, 0); // before both local rows
    const a = fakeSibling(() =>
      Response.json({
        // l2 again: a row both machines report must count once.
        rows: [siblingRow(child.id, early, 10), {
          ...siblingRow(child.id, l2.usage_id, 2),
          machine_id: "local",
        }],
        floor: FAR_FLOOR,
      })
    );
    const late = idAt(now - 1000, 7);
    const b = fakeSibling(() =>
      Response.json({
        rows: [siblingRow(child.id, late, 20)],
        floor: FAR_FLOOR,
      })
    );
    siblings.discover = () => Promise.resolve([a.origin, b.origin]);
    try {
      const { status, partial, body } = await get(
        child.jwt,
        `?since=0&jti=${child.id}&limit=5000`,
      );
      assertEquals(status, 200);
      assertEquals(partial, null);
      assertEquals(body.rows.map((r) => r.input_tokens).sort(), [1, 10, 2, 20]);
      assertEquals(body.rows[0].usage_id, early);
      const ids = body.rows.map((r) => r.id);
      assertEquals(ids, [...ids].sort((x, y) => x - y));
      assertEquals(
        body.rows.map((r) => r.id),
        body.rows.map((r) => cursorOf(r.usage_id)),
      );
      assertEquals(body.max_id, ids[ids.length - 1]);
      assertEquals(body.totals.requests, 4);
      assertEquals(body.totals.input_tokens, 33);
      assertEquals(body.totals.cost_usd, 1.5);

      // Siblings were asked with the poll token, the caller's scope and the
      // caller's own params, on the internal endpoint.
      for (const s of [a, b]) {
        assertEquals(s.seen.length, 1);
        assertEquals(s.seen[0].url.pathname, "/usage/local");
        assertEquals(s.seen[0].auth, `Bearer ${POLL_TOKEN}`);
        assertEquals(s.seen[0].url.searchParams.get("scope_key"), child.id);
        assertEquals(s.seen[0].url.searchParams.get("scope_root"), null);
        assertEquals(s.seen[0].url.searchParams.get("jti"), child.id);
        assertEquals(s.seen[0].url.searchParams.get("since"), "0");
      }

      // A top-level key is scoped by root on the siblings.
      await get(topSecret, "");
      assertEquals(a.seen[1].url.searchParams.get("scope_root"), top.id);
      assertEquals(a.seen[1].url.searchParams.get("scope_key"), null);
      assert(body.rows.some((r) => r.usage_id === l1.usage_id));
    } finally {
      await a.server.shutdown();
      await b.server.shutdown();
    }
  },
  ...opts,
});

Deno.test({
  name: "merge: the builder's since=max_id loop counts every row once",
  fn: async () => {
    const child = await seedChild();
    let sibRows: ReturnType<typeof siblingRow>[] = [];
    const a = fakeSibling((url) => {
      const since = Number(url.searchParams.get("since"));
      return Response.json({
        rows: sibRows.filter((r) => r.id > since),
        floor: FAR_FLOOR,
      });
    });
    siblings.discover = () => Promise.resolve([a.origin]);
    try {
      use(child.id, 1, 0.1);
      sibRows = [siblingRow(child.id, idAt(Date.now() - 5, 0), 2)];
      const first = await get(child.jwt, `?since=0&jti=${child.id}`);
      assertEquals(first.body.totals.input_tokens, 3);

      // New rows on both machines after the cursor; nothing is re-counted.
      use(child.id, 4, 0.1);
      sibRows.push(siblingRow(child.id, idAt(Date.now() + 1, 0), 8));
      // Local floor is "now": wait until the sibling row is under it.
      await new Promise((r) => setTimeout(r, 5));
      const second = await get(
        child.jwt,
        `?since=${first.body.max_id}&jti=${child.id}`,
      );
      assertEquals(second.body.totals.input_tokens, 12);
      const third = await get(
        child.jwt,
        `?since=${second.body.max_id}&jti=${child.id}`,
      );
      assertEquals(third.body.rows, []);
      assertEquals(third.body.max_id, null);
    } finally {
      await a.server.shutdown();
    }
  },
  ...opts,
});

Deno.test({
  name: "merge: rows above a sibling's floor wait for a later read",
  fn: async () => {
    const child = await seedChild();
    const base = Date.now() - 10_000;
    const sib = siblingRow(child.id, idAt(base, 0), 2);
    let floor = cursorOf(idAt(base - 1, 0)); // sibling written up to before sib
    const a = fakeSibling(() => Response.json({ rows: [sib], floor }));
    siblings.discover = () => Promise.resolve([a.origin]);
    try {
      use(child.id, 1, 0.1); // newer than the sibling's floor
      const held = await get(child.jwt, `?jti=${child.id}`);
      assertEquals(held.body.rows, []);
      assertEquals(held.body.max_id, null);

      floor = FAR_FLOOR;
      const later = await get(child.jwt, `?since=0&jti=${child.id}`);
      assertEquals(later.body.rows.map((r) => r.input_tokens), [2, 1]);
    } finally {
      await a.server.shutdown();
    }
  },
  ...opts,
});

Deno.test({
  name: "merge: limit keeps rows that share the last id across machines",
  fn: async () => {
    const child = await seedChild();
    const ms = Date.now() - 20_000;
    const a = fakeSibling(() =>
      Response.json({
        rows: [
          siblingRow(child.id, idAt(ms, 0), 1),
          siblingRow(child.id, idAt(ms, 1), 2),
        ],
        floor: FAR_FLOOR,
      })
    );
    const b = fakeSibling(() =>
      Response.json({
        rows: [siblingRow(child.id, idAt(ms, 1), 3)], // same ms + counter
        floor: FAR_FLOOR,
      })
    );
    siblings.discover = () => Promise.resolve([a.origin, b.origin]);
    try {
      const page = await get(child.jwt, `?limit=2&jti=${child.id}`);
      assertEquals(page.body.rows.length, 3);
      assertEquals(page.body.rows[1].id, page.body.rows[2].id);
      const one = await get(child.jwt, `?limit=1&jti=${child.id}`);
      assertEquals(one.body.rows.map((r) => r.input_tokens), [1]);
    } finally {
      await a.server.shutdown();
      await b.server.shutdown();
    }
  },
  ...opts,
});

Deno.test({
  name: "merge: unreachable, failing or slow siblings give a partial answer",
  fn: async () => {
    const child = await seedChild();
    use(child.id, 5, 0.1);
    // A port nothing listens on: bind one, then close it.
    const closed = Deno.listen({ port: 0 });
    const closedOrigin = `http://127.0.0.1:${
      (closed.addr as Deno.NetAddr).port
    }`;
    closed.close();
    const failing = fakeSibling(() => new Response("boom", { status: 500 }));
    const slow = fakeSibling(() =>
      new Promise((r) =>
        setTimeout(() => r(Response.json({ rows: [], floor: 0 })), 3000)
      )
    );
    siblings.discover = () =>
      Promise.resolve([closedOrigin, failing.origin, slow.origin]);
    try {
      const t0 = Date.now();
      const { status, partial, body } = await get(
        child.jwt,
        `?jti=${child.id}`,
      );
      assert(Date.now() - t0 < 2900, "sibling timeout must be ~2 s");
      assertEquals(status, 200);
      assertEquals(body.rows.map((r) => r.input_tokens), [5]);
      assertEquals(partial, "127,127,127");

      siblings.discover = () => Promise.reject(new Error("no dns"));
      const noDns = await get(child.jwt, `?jti=${child.id}`);
      assertEquals(noDns.partial, "discovery");
      assertEquals(noDns.body.rows.map((r) => r.input_tokens), [5]);
    } finally {
      await failing.server.shutdown();
      await slow.server.shutdown();
    }
  },
  ...opts,
});

Deno.test({
  name: "poll token: local only, never asks siblings",
  fn: async () => {
    const child = await seedChild();
    use(child.id, 7, 0.1);
    let asked = false;
    siblings.discover = () => {
      asked = true;
      return Promise.resolve([]);
    };
    const { body, partial } = await get(POLL_TOKEN, `?jti=${child.id}`);
    assertEquals(asked, false);
    assertEquals(partial, null);
    assertEquals(body.rows.map((r) => r.input_tokens), [7]);
    // Poll-path ids stay this machine's row ids.
    assert(body.rows[0].id < 1_000_000);
  },
  ...opts,
});

Deno.test({
  name: "/usage/local: poll token only, scoped, this machine only",
  fn: async () => {
    const child = await seedChild();
    const other = await seedChild();
    use(child.id, 3, 0.1);
    use(other.id, 4, 0.1);
    let asked = false;
    siblings.discover = () => {
      asked = true;
      return Promise.resolve([]);
    };
    const local = (bearer: string, query: string) =>
      usage.request(`/local${query}`, {
        headers: { authorization: `Bearer ${bearer}` },
      });

    assertEquals(
      (await local(child.jwt, `?scope_key=${child.id}`)).status,
      401,
    );
    assertEquals((await local(topSecret, `?scope_root=${top.id}`)).status, 401);
    assertEquals((await local(POLL_TOKEN, "")).status, 400);
    assertEquals(
      (await local(POLL_TOKEN, `?scope_key=a&scope_root=b`)).status,
      400,
    );

    const res = await local(POLL_TOKEN, `?scope_key=${child.id}`);
    assertEquals(res.status, 200);
    const body = await res.json() as {
      rows: Array<{ id: number; usage_id: string; input_tokens: number }>;
      floor: number;
    };
    assertEquals(body.rows.map((r) => r.input_tokens), [3]);
    assertEquals(body.rows[0].id, cursorOf(body.rows[0].usage_id));
    assert(body.floor > body.rows[0].id);
    assertEquals(asked, false);

    // A scope filter never widens: the other key's rows via jti stay out.
    const narrowed = await local(
      POLL_TOKEN,
      `?scope_key=${child.id}&jti=${other.id}`,
    );
    assertEquals((await narrowed.json()).rows, []);
  },
  ...opts,
});

Deno.test({
  name: "cleanup: restore discovery, close pools",
  fn: async () => {
    siblings.discover = () => Promise.resolve([]);
    await admin.end();
    await gateway.end();
  },
  ...opts,
});

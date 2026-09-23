import "./support/env.ts";
import { assertEquals } from "@std/assert";
import { buildTestApp } from "./support/app.ts";
import { adminSql, resetDb, seedTeam } from "./support/db.ts";
import { generateTopLevelKey } from "../lib/keys.ts";
import { env } from "../env.ts";

// Regression for commit f48b3ba ("add absolute MAX_SUBKEY_TTL_SECONDS ceiling
// for derived sub-keys") — api/src/env.ts MAX_SUBKEY_TTL_SECONDS + keys.ts
// derive handler. Before the fix, the ONLY TTL clamp was "child cannot outlive
// its parent" (SS7.1) — which imposes no bound at all when the parent is
// UNBOUNDED (expires_at IS NULL, the permanent-service-key case, e.g. a
// studio/builder-queue key). A parent with no expiry could mint an
// arbitrarily long-lived (multi-year) sub-key. The fix adds a hard ceiling
// (MAX_SUBKEY_TTL_SECONDS, test env = 86400s/24h) independent of the
// parent-relative clamp, and verifies BOTH clamps are enforced with correct
// precedence (whichever of "parent remaining" and "the absolute ceiling" is
// tighter wins).

async function mintParent(
  teamId: string,
  expiresAt: string | null,
): Promise<string> {
  const { secret, hash, prefix } = await generateTopLevelKey();
  const [row] = await adminSql<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, status, expires_at)
    VALUES (${teamId}, 'ttl-test parent', ${hash}, ${prefix}, 'top', '{"*"}', 'active', ${expiresAt})
    RETURNING id
  `;
  await adminSql`UPDATE llm.keys SET root_key_id = id WHERE id = ${row.id}`;
  return secret;
}

async function derive(
  app: ReturnType<typeof buildTestApp>,
  secret: string,
  ttl: number,
) {
  return await app.request("/api/keys/derive", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ label: "ttl test child", expires_in_seconds: ttl }),
  });
}

Deno.test(
  "derive: unbounded parent + multi-year TTL is rejected by the absolute ceiling",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await resetDb();
    const team = await seedTeam();
    const secret = await mintParent(team.id, null); // unbounded parent
    const app = buildTestApp();

    const twoYears = 2 * 365 * 24 * 3600;
    const res = await derive(app, secret, twoYears);

    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(
      body.error,
      "expires_in_seconds exceeds the maximum sub-key TTL",
    );
    assertEquals(body.max_ttl_seconds, env.MAX_SUBKEY_TTL_SECONDS);
  },
);

Deno.test("derive: unbounded parent + TTL just under the ceiling succeeds", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const secret = await mintParent(team.id, null);
  const app = buildTestApp();

  const res = await derive(app, secret, env.MAX_SUBKEY_TTL_SECONDS - 60);
  assertEquals(res.status, 201);
});

Deno.test(
  "derive: unbounded parent + TTL exactly at the ceiling succeeds (inclusive)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await resetDb();
    const team = await seedTeam();
    const secret = await mintParent(team.id, null);
    const app = buildTestApp();

    const res = await derive(app, secret, env.MAX_SUBKEY_TTL_SECONDS);
    assertEquals(res.status, 201);
  },
);

Deno.test("derive: short TTL under both clamps succeeds", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const team = await seedTeam();
  const secret = await mintParent(team.id, null);
  const app = buildTestApp();

  const res = await derive(app, secret, 60);
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.key.status, "active");
});

Deno.test(
  "derive: a bounded parent expiring sooner than the ceiling still clamps to the parent (precedence)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // parent expires in 100s — well under the 86400s ceiling. The tighter clamp
    // (parent-remaining) must win: a 200s request is rejected by the
    // parent-relative check, NOT silently allowed because it's under the
    // absolute ceiling.
    await resetDb();
    const team = await seedTeam();
    const parentExpiresAt = new Date(Date.now() + 100_000).toISOString();
    const secret = await mintParent(team.id, parentExpiresAt);
    const app = buildTestApp();

    const res = await derive(app, secret, 200);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(
      body.error,
      "child expires_at cannot exceed the parent's remaining TTL",
    );
  },
);

Deno.test(
  "derive: a bounded parent expiring later than the ceiling is clamped by the absolute ceiling (precedence)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // parent expires far in the future (well beyond the ceiling) — the absolute
    // ceiling must be the one that fires, even though the parent-relative clamp
    // alone would have allowed it.
    await resetDb();
    const team = await seedTeam();
    const parentExpiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000)
      .toISOString();
    const secret = await mintParent(team.id, parentExpiresAt);
    const app = buildTestApp();

    const res = await derive(app, secret, env.MAX_SUBKEY_TTL_SECONDS + 3600);
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(
      body.error,
      "expires_in_seconds exceeds the maximum sub-key TTL",
    );
  },
);

Deno.test(
  "derive: omitting expires_in_seconds uses DEFAULT_SUBKEY_TTL_SECONDS (well under the ceiling)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await resetDb();
    const team = await seedTeam();
    const secret = await mintParent(team.id, null);
    const app = buildTestApp();

    const res = await app.request("/api/keys/derive", {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "default ttl child" }),
    });
    assertEquals(res.status, 201);
  },
);

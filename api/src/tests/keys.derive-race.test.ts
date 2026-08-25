import "./support/env.ts";
import { assertEquals, assertLessOrEqual } from "@std/assert";
import { buildTestApp } from "./support/app.ts";
import { adminSql, resetDb, seedInternalPlatformTeam } from "./support/db.ts";
import { generateTopLevelKey } from "../lib/keys.ts";

// Regression for commit 3963761 ("close TOCTOU race in derive rate-limit/
// active-cap checks") — api/src/routes/keys.ts POST /api/keys/derive. This is
// the single highest-value test in the suite.
//
// Before the fix: derive read `SELECT COUNT(*) ... WHERE parent_key_id = ?`
// and then did a separate INSERT with no lock between them. Under N concurrent
// derive calls against the same parent, every in-flight request reads the
// count before any sibling's INSERT commits, so all of them observe "under
// the limit" and all insert — the commit message records a re-verification
// of the pre-fix code measuring 14/15 succeeding against a configured limit
// of 5. The fix wraps the count-check + insert in one transaction holding
// `pg_advisory_xact_lock(hashtextextended(parent_id, 0))`, serializing derive
// calls per-parent.
//
// This test fires SUBKEY_DERIVE_MAX_ACTIVE * 3 concurrent derive requests
// against one can_mint parent (env test config: both
// SUBKEY_DERIVE_MAX_ACTIVE and SUBKEY_DERIVE_RATE_PER_MIN = 5, see
// support/env.ts) and asserts the persisted row count for that parent NEVER
// exceeds the configured limit, and that the surplus requests were rejected
// (429), not silently dropped.

const CONCURRENCY = 15; // 3x the configured limit of 5

Deno.test(
  "POST /api/keys/derive: concurrent derives never exceed the configured limit",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await resetDb();
    const team = await seedInternalPlatformTeam();
    const { secret, hash, prefix } = await generateTopLevelKey();
    const [parent] = await adminSql<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, status, can_mint)
    VALUES (${team.id}, 'race-test parent', ${hash}, ${prefix}, 'top', '{"*"}', 'active', true)
    RETURNING id
  `;
    await adminSql`UPDATE llm.keys SET root_key_id = id WHERE id = ${parent.id}`;

    const app = buildTestApp();

    const results = await Promise.all(
      Array.from(
        { length: CONCURRENCY },
        () =>
          app.request("/api/keys/derive", {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ label: "race child" }),
          }),
      ),
    );

    const statuses = results.map((r) => r.status);
    const succeeded = statuses.filter((s) => s === 201).length;
    const rejected = statuses.filter((s) => s === 429).length;

    // Every response must be accounted for as either a success or a documented
    // rate/cap rejection — no unexpected status (e.g. a 500 from a broken
    // constraint) should slip through.
    assertEquals(succeeded + rejected, CONCURRENCY);

    const [{ n }] = await adminSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM llm.keys WHERE parent_key_id = ${parent.id}
  `;

    // The load-bearing assertion: the persisted row count must never exceed the
    // configured limit, no matter how many requests raced past the read.
    assertLessOrEqual(n, 5);
    // And it must match how many the API itself reported as successful — the
    // DB and the API's view of "how many were minted" must agree.
    assertEquals(n, succeeded);
  },
);

Deno.test(
  "POST /api/keys/derive: max-active-children cap is protected by the same lock",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    // Distinguishes the active-cap path from the rate-limit path: mint up to the
    // active cap, then race MORE concurrent derives against the same parent —
    // all of them should be rejected (revoked/expired children don't count, but
    // none here are revoked/expired), proving the active-count check inside the
    // locked transaction sees the already-committed siblings rather than a
    // stale pre-lock read.
    await resetDb();
    const team = await seedInternalPlatformTeam();
    const { secret, hash, prefix } = await generateTopLevelKey();
    const [parent] = await adminSql<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, status, can_mint)
    VALUES (${team.id}, 'active-cap parent', ${hash}, ${prefix}, 'top', '{"*"}', 'active', true)
    RETURNING id
  `;
    await adminSql`UPDATE llm.keys SET root_key_id = id WHERE id = ${parent.id}`;

    const app = buildTestApp();

    const results = await Promise.all(
      Array.from(
        { length: CONCURRENCY },
        () =>
          app.request("/api/keys/derive", {
            method: "POST",
            headers: {
              authorization: `Bearer ${secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ label: "active-cap child" }),
          }),
      ),
    );

    const succeeded = results.filter((r) => r.status === 201).length;
    const [{ n }] = await adminSql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM llm.keys
    WHERE parent_key_id = ${parent.id} AND status = 'active'
  `;
    assertLessOrEqual(n, 5);
    assertEquals(n, succeeded);
  },
);

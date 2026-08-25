import "./support/env.ts";
import { assertEquals } from "@std/assert";
import postgres from "postgres";
import { gateway, lookupKeyByHash, lookupKeyById } from "../gateway-db.ts";

// Regression for commit 9ec9bde ("coerce budget_usd to number when hydrating
// the key-meta cache") — proxy/src/gateway-db.ts's `toKeyMeta`. Postgres NUMERIC
// columns come back from postgres.js as STRINGS (never auto-coerced, to avoid
// silent float precision loss). Before the fix, `budget_usd` on a KeyMeta was a
// string when the row had a budget, so a downstream numeric comparison
// (`spend > budget_usd`, ADR 0001 SS10.6 budget enforcement) would do string
// comparison ("9" > "10" is true) instead of numeric — silently breaking
// budget enforcement for any two-digit-or-more dollar amount.
//
// `toKeyMeta` itself isn't exported (private to the module), so this exercises
// it through the two public lookup functions against a real seeded row —
// still a fast, isolated test (no HTTP, no other module), just via Postgres
// instead of calling the function directly.

const admin = postgres(
  Deno.env.get("GATEWAY_DATABASE_URL")!.replace(
    "app_user:app_user",
    "postgres:postgres",
  ),
  { connection: { search_path: "llm,public" }, onnotice: () => {} },
);

async function seedTeamAndKey(
  opts: { budgetUsd: number | null; keyType?: "top" | "derived" },
): Promise<{ id: string; hash: string }> {
  const kamuidOrgId = `org_numeric_${crypto.randomUUID()}`;
  const [team] = await admin<{ id: string }[]>`
    INSERT INTO llm.teams (kamuid_org_id, name, slug)
    VALUES (${kamuidOrgId}, 'Numeric Test', ${kamuidOrgId})
    RETURNING id
  `;
  const hash = crypto.randomUUID().replaceAll("-", "");
  const [key] = await admin<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, budget_usd, status, can_mint)
    VALUES
      (${team.id}, 'numeric test key', ${hash}, 'sk_live_test', ${
    opts.keyType ?? "top"
  }, '{"*"}', ${opts.budgetUsd}, 'active', false)
    RETURNING id
  `;
  await admin`UPDATE llm.keys SET root_key_id = id WHERE id = ${key.id}`;
  return { id: key.id, hash };
}

Deno.test({
  name: "lookupKeyByHash: budget_usd is a real number, not a string",
  fn: async () => {
    const { hash } = await seedTeamAndKey({ budgetUsd: 12.5 });
    const meta = await lookupKeyByHash(hash);
    if (!meta) throw new Error("expected a key-meta row");
    assertEquals(typeof meta.budget_usd, "number");
    assertEquals(meta.budget_usd, 12.5);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name:
    "lookupKeyByHash: a two-digit-plus budget doesn't sort below a one-digit spend as a string",
  fn: async () => {
    // The bug this guards: "9" > "10" as strings, but 9 < 10 numerically. A
    // $10 budget must compare correctly against a $9 spend.
    const { hash } = await seedTeamAndKey({ budgetUsd: 10 });
    const meta = await lookupKeyByHash(hash);
    if (!meta) throw new Error("expected a key-meta row");
    const spend = 9;
    // deno-lint-ignore no-explicit-any
    const budget = meta.budget_usd as any;
    // If budget_usd were still a string, this would be a lexicographic
    // comparison ("10" < "9" as strings is FALSE, so the bug would make an
    // over-budget spend look under budget for some magnitudes — the point is
    // that arithmetic below must not throw / must be numeric).
    assertEquals(typeof budget, "number");
    assertEquals(spend < budget, true);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "lookupKeyByHash: null budget_usd stays null (unbudgeted key)",
  fn: async () => {
    const { hash } = await seedTeamAndKey({ budgetUsd: null });
    const meta = await lookupKeyByHash(hash);
    if (!meta) throw new Error("expected a key-meta row");
    assertEquals(meta.budget_usd, null);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "lookupKeyById: budget_usd is a real number for a derived sub-key row",
  fn: async () => {
    const kamuidOrgId = `org_numeric_${crypto.randomUUID()}`;
    const [team] = await admin<{ id: string }[]>`
      INSERT INTO llm.teams (kamuid_org_id, name, slug)
      VALUES (${kamuidOrgId}, 'Numeric Test', ${kamuidOrgId})
      RETURNING id
    `;
    const [parent] = await admin<{ id: string }[]>`
      INSERT INTO llm.keys
        (team_id, label, key_hash, prefix, key_type, models, status, can_mint)
      VALUES (${team.id}, 'parent', ${crypto.randomUUID()}, 'sk_live_test', 'top', '{"*"}', 'active', true)
      RETURNING id
    `;
    const [child] = await admin<{ id: string }[]>`
      INSERT INTO llm.keys
        (team_id, label, key_type, models, budget_usd, status, can_mint, parent_key_id, root_key_id)
      VALUES (${team.id}, 'child', 'derived', '{"*"}', 250.75, 'active', false, ${parent.id}, ${parent.id})
      RETURNING id
    `;
    const meta = await lookupKeyById(child.id);
    if (!meta) throw new Error("expected a key-meta row");
    assertEquals(typeof meta.budget_usd, "number");
    assertEquals(meta.budget_usd, 250.75);
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "cleanup: close pools",
  fn: async () => {
    await admin.end();
    await gateway.end();
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

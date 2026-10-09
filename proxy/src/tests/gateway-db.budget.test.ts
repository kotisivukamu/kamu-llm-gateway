import "./support/env.ts";
import { assertEquals } from "@std/assert";
import postgres from "postgres";
import { getSpentUsd, recordSpend } from "../gateway-db.ts";

// The per-key spend ledger lives in Postgres (llm.key_spend) so every proxy
// machine sees one total. When it lived in each machine's SQLite, a budgeted
// key could spend its budget once per machine.

const admin = postgres(
  Deno.env.get("GATEWAY_DATABASE_URL")!.replace(
    "admin_role:admin_role",
    "postgres:postgres",
  ),
  { connection: { search_path: "llm,public" }, onnotice: () => {} },
);

async function seedBudgetedKey(): Promise<string> {
  const org = `org_spend_${crypto.randomUUID()}`;
  const [team] = await admin<{ id: string }[]>`
    INSERT INTO llm.teams (kamuid_org_id, name, slug)
    VALUES (${org}, 'Spend Test', ${org})
    RETURNING id
  `;
  const [key] = await admin<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, budget_usd, status)
    VALUES (${team.id}, 'spend', ${crypto.randomUUID()}, 'sk_live_',
            'top', ${["*"]}, 3, 'active')
    RETURNING id
  `;
  return key.id;
}

Deno.test("key_spend: no row reads as 0", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const keyId = await seedBudgetedKey();
  assertEquals(await getSpentUsd(keyId), 0);
});

Deno.test("key_spend: spend from concurrent requests accumulates", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // Two requests finishing at once, as on two machines, must both count.
  const keyId = await seedBudgetedKey();
  await Promise.all([recordSpend(keyId, 1.25), recordSpend(keyId, 0.5)]);
  await recordSpend(keyId, 0); // unpriced: ignored
  assertEquals(await getSpentUsd(keyId), 1.75);
  const [row] = await admin<{ request_count: number }[]>`
    SELECT request_count FROM llm.key_spend WHERE key_id = ${keyId}
  `;
  assertEquals(row.request_count, 2);
});

// No pool cleanup here: gateway-db.numeric.test.ts (which sorts after this
// file) closes the shared `gateway` pool once all of them are done.
Deno.test({
  name: "key_spend: close the fixture pool",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await admin.end();
  },
});

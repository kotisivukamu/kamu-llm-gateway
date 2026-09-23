import "./support/env.ts";
import { assertEquals } from "@std/assert";
import { buildTestApp, type TestApp, testRequest } from "./support/app.ts";
import { addTeamMember, resetDb, seedTeam } from "./support/db.ts";
import { signTestContext } from "./support/token.ts";

// Derive rules after dropping can_mint: any active top-level key in any org can
// derive, derived keys cannot (depth 1), and a child's budget is independent of
// the parent's (a budget caps only its own key's spend).

async function createOrgKey(
  app: TestApp,
  budgetUsd: number | null,
): Promise<string> {
  const team = await seedTeam();
  const userId = `user_${crypto.randomUUID()}`;
  await addTeamMember(team.id, userId);
  const token = await signTestContext({
    sub: userId,
    orgs: [{ kamuidOrgId: team.kamuidOrgId, grants: ["llm.keys.create"] }],
  });
  const res = await testRequest(app, "POST", "/api/keys", {
    token,
    body: { team_id: team.id, label: "customer key", budget_usd: budgetUsd },
  });
  assertEquals(res.status, 201);
  return (await res.json()).secret;
}

Deno.test("derive: an ordinary org key can derive a sub-key", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const app = buildTestApp();
  const secret = await createOrgKey(app, null);

  const res = await testRequest(app, "POST", "/api/keys/derive", {
    token: secret,
    body: { label: "session" },
  });

  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.key.key_type, "derived");
  assertEquals(typeof body.sub_key, "string");
});

Deno.test("derive: child budget may exceed the parent's budget", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const app = buildTestApp();
  const secret = await createOrgKey(app, 50);

  const res = await testRequest(app, "POST", "/api/keys/derive", {
    token: secret,
    body: { label: "big child", budget_usd: 200 },
  });

  assertEquals(res.status, 201);
  assertEquals(Number((await res.json()).key.budget_usd), 200);
});

Deno.test("derive: a derived sub-key cannot derive (depth 1)", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const app = buildTestApp();
  const secret = await createOrgKey(app, null);
  const first = await testRequest(app, "POST", "/api/keys/derive", {
    token: secret,
    body: { label: "child" },
  });
  const { sub_key } = await first.json();

  const res = await testRequest(app, "POST", "/api/keys/derive", {
    token: sub_key,
    body: { label: "grandchild" },
  });

  assertEquals(res.status, 401);
});

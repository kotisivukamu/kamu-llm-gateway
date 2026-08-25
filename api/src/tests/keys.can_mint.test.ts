import "./support/env.ts";
import { assertEquals } from "@std/assert";
import { buildTestApp, testRequest } from "./support/app.ts";
import { addTeamMember, resetDb, seedTeam } from "./support/db.ts";
import { signTestContext } from "./support/token.ts";

// Regression for commit dbabca3 ("require llm.keys.mint grant to mint a
// can_mint key") — api/src/routes/keys.ts POST /api/keys. Before that fix,
// any caller holding only `llm.keys.create` could mint a can_mint:true key
// (a privilege-escalation primitive: mint a top-level key that can itself
// derive unlimited sub-keys). The fix adds a body-conditional middleware that
// requires the separate `llm.keys.mint` grant only when can_mint:true.

Deno.test("POST /api/keys: can_mint:true is 403 with only llm.keys.create", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const app = buildTestApp();
  const team = await seedTeam();
  const userId = "user_no_mint";
  await addTeamMember(team.id, userId);
  const token = await signTestContext({
    sub: userId,
    orgs: [{ kamuidOrgId: team.kamuidOrgId, grants: ["llm.keys.create"] }],
  });

  const res = await testRequest(app, "POST", "/api/keys", {
    token,
    body: { team_id: team.id, label: "escalation attempt", can_mint: true },
  });

  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, "missing grant: llm.keys.mint");
});

Deno.test("POST /api/keys: can_mint absent is 201 with only llm.keys.create", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const app = buildTestApp();
  const team = await seedTeam();
  const userId = "user_no_mint_2";
  await addTeamMember(team.id, userId);
  const token = await signTestContext({
    sub: userId,
    orgs: [{ kamuidOrgId: team.kamuidOrgId, grants: ["llm.keys.create"] }],
  });

  const res = await testRequest(app, "POST", "/api/keys", {
    token,
    body: { team_id: team.id, label: "ordinary key" },
  });

  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.key.can_mint, false);
});

Deno.test("POST /api/keys: can_mint:false is 201 with only llm.keys.create", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  await resetDb();
  const app = buildTestApp();
  const team = await seedTeam();
  const userId = "user_no_mint_3";
  await addTeamMember(team.id, userId);
  const token = await signTestContext({
    sub: userId,
    orgs: [{ kamuidOrgId: team.kamuidOrgId, grants: ["llm.keys.create"] }],
  });

  const res = await testRequest(app, "POST", "/api/keys", {
    token,
    body: { team_id: team.id, label: "explicit false", can_mint: false },
  });

  assertEquals(res.status, 201);
});

Deno.test(
  "POST /api/keys: can_mint:true is 201 with llm.keys.mint + llm.keys.create",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    await resetDb();
    const app = buildTestApp();
    const team = await seedTeam();
    const userId = "user_with_mint";
    await addTeamMember(team.id, userId);
    const token = await signTestContext({
      sub: userId,
      orgs: [{
        kamuidOrgId: team.kamuidOrgId,
        grants: ["llm.keys.create", "llm.keys.mint"],
      }],
    });

    const res = await testRequest(app, "POST", "/api/keys", {
      token,
      body: {
        team_id: team.id,
        label: "admin-provisioned mint key",
        can_mint: true,
      },
    });

    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.key.can_mint, true);
  },
);

Deno.test("POST /api/keys: llm.keys.mint alone (no llm.keys.create) is 403", {
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  // requireGrant("llm.keys.create", ...) runs first and gates unconditionally
  // — llm.keys.mint alone must not substitute for it.
  await resetDb();
  const app = buildTestApp();
  const team = await seedTeam();
  const userId = "user_mint_only";
  await addTeamMember(team.id, userId);
  const token = await signTestContext({
    sub: userId,
    orgs: [{ kamuidOrgId: team.kamuidOrgId, grants: ["llm.keys.mint"] }],
  });

  const res = await testRequest(app, "POST", "/api/keys", {
    token,
    body: { team_id: team.id, label: "mint only", can_mint: true },
  });

  assertEquals(res.status, 403);
  const body = await res.json();
  assertEquals(body.error, "missing grant: llm.keys.create");
});

import "./env.ts";
import { adminSql } from "../../config/db.ts";

// Test-only DB helpers against the real Postgres started for the regression
// suite (see README "Running tests"). Uses the owner pool (adminSql) directly
// — tests don't go through RLS setup/teardown, only through the app's own
// handlers when a test wants RLS exercised.

export { adminSql };

/** Wipe every row the test suite could have written, keep the schema. */
export async function resetDb(): Promise<void> {
  await adminSql`TRUNCATE llm.usage_log, llm.keys, llm.team_members, llm.teams CASCADE`;
}

export interface TestTeam {
  id: string;
  kamuidOrgId: string;
}

/**
 * Insert a team (KamuID org projection). Random org id per call so tests
 * don't collide; pass `id`/`kamuidOrgId` to pin them.
 */
export async function seedTeam(
  opts: { id?: string; kamuidOrgId?: string; name?: string } = {},
): Promise<TestTeam> {
  const kamuidOrgId = opts.kamuidOrgId ?? `org_test_${crypto.randomUUID()}`;
  const name = opts.name ?? "Test Team";
  const [row] = opts.id
    ? await adminSql<{ id: string }[]>`
      INSERT INTO llm.teams (id, kamuid_org_id, name, slug)
      VALUES (${opts.id}, ${kamuidOrgId}, ${name}, ${kamuidOrgId})
      RETURNING id
    `
    : await adminSql<{ id: string }[]>`
      INSERT INTO llm.teams (kamuid_org_id, name, slug)
      VALUES (${kamuidOrgId}, ${name}, ${kamuidOrgId})
      RETURNING id
    `;
  return { id: row.id, kamuidOrgId };
}

export async function addTeamMember(
  teamId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "owner",
): Promise<void> {
  await adminSql`
    INSERT INTO llm.team_members (team_id, user_id, role)
    VALUES (${teamId}, ${userId}, ${role})
    ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `;
}

export interface SeedKeyOpts {
  teamId: string;
  label?: string;
  keyHash?: string | null;
  prefix?: string | null;
  keyType?: "top" | "derived";
  models?: string[];
  budgetUsd?: number | null;
  status?: "active" | "revoked";
  parentKeyId?: string | null;
  rootKeyId?: string | null;
  expiresAt?: string | null;
  createdBy?: string | null;
}

/** Insert a `llm.keys` row directly (bypassing the API), for test fixtures. */
export async function seedKey(opts: SeedKeyOpts): Promise<string> {
  const [row] = await adminSql<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, budget_usd,
       status, parent_key_id, root_key_id, expires_at, created_by)
    VALUES
      (${opts.teamId}, ${opts.label ?? "seed key"}, ${opts.keyHash ?? null},
       ${opts.prefix ?? null}, ${opts.keyType ?? "top"},
       ${opts.models ?? ["*"]}, ${opts.budgetUsd ?? null},
       ${opts.status ?? "active"},
       ${opts.parentKeyId ?? null}, ${opts.rootKeyId ?? null},
       ${opts.expiresAt ?? null}, ${opts.createdBy ?? null})
    RETURNING id
  `;
  if (opts.rootKeyId == null) {
    await adminSql`UPDATE llm.keys SET root_key_id = id WHERE id = ${row.id}`;
  }
  return row.id;
}

import { adminSql } from "../config/db.ts";
import type { OrgClaim, Role } from "@shared/types.ts";

// Decode a JWT payload without verifying — the caller already verified the
// token (KamuID /userinfo verified the opaque access token; kamuhub verified
// the EdDSA platform-context JWT). We only read claims.
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  const b64 = part.replaceAll("-", "+").replaceAll("_", "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// KamuID serializes the organizations claim either as an array or as a
// JSON-encoded string. Normalize and keep only well-formed entries.
export function parseOrgs(claim: unknown): OrgClaim[] {
  let value = claim;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((o): OrgClaim[] => {
    if (!o || typeof o !== "object") return [];
    const { id, slug, name, role } = o as Record<string, unknown>;
    if (typeof id !== "string" || typeof slug !== "string") return [];
    const normRole: Role = role === "owner" || role === "admin"
      ? role
      : "member";
    return [{
      id,
      slug,
      name: typeof name === "string" ? name : slug,
      role: normRole,
    }];
  });
}

/**
 * Upsert teams + team_members for the given orgs WITHOUT deleting memberships
 * absent from the list. Used by the access-key path: a signed access key carries
 * only its single scoped org, so a full reconcile (which deletes) would wrongly
 * revoke the user's other team memberships. Insert/update only.
 */
export async function ensureTeams(
  userId: string,
  orgs: OrgClaim[],
): Promise<void> {
  for (const org of orgs) {
    const [team] = await adminSql<{ id: string }[]>`
      INSERT INTO llm.teams (kamuid_org_id, name, slug)
      VALUES (${org.id}, ${org.name}, ${org.slug})
      ON CONFLICT (kamuid_org_id) DO UPDATE
        SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = now()
      RETURNING id
    `;
    await adminSql`
      INSERT INTO llm.team_members (team_id, user_id, role)
      VALUES (${team.id}, ${userId}, ${org.role})
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
  }
}

/**
 * Upsert a user's teams + team_members from a parsed org claim, fully
 * reconciling membership (insert/update/delete). Touches ONLY team_members.
 * Runs on the owner pool (adminSql) — it writes team_members for the logging-in
 * user, which RLS would otherwise block for a non-bypass role.
 *
 * Used by the resource-server bearer path, which reads the organizations claim
 * straight from /userinfo (opaque KamuID token) and reconciles it into local
 * teams keyed on the shared kamuid_org_id.
 */
export async function reconcileTeams(
  userId: string,
  orgs: OrgClaim[],
): Promise<void> {
  const teamIds: string[] = [];
  for (const org of orgs) {
    const [team] = await adminSql<{ id: string }[]>`
      INSERT INTO llm.teams (kamuid_org_id, name, slug)
      VALUES (${org.id}, ${org.name}, ${org.slug})
      ON CONFLICT (kamuid_org_id) DO UPDATE
        SET name = EXCLUDED.name, slug = EXCLUDED.slug, updated_at = now()
      RETURNING id
    `;
    teamIds.push(team.id);
    await adminSql`
      INSERT INTO llm.team_members (team_id, user_id, role)
      VALUES (${team.id}, ${userId}, ${org.role})
      ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
  }

  // Revocation: drop memberships no longer in the claim.
  if (teamIds.length > 0) {
    await adminSql`
      DELETE FROM llm.team_members
      WHERE user_id = ${userId} AND team_id <> ALL(${teamIds}::uuid[])
    `;
  } else {
    await adminSql`DELETE FROM llm.team_members WHERE user_id = ${userId}`;
  }
}

// Re-export for the bearer path that reads organizations from /userinfo and
// needs to decode a KamuID id_token payload (kept for parity with kamusites;
// the gateway's live path reads /userinfo's organizations claim directly, not
// a stored id_token — there is no local account table).
export { decodeJwtPayload };

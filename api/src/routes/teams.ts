import { Hono } from "@hono/hono";
import { type AuthEnv, authMiddleware } from "../middleware/auth.ts";
import { withUserContext } from "../config/db.ts";

// Team listing for the kamuhub dashboard. Teams are projections of KamuID
// orgs, upserted by authMiddleware on every request (reconcileTeams /
// ensureTeams), so a caller's team row always exists by the time this runs —
// but until this endpoint there was no way to LEARN its id: POST /keys needs a
// team_id, and only GET /keys rows carried one, so a fresh org with zero keys
// could never mint its first key. RLS-scoped via withUserContext
// (teams_select: user_teams()), same visibility boundary as GET /keys.

export const teams = new Hono<AuthEnv>();

teams.use("/teams", authMiddleware);

type TeamRow = {
  id: string;
  kamuid_org_id: string;
  name: string;
  slug: string;
};

teams.get("/teams", async (c) => {
  const user = c.get("user");
  const rows = await withUserContext(user.id, (tx) =>
    tx<TeamRow[]>`
      SELECT id, kamuid_org_id, name, slug
      FROM llm.teams
      ORDER BY name
    `);
  return c.json({ teams: rows });
});

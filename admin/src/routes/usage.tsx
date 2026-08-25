import { Hono } from "@hono/hono";
import { requireSession, type SessionEnv } from "../middleware/session.ts";
import { adminSql } from "../config/db.ts";
import { Layout } from "../views/layout.tsx";

// Feature 1 — cross-org usage visibility. Reads llm.usage_log / llm.keys
// directly as the owner/BYPASSRLS role: this is a superuser surface, NOT
// tenant/RLS-scoped like the kamuhub dashboard. No team_id filter anywhere
// on this router by design.

interface UsageRow {
  org: string;
  team: string;
  key_label: string;
  key_id: string;
  model: string | null;
  cost_usd: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

interface SpendByOrg {
  org: string;
  team: string;
  total_cost_usd: string;
  request_count: string;
}

export const usageRoutes = new Hono<SessionEnv>();
usageRoutes.use("/usage", requireSession);
usageRoutes.use("/usage/*", requireSession);
usageRoutes.use("/api/usage", requireSession);

usageRoutes.get("/usage", async (c) => {
  const byOrg = await adminSql<SpendByOrg[]>`
    SELECT t.kamuid_org_id AS org, t.name AS team,
           COALESCE(SUM(u.cost_usd), 0)::text AS total_cost_usd,
           COUNT(u.id)::text AS request_count
    FROM llm.teams t
    LEFT JOIN llm.keys k ON k.team_id = t.id
    LEFT JOIN llm.usage_log u ON u.key_id = k.id
    GROUP BY t.id, t.kamuid_org_id, t.name
    ORDER BY COALESCE(SUM(u.cost_usd), 0) DESC
  `;

  const rows = await adminSql<UsageRow[]>`
    SELECT t.kamuid_org_id AS org, t.name AS team, k.label AS key_label,
           k.id::text AS key_id, u.model, u.cost_usd::text AS cost_usd,
           u.tokens_in, u.tokens_out, u.created_at::text AS created_at
    FROM llm.usage_log u
    JOIN llm.keys k ON k.id = u.key_id
    JOIN llm.teams t ON t.id = k.team_id
    ORDER BY u.created_at DESC
    LIMIT 200
  `;

  return c.html(
    <Layout title="Usage" admin={c.get("admin").email}>
      <h2>Spend by org (all orgs — superuser view)</h2>
      <table>
        <thead>
          <tr>
            <th>Org</th>
            <th>Team</th>
            <th>Total cost (USD, est.)</th>
            <th>Requests</th>
          </tr>
        </thead>
        <tbody>
          {byOrg.map((r) => (
            <tr>
              <td>{r.org}</td>
              <td>{r.team}</td>
              <td>${Number(r.total_cost_usd).toFixed(4)}</td>
              <td>{r.request_count}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style="margin-top:32px">Recent requests (latest 200, all orgs)</h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Org</th>
            <th>Key</th>
            <th>Model</th>
            <th>Cost</th>
            <th>Tokens in/out</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr>
              <td class="muted">{r.created_at}</td>
              <td>{r.org}</td>
              <td>
                {r.key_label} <span class="muted">{r.key_id.slice(0, 8)}</span>
              </td>
              <td>{r.model ?? "-"}</td>
              <td>{r.cost_usd ? `$${Number(r.cost_usd).toFixed(6)}` : "-"}</td>
              <td>{r.tokens_in ?? 0}/{r.tokens_out ?? 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>,
  );
});

// JSON form for programmatic/API access to the same cross-org data.
usageRoutes.get("/api/usage", async (c) => {
  const rows = await adminSql<UsageRow[]>`
    SELECT t.kamuid_org_id AS org, t.name AS team, k.label AS key_label,
           k.id::text AS key_id, u.model, u.cost_usd::text AS cost_usd,
           u.tokens_in, u.tokens_out, u.created_at::text AS created_at
    FROM llm.usage_log u
    JOIN llm.keys k ON k.id = u.key_id
    JOIN llm.teams t ON t.id = k.team_id
    ORDER BY u.created_at DESC
    LIMIT 500
  `;
  return c.json({ usage: rows });
});

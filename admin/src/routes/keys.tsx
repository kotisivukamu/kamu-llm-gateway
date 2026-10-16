import { Hono } from "@hono/hono";
import { requireSession, type SessionEnv } from "../middleware/session.ts";
import { adminSql } from "../config/db.ts";
import { Layout } from "../views/layout.tsx";
import { generateTopLevelKey } from "../lib/keys.ts";
import type { KeyScope } from "@shared/types.ts";

// Superuser key provisioning: mint or revoke a top-level key in any org,
// outside the kamuhub grant model (e.g. keys for platform services).
//
// Revoke uses the identical cascade semantics as api/src/routes/keys.ts's
// POST /keys/:id/revoke (status='revoked' on the key AND every row where
// root_key_id = id, in one statement) — same query, admin_sql instead of
// api's adminSql, no RLS involved either way.
//
// Scopes (shared/types.ts KeyScope) are set at mint time only; to change them
// on an existing key, UPDATE llm.keys SET scopes = ... by hand.

const SCOPES: KeyScope[] = ["prices:write"];

function parseScopes(raw: unknown[]): KeyScope[] | string {
  const bad = raw.find((s) => !SCOPES.includes(s as KeyScope));
  return bad === undefined
    ? raw as KeyScope[]
    : `unknown scope ${String(bad)} (known: ${SCOPES.join(", ")})`;
}

interface KeyRow {
  id: string;
  team_id: string;
  org: string;
  label: string;
  prefix: string | null;
  key_type: string;
  status: string;
  models: string[];
  budget_usd: string | null;
  scopes: string[];
  created_at: string;
  revoked_at: string | null;
}

export const keysRoutes = new Hono<SessionEnv>();
keysRoutes.use("/keys", requireSession);
keysRoutes.use("/keys/*", requireSession);
keysRoutes.use("/api/keys", requireSession);
keysRoutes.use("/api/keys/*", requireSession);

async function listKeys(): Promise<KeyRow[]> {
  return await adminSql<KeyRow[]>`
    SELECT k.id::text, k.team_id::text, t.kamuid_org_id AS org, k.label,
           k.prefix, k.key_type, k.status, k.models,
           k.budget_usd::text AS budget_usd, k.scopes,
           k.created_at::text AS created_at,
           k.revoked_at::text AS revoked_at
    FROM llm.keys k
    JOIN llm.teams t ON t.id = k.team_id
    ORDER BY k.created_at DESC
  `;
}

async function listTeams() {
  return await adminSql<{ id: string; kamuid_org_id: string; name: string }[]>`
    SELECT id::text, kamuid_org_id, name FROM llm.teams ORDER BY name
  `;
}

keysRoutes.get("/keys", async (c) => {
  const [rows, teams] = await Promise.all([listKeys(), listTeams()]);
  const flash = c.req.query("secret");
  const err = c.req.query("err");
  return c.html(
    <Layout title="Keys" admin={c.get("admin").email}>
      {flash
        ? (
          <div class="flash">
            New key secret (shown once): <code>{flash}</code>
          </div>
        )
        : null}
      {err ? <div class="err">{err}</div> : null}

      <div class="card">
        <h3 style="margin-top:0">Mint a top-level key</h3>
        <form method="post" action="/keys">
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <select name="team_id" required>
              {teams.map((t) => (
                <option value={t.id}>{t.name} ({t.kamuid_org_id})</option>
              ))}
            </select>
            <input name="label" placeholder="label" required />
            <input name="budget_usd" placeholder="budget_usd (optional)" />
            {SCOPES.map((s) => (
              <label>
                <input type="checkbox" name="scopes" value={s} /> {s}
              </label>
            ))}
            <button type="submit">Create key</button>
          </div>
        </form>
      </div>

      <h2>All keys (all orgs — superuser view)</h2>
      <table>
        <thead>
          <tr>
            <th>Org</th>
            <th>Label</th>
            <th>Prefix</th>
            <th>Type</th>
            <th>Status</th>
            <th>Budget</th>
            <th>Scopes</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr>
              <td>{k.org}</td>
              <td>{k.label}</td>
              <td>
                <code>{k.prefix ?? "(derived)"}</code>
              </td>
              <td>{k.key_type}</td>
              <td>{k.status}</td>
              <td>{k.budget_usd ?? "-"}</td>
              <td>{k.scopes.join(", ") || "-"}</td>
              <td class="muted">{k.created_at}</td>
              <td>
                {k.status === "active"
                  ? (
                    <form
                      method="post"
                      action={`/keys/${k.id}/revoke`}
                      class="inline"
                    >
                      <button class="danger" type="submit">Revoke</button>
                    </form>
                  )
                  : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>,
  );
});

keysRoutes.post("/keys", async (c) => {
  const admin = c.get("admin");
  const form = await c.req.formData();
  const teamId = String(form.get("team_id") ?? "");
  const label = String(form.get("label") ?? "").trim();
  const budgetRaw = String(form.get("budget_usd") ?? "").trim();
  const budget = budgetRaw ? Number(budgetRaw) : null;
  const scopes = parseScopes(form.getAll("scopes"));

  if (!teamId || !label) {
    return c.redirect(
      `/keys?err=${encodeURIComponent("team_id and label are required")}`,
    );
  }
  if (budget !== null && !Number.isFinite(budget)) {
    return c.redirect(
      `/keys?err=${encodeURIComponent("budget_usd must be a number")}`,
    );
  }
  if (typeof scopes === "string") {
    return c.redirect(`/keys?err=${encodeURIComponent(scopes)}`);
  }

  const { secret, hash, prefix } = await generateTopLevelKey();

  const [row] = await adminSql<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, budget_usd,
       status, root_key_id, created_by, scopes)
    VALUES
      (${teamId}, ${label}, ${hash}, ${prefix}, 'top', ${["*"]}, ${budget},
       'active', null, ${"admin:" + admin.email}, ${scopes})
    RETURNING id
  `;
  await adminSql`
    UPDATE llm.keys SET root_key_id = id, updated_at = now() WHERE id = ${row.id}
  `;

  return c.redirect(`/keys?secret=${encodeURIComponent(secret)}`);
});

// Revoke — identical cascade semantics to api/src/routes/keys.ts's
// POST /keys/:id/revoke: sets status='revoked' on the key AND every row
// where root_key_id = id (cascades the whole subtree in one statement).
keysRoutes.post("/keys/:id/revoke", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const result = await adminSql`
    UPDATE llm.keys
    SET status = 'revoked', revoked_at = now(), revoked_by = ${
    "admin:" + admin.email
  },
        updated_at = now()
    WHERE id = ${id} OR root_key_id = ${id}
  `;
  if (result.count === 0) {
    return c.redirect(`/keys?err=${encodeURIComponent("key not found")}`);
  }
  return c.redirect("/keys");
});

// JSON API mirrors of the two actions above, for scripted/API use.
keysRoutes.get("/api/keys", async (c) => {
  return c.json({ keys: await listKeys() });
});

keysRoutes.post("/api/keys", async (c) => {
  const admin = c.get("admin");
  const body = await c.req.json<{
    team_id?: string;
    label?: string;
    budget_usd?: number | null;
    scopes?: unknown[];
  }>();
  if (!body.team_id || !body.label) {
    return c.json({ error: "team_id and label are required" }, 400);
  }
  const scopes = parseScopes(body.scopes ?? []);
  if (typeof scopes === "string") return c.json({ error: scopes }, 400);
  const { secret, hash, prefix } = await generateTopLevelKey();
  const [row] = await adminSql<{ id: string }[]>`
    INSERT INTO llm.keys
      (team_id, label, key_hash, prefix, key_type, models, budget_usd,
       status, root_key_id, created_by, scopes)
    VALUES
      (${body.team_id}, ${body.label}, ${hash}, ${prefix}, 'top', ${["*"]},
       ${body.budget_usd ?? null}, 'active', null, ${"admin:" + admin.email},
       ${scopes})
    RETURNING id
  `;
  await adminSql`
    UPDATE llm.keys SET root_key_id = id, updated_at = now() WHERE id = ${row.id}
  `;
  return c.json({ key: { id: row.id, prefix, scopes }, secret }, 201);
});

keysRoutes.post("/api/keys/:id/revoke", async (c) => {
  const admin = c.get("admin");
  const id = c.req.param("id");
  const result = await adminSql`
    UPDATE llm.keys
    SET status = 'revoked', revoked_at = now(), revoked_by = ${
    "admin:" + admin.email
  },
        updated_at = now()
    WHERE id = ${id} OR root_key_id = ${id}
  `;
  if (result.count === 0) return c.json({ error: "key not found" }, 404);
  return c.json({ ok: true, revoked: result.count });
});

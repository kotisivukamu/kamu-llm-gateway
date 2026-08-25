import { Hono } from "@hono/hono";
import { requireSession, type SessionEnv } from "../middleware/session.ts";
import { adminSql } from "../config/db.ts";
import { Layout } from "../views/layout.tsx";
import { MODELS, PROVIDERS } from "../../../proxy/src/catalog.ts";

// Feature 2 — system-wide settings. See admin/README.md "Feature 2 scope" for
// the full honest accounting of what's built vs deferred. Summary:
//
//   - The provider/model catalog (proxy/src/catalog.ts) stays CODE, read here
//     read-only, imported directly (source of truth, no drift risk from a
//     stale DB copy).
//   - llm.settings (new, this task) is a small DB-backed, admin-editable
//     table of OPERATOR OVERRIDES layered on top of that catalog:
//     disabled_models[] and default_budget_usd. Full read/write here.
//   - NOT built: the proxy does not yet consult llm.settings on the hot path
//     (it would need to read disabled_models before dispatch — see README for
//     the exact follow-up shape). So today this page is truthful about
//     intent (an admin can record "glm-5 is disabled") but that record does
//     not yet change what the proxy actually forwards. Shipping the read-only
//     catalog view plus this override table, without wiring the proxy, is the
//     deliberately scoped slice — not a half-built full redesign.

interface SettingsRow {
  disabled_models: string[];
  default_budget_usd: string | null;
  updated_at: string;
  updated_by: string | null;
}

export const settingsRoutes = new Hono<SessionEnv>();
settingsRoutes.use("/settings", requireSession);
settingsRoutes.use("/api/settings", requireSession);

async function getSettings(): Promise<SettingsRow> {
  const [row] = await adminSql<SettingsRow[]>`
    SELECT disabled_models, default_budget_usd::text AS default_budget_usd,
           updated_at::text AS updated_at, updated_by
    FROM llm.settings WHERE id = true
  `;
  return row;
}

settingsRoutes.get("/settings", async (c) => {
  const settings = await getSettings();
  const disabledSet = new Set(settings.disabled_models);

  return c.html(
    <Layout title="Settings" admin={c.get("admin").email}>
      <div class="card">
        <h3 style="margin-top:0">Operator overrides</h3>
        <p class="muted">
          Layered on top of the code catalog below. Not yet consumed by the
          proxy hot path — see admin/README.md "Feature 2 scope".
        </p>
        <form method="post" action="/settings">
          <div style="margin-bottom:10px">
            <label>
              Default budget_usd for new keys (blank = unlimited)
            </label>
            <br />
            <input
              name="default_budget_usd"
              value={settings.default_budget_usd ?? ""}
            />
          </div>
          <div style="margin-bottom:10px">
            <label>Disabled models (comma-separated slugs)</label>
            <br />
            <input
              name="disabled_models"
              style="width:100%;box-sizing:border-box"
              value={settings.disabled_models.join(",")}
            />
          </div>
          <button type="submit">Save</button>
          <span class="muted" style="margin-left:12px">
            last updated {settings.updated_at} by {settings.updated_by ?? "-"}
          </span>
        </form>
      </div>

      <h2>Model catalog (read-only — source: proxy/src/catalog.ts)</h2>
      <table>
        <thead>
          <tr>
            <th>Slug</th>
            <th>Provider</th>
            <th>Input $/Mtok</th>
            <th>Output $/Mtok</th>
            <th>Disabled (override)</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(MODELS).map(([slug, m]) => (
            <tr>
              <td>{slug}</td>
              <td>{m.provider_slug}</td>
              <td>{m.input_cost_per_mtok_usd}</td>
              <td>{m.output_cost_per_mtok_usd}</td>
              <td>{disabledSet.has(slug) ? "yes" : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style="margin-top:32px">Providers (read-only)</h2>
      <table>
        <thead>
          <tr>
            <th>Slug</th>
            <th>Base URL</th>
            <th>Auth style</th>
            <th>API key env var</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(PROVIDERS).map(([slug, p]) => (
            <tr>
              <td>{slug}</td>
              <td>{p.base_url}</td>
              <td>{p.auth_style}</td>
              <td>
                <code>{p.api_key_env_var}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Layout>,
  );
});

settingsRoutes.post("/settings", async (c) => {
  const admin = c.get("admin");
  const form = await c.req.formData();
  const disabledRaw = String(form.get("disabled_models") ?? "");
  const disabled = disabledRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const budgetRaw = String(form.get("default_budget_usd") ?? "").trim();
  const budget = budgetRaw ? Number(budgetRaw) : null;

  await adminSql`
    UPDATE llm.settings
    SET disabled_models = ${disabled}, default_budget_usd = ${budget},
        updated_at = now(), updated_by = ${admin.email}
    WHERE id = true
  `;
  return c.redirect("/settings");
});

settingsRoutes.get("/api/settings", async (c) => {
  return c.json({ settings: await getSettings() });
});

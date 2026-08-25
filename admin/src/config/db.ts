import postgres from "postgres";
import { env } from "../env.ts";

// Owner/BYPASSRLS pool onto the same Postgres the api uses, scoped to the
// `llm` schema via search_path. admin/ reads/writes llm.keys, llm.usage_log,
// llm.settings directly as the superuser role — deliberately NOT RLS-scoped
// (Feature 1: cross-org visibility is the point). There is no per-admin-user
// tenant scoping here; authorization is "is this an admin_auth session",
// full stop.
export const adminSql = postgres(env.ADMIN_DATABASE_URL, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
  connection: { search_path: "llm,public" },
  onnotice: () => {},
});

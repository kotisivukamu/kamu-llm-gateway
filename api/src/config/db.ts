import postgres from "postgres";
import { env } from "../env.ts";

// Two pools, named by privilege, with NO generic fallback — a misconfigured URL
// fails fast instead of silently bypassing RLS. Mirrors kamusites/studio/kamudns.
//   sql      — request pool, the NON-bypass role (app_user). Used only through
//              withUserContext, which SET LOCAL ROLE into authenticated so RLS
//              scopes every query.
//   adminSql — trusted pool, the owner role (postgres). The explicit
//              cross-tenant path (login reconcile, grant lookups, key hashing
//              lookups, provision).
// search_path makes unqualified names resolve to llm.* (then public), so the
// schema is relocatable and collision-free in a shared dev DB.
const opts = {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
  connection: { search_path: "llm,public" },
  onnotice: () => {},
};

export const sql = postgres(env.APP_USER_DATABASE_URL, opts);
export const adminSql = postgres(env.BYPASSRLS_DATABASE_URL, opts);

/**
 * Run queries as the "authenticated" role with the given user's identity.
 * RLS policies (llm.user_teams() / llm.user_keys()) enforce access. Used by
 * all dashboard (authenticated) route handlers.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // @ts-expect-error: postgres.js begin() UnwrapPromiseArray conflicts with generic T
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_user_id', ${userId}, true)`;
    await tx`SET LOCAL ROLE authenticated`;
    return await fn(tx);
  });
}

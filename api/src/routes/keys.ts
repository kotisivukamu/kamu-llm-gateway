import { type Context, Hono } from "@hono/hono";
import { HTTPException } from "@hono/hono/http-exception";
import { type AuthEnv, authMiddleware } from "../middleware/auth.ts";
import { requireGrant } from "../middleware/grants.ts";
import { adminSql, withUserContext } from "../config/db.ts";
import { env } from "../env.ts";
import { generateTopLevelKey, hashKey, signSubKeyJwt } from "../lib/keys.ts";
import { PREFIX_LIVE } from "../lib/keys.ts";
import type { Key } from "@shared/types.ts";

// The key-management CRUD surface (ADR 0001 §9). RLS scopes visibility
// (withUserContext); requireGrant is the explicit permission gate for
// create/revoke. The derive endpoint is a SEPARATE auth path — it authenticates
// with the PARENT KEY (a `sk_live_…` top-level key presented as Bearer), NOT
// the BFF context — so it lives on a separate router mounted before the
// authMiddleware-protected routes.

// ---------------------------------------------------------------------------
// Row shapes (named, so deno fmt can't mangle an inline intersection)
// ---------------------------------------------------------------------------

type KeyListRow =
  & Pick<
    Key,
    | "id"
    | "team_id"
    | "label"
    | "prefix"
    | "key_type"
    | "models"
    | "budget_usd"
    | "status"
    | "can_mint"
    | "parent_key_id"
    | "root_key_id"
    | "expires_at"
    | "created_at"
    | "created_by"
    | "revoked_at"
    | "revoked_by"
  >
  & { kamuid_org_id: string };

type KeyCreateRow = Pick<
  Key,
  | "id"
  | "team_id"
  | "label"
  | "prefix"
  | "key_type"
  | "models"
  | "budget_usd"
  | "status"
  | "can_mint"
  | "root_key_id"
  | "expires_at"
  | "created_at"
  | "created_by"
>;

type KeyDetailRow =
  & Pick<
    Key,
    | "id"
    | "team_id"
    | "label"
    | "prefix"
    | "key_type"
    | "models"
    | "budget_usd"
    | "status"
    | "can_mint"
    | "parent_key_id"
    | "root_key_id"
    | "metadata"
    | "constraints"
    | "expires_at"
    | "created_at"
    | "updated_at"
    | "revoked_at"
    | "created_by"
    | "revoked_by"
  >
  & { kamuid_org_id: string };

interface UsageTotals {
  total_cost_usd: string;
  total_tokens_in: number;
  total_tokens_out: number;
  request_count: number;
}

interface ParentKeyRow {
  id: string;
  team_id: string;
  key_type: string;
  status: string;
  can_mint: boolean;
  models: string[];
  budget_usd: number | null;
  root_key_id: string;
  parent_key_id: string | null;
  expires_at: string | null;
}

interface DerivedKeyRow {
  id: string;
  team_id: string;
  label: string | null;
  key_type: string;
  models: string[];
  budget_usd: number | null;
  status: string;
  can_mint: boolean;
  parent_key_id: string;
  root_key_id: string;
  metadata: Record<string, unknown> | null;
  expires_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Resolve the KamuID org id a request targets, so requireGrant can find the
// matching org in the platform context. A key's team carries kamuid_org_id;
// read on the owner pool (this is a grant lookup, not the RLS gate — RLS still
// applies in the handler). Create reads the body's team_id; revoke reads the
// key's team via the id param.
const teamOrgIdFromCreate = async (c: Context): Promise<string | null> => {
  const { team_id } = await c.req.json<{ team_id?: string }>().catch(
    () => ({} as { team_id?: string }),
  );
  if (!team_id) return null;
  const [t] = await adminSql<{ kamuid_org_id: string }[]>`
    SELECT kamuid_org_id FROM llm.teams WHERE id = ${team_id}
  `;
  return t?.kamuid_org_id ?? null;
};

const teamOrgIdFromKey = async (c: Context): Promise<string | null> => {
  const id = c.req.param("id");
  const [r] = await adminSql<{ kamuid_org_id: string }[]>`
    SELECT t.kamuid_org_id
    FROM llm.keys k JOIN llm.teams t ON t.id = k.team_id
    WHERE k.id = ${id}
  `;
  return r?.kamuid_org_id ?? null;
};

// Strict set-enclosure check (ADR 0001 §7.4). models[] is an allowlist of catalog
// slugs or the literal `*`. `*` attenuates to any named subset; a named set
// attenuates to a subset of itself; `*` can never be PRODUCED from a named
// parent (widening a named set to `*` is rejected). No string-prefix matching —
// slugs are exact-match atoms.
function modelsSubset(child: string[], parent: string[]): boolean {
  const parentHasAll = parent.includes("*");
  if (child.includes("*")) {
    // A child requesting `*` requires the parent to be `*` (never widen named→*).
    return parentHasAll;
  }
  if (parentHasAll) {
    return true; // `*` attenuates to any named subset
  }
  // Both named: child must be a subset of parent (exact set ops).
  const parentSet = new Set(parent);
  return child.every((m) => parentSet.has(m));
}

// ---------------------------------------------------------------------------
// Authed keys router (list / create / detail / revoke)
// ---------------------------------------------------------------------------
export const keys = new Hono<AuthEnv>();

keys.use("/keys", authMiddleware);
keys.use("/keys/*", authMiddleware);

// List keys in the caller's org (RLS-scoped). Joins teams for kamuid_org_id so
// the kamuhub dashboard can filter to the active org.
keys.get("/keys", async (c) => {
  const user = c.get("user");
  const rows = await withUserContext(user.id, (tx) =>
    tx<KeyListRow[]>`
      SELECT k.id, k.team_id, t.kamuid_org_id, k.label, k.prefix, k.key_type,
             k.models, k.budget_usd, k.status, k.can_mint,
             k.parent_key_id, k.root_key_id, k.expires_at,
             k.created_at, k.created_by, k.revoked_at, k.revoked_by
      FROM llm.keys k
      JOIN llm.teams t ON t.id = k.team_id
      ORDER BY k.created_at DESC
    `);
  return c.json({ keys: rows });
});

// Mint a top-level key (requireGrant `llm.keys.create`). Generate an opaque
// secret, store hash+prefix (never the secret), return the secret ONCE.
keys.post(
  "/keys",
  requireGrant("llm.keys.create", teamOrgIdFromCreate),
  // Minting a can_mint key is additionally gated by llm.keys.mint (admin-only)
  // per ADR 0001's 2026-08-25 "can_mint provisioning" resolution: issuing a
  // key that can itself mint sub-keys is the single most powerful capability
  // in this system, so it needs its own grant on top of the ordinary
  // llm.keys.create check. A request that doesn't set can_mint:true is
  // unaffected — this middleware is a no-op for it.
  async (c: Context, next: () => Promise<void>) => {
    const body = await c.req.json<{ can_mint?: boolean }>().catch(
      () => ({}) as { can_mint?: boolean },
    );
    if (body.can_mint) {
      await requireGrant("llm.keys.mint", teamOrgIdFromCreate)(c, next);
      return;
    }
    await next();
  },
  async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      team_id?: string;
      label?: string;
      models?: string[];
      budget_usd?: number | null;
      can_mint?: boolean;
      expires_at?: string | null;
      metadata?: Record<string, unknown> | null;
    }>();
    const teamId = body.team_id;
    const label = body.label?.trim();
    if (!teamId) {
      throw new HTTPException(400, { message: "team_id is required" });
    }
    if (!label) throw new HTTPException(400, { message: "label is required" });

    const models = body.models ?? ["*"];
    if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) {
      throw new HTTPException(400, {
        message: "models must be a string array",
      });
    }
    const budget = body.budget_usd ?? null;
    const canMint = body.can_mint ?? false;
    const expiresAt = body.expires_at ?? null;
    // metadata is stored as JSONB; pass as a JSON-stringified param so postgres.js
    // binds it as text and PG casts to jsonb (the column is jsonb). null stays null.
    const metadataJson = body.metadata != null
      ? JSON.stringify(body.metadata)
      : null;

    // Verify the team exists (friendly 404). Done on the owner pool — it's a
    // team lookup, not the auth gate; the INSERT's RLS keys_insert enforces
    // membership.
    const [team] = await adminSql<{ id: string }[]>`
      SELECT id FROM llm.teams WHERE id = ${teamId}
    `;
    if (!team) throw new HTTPException(404, { message: "team not found" });

    const { secret, hash, prefix } = await generateTopLevelKey();

    // Insert as the authenticated role so RLS (keys_insert: team membership) is
    // enforced. root_key_id is set to the row's own id post-insert (the ADR keeps
    // the row's lifecycle authority explicit — no trigger).
    const [row] = await withUserContext(user.id, (tx) =>
      tx<KeyCreateRow[]>`
        INSERT INTO llm.keys
          (team_id, label, key_hash, prefix, key_type, models, budget_usd,
           status, can_mint, root_key_id, expires_at, metadata, created_by)
        VALUES
          (${teamId}, ${label}, ${hash}, ${prefix}, 'top', ${models}, ${budget},
           'active', ${canMint}, null, ${expiresAt}, ${metadataJson}::jsonb, ${user.id})
        RETURNING id, team_id, label, prefix, key_type, models, budget_usd,
                  status, can_mint, root_key_id, expires_at, created_at, created_by
      `);

    // Self-reference root_key_id = own id (a top-level key's lineage points at
    // itself). Done on the owner pool — it's a single maintenance write.
    await adminSql`
      UPDATE llm.keys SET root_key_id = id, updated_at = now() WHERE id = ${row.id}
    `;

    // The full secret is returned exactly once; the stored row holds only the
    // hash + prefix.
    return c.json({ key: { ...row, root_key_id: row.id }, secret }, 201);
  },
);

// Key detail + live usage totals. Usage is summed across the key and its whole
// subtree (rows where key_id OR root_key_id = id) so a parent's spend rolls up.
keys.get("/keys/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [key] = await withUserContext(user.id, (tx) =>
    tx<KeyDetailRow[]>`
      SELECT k.id, k.team_id, t.kamuid_org_id, k.label, k.prefix, k.key_type,
             k.models, k.budget_usd, k.status, k.can_mint,
             k.parent_key_id, k.root_key_id, k.metadata, k.constraints,
             k.expires_at, k.created_at, k.updated_at,
             k.revoked_at, k.created_by, k.revoked_by
      FROM llm.keys k JOIN llm.teams t ON t.id = k.team_id
      WHERE k.id = ${id}
    `);
  if (!key) throw new HTTPException(404, { message: "Key not found" });

  // Live usage totals: spend for this key directly + its whole subtree. RLS
  // (usage_log_select: user_keys()) scopes these rows to reachable keys; since
  // the key itself is reachable (gated above), the subtree is too.
  const [totals] = await withUserContext(user.id, (tx) =>
    tx<UsageTotals[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS total_cost_usd,
             COALESCE(SUM(tokens_in), 0)::int AS total_tokens_in,
             COALESCE(SUM(tokens_out), 0)::int AS total_tokens_out,
             COUNT(*)::int AS request_count
      FROM llm.usage_log
      WHERE key_id = ${id} OR root_key_id = ${id}
    `);

  return c.json({
    key,
    usage: {
      total_cost_usd: totals?.total_cost_usd ?? "0",
      total_tokens_in: totals?.total_tokens_in ?? 0,
      total_tokens_out: totals?.total_tokens_out ?? 0,
      request_count: totals?.request_count ?? 0,
    },
  });
});

// Revoke a key (requireGrant `llm.keys.revoke`). Cascade: set status='revoked'
// on the key AND all rows where root_key_id = id (a single indexed update —
// ADR 0001 §7.2). Set revoked_at/revoked_by. Done on the owner pool: revoke is
// an authority write; the platform grant is the primary gate, so this runs on
// adminSql to revoke parents even when the caller isn't a team admin (a
// kamuhub operator holding `llm.keys.revoke` can revoke any key in the org).
keys.post(
  "/keys/:id/revoke",
  requireGrant("llm.keys.revoke", teamOrgIdFromKey),
  async (c) => {
    const user = c.get("user");
    const id = c.req.param("id");

    // Verify the key exists + belongs to a team reachable by the caller (so a
    // stranger with a forged grant on a different org can't revoke by id).
    const [owned] = await withUserContext(
      user.id,
      (tx) => tx<{ id: string }[]>`SELECT id FROM llm.keys WHERE id = ${id}`,
    );
    if (!owned) throw new HTTPException(404, { message: "Key not found" });

    // Cascade revoke: the key itself + its whole subtree (root_key_id = id),
    // in one update. Rows where id = root_key_id covers the key and all its
    // descendants.
    const result = await adminSql`
      UPDATE llm.keys
      SET status = 'revoked', revoked_at = now(), revoked_by = ${user.id},
          updated_at = now()
      WHERE id = ${id} OR root_key_id = ${id}
    `;
    if (result.count === 0) {
      throw new HTTPException(404, { message: "Key not found" });
    }
    return c.json({ ok: true, revoked: result.count });
  },
);

// ---------------------------------------------------------------------------
// Derive router — SEPARATE auth path (parent key, NOT BFF context)
// ---------------------------------------------------------------------------
// POST /api/keys/derive mints a sub-key from a parent key (ADR 0001 §6/§7).
// Auth = the parent key (Bearer `sk_live_…`), NOT the BFF context. Mounted
// before the authMiddleware-protected keys routes so it bypasses them.
//
// Checklist (the contract derive enforces — ADR 0001 §7):
//   1. Lifetime — child expires_at = min(requested, parent.expires_at)
//   2. Revocation — parent must be active; revoke cascades subtree (separate)
//   3. Recursion — parent must be a top-level key with can_mint; child can_mint=false
//   4. Scope enclosure — models ⊆ parent.models (exact set ops); budget ≤ parent remaining
//   5. (constraints — reserved, nullable, unused at MVP)
//   6. Attribution — lineage cols (parent_key_id, root_key_id) set on the child
//   7. Rate limit — per-parent mint rate + max active children (MVP: max-active cap)
//   Tenant boundary — child.team_id = parent.team_id (no cross-tenant)
export const derive = new Hono();

derive.post("/keys/derive", async (c) => {
  const header = c.req.header("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  if (!token) return c.json({ error: "Unauthorized" }, 401);

  // Detect parent key format: must be sk_live_… (top-level opaque key).
  if (!token.startsWith(PREFIX_LIVE)) {
    return c.json({ error: "derive requires a top-level sk_live_ key" }, 401);
  }

  const secretHash = await hashKey(token);

  // Look up the parent key row by hash on the owner pool (adminSql): the derive
  // path has no RLS context (no BFF, no authenticated role), and the key hash
  // is the authority here.
  const [parent] = await adminSql<ParentKeyRow[]>`
    SELECT id, team_id, key_type, status, can_mint, models, budget_usd,
           root_key_id, parent_key_id, expires_at
    FROM llm.keys
    WHERE key_hash = ${secretHash} AND key_type = 'top'
    LIMIT 1
  `;

  // Fail closed on no match, revoked, or non-top-level.
  if (!parent || parent.status !== "active") {
    return c.json({ error: "Unauthorized" }, 401);
  }
  // Recursion — depth = 1 hard limit: only top-level keys with can_mint can
  // derive. A derived key (parent_key_id set) is rejected; can_mint=false is
  // rejected. (Derived keys are minted can_mint=false unconditionally, so this
  // also kills the A→B→C loop.)
  if (!parent.can_mint || parent.parent_key_id !== null) {
    return c.json({ error: "key cannot mint sub-keys" }, 403);
  }
  // Internal-caller boundary (ADR 0001, open question resolved 2026-08-25):
  // we never issue can_mint to external orgs, so derive additionally requires
  // the parent's team to be the fixed internal-platform org. This is the
  // simplest closure of the confused-deputy risk in §7.4 — until this lands,
  // any can_mint key (there shouldn't be any external ones, but nothing
  // enforced that) could derive freely.
  if (parent.team_id !== env.INTERNAL_PLATFORM_TEAM_ID) {
    return c.json({ error: "key cannot mint sub-keys" }, 403);
  }

  const body = await c.req.json<{
    label?: string;
    models?: string[];
    budget_usd?: number | null;
    expires_in_seconds?: number | null;
    metadata?: Record<string, unknown> | null;
  }>().catch(
    () =>
      ({}) as {
        label?: string;
        models?: string[];
        budget_usd?: number | null;
        expires_in_seconds?: number | null;
        metadata?: Record<string, unknown> | null;
      },
  );

  // label is NOT NULL on keys (ADR 0001 §2: every key carries a display
  // label). Derive callers may omit it; default to "derived".
  const childLabel = body.label?.trim() || "derived";

  // --- Scope enclosure (§7.4): models ---
  const childModels = body.models ?? ["*"];
  if (
    !Array.isArray(childModels) ||
    childModels.length === 0 ||
    childModels.some((m) => typeof m !== "string")
  ) {
    return c.json({ error: "models must be a non-empty string array" }, 400);
  }
  if (!modelsSubset(childModels, parent.models)) {
    return c.json(
      { error: "child models must be a subset of the parent's models" },
      400,
    );
  }

  // --- Lifetime (§7.1): child cannot outlive parent ---
  const nowSec = Math.floor(Date.now() / 1000);
  const requestedTtl = body.expires_in_seconds ??
    env.DEFAULT_SUBKEY_TTL_SECONDS;
  if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) {
    return c.json(
      { error: "expires_in_seconds must be a positive number" },
      400,
    );
  }
  // Absolute TTL ceiling (MAX_SUBKEY_TTL_SECONDS), independent of the
  // parent-remaining-TTL clamp below. §7.1's clamp alone imposes no upper
  // bound when the parent is unbounded (expires_at IS NULL — the permanent
  // service-key case), so an unbounded can_mint parent could otherwise mint
  // an arbitrarily long-lived (e.g. multi-year) sub-key. This hard ceiling
  // applies regardless of parent expiry.
  if (requestedTtl > env.MAX_SUBKEY_TTL_SECONDS) {
    return c.json(
      {
        error: "expires_in_seconds exceeds the maximum sub-key TTL",
        max_ttl_seconds: env.MAX_SUBKEY_TTL_SECONDS,
      },
      400,
    );
  }
  const childExpSec = nowSec + requestedTtl;
  if (parent.expires_at) {
    const parentExpSec = Math.floor(
      new Date(parent.expires_at).getTime() / 1000,
    );
    if (childExpSec > parentExpSec) {
      // Clamp: a dying parent must not mint persistent access.
      return c.json(
        {
          error: "child expires_at cannot exceed the parent's remaining TTL",
          parent_expires_at: parent.expires_at,
        },
        400,
      );
    }
  }
  const childExpiresAt = new Date(childExpSec * 1000).toISOString();

  // --- Budget (§7.4): child budget ≤ parent remaining ---
  let childBudget: number | null = body.budget_usd ?? null;
  if (parent.budget_usd !== null) {
    // Parent remaining = parent budget − parent's own subtree spend so far.
    // Spend is summed over the parent's subtree (rows where key_id OR root_key_id
    // = parent id). The poller flushes the satellite's local buffer here, so this
    // is the durable ledger total.
    const [spent] = await adminSql<{ spent: string | null }[]>`
      SELECT COALESCE(SUM(cost_usd), 0)::text AS spent
      FROM llm.usage_log
      WHERE key_id = ${parent.id} OR root_key_id = ${parent.id}
    `;
    const spentUsd = spent ? Number(spent.spent) : 0;
    const remaining = parent.budget_usd - spentUsd;
    if (childBudget === null) {
      // Default the child to the parent's remaining budget (attenuate fully).
      childBudget = remaining > 0 ? remaining : 0;
    }
    if (childBudget > remaining) {
      return c.json(
        {
          error: "child budget cannot exceed the parent's remaining budget",
          parent_remaining_usd: remaining,
        },
        400,
      );
    }
  }

  // metadata is stored as JSONB; pass as a JSON-stringified param.
  const metadataJson = body.metadata != null
    ? JSON.stringify(body.metadata)
    : null;

  // --- Rate limit (§7.7) + insert, made atomic ---
  // Original shape was SELECT COUNT(*) then a separate INSERT with no lock
  // between them — under concurrent derive calls against the same parent,
  // every in-flight request reads the count *before* any of the siblings'
  // inserts commit, so all of them observe "under the limit" and all of them
  // insert (TOCTOU race; re-verification of 3c9f308 measured 14/15 succeeding
  // against a configured limit of 5). Fixed by taking a Postgres session
  // (transaction-scoped) advisory lock keyed on the parent's id before doing
  // either count check, and holding it across the insert. This serializes
  // derive calls per-parent (not globally — different parents key different
  // locks) and holds correctly across instances in the documented multi-
  // instance HA posture (ADR §10.3), since the lock lives in Postgres, not
  // in-process. hashtextextended(text, 0) gives the bigint pg_advisory_xact_lock
  // wants; the seed is fixed so the same parent id always maps to the same
  // lock. The lock auto-releases at transaction end (commit or rollback), so
  // there's no separate unlock path to forget.
  const child = await adminSql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${parent.id}, 0))`;

    // Counts derive-minted rows for this parent created in the trailing 60s
    // (a sliding window, not a fixed-bucket reset), regardless of the child's
    // current status — a runaway script that immediately revokes what it
    // mints must not be able to bypass the rate limit that way. This is on
    // top of, not instead of, the max-active-children cap below (both are
    // named in §7.7: "N mints/min, capped at M active children per parent").
    const [recentCount] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM llm.keys
      WHERE parent_key_id = ${parent.id}
        AND created_at > now() - interval '1 minute'
    `;
    if (recentCount && recentCount.n >= env.SUBKEY_DERIVE_RATE_PER_MIN) {
      return "rate_limited" as const;
    }

    // --- Rate limit (§7.7): max active children per parent ---
    // MVP: cap active (not revoked, not expired) children.
    const [activeCount] = await tx<{ n: number }[]>`
      SELECT COUNT(*)::int AS n
      FROM llm.keys
      WHERE parent_key_id = ${parent.id}
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())
    `;
    if (activeCount && activeCount.n >= env.SUBKEY_DERIVE_MAX_ACTIVE) {
      return "too_many_active" as const;
    }

    // --- Insert the derived keys row ---
    // can_mint = false unconditionally (depth 1). team_id = parent.team_id (no
    // cross-tenant). parent_key_id + root_key_id carry the lineage. key_hash is
    // NULL for derived keys (the JWT on the wire is the credential; jti = row PK).
    const [row] = await tx<DerivedKeyRow[]>`
      INSERT INTO llm.keys
        (team_id, label, key_hash, prefix, key_type, models, budget_usd,
         status, can_mint, parent_key_id, root_key_id, metadata, expires_at)
      VALUES
        (${parent.team_id}, ${childLabel}, null, null, 'derived', ${childModels},
         ${childBudget}, 'active', false, ${parent.id}, ${parent.root_key_id},
         ${metadataJson}::jsonb, ${childExpiresAt})
      RETURNING id, team_id, label, key_type, models, budget_usd, status,
                can_mint, parent_key_id, root_key_id, metadata, expires_at,
                created_at
    `;
    return row;
  });

  if (child === "rate_limited") {
    return c.json({ error: "derive rate limit exceeded for this parent" }, 429);
  }
  if (child === "too_many_active") {
    return c.json({ error: "too many active children for this parent" }, 429);
  }

  // Sign the compact Ed25519 JWT (jti = row PK). The row is the authority on
  // lifecycle/lineage/budget; the JWT is the authority on request authenticity.
  const jwt = await signSubKeyJwt(
    {
      jti: child.id,
      sub: parent.root_key_id,
      models: child.models,
      budget_usd: child.budget_usd,
      metadata: child.metadata,
    },
    childExpSec,
  );

  // The JWT is returned exactly once (the credential on the wire).
  return c.json({ key: child, sub_key: jwt }, 201);
});

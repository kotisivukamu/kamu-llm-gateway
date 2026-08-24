// Pure types shared across kamu-llm-gateway surfaces. No runtime code.
//
// The key is the product (ADR 0001 §2): a first-class `keys` row, in the role a
// `sites` row plays in kamusites. Every type here mirrors a column or relation
// on that row. Two credential shapes are both `Key` rows — a top-level key
// (opaque secret, `parent_key_id` is null) and a derived sub-key (Ed25519-signed
// JWT on the wire whose `jti` is the row's PK, `parent_key_id` set).

export type KeyStatus = "active" | "revoked";
export type KeyType = "top" | "derived";

export type Role = "owner" | "admin" | "member";

// The owning-org projection of a KamuID org, keyed on the shared, non-divergent
// `kamuid_org_id` (kamuhub ADR 0001). A key's `team_id` points here; RLS scopes
// by `llm.user_teams()`.
export interface Team {
  id: string;
  name: string;
  slug: string;
  kamuid_org_id: string;
  created_at: string;
  updated_at: string;
}

export interface Membership {
  team_id: string;
  role: Role;
}

// The product row. `keys` is to this service what `sites` is to kamusites.
// The credential is an attribute of the row, shown once on creation and stored
// hashed for verification (§2).
export interface Key {
  id: string;
  // Owning org projection (the KamuID org via kamuid_org_id). RLS scopes a key
  // to its team exactly like sites.team_id.
  team_id: string;
  // Display + audit fields, like a site's name/owner.
  label: string;
  created_by: string | null;
  created_at: string;
  // The product's configuration — properties of the resource the org owns, not
  // security metadata bolted onto a credential.
  //   models: allowlist of catalog slugs, or ["*"] for all.
  //   budget_usd: soft spend cap (ADR §10 — overdraft is accepted and bounded).
  models: string[];
  budget_usd: number | null;
  // Lifecycle, like a site's published/archived state.
  status: KeyStatus;
  revoked_at: string | null;
  revoked_by: string | null;
  // The credential itself. `key_hash` is stored; the full secret is returned
  // exactly once on create/derive. `prefix` is a human-readable display stub.
  // Both are NULL for derived sub-keys (key_type = 'derived'), whose credential
  // is a signed JWT on the wire whose `jti` IS the row's PK (ADR §3/§10.4).
  key_type: KeyType;
  key_hash: string | null;
  prefix: string | null;
  // Delegated-minting edges (ADR §4). A derived sub-key is a `keys` row like
  // any other, with `parent_key_id` set instead of a human creator.
  can_mint: boolean;
  parent_key_id: string | null;
  root_key_id: string;
  // TTL. A top-level key is permanent (expires_at IS NULL); a derived sub-key is
  // short-lived (1h), clamped to the parent's remaining TTL (ADR §7.1).
  expires_at: string | null;
  // Reserved for future environmental constraints (IP allowlist, mTLS). Children
  // may only tighten, never loosen (ADR §7.5). Nullable + unused at MVP.
  constraints: Record<string, unknown> | null;
  // Arbitrary attribution blob a derived key may carry (today's
  // site_id/machine_id/model_id, a build_id) that flows into the usage_log row
  // so cost rolls up to the session/build (ADR §6/§7.6).
  metadata: Record<string, unknown> | null;
  updated_at: string;
}

// The shape of one entry in the KamuID id_token `organizations` claim.
export interface OrgClaim {
  id: string;
  slug: string;
  name: string;
  role: Role;
}

// One org in the verified X-Kamuhub-Authz platform context. Grants are the
// RBAC surface the gateway enforces (llm.keys.create, llm.keys.revoke); the
// gateway owns no grants — kamuhub does, and signs them here.
export interface ContextOrg {
  id: string;
  kamuid_org_id: string | null;
  slug: string;
  name: string;
  role: string;
  grants: string[];
}

// The verified kamuhub platform context (EdDSA-signed JWT, X-Kamuhub-Authz).
// Identity comes from KamuID (/userinfo); org membership + grants come from
// here, never the raw KamuID claim.
export interface PlatformContext {
  user_id: string;
  sub: string;
  orgs: ContextOrg[];
  iat: number;
  exp: number;
}

// A derived sub-key as it appears on the wire: a compact Ed25519-signed JWT
// whose `jti` is the DB row's PK. The row is the authority on lifecycle
// (revocation, lineage, budget); the JWT is the authority on request
// authenticity (ADR §3/§10.4).
export interface SubKeyJwtClaims {
  jti: string; // the keys row's PK
  sub: string; // the root key id (root_key_id)
  models: string[];
  budget_usd: number | null;
  exp: number;
  metadata: Record<string, unknown> | null;
}

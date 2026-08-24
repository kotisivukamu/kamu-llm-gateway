---
name: api-writer
description: Writes the kamu-llm-gateway control-plane API (env, db config, auth/grants middleware, keys CRUD + derive + usage routes, main.ts), mirroring kamusites.
tools:
  - read
  - write
  - edit
  - bash
model: claude-sonnet-5-5
thinking: low
---

You write the control-plane API for `kamu-llm-gateway`. The spec is the ADR at `/home/tapio.linux/kotisivukamu/kamu-llm-gateway/docs/adr/0001-llm-gateway-resource-server.md` (§1 resource server, §3 two credential shapes, §6/§7 delegated minting, §9 CRUD surface, §10 hot path). The template is kamusites at `/home/tapio.linux/kotisivukamu/kamusites/api/src/`.

## Your job — write these files
- `api/src/env.ts` — zod-validated env (two DB pools, PORT default 8300, KAMUHUB_JWKS_URL, KAMUID_ISSUER, and gateway-specific: `ED25519_PRIVATE_KEY` (base64 Ed25519 seed for signing sub-key JWTs), `ED25519_PUBLIC_KEY` (base64 for verify path — though control plane only signs), `KEY_META_CACHE_TTL_SEC` default 10). Fail-fast.
- `api/src/config/db.ts` — two-pool split like kamusites (sql = app_user RLS, adminSql = postgres BYPASSRLS), `withUserContext(userId, fn)` setting `app.current_user_id` + `SET LOCAL ROLE authenticated`. search_path `llm,public`.
- `api/src/lib/platform-context.ts` — copy kamusites' version verbatim (jose JWKS verify EdDSA, `verifyPlatformContext`).
- `api/src/lib/kamuid-sync.ts` — copy kamusites' `ensureTeams` + `reconcileTeams` + `contextToOrgClaims` logic, adapted to the `llm` schema. You can copy `parseOrgs`/`decodeJwtPayload` too.
- `api/src/lib/keys.ts` — key material helpers: `generateTopLevelKey()` → returns `{secret, hash, prefix}` where secret is `sk_live_<32 hex>`, hash = sha256(secret) hex, prefix = first 12 chars of secret. `signSubKeyJwt(payload, privateKey)` → Ed25519-signed compact JWT with jti=models/budget_usd/exp/metadata. `hashKey(secret)`.
- `api/src/lib/ed25519.ts` — load the Ed25519 key pair from env base64 (use jose `importPKCS8`/`importSPKI` or `crypto.subtle`). Provide `getSigningKey()` and `getVerifyKey()`.
- `api/src/middleware/auth.ts` — copy kamusites' `authMiddleware` (opaque-KamuID path with mandatory X-Kamuhub-Authz + access-key path). Adapt provisionUser to the `llm` schema.
- `api/src/middleware/grants.ts` — copy kamusites' `requireGrant` verbatim.
- `api/src/routes/keys.ts` — the CRUD surface (§9):
  - `GET /api/keys` — list keys in caller's org (RLS-scoped via withUserContext).
  - `POST /api/keys` — mint top-level key (requireGrant `llm.keys.create`, resolve org from body team_id). Generate opaque secret, store hash+prefix, return secret ONCE.
  - `GET /api/keys/:id` — detail + live usage totals (sum usage_log where key_id or root_key_id = id).
  - `POST /api/keys/:id/revoke` — revoke (requireGrant `llm.keys.revoke`); cascade: set status='revoked' on the key AND all rows where root_key_id = id (single UPDATE). Set revoked_at/revoked_by.
  - `POST /api/keys/derive` — mint a sub-key. **Auth = the parent key (Bearer), NOT the BFF context** per §9. Steps per ADR §7 checklist:
    - detect parent key (must be `sk_live_...` top-level, can_mint=true, status active, not expired). Look up by hash on adminSql.
    - enforce: child.expires_at = min(requested, parent.expires_at); models ⊆ parent.models (exact set ops, `*` attenuates to any subset, never widen named→`*`); budget ≤ parent remaining; child.team_id = parent.team_id (no cross-tenant); derived can_mint = false (depth 1).
    - insert a `derived` keys row (jti = row id), sign a compact JWT (Ed25519) carrying jti/models/budget_usd/exp/metadata, return the JWT + the row metadata.
- `api/src/routes/usage.ts` — `GET /api/usage` (filters: key_id, model, from, to → per-day/per-key/per-model), `GET /api/usage/totals`, `GET /api/usage/facets` (distinct keys + models). RLS-scoped (withUserContext). For MVP these can be simple SQL aggregations.
- `api/src/main.ts` — Hono app, requestLogger, cors, health, mount auth + keys + usage routes, OpenAPI doc + swagger, onError, Deno.serve on PORT.

## Patterns
- `withUserContext(user.id, tx => tx`...`)` for all RLS-scoped queries. `adminSql` for grant lookups + key hashing lookups + provision.
- `requireGrant("llm.keys.create", teamOrgId)` where `teamOrgId` reads body team_id → adminSql teams lookup for kamuid_org_id, like kamusites `sites.ts`.
- The derive endpoint is a SEPARATE auth path: it reads the bearer, detects `sk_live_` prefix, hashes, looks up the key row on adminSql, validates, and proceeds WITHOUT authMiddleware/requireGrant. Mount it under its own `app.route` so it bypasses the BFF-context auth. Actually mount keys routes with authMiddleware EXCEPT derive — simplest is a separate Hono app for `/api/keys/derive` mounted before the authed keys routes. Use your judgment; keep it clean.

## Constraints
- No emojis. English. Fail-fast. Deno + Hono + postgres.js + zod + jose.
- The full key secret is returned exactly once on POST /api/keys and POST /api/keys/derive.
- Do NOT run the server; the verifier agent does that. But ensure `deno check src/**/*.ts` would pass (use the import map from api/deno.json). If you need deps not in deno.json, add them.
- Copy real working code from kamusites where it is generic (platform-context.ts, grants.ts, kamuid-sync logic) — don't reinvent.

When done, run `cd api && deno fmt` and `cd api && deno check src/main.ts 2>&1 | head -40` and report any type errors. Fix them.

# ADR 0001 — `kamu-llm-gateway`: the API key is the product

- **Status:** Accepted — 2026-08-24, open questions resolved 2026-08-25,
  `can_mint` provisioning decision superseded 2026-08-25 (see "Open questions"
  below), `can_mint` itself removed and budget enclosure dropped 2026-09-23 (see
  "Revision 2026-09-23" at the end)
- **Context repo:** new top-level `kamu-llm-gateway/` in the KamuHub workspace
- **Builds on:** kamuhub ADR 0001 (identity/authz/billing boundaries), ADR 0002
  (platform agent service), ADR 0005 (public CLI + site git access)
- **Template:** `kamusites` — this service is structured exactly like kamusites,
  with `keys` in the role `sites` plays there.

## The core idea

**The API key is the product.** `kamu-llm-gateway` is a platform resource
server whose resource is **API keys**, in precisely the sense that `kamusites`
is a resource server whose resource is **sites**. Everything else — the proxy
satellite, the usage ledger, the delegated minting — is machinery around that
one product row, exactly as the builder, analytics, and journey machinery in
kamusites hang off a `site_id`.

This is the framing to hold when reading the rest of the doc. The service does
not exist to "run a proxy" or "issue tokens"; it exists to let an organization
**create, manage, consume, and account for API keys** as a first-class resource,
the way kamusites lets an org create and manage sites. The LLM proxy is the
*consumption path* for a key, in the role kamusites' builder is the consumption
path for a site.

## Context

Today the platform's only LLM gateway is `llm-proxy/`, a Hono/Deno satellite
living **inside the `kotisivukamu` monorepo** as a subdirectory. Its control plane
is scattered across kotisivukamu as a "guest":

- **Satellite** — `kotisivukamu/llm-proxy/src/`: forwards to upstream providers,
  meters every request into a local SQLite `usage_log`, exposes `GET /usage`
  for polling. Stateless beyond that file.
- **Control plane (guest in kotisivukamu):**
  - `kotisivukamu/worker/src/llm_usage/poll.ts` — graphile-worker task polling
    the satellite.
  - `kotisivukamu/database/migrations/20260821120000_llm_usage` — durable
    `llm_usage` + `llm_usage_cursor` tables. The migration's own comment says:
    *"lifting them into llm-proxy's own repo later is a folder move plus this
    migration, not an archaeology dig."*
  - `kotisivukamu/internal-api/src/llm_usage/` — reporting read API.
  - `kotisivukamu/internal-dashboard/src/components/LlmTokens.jsx` — the
    `/llm-tokens` page; **stateless mint only, no per-key revocation**.

### The problem this ADR exists to fix

The token model is **stateless HMAC JWTs verified with a shared
`SESSION_JWT_SECRET`**, and that secret is held by **every caller that mints**:
`internal-api`, `studio/router` (its own custom JWT shape), `builder-queue`,
the kamuhub `agent/` service, and more. Consequences:

1. **No per-key revocation.** The only kill switch is rotating
   `SESSION_JWT_SECRET`, which invalidates *every* token at once — including
   every internal service's. That is acceptable for an internal dev tool and
   unacceptable for a service that hands keys to external developers.
2. **No per-key budget that survives a restart.** `budget_usd` is enforced from
   a SQLite `token_spend` ledger that is destroyed on every deploy.
3. **No approval gate.** Any authenticated internal user mints freely; the
   stated goal of "lock the feature to require admin approval" is impossible in
   the current shape.
4. **The product is mis-located.** A public LLM gateway ("use LLMs via our
   proxy") is a product for *external developers*, not a kotisivukamu
   subdirectory. It needs its own lifecycle, its own DB, its own name.

## Decision

Create a new top-level repo, **`kamu-llm-gateway`**, that is a **platform
resource server** — sibling to `kamusites`, `kamudns`, `kamustatus`, etc. —
whose **product is API keys**. Structurally it is kamusites with `keys` in
the role of `sites`:

| kamusites                                  | kamu-llm-gateway                          |
|--------------------------------------------|-------------------------------------------|
| resource = `sites`                         | resource = `keys`                          |
| `teams` = projection of KamuID org         | `teams` = projection of KamuID org         |
| `sites.team_id → teams`                    | `keys.team_id → teams`                    |
| consumption = the builder                  | consumption = the LLM proxy satellite      |
| usage hangs off `site_id` (analytics)      | usage hangs off `key_id` (the spend ledger)|
| grants: `sites.create`, `sites.delete`     | grants: `llm.keys.create`, `llm.keys.revoke`|
| rendered through the kamuhub dashboard     | rendered through the kamuhub dashboard     |

Holding this table in your head is the whole design. The proxy satellite, the
usage ledger, and the delegated-minting capability are all machinery around
the `keys` product row, exactly as kamusites' builder/analytics/journey
machinery hang off a `site_id`.

### 1. It is a resource server, not a front door

The gateway has **no user-facing UI of its own**. It exposes a CRUD/usage API
that the **kamuhub dashboard** renders, exactly like kamusites is rendered
through `app.kamuhub.com`. Dev traffic must go through the locally-run kamuhub
BFF, which injects the signed `X-Kamuhub-Authz` context; the gateway rejects a
bare KamuID bearer (same fail-closed rule as kamusites — no verified context ⇒
403).

This means the gateway inherits the platform authz/billing model wholesale:

- **Identity** comes from KamuID (`/userinfo` on the opaque bearer).
- **Org membership + grants** come from the signed `X-Kamuhub-Authz` context,
  never the raw KamuID claim.
- **Each key belongs to a KamuID organization** (the shared, non-divergent
  `kamuid_org_id`), exactly like every other satellite service's rows.
- **The gateway owns no account model.** There is no gateway-local signup, no
  gateway-local approval queue. "Admin approval to register" — if and when it
  is needed — is a **kamuhub/kamuid** concern (org membership, a grant), not a
  gateway concern. The gateway just enforces whatever grants kamuhub signed.

> Note: the earlier framing of "request a key → admin approves the *account* →
> mint freely" is **withdrawn**. There is no gateway account. The approval
> surface, if it exists, lives in kamuhub as a grant (`llm.keys.create`) an org
> must hold; whether *granting* that capability is gated by a human-approval
> step is a kamuhub policy decision, not a gateway one.

### 2. The key row is the product; the proxy is consumption

A key is a **first-class resource row**, not an authz artifact. Concretely it
carries the same shape a `sites` row carries in kamusites:

- `team_id` → the owning org projection (which is the KamuID org via
  `kamuid_org_id`), so RLS scopes it exactly like `sites.team_id`.
- `label`, `created_at`, `created_by` — display + audit fields, like a site's
  name/owner.
- `models[]`, `budget_usd` — the product's *configuration*, the way a site's
  config is a column on its row. These are not security metadata bolted onto a
  credential; they are properties of the resource the org owns.
- `status` (`active`/`revoked`), `revoked_at`, `revoked_by` — lifecycle, like
  a site's published/archived state.
- `key_hash` + `prefix` — the credential itself is an attribute of the row,
  shown once on creation, stored hashed for verification. For top-level keys
  this is an opaque secret (§3); for derived sub-keys the row's PK is bound to
  a signed JWT on the wire (§3, §10.4).
- `parent_key_id` + `can_mint` — the delegated-minting edges (§4). A derived
  sub-key is a `keys` row like any other, with a `parent_key_id` instead of a
  human creator; it is consumed and revoked identically.

**Usage hangs off `key_id`** the way analytics hang off `site_id` in kamusites:
every metered request writes a `usage_log` row carrying `key_id` (plus the
`metadata` blob a derived key may carry, so spend rolls up to the session/build).

### 3. Opaque-hash top-level keys, signed-JWT sub-keys

There are **two credential shapes** in this system, and they are deliberately
different — because top-level keys and derived sub-keys have different
lifecycles and different verification needs:

- **Top-level keys** (the product row, held by external developers and by
  internal services with `can_mint`): an **opaque random secret** (`sk_live_…`),
  stored as a hash on the row. Verified on the hot path by lookup against an
  in-process key-metadata cache (fed by the poller, mirroring kamuhub's
  `key_gate` pattern). A revoke (or org/team suspension) takes effect within the
cache TTL without a DB read on every request.
- **Derived sub-keys** (short-lived, session/build-scoped, per §6/§7): a
  **compact signed JWT** on the wire, **also backed by a DB row**. The row
  holds the management/lineage metadata (`parent_key_id`, `root_key_id`,
  `models`, `budget_usd`, `expires_at`, `status`); the JWT on the wire is what
  the proxy verifies statelessly. The binding is the `jti` claim, which **is**
  the DB row's PK — so the row is the authority on the key's lifecycle
  (revocation, lineage, budget), while the JWT is the authority on the
  request's authenticity.

The two shapes serve the two hot-path needs: top-level keys need **lookup**
(there is no signature to verify — the secret is opaque), so they go through
the cache; sub-keys need **signature verification** (stateless, ~0ms), so they
go through in-memory crypto. In both cases the hot path is ~0ms and never
touches the DB — the difference is only the verification mechanism, not the
latency. See §10 for how the hot path dispatches on key format.

Sub-keys are signed with **Ed25519** (asymmetric), not HMAC — see §10.4 for
why: the proxy must never hold a key capable of minting.

### 4. Delegated minting is a property of a key row

> **Revised 2026-09-23:** there is no `can_mint` capability any more; every
> active top-level key can derive. See "Revision 2026-09-23".

Because the key is the product, delegated minting is not a separate control
plane — it is a capability (`can_mint`) on a key row, and a derived sub-key
is itself a `keys` row (with `parent_key_id` set) consumed and revoked
identically. On the wire the sub-key is a short-lived signed JWT (Ed25519,
§10.4a) whose `jti` is the row's PK; the row is the authority on lifecycle
and lineage, the JWT is the authority on request authenticity. The
constraints (subset scope, TTL ≤ parent remaining, cascade on revoke) and the
migration off `SESSION_JWT_SECRET` are detailed in §6.

### 5. DB/RLS convention (kamusites template)

Same DB/RLS convention as kamusites:

- **Own database**; **all objects in one schema** (e.g. `llm`), so the schema is
  relocatable and collision-free in a shared dev DB.
- **Two-pool split:** owner/BYPASSRLS pool for migrations + the login reconcile;
  `app_user`/`authenticated` request pool subject to RLS.
- **RLS keyed on the team/org projection** (which is keyed on the shared,
  non-divergent `kamuid_org_id` per kamuhub ADR 0001). A key row carries
  `team_id`; RLS policies scope a user to their orgs' keys, exactly like
  `sites.user_sites()` scopes sites.
- **`requireGrant`** enforcement mirrors kamusites: a route that creates/revokes
  a key requires an `llm.keys.*` grant on the targeted org in the signed
  context. RLS scopes visibility; `requireGrant` is the explicit permission
  gate. Fail-closed unconditionally.

### 6. Delegated minting replaces the shared secret

- The `llm-proxy/` satellite moves **out of kotisivukamu into this repo**. Its
  only couplings to kotisivukamu are (a) the shared `SESSION_JWT_SECRET` and
  (b) the poller — both are addressed below.
- The control-plane folders (`worker/src/llm_usage`, `internal-api/src/llm_usage`,
  the `llm_usage` migration, the `LlmTokens.jsx` page's *data layer*) move into
  this repo. The dashboard *component* may stay in kamuhub (it renders the
  gateway's API like it renders kamusites' API); what moves is the server side.

**The shared `SESSION_JWT_SECRET` is retired, but not by deleting minting.**
The secret currently lets several services mint their own short-lived,
session-scoped sub-tokens — and that capability must survive, because the
callers that use it **cannot hold a static key instead**:

- **studio** mints a per-editor-session credential carrying `site_id` /
  `machine_id` / `model_id`, so an editor session's provider cost is
  attributable and a leaked session token can only reach its own session's
  model. A static gateway key would either be unscoped (loses attribution +
  per-session blast-radius) or require one gateway key per session (a key
  storm, and studio would have no way to create them without minting rights).
- **builder-queue** mints a per-build token so a build's cost is attributable
  to that build and the token dies with the build. Same reasoning.

The gateway replaces the shared secret with **delegated minting**: a key can
hold a `can_mint` capability that authorizes it to mint **sub-keys** (short-
lived, narrower-scoped child keys) through a gateway `POST /api/keys/derive`
endpoint. The sub-key is itself a DB-backed key row (revocable, budgeted,
attributable), but created by the parent key holder, not by a logged-in user.

This preserves every property the shared secret gives today and removes the
thing that makes it unsafe (one global secret, held by N processes, whose only
revocation is rotation):

- The powerful minting secret is no longer held by studio / builder-queue /
  the kamuhub agent. Each gets **one** gateway key with `can_mint`, scoped to
  its org. Revoking that one key revokes the service's ability to mint — a
  real kill switch, per service, without nuking everyone.
- Sub-keys are scoped **narrower** than their parent (a sub-key's model
  allowlist and budget must be a subset of the parent's). A leaked sub-key
  (an editor session, a build) is revocable individually and bounds blast
  radius to itself.
- Attribution is preserved or improved: the sub-key carries an arbitrary
  `metadata` blob (today's `site_id`/`machine_id`/`model_id`, a `build_id`) that
  flows into the `usage_log` row, so cost still rolls up to the session/build.
- The sub-key's TTL is bounded by the parent's remaining TTL (a permanent
  parent can still mint short-lived children — the studio case — but a
  short-lived parent cannot mint children that outlive it).

So the migration is not "retire the secret, give everyone a static key." It is
"retire the shared secret, give the services that need to mint a `can_mint`
key, and let them derive session-scoped sub-keys through the gateway."

### 7. Delegation risk model (token attenuation)

Allowing a key to mint child keys is **token attenuation / delegation**
(AWS STS, GCP downscoped tokens, Macaroons). The pattern is safe *only* with
the following seven invariants, all enforced at `POST /api/keys/derive` and on
the satellite hot path. These are hard rules, not aspirations — each has a
concrete check below.

**1. Lifetime — child cannot outlive parent (no zombie tokens).**
A dying parent must not mint persistent access. The child expiry is clamped:
`child.expires_at = min(requested_expiry, parent.expires_at)`. A permanent
parent (`expires_at IS NULL`) imposes no upper bound (the studio case: a
permanent service key mints 24h session keys). A parent with a short TTL
simply cannot request a longer child — the request fails closed.

**2. Revocation — cascade down the lineage, not just the one row.**
Revoking a parent invalidates its entire subtree immediately. Because keys are
DB rows (not stateless JWTs), this is a real cascade, not a denylist that
propagates eventually: `revoke(key)` sets `status='revoked'` on the key **and
all rows where `root_key_id = key.id`** (a single indexed update). The hot path
needs to check only the presented key's own `status` **plus** that no ancestor
is revoked — which, because the cascade is write-time, is equivalent to
checking the one row. (If we ever wanted lazy revocation, the hot path would
walk `parent_key_id` up; we don't, because write-time cascade is simpler and
the subtree is expected to be small.) The 10s key-meta cache is the only
window in which a revoked parent's child still works — same window as any
other revocation, by design.

**3. Recursion — sub-keys cannot mint (depth = 1, hard limit).**
*(Still in force after 2026-09-23; it is now enforced by `derive` rejecting
any key with `parent_key_id` set, not by `can_mint`.)*
`can_mint` is **not inherited** by derived keys. A derived key is minted with
`can_mint = false` unconditionally; `POST /api/keys/derive` 403s if presented a
child key. This kills the `A→B→C→…` loop at depth 1 with no depth counter
needed. If delegation depth is ever required, add an explicit
`max_delegation_depth` column and decrement; do not infer it from capability
presence.

**4. Scope enclosure — strict set intersection, not string matching.**
Child scopes must be a **subset** of parent scopes, verified by exact set
operations. Concretely: `models[]` is an allowlist of catalog slugs (or the
literal `*`); `*` attenuates to any named subset, a named set attenuates to a
subset of itself, and `*` cannot be *produced* from a named parent
(narrowing `*` stays `*`, which is fine; widening a named set to `*` is
rejected). There is **no string-prefix / `startsWith` matching** anywhere —
slugs are exact-match atoms. ~~`budget_usd` attenuates numerically: child budget
≤ parent's *remaining* budget (not the original), so a parent that has already
spent most of its budget cannot mint a child with a fresh full budget.~~
*(Dropped 2026-09-23: a budget caps only its own key's spend; see
"Revision 2026-09-23".)* Fail
closed on every constraint. The org/team boundary is enforced separately and
non-negotiably: a child key's `team_id` **must equal** the parent's `team_id`
(confused-deputy defense — a parent scoped to tenant A cannot mint a child
pointing at tenant B; there is no cross-tenant derivation).

**5. Environmental context — children may only tighten, never loosen.**
If a parent carries environmental constraints (today: none in the JWT; future:
IP allowlist, mTLS), a child must inherit them and may only **add** more
restriction. The schema supports this with a `constraints jsonb` column on
`keys`; derivation merges parent.constraints ∪ requested.constraints (union of
restrictive predicates — a tighter IP set, not a wider one). Today the column
is nullable and unused; the rule is stated now so the design doesn't have to be
retrofitted when the first constraint is added. Network-boundary tokens must
never mint tokens usable outside the boundary.

**6. Attribution — log the full lineage on every event.**
Every `usage_log` row (and every audit event) captures, in addition to the
acting `key_id`: `parent_key_id` (immediate creator) and `root_key_id` (the
top-level key the chain descends from). For a top-level key, `parent_key_id =
root_key_id = self.id`. This gives both roll-up ("what did this service's whole
subtree cost?" → sum where `root_key_id = X`) and drill-down ("which specific
session spent this?" → the `key_id` + its `metadata` blob). Telemetry never
records only one level.

**7. Token flooding — rate-limit derivation per parent.**
`POST /api/keys/derive` is rate-limited **per parent key** (e.g. N mints/min,
capped at M active children per parent). This bounds the database/cache impact
of a runaway script or a compromised `can_mint` key. Expired/revoked children
don't count toward M (a periodic sweep marks them inactive). The cache that
backs the hot path is bounded by M × number-of-`can_mint`-keys, which is
small and knowable.

**Checklist (the contract `derive` enforces):**

| Invariant              | Rule                                                             |
|------------------------|------------------------------------------------------------------|
| Max expiry             | `child.expires_at = min(requested, parent.expires_at)`           |
| Revocation             | `parent_key_id` + `root_key_id` cols; revoke cascades subtree   |
| Recursion              | derived keys cannot derive (`parent_key_id` set → 403); depth = 1 |
| Scope enclosure        | `models ⊆ parent.models`, exact set (budget: not enclosed)       |
| Lineage tracking       | every event logs `key_id` + `parent_key_id` + `root_key_id`      |
| Rate limit             | per-parent mint rate + max active children                       |
| Tenant boundary        | `child.team_id = parent.team_id` (no cross-tenant derivation)     |

### 8. Usage accounting is keyed by `key_id`

The existing `llm_usage` table is keyed by `jti`/`token_name` (the stateless-JWT
labels). In the new model usage is keyed by **`key_id`** (the DB row's PK), so a
key's spend is attributable, revocable, and aggregatable per org, and the
lineage columns from §7 (`parent_key_id`, `root_key_id`) let spend roll up to
a service's whole subtree. The satellite meters into its local SQLite buffer
exactly as today; the poller pulls rows into the gateway's durable `usage_log`
keyed by `key_id` + the lineage cols. The contract shape is otherwise unchanged
(the satellite ↔ control-plane `/usage` poll is preserved; only the identity
columns change).

### 9. CRUD surface for kamuhub

The gateway exposes (all behind `X-Kamuhub-Authz` + `requireGrant`, RLS-scoped,
*except* the derive endpoint which is parent-key-authenticated):

- `GET    /api/keys`                  — list keys in the caller's org
- `POST   /api/keys`                  — mint a top-level key
                                        (requireGrant `llm.keys.create`)
- `GET    /api/keys/:id`              — key detail + live usage totals
- `POST   /api/keys/:id/revoke`       — revoke a key
                                        (requireGrant `llm.keys.revoke`;
                                        revoking a parent revokes its subtree)
- `POST   /api/keys/derive`           — mint a sub-key from a parent key
                                        (auth = the parent key, **not** the
                                        BFF context; subset-scoped, TTL ≤
                                        parent remaining, optional `metadata`)
- `GET    /api/usage`                 — per-day/per-key/per-model breakdown
                                        (filters: key_id, model, from, to)
- `GET    /api/usage/totals`          — totals per key over a window
- `GET    /api/usage/facets`          — distinct keys + models for filter UIs

The full key secret is returned **exactly once** on `POST /api/keys` and on
`POST /api/keys/derive`; the stored row holds only a hash + a human-readable
prefix for display.

## §10. Hot path, spend, and revocation

### 10.1 Objective and accepted trade

The proxy optimizes for **Time To First Token (TTFT)**. Spend caps are
**soft**: overdraft is accepted and bounded. Exact spend enforcement would
require a synchronous central-DB check on every request (single node,
always-on Postgres), which is explicitly rejected. The trade is deterministic
~0ms proxy overhead in exchange for bounded soft overdraft. Every design
decision in this section follows from that priority.

### 10.2 Why the proxy is not at the edge

The proxy forwards to an external upstream provider (Scaleway, etc.). Edge
placement near the user only shortens the client→proxy leg; the expensive
proxy→upstream leg is fixed by the provider's region. So the proxy sits **near
the upstream provider** (e.g. ams/cdg), not at the edge. This collapses the
cross-region cache-miss problem: proxy and central API+DB can be in the same
region, latencies are small, and the elaborate cross-region machinery that
edge placement would require is unnecessary.

### 10.3 High availability (the reason for cross-instance coordination)

HA requires ≥2 instances, same provider region (e.g. ams + cdg over Fly 6PN).
This reintroduces a small-N version of the multi-instance budget problem: a
key hitting N instances can spend ~N× its budget locally. The two-tier model
below is the HA baseline (light version, N=2–3), not an escalation.
Multi-region edge scaling (with regional affinity to bound the N×budget
worst case) is the documented escalation path, unbuilt at MVP.

### 10.4 The two key types and where they live

- **Top-level keys** (the product, per §2/§3): DB-backed rows in central
  Postgres, with an **opaque-hash credential** (`sk_live_…`) on the wire.
  Permanent (or admin-revoked). The thing customers manage through the kamuhub
  dashboard. Verified on the hot path by lookup against an in-process
  key-metadata cache (the kamuhub `key_gate` pattern). Never causes a DB read
  on the hot path.
- **Derived sub-keys** (per §6/§7): **short-lived signed JWTs** (1h TTL) on
  the wire, **backed by DB rows** for management/lineage/revocation. The JWT
  carries `jti` (the DB row's PK), `models`, `budget_usd`, `exp`, and an
  optional `metadata` blob. The proxy verifies the JWT signature statelessly
  (~0ms), then checks the in-memory `revokedSet` and `localSpendMap` — both
  populated from the DB rows via gossip/poller, same background paths as
  top-level keys. So sub-keys are also ~0ms on the hot path and also never cause
  a DB read.

This retires the global `SESSION_JWT_SECRET` held by ~8 services: statelessness
survives only at the short-lived leaf (the sub-key JWT), not at the top-level
key (the opaque product row).

### 10.4a Signing: Ed25519, not HMAC

Sub-key JWTs are signed with **Ed25519** (asymmetric), not HMAC (symmetric).
The reason is defense-in-depth against proxy compromise:

- **HMAC** would require the proxy to hold the same secret that mints sub-keys.
  A compromised proxy VM could then forge arbitrary sub-keys — which is the
  exact blast-radius problem `SESSION_JWT_SECRET` has, just relocated to the
  proxy.
- **Ed25519** keeps the private key in the central API only (the single place
  that mints). Proxies hold only the **public key** — they can verify
  signatures in <0.1ms but can never mint, even if the proxy VM is fully
  compromised.

Verification cost is the same (~0.1ms either way). Key rotation is cleaner:
the central API pushes a new public key to proxies via the poller (with a
grace window accepting signatures from the previous key), and a compromised
old key can be retired without touching any proxy's verification key.

The proxy holds **two verification capabilities** and **zero minting
capabilities**: the Ed25519 public key (for sub-key JWTs) and the key-meta
cache (for top-level opaque keys). Neither can mint.

### 10.5 Timing decomposition (the organizing principle)

- **spend read** (pre-check): on the hot path, gates forward, before the
  stream. Must be ~0ms.
- **spend write** (increment): off the hot path, **after the stream completes**
  — cost depends on output tokens, which aren't known until the response is
  done. This is a constraint of the problem, not an optimization we chose.
- **revocation read**: on the hot path, before forward.
- **revocation update**: background (gossip or poll), off the hot path.

The only operations on the hot path are two in-memory reads. Every write is
post-response or background. This is what makes the hot path deterministically
~0ms: there is no jitter source on it, by construction.

### 10.6 Hot path (per request, ~0ms)

The hot path dispatches on key format (see §3 for the two credential shapes):

```
1. Detect key format:
   - sk_live_…  (top-level opaque key) → lookup in key-meta cache
   - three-segment compact JWT (derived sub-key) → verify Ed25519 signature
   - neither                                     → fail: 401

2. Extract jti (cache row PK for top-level; JWT jti claim for sub-key)

3. if (revokedSet.has(jti))                              → fail: 401
4. if (localSpendMap.get(jti) >= token.budget)           → fail: 402
5. forward to upstream, stream response to client
   (metering happens in a tee() off the response, after the stream)
```

For top-level keys, step 1 is a cache lookup (the cache holds the row's
metadata, keyed by the opaque key's hash). For sub-keys, step 1 is an Ed25519
signature verification (the public key is held in memory). Both are ~0ms. In
either case, steps 3–5 are identical: two in-memory reads, then forward.

No network call, no DB read, no disk read. The hot path is ~0ms for both key
types, by construction.

### 10.7 Post-response metering (off hot path)

```
1. stream completes → compute {cost_usd, tokens_in, tokens_out}
2. localSpendMap.set(jti, current + cost_usd)            [in-memory, per-key summary]
3. write usage_log row to local SQLite                  [per-request detail, on disk]
4. gossip.broadcast({jti, delta, req_id})               [fire-and-forget to 6PN peers]
```

### 10.8 Cross-instance coordination: G-counter gossip + central poller

Spend is a **Grow-Only Counter (G-counter)**: Δ ≥ 0, addition is
commutative/associative, message order irrelevant. Instances broadcast spend
deltas over Fly 6PN (UDP, fire-and-forget, ~7ms). A central poller is the
safety net: each instance flushes its SQLite usage to central every ~2s and
pulls the global revocation set. The poller catches dropped gossip and
handles admin/budget revocations.

**Two-layer revocation composition:**
- **Gossip** (fast, ~7ms): cross-instance spend propagation, so one instance
  learns when another has spent the budget.
- **Central poller** (authoritative, ~2s): global revocation set, catches
  anything gossip missed + admin-revoked keys.

Both safe directions: the local accumulator can only under-enforce
(per-satellite soft cap); the revocation set can only over-enforce (adds
revocations, never removes). Overdraft is bounded by
`(post-response lag + gossip/poll lag) × throughput × cost/req` — pennies at
projected traffic.

### 10.9 In-memory structures and bounds

| Structure                | Granularity              | In memory      | Bounded by                  |
|--------------------------|--------------------------|----------------|-----------------------------|
| `localSpendMap` (jti→usd) | per key (aggregated)     | yes            | distinct keys alive         |
| `revokedSet` (jti)       | per key                  | yes            | revoked & not-expired       |
| seen-request-ids         | per request, 30s window  | yes (or SQLite)| 30s × rate                  |
| usage_log                | per request (detail)     | **no, SQLite** | unbounded (on disk)         |

**Nothing accumulates per-request-in-memory-forever.** Spend is aggregated
per-key; usage detail is on disk; dedup is time-windowed. The per-request
volume (1M req/day) only affects how often in-memory entries are *touched*,
not how many *exist* — spend is one entry per key, updated ~1000×/day, not
1000 entries.

**Footprint at 1000 users × 1000 messages/day** (~12 req/s, 1h sub-keys,
5% permanent keys):

- `localSpendMap`: ~1000 alive short-lived keys + ~5% permanent. Short-lived
  bounded by `exp`-pruning (~120 KB); permanent keys have no `exp`, accumulate
  monotonically with total distinct permanent keys ever issued (~2 MB at 1
  year, ~6 MB at 3 years projected growth). Total: single-digit MB for years.
- `revokedSet`: ~10 KB (only revoked-and-not-yet-expired keys).
- seen-request-ids: ~100 KB (30s × 12 req/s).
- **Total in-memory: well under 10 MB** at projected 3-year growth. Not OOM.

**Escalation if permanent keys ever dominate:** inactivity-pruning — evict
permanent-key entries unused >30d from the in-memory map, repopulate on next
use. Dormant-key return pays one SQLite read (off-hot-path at first use). This
is the documented hedge, not built at MVP, because at projected growth the
permanent population is single-digit MB for years.

### 10.10 Invariants

1. **Per-request idempotency on gossip.** UDP can duplicate; a bare additive
   counter is not idempotent. Gossip messages carry a `req_id`; receivers
   track seen-ids and ignore re-deliveries. (Seen-ids are off-hot-path, so can
   be SQLite-backed if they ever grow.)

2. **Revocation set pruned to `exp > now`.** A jti past its `exp` can't pass
   JWT verify anyway, so keeping it in the set is dead weight. Prune on poll
   and on gossip receive. Bounds the set to recent revocations.

3. **Boot fails closed.** A freshly-booted instance has empty spend state.
   Until it fetches the global revocation set (and, for correctness under
   overdraft, the global spend baseline) from central, it must **refuse to
   serve** (503), not serve with zero baseline — otherwise it would allow a
   key already exhausted elsewhere.

4. **Usage flush clears on success only.** Drain-then-fetch loses records on
   network failure. Snapshot the buffer, fetch, clear only on success; on
   failure, restore.

5. **Minting capability stays centralized (Ed25519 private key only).** Only
   the central API holds the Ed25519 private key (the only thing that can mint
   sub-keys). The proxy holds only the public key (can verify, cannot mint)
   plus the opaque-key cache (can look up, cannot forge). This is what retires
   `SESSION_JWT_SECRET` — not just by centralizing minting, but by making the
   proxy's verification keys *incapable* of minting, even under full VM
   compromise. The era of N services sharing a symmetric minting secret ends
   here; the capability it provided (delegated, ephemeral, attributable
   credentials) is preserved as a first-class gateway feature with a strictly
   smaller attack surface.

### 10.11 Overdraft exposure

At 1000 users × 1000 messages/day (~12 req/s) with the lag bound of
`~2s push + ~2s poll + in-flight` ≈ 4s, and $0.01/req worst case:

```
Max overdraft per budget-exhaustion event = 4s × 12 req/s × $0.01 ≈ $0.48
```

Pennies. This is the explicit, accepted trade for deterministic ~0ms TTFT.

## Consequences

- **One new repo, one new service, one new Fly app.** The satellite + control
  plane are no longer a kotisivukamu guest; they have their own release, own
  Fly app, own Postgres. (The current `kotisivukamu-llm-proxy` Fly app is
  renamed/migrated, not duplicated.)
- **kamuhub gains an `llm.keys.*` grant family** and a dashboard page that
  renders the gateway's API. That is the only kamuhub-side change.
- **Every internal caller that minted with `SESSION_JWT_SECRET` is migrated**
  to a `can_mint` gateway key. Each becomes a gateway client that derives
  session-scoped sub-keys (studio per editor session, builder-queue per build).
  This is the bulk of the migration work and the reason to stage it (see
  *Migration*).
- **Revocation becomes real.** A leaked external-developer key is killed with
  one row update, within the cache TTL, without touching any other caller. A
  compromised *service* is killed by revoking its `can_mint` key, which also
  (cascade) revokes every sub-key it minted.
- **Per-key budgets survive restarts**, because they are DB rows, not a SQLite
  file.
- **The kotisivukamu `/llm-tokens` page is removed** once the kamuhub dashboard
  page renders the gateway; the stateless-mint escape hatch (`scripts/mint.ts`)
  is removed.

## Boundaries this draws

- **The gateway is a resource server, not the front door.** No UI; it is
  rendered by kamuhub. Driven through the BFF, which injects authz.
- **The gateway owns no identity.** No account model, no signup, no approval
  queue. Identity → KamuID; authz/grants → kamuhub; the gateway keys rows on
  `kamuid_org_id` and enforces grants. This is the same boundary as every
  other satellite (kamuhub ADR 0001), applied to a new resource.
- **One secret holder, but minting survives.** Only the gateway mints/
  verifies gateway keys. Services that need session-scoped credentials hold a
  `can_mint` key and **derive** sub-keys through the gateway — they no longer
  hold a global HMAC secret. The era of N services sharing
  `SESSION_JWT_SECRET` ends here; the capability it provided (delegated,
  ephemeral, attributable credentials) is preserved as a first-class gateway
  feature.
- **Usage is a gateway-owned ledger**, keyed by `key_id`, exposed read-only to
  kamuhub. It is not billing — `cost_usd` is the proxy's catalog-price estimate,
  labelled "estimated." Billing, if it happens, is a kamuhub concern fed by this
  ledger (kamuhub ADR 0001: billing lives in kamuhub, not in resource servers).

## Migration (staged)

1. **Stand up the repo + DB + satellite.** Move `llm-proxy/` in; port the
   `llm_usage` migration (re-keyed to `key_id`); stand up the `keys` table +
   RLS. The satellite still accepts the legacy HMAC JWT in parallel during the
   cutover.
2. **Add the keys CRUD + usage API.** Wire kamuhub's `llm.keys.*` grants and a
   dashboard page that renders them.
3. **Migrate internal callers off `SESSION_JWT_SECRET`**, one at a time:
   studio, builder-queue, the kamuhub agent, internal-api. Each receives a
   `can_mint` gateway key scoped to its org and switches from "sign my own HMAC
   JWT" to "derive a sub-key via `POST /api/keys/derive`." Verify each before
   moving the next. The sub-key carries the metadata the caller previously
   baked into its JWT (`site_id`/`machine_id`/`model_id`, `build_id`) so
   attribution is unchanged.
4. **Cut over the satellite** to DB-backed-key verification only; retire the
   HMAC-JWT path and `SESSION_JWT_SECRET`. The satellite's only signing-related
   state is now: look the key up, check `can_mint`/`status`/budget, forward.
   Sub-keys are verified the same way (they are rows), so there is no separate
   verification path.
5. **Remove the kotisivukamu control-plane guest** (poller, `internal-api`
   llm_usage route, `LlmTokens.jsx` data layer, `scripts/mint.ts`).

## Open questions (resolved 2026-08-25)

- **Key shape on the wire.** *Resolved: prefixed-opaque.* Already implemented
  as `sk_live_…`, sha256-hashed (`api/src/lib/keys.ts`). No further decision
  needed.
- **`can_mint` provisioning.**
  ~~*Resolved: gated by a kamuhub grant.* Issuing a `can_mint` key requires
  `llm.keys.mint` (admin-only), enforced by kamuhub the same way as every
  other privileged action in this system. Rationale: the ADR's own design
  principle (§1, §9) is that every capability is a grant kamuhub enforces and
  can audit; carving out the single most powerful capability — the ability to
  mint minting keys — as an ungoverned, unauditable out-of-band step
  contradicts that principle for no real benefit, since the set of holders
  (studio, builder-queue, the kamuhub agent) is small and already goes through
  kamuhub-mediated provisioning for everything else.~~
  **SUPERSEDED 2026-08-25.** `can_mint` key issuance and revocation is now
  managed exclusively through the new `admin/` app (its own Fly app,
  `llm-proxy-admin`), not through a kamuhub grant. This is a deliberate
  reversal of the 2026-08-25-morning resolution above, made the same day once
  building the surface made the shape mismatch concrete:
  - **This is not the shape kamuhub's grant model fits.** Every other grant
    in this system (`llm.keys.create`, `llm.keys.revoke`) is a *customer-facing,
    per-org* action: an org member acting within their own org's data, scoped
    by RLS, rendered through the kamuhub dashboard. Minting a `can_mint` key is
    a *cross-org, superuser* action with no owning org and no RLS scope to
    speak of — the set of people who should be able to do it is "platform
    operators," not "members of org X with grant Y." Bending the per-org grant
    model to cover a capability that has no org is what the original
    resolution actually did, and it does not fit cleanly: `requireGrant`'s
    whole contract (`resolveKamuidOrgId` — see `api/src/routes/keys.ts`)
    assumes the action targets one org.
  - **A genuinely different surface, not a missing grant.** `admin/` is a
    separate authn system (better-auth, its own `admin_auth` Postgres schema,
    no self-service signup — see `admin/README.md`) precisely because "can an
    operator do platform-wide superuser things" is not a question KamuID
    identity + a kamuhub org grant is designed to answer. Keeping it there
    would mean either (a) a `can_mint` grant scoped to a fake/internal
    "platform" org, which is the confused-deputy shape ADR §7.4's tenant
    boundary exists to prevent, or (b) kamuhub growing an ungoverned
    non-org-scoped superuser grant type solely for this one capability. Both
    are worse than a dedicated small admin surface.
  - **The set of holders didn't change, only who provisions them.** studio,
    builder-queue, and the kamuhub agent still each hold exactly one
    `can_mint` key, scoped to the internal-platform team, exactly as designed
    in §6. What changed is *who mints that key*: a platform operator through
    `admin/`, not an org member through a kamuhub-rendered dashboard action.
  - **Known follow-up (do not build speculatively):** the kamuhub-side
    `llm.keys.mint` grant, added by kamuhub's own migration
    `20260825120000_llm_gateway_grants.up.sql`, is now dead/unused code in the
    kamuhub repo. That repo is out of scope for this change (this gateway
    doesn't touch kamuhub), but a future kamuhub cleanup pass should remove
    it — leaving it live but unenforced is a landmine for whoever next reads
    kamuhub's grant catalog and assumes it does something.
  - **Known follow-up in THIS repo:** `api/src/routes/keys.ts`'s
    `POST /keys` still additionally gates `can_mint: true` behind
    `requireGrant("llm.keys.mint", ...)` (the old path). It is untouched by
    this change to avoid destabilizing the existing keys-CRUD test suite in
    the same pass as adding `admin/`; a follow-up should decide whether to
    remove that branch outright (making `admin/` truly the only path, per
    this note's own title) or leave it as a defense-in-depth belt-and-braces
    check now that the kamuhub grant behind it is itself unused (see the
    previous bullet) — either is defensible, but the current state (both
    paths technically live, only one actually provisioned) should not be
    mistaken for the intended end state.
- **Budget enforcement location.** *Resolved by §10.* Satellite-side
  pre-check stays (bounds blast radius to budget + in-flight); the proxy gates
  on in-memory per-key spend, updated post-response, with a G-counter gossip +
  central-poller two-layer model for cross-instance coordination. Soft overdraft
  is the explicit trade for deterministic ~0ms TTFT; exact spend would require a
  synchronous central-DB check on every request, which is rejected.
- **Internal-caller authz to the gateway.** *Resolved: we never issue
  `can_mint` to external orgs.* `POST /api/keys/derive` additionally requires
  the parent key's `team_id` to equal a fixed internal-platform org id (env
  config), on top of the existing `can_mint` check. Rationale: this is the
  simplest closure of the confused-deputy risk in §7.4, it matches the actual
  present-day caller set (studio, builder-queue, the kamuhub agent — all
  internal), and it avoids building a second, more permissive external-`can_mint`
  path that has no current consumer. If an external `can_mint` use case appears
  later, it should be a deliberate follow-up ADR, not a default left open here.

> Resolved by §7 (delegation risk model): child TTL ≤ parent remaining;
> cascade revocation via `parent_key_id`/`root_key_id`; depth = 1 (`can_mint`
> non-inheritable); strict set-intersection scope enclosure + tenant boundary;
> full lineage in every log; per-parent derivation rate limits. These are now
> invariants, not open questions.

## Revision 2026-09-23: `can_mint` removed, budgets are per key

**Any active top-level key can derive sub-keys.** The `can_mint` column, the
`INTERNAL_PLATFORM_TEAM_ID` check on `POST /api/keys/derive`, the
`llm.keys.mint` branch of `POST /keys`, and `admin/`'s `can_mint` option are
gone (migration `20260923105027_drop_can_mint`).

- **Why the gate was not needed.** Under the §7 invariants a derived key can
  never do more than its parent: TTL ≤ parent, `models ⊆ parent.models`,
  same `team_id`, cascade revocation, depth 1, per-parent rate limits. A
  holder of a leaked parent key can already do everything its children could,
  so the ability to derive adds no access. `can_mint` was a leftover of
  migrating off the shared `SESSION_JWT_SECRET` (§6), and the internal-team
  restriction (2026-08-25, "Internal-caller authz") rested on "no external
  consumer yet", not on a security argument. Keeping it cost a fragile
  env var: a random `llm.teams.id` that only exists after the internal org's
  first login through kamuhub and differs per environment.
- **Depth stays 1.** Derived keys cannot derive. Sub-keys are the credentials
  handed to less-trusted places (browser, build machine, editor session), so
  the chain ends there. Depth 1 also keeps the per-parent rate limit a real
  bound (it would compound per level) and keeps lineage flat (`root_key_id`).
- **Budgets are per key, not enclosed.** A key's `budget_usd` caps only that
  key's own spend. A parent with a $50 budget may derive a child with a $200
  budget or none. Consequence: a budget is not a subtree spend cap. Org- or
  service-level spend control belongs to billing (kamuhub), not to key
  attenuation. The §7.4 "budget ≤ parent remaining" rule is dropped (it was
  also unsound as implemented: each child was checked separately against the
  parent's remaining budget, and the proxy enforces spend per `key_id` only).
- **Internal services** (studio, builder-queue, the kamuhub agent) hold
  ordinary top-level keys in an ordinary org. `admin/` remains the cross-org
  superuser surface for minting/revoking keys in any org.
- **Follow-up outside this repo:** kamuhub's `llm.keys.mint` grant
  (`20260825120000_llm_gateway_grants`) is now unused and should be removed.

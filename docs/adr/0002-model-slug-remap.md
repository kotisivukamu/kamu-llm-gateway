# ADR 0002 — Client-facing vs. upstream model slugs

- **Status:** Accepted — 2026-08-31
- **Builds on:** ADR 0001 (the key is the product; client-facing slugs are
  the product-facing name)

## Context

`ModelEntry` (in `proxy/src/catalog.ts`) keys models by a single slug — the
value of the `model` field clients send. `proxy.ts` forwards that field
**verbatim** to the upstream provider. The catalog's `request_overrides`
mechanism is the only way to alter the body before forwarding, and it is a
shallow merge that lets the client's `model` win:

```ts
const merged = { ...original, ...overrides };
```

So `request_overrides` cannot rewrite `model` — a `model` override is silently
overwritten by the client's own `model`.

This was never a problem while every upstream accepted the bare client slug.
It became one with **tensorx.ai** (added 2026-08-31): tensorx is OpenAI-
compatible but namespaces its model ids, so it answers `z-ai/glm-5.3` and
**403s on the bare `glm-5.3`**. Routing `glm-5.3` to tensorx.ai-native is
therefore impossible in the current shape — the proxy would forward the bare
slug and get a 403. The workaround was to route through **cortecs**, which
happens to accept the bare slug and fronts tensorx under the hood. That works,
but it smuggles a routing decision through the *name* of the model: the same
string (`glm-5.3`) means a different provider depending on which row you read,
and the only record of why is a catalog comment.

Two jobs are being forced onto one field:

1. **Client-facing slug** — the atom clients send, and the atom authz,
   budget, metering, and `usage_log` are keyed on. The *product* name of a
   model, stable across provider moves.
2. **Upstream slug** — the atom the provider actually understands. Plumbing.
   Provider-specific, sometimes namespaced (`z-ai/glm-5.3`), sometimes not
   (`glm-5.3` on cortecs / opencode-zen).

## Decision

Split them. `ModelEntry` gains an optional `upstream_model_slug`:

```ts
export interface ModelEntry {
  provider_slug: string;
  // ... pricing ...
  // The slug sent to the upstream provider. Defaults to the client-facing
  // slug (the MODELS key) when omitted. Set when a provider namespaces or
  // renames a model the client knows by another name (e.g. tensorx.ai wants
  // `z-ai/glm-5.3`; cortecs / opencode-zen take `glm-5.3` bare).
  upstream_model_slug?: string;
  // (request_overrides stays for OTHER body tweaks — forcing thinking on/off,
  // pinning anthropic-version — not for the model field.)
  request_overrides?: Record<string, unknown>;
}
```

`proxy.ts` rewrites the `model` field **upstream-only**. The client-facing
slug (the `model` the client sent, which is the MODELS key) continues to drive
everything internal — authz (`isModelAllowed`), cost lookup (`getModel`), the
`usage_log.model` column, the metering log lines. Only the bytes on the wire
to the upstream provider change:

```ts
const entry = modelInBody ? getModel(modelInBody) : null;
const overrides = entry?.request_overrides ?? {};
const upstreamModel = entry?.upstream_model_slug ?? modelInBody;
const merged = upstreamModel !== modelInBody || Object.keys(overrides).length > 0
  ? { ...original, ...overrides, model: upstreamModel }   // model LAST → wins
  : original;
```

`model` is placed **last** in the merge so the upstream slug wins over both
the client's `model` and any stray `model` in `request_overrides`. (The
pre-fix merge `{ ...original, ...overrides }` let the client's `model` win;
this is the one-line correctness fix that makes a slug remap possible at all.)

The merge logic is extracted into a pure helper (`mergeRequestBody`) so the
ordering invariant is testable without standing up the gateway DB the full
proxy route needs.

## Why a field, not a convention

- **Routing becomes a real field, not a naming convention.** "glm-5.3 moved
  from zen to cortecs" stops being a comment explaining why one string means
  two providers; it is a one-field change (`provider_slug`), and
  `upstream_model_slug` changes only when the new provider names the model
  differently.
- **Client-facing slugs become stable contracts.** A key minted with
  `models: ["glm-5.3"]` keeps working when GLM 5.3 moves providers — the
  client slug never changes, only `provider_slug` + `upstream_model_slug` do.
  Today a provider move can change what a key's allowlist atom *means*; with
  the split it cannot.
- **Metering stays on the stable atom.** `usage_log.model` keeps the
  client-facing slug, so a usage query for "what did glm-5.3 cost this month"
  does not fragment when the model hopped providers mid-month (the rate at
  request time is still the `ModelEntry`'s price, which is the source of
  truth). If a move ever *renamed* the upstream slug, the old shape would log
  the same client slug billed at two rates with no way to tell them apart;
  keeping metering on the client slug and pricing on the entry is clean.
- **It composes with `request_overrides`.** The override mechanism keeps its
  job (other body tweaks); the slug is a separate concern with its own field,
  so the two aren't crammed into one map.
- **Strict generalization.** `upstream_model_slug` defaults to the
  client-facing slug, so every existing entry is unchanged — zero churn for
  the models that don't need it.

## Boundary: routing is the platform's decision, not the client's

The client sends the product slug; the platform picks the provider. A client
cannot pin a provider by sending a namespaced slug (`z-ai/glm-5.3`) — such a
slug is not in `MODELS`, so it 403s at authz before any upstream call. This
is deliberate: routing is how the platform moves models between providers for
cost / region / availability reasons, and letting a client pin a provider
defeats that. If a power user ever needs provider pinning, it is a separate,
explicit feature (a `provider_hint` on the key, resolved against the catalog),
not a reason to leak upstream slugs into the client contract.

Three clean layers: **client slug = product identity, upstream slug =
provider plumbing, routing = platform decision.**

## Consequences

- One optional field on `ModelEntry`; the MODELS key stays the client slug.
- One merge-ordering fix in `proxy.ts` (and a pure helper to make it
  testable). Authz, cost, and metering are untouched — they already key on
  the client slug (`modelInBody`), which is the whole point.
- `glm-5.3` / `glm-5.3-flash` can now route to a `tensorx`-native provider by
  setting `upstream_model_slug: "z-ai/glm-5.3"` — no cortecs workaround
  required (though routing through cortecs remains valid and is what
  `kotisivukamu/llm-proxy` does today, for its EU data-residency story).
- The same change applies to the legacy `kotisivukamu/llm-proxy` until it
  sunsets, so the two catalogs do not drift on this behavior.

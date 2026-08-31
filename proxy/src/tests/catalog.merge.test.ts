// mergeRequestBody (ADR 0002): the proxy rewrites the `model` field
// upstream-only when a provider namespaces/renames a model, while the
// client-facing slug stays the authority for authz/cost/metering. This is a
// pure function — no I/O, no DB — so the merge-ordering invariant (the
// upstream `model` must win over both the client's `model` and any stray
// `model` in request_overrides) is tested directly, without standing up the
// gateway DB the full proxy route needs.

import assert from "node:assert/strict";

const { mergeRequestBody, MODELS } = await import("../catalog.ts");

Deno.test("mergeRequestBody: no rewrite when model has no upstream slug or overrides", () => {
  // claude-opus-4-8 has neither upstream_model_slug nor request_overrides.
  const original = { model: "claude-opus-4-8", messages: [], max_tokens: 10 };
  const out = mergeRequestBody("claude-opus-4-8", original);
  assert.equal(out, original, "returned the same object (no reserialize)");
  assert.equal(out.model, "claude-opus-4-8");
});

Deno.test("mergeRequestBody: upstream_model_slug rewrites model on the wire", () => {
  // glm-5.3 routes through cortecs, which accepts the bare slug — so by
  // default there is no upstream_model_slug and nothing changes. Simulate a
  // tensorx-native entry by setting the field on a copy, the way a future
  // catalog edit would, to prove the mechanism independently of which
  // provider glm-5.3 happens to point at today.
  const entry = MODELS["glm-5.3"];
  assert.ok(entry, "glm-5.3 must exist in the catalog");
  const tensorxEntry = { ...entry, upstream_model_slug: "z-ai/glm-5.3" };
  // Swap in the tensorx variant for this test only.
  const saved = MODELS["glm-5.3"];
  MODELS["glm-5.3"] = tensorxEntry;
  try {
    const original = { model: "glm-5.3", messages: [] };
    const out = mergeRequestBody("glm-5.3", original);
    assert.notEqual(out, original, "a rewrite produced a new object");
    assert.equal(out.model, "z-ai/glm-5.3", "upstream slug sent on the wire");
    assert.equal(
      out.messages,
      original.messages,
      "non-model fields preserved",
    );
  } finally {
    MODELS["glm-5.3"] = saved;
  }
});

Deno.test("mergeRequestBody: model wins over a client-supplied upstream name and over overrides", () => {
  // The ordering invariant (ADR 0002): `model` is placed LAST in the merge so
  // the upstream slug wins over the client's own `model` AND over any `model`
  // a misconfigured request_overrides might carry. This is the one-line fix
  // that makes slug remap possible at all — the pre-fix merge
  // `{ ...original, ...overrides }` let the client's model win.
  const entry = MODELS["glm-5.3"];
  assert.ok(entry);
  const tensorxEntry = {
    ...entry,
    upstream_model_slug: "z-ai/glm-5.3",
    request_overrides: { model: "WRONG-from-override", temperature: 0.2 },
  };
  const saved = MODELS["glm-5.3"];
  MODELS["glm-5.3"] = tensorxEntry;
  try {
    const original = { model: "WRONG-from-client", messages: [] };
    const out = mergeRequestBody("glm-5.3", original);
    assert.equal(
      out.model,
      "z-ai/glm-5.3",
      "upstream slug beats both client model and override model",
    );
    assert.equal(out.temperature, 0.2, "non-model override applied");
  } finally {
    MODELS["glm-5.3"] = saved;
  }
});

Deno.test("mergeRequestBody: missing catalog entry passes the body through unchanged", () => {
  // A model the catalog doesn't know (e.g. a client sending a namespaced slug
  // to pin a provider) is not rewritten — it 403s at authz before this runs,
  // but mergeRequestBody must not throw on it.
  const original = { model: "z-ai/unknown-model", messages: [] };
  const out = mergeRequestBody("z-ai/unknown-model", original);
  assert.equal(out, original);
  assert.equal(out.model, "z-ai/unknown-model");
});

import { Hono } from "@hono/hono";
import {
  type AuthStyle,
  getModel,
  getProvider,
  mergeRequestBody,
} from "../catalog.ts";
import {
  extractCredential,
  isModelAllowed,
  verifyCredential,
} from "../auth.ts";
import {
  computeCostUsd,
  extractUsageFromJson,
  extractUsageFromSse,
} from "../cost.ts";
import { getSpentUsd, recordSpend, recordUsage } from "../db.ts";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const proxy = new Hono();

// Headers we forward to upstream. Drops hop-by-hop, cookies, and anything
// caller-identifying. Allowlist matches what the Anthropic and OpenAI SDKs
// actually send.
//
// Deliberately omits `accept-encoding`: Deno's fetch() auto-decompresses the
// response body but doesn't strip the `content-encoding` header it came back
// with. If we forwarded accept-encoding, upstream would gzip, we'd hand the
// SDK already-decompressed bytes with content-encoding=gzip still set, and
// the SDK would hang trying to gunzip plain text. Forcing identity transport
// here costs us a few percent of bandwidth and removes the trap entirely.
const FORWARD_HEADERS = new Set([
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "user-agent",
]);

function buildHeaders(
  src: Headers,
  auth_style: AuthStyle,
  upstream_api_key: string,
): Headers {
  const h = new Headers();
  for (const [k, v] of src.entries()) {
    if (FORWARD_HEADERS.has(k.toLowerCase())) h.set(k, v);
  }
  if (auth_style === "x-api-key" || auth_style === "both") {
    h.set("x-api-key", upstream_api_key);
  }
  if (auth_style === "bearer" || auth_style === "both") {
    h.set("authorization", `Bearer ${upstream_api_key}`);
  }
  return h;
}

proxy.all("/:provider_slug/*", async (c) => {
  const startedAt = Date.now();
  const provider_slug = c.req.param("provider_slug");
  const provider = getProvider(provider_slug);
  if (!provider) {
    return c.json({ error: "provider_unknown", provider: provider_slug }, 404);
  }

  const presented = extractCredential(c.req.raw.headers);
  const token = await verifyCredential(presented);
  if (!token) return c.json({ error: "unauthorized" }, 401);

  // Opt-in spend cap. Only keys minted with a budget are enforced; uncapped
  // keys skip this pre-check (their usage is still recorded by the
  // background tee below). Pre-check bounds the blast radius to at most the
  // budget plus one in-flight request's cost (we only learn a request's cost
  // after it completes). Keyed by key_id (ADR 0001 §8); null budget = uncapped.
  const budgeted = typeof token.budget_usd === "number";
  if (budgeted) {
    const spent = getSpentUsd(token.key_id);
    if (spent >= token.budget_usd!) {
      return c.json(
        {
          error: "budget_exhausted",
          message:
            `Key "${token.name}" has spent $${spent.toFixed(4)} of its ` +
            `$${token.budget_usd!.toFixed(2)} budget and is blocked. ` +
            `Mint a new key to continue.`,
        },
        402,
      );
    }
  }

  const url = new URL(c.req.url);
  const upstreamPath = url.pathname.replace(
    new RegExp(`^.*?/llm/${provider_slug}`),
    "",
  ) || "/";

  if (!provider.allowed_paths.some((re) => re.test(upstreamPath))) {
    console.warn(
      `[proxy] path rejected provider=${provider_slug} path=${upstreamPath}`,
    );
    return c.json(
      {
        error: "path_not_allowed",
        provider: provider_slug,
        path: upstreamPath,
      },
      403,
    );
  }

  // Buffer the JSON body so we can authorize against the model BEFORE we
  // touch the upstream key. Model authorization is a property of the key
  // (credential concern); the upstream-key check is a property of the
  // deployment. A key asking for a forbidden model must get 403 regardless of
  // whether this deploy has the provider key — otherwise the negative test
  // (sub-key for a model NOT in its allowlist) sees 502 instead of 403.
  let bodyInit: BodyInit | null = null;
  let duplexNeeded = false;
  let modelInBody: string | null = null;

  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const contentType = c.req.header("content-type") ?? "";
    const isJson = contentType.toLowerCase().includes("application/json");

    // Non-JSON requests stream raw — they can't carry a model field anyway.
    if (isJson) {
      // Read the body as text once — falling back to c.req.raw.body after a
      // failed json() would hand fetch() an already-disturbed stream
      // ("ReadableStream is locked or disturbed").
      const rawText = await c.req.text();
      try {
        const original = JSON.parse(rawText) as Record<string, unknown>;
        modelInBody = typeof original.model === "string"
          ? original.model
          : null;

        // Authorization: token must allow the requested model. Missing model
        // in body is treated as "any" — only chat / completion endpoints carry
        // it, others (count_tokens, /v1/models GET) don't, and those still
        // require the credential to verify.
        if (modelInBody && !isModelAllowed(token, modelInBody)) {
          return c.json(
            {
              error: "model_not_allowed",
              detail: `key "${token.name}" does not grant model=${modelInBody}`,
            },
            403,
          );
        }

        // Rewrite `model` upstream-only when the provider namespaces/renames
        // it (ADR 0002). modelInBody — the client-facing slug — stays the
        // authority for authz (above), cost lookup, and the usage_log row
        // (below). Only the bytes sent upstream change.
        const merged = modelInBody
          ? mergeRequestBody(modelInBody, original)
          : original;

        const newBody = JSON.stringify(merged);
        bodyInit = newBody;
      } catch (err) {
        console.warn(
          `[proxy] body parse failed (passing through): ${
            err instanceof Error ? err.message : err
          }`,
        );
        bodyInit = rawText;
      }
    } else {
      bodyInit = c.req.raw.body;
      duplexNeeded = true;
    }
  }

  // Catalog names which env var holds the upstream secret; the actual key
  // never sits in the DB. Sourced from Doppler → Fly secrets → process env.
  // To rotate: update Doppler, redeploy. Done AFTER model authorization so a
  // forbidden model 403s before a missing-key 502 (see comment above).
  const upstreamKey = (Deno.env.get(provider.api_key_env_var) ?? "").trim();
  if (!upstreamKey) {
    console.warn(
      `[proxy] env var ${provider.api_key_env_var} is empty for provider=${provider_slug}`,
    );
    return c.json({ error: "provider_key_missing" }, 502);
  }

  const headers = buildHeaders(
    c.req.raw.headers,
    provider.auth_style,
    upstreamKey,
  );

  // Re-apply content-length against the (possibly merged) body we will send.
  if (bodyInit && typeof bodyInit === "string") {
    headers.set(
      "content-length",
      String(new TextEncoder().encode(bodyInit).byteLength),
    );
  }

  const init: RequestInit = {
    method: c.req.method,
    headers,
    signal: c.req.raw.signal,
    ...(bodyInit !== null ? { body: bodyInit } : {}),
  };
  if (duplexNeeded) (init as { duplex?: string }).duplex = "half";

  const upstreamUrl = `${
    provider.base_url.replace(/\/$/, "")
  }${upstreamPath}${url.search}`;

  const upstream = await fetch(upstreamUrl, init);

  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    const lower = k.toLowerCase();
    if (lower.startsWith("access-control-")) continue;
    // Deno's fetch() transparently decompresses the upstream body but leaves
    // the original encoding headers attached. Forwarding them tricks the
    // client SDK into a second decode pass against already-plain bytes.
    if (lower === "content-encoding" || lower === "content-length") continue;
    outHeaders.set(k, v);
  }

  console.log(
    `[proxy] ${c.req.method} ${provider_slug}${upstreamPath} ` +
      `key="${token.name}" model=${modelInBody ?? "-"} ` +
      `status=${upstream.status} latency=${Date.now() - startedAt}ms`,
  );

  // Error / bodyless responses carry no billable usage — pass straight
  // through. Everything else (budgeted or not) is teed so the usage log gets a
  // row for every request; the spend ledger is additionally updated for
  // budgeted keys.
  const model = modelInBody ? getModel(modelInBody) : null;
  if (!upstream.body || upstream.status >= 400) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  }

  // Mirror the response so the client stream is untouched while a background
  // reader tallies usage from the copy. tee() preserves streaming (the client
  // branch is returned immediately); the meter branch is drained off the
  // response path, so recording never adds client-visible latency.
  const contentType = (upstream.headers.get("content-type") ?? "")
    .toLowerCase();
  const isSse = contentType.includes("event-stream");
  const [clientBranch, meterBranch] = upstream.body.tee();

  (async () => {
    try {
      const buffered = await new Response(meterBranch).text();
      const usage = isSse
        ? extractUsageFromSse(buffered)
        : extractUsageFromJson(safeJsonParse(buffered));
      if (!usage) return;

      // Cost is null when the model has no catalog price — token counts are
      // still recorded so the gap is visible and re-priceable later.
      const cost = model ? computeCostUsd(model, usage) : null;
      recordUsage({
        key_id: token.key_id,
        name: token.name,
        parent_key_id: token.parent_key_id,
        root_key_id: token.root_key_id,
        model: modelInBody ?? "-",
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        cost_usd: cost,
      });

      if (cost === null) {
        // Surfaced so an operator can add the missing catalog entry.
        console.warn(
          `[proxy] key="${token.name}" model=${
            modelInBody ?? "-"
          } has no catalog price; usage recorded without cost`,
        );
        return;
      }

      if (budgeted) {
        recordSpend(
          token.key_id,
          token.name,
          token.budget_usd!,
          cost,
          token.parent_key_id,
          token.root_key_id,
        );
      }
      console.log(
        `[proxy] metered key="${token.name}" model=${modelInBody} ` +
          `in=${usage.input_tokens} out=${usage.output_tokens} ` +
          `cacheRead=${usage.cache_read_tokens} ` +
          `cacheWrite=${usage.cache_write_tokens} cost=$${cost.toFixed(6)}`,
      );
    } catch (e) {
      // Metering must never take down a request that already succeeded upstream.
      console.error(
        `[proxy] metering failed key="${token.name}": ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  })();

  return new Response(clientBranch, {
    status: upstream.status,
    headers: outHeaders,
  });
});

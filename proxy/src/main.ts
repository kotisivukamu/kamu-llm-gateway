import { Hono } from "@hono/hono";
import { env } from "./env.ts";
import { proxy } from "./routes/proxy.ts";
import { usage } from "./routes/usage.ts";
import { catalog, piCatalogHandler } from "./routes/catalog.ts";
import { probe } from "./db.ts";
import {
  installGlobalErrorReporting,
  reportError,
} from "./kamustatus-reporter.ts";

installGlobalErrorReporting();

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, version: env.VERSION }));

// Deep health check: touches the local SQLite ledger. Deliberately NOT the
// path Fly checks (fly.toml points at /health) -- a broken ledger file must
// not make Fly restart the machine in a loop. This one is for KamuStatus.
// Synchronous by nature (node:sqlite is DatabaseSync), so no timeout applies.
app.get("/health/deep", (c) => {
  try {
    probe();
    return c.json({ status: "ok", db: "ok" });
  } catch (err) {
    console.error("[health] sqlite probe failed:", err);
    return c.json({ status: "degraded", db: "error" }, 503);
  }
});

// A direct static route, not a mounted sub-app: the proxy's /llm/:provider
// pattern otherwise wins and answers provider_unknown for "catalog".
app.get("/llm/catalog", piCatalogHandler);

// Control-plane ingestion endpoint. Mounted before the /llm/:provider catch-all
// for the same reason /llm/catalog is a static route: /llm/usage would otherwise
// be interpreted as provider_slug="usage". See routes/usage.ts for the contract.
app.route("/usage", usage);

app.route("/llm", proxy);

// Read-only catalog view. See routes/catalog.ts for why this is not writable.
app.route("/catalog", catalog);

app.onError((err, c) => {
  const msg = err instanceof Error ? err.message : String(err);
  // Upstream connect/DNS errors get a 503 with a one-liner — full stacks
  // for "provider not reachable" aren't actionable.
  const transient =
    /dns error|Connect|Connection refused|tcp connect|connection closed/i.test(
      msg,
    );
  if (transient) {
    console.warn(
      `[proxy] ${c.req.method} ${c.req.path} upstream not ready: ${msg}`,
    );
    return c.json({ error: "upstream_not_ready", message: msg }, 503);
  }
  reportError(err, c.req.url);
  console.error("[proxy] error:", err);
  return c.json({ error: msg }, 500);
});

// Bind :: so internal Fly 6PN callers can reach us. Linux dual-still
// gives us IPv4 for the public Fly proxy.
Deno.serve({ port: env.PORT, hostname: "::" }, app.fetch);
console.log(`proxy listening on :${env.PORT}`);

import { cors } from "@hono/hono/cors";
import { HTTPException } from "@hono/hono/http-exception";
import { swaggerUI } from "@hono/swagger-ui";
import { env } from "./env.ts";
import { sql } from "./config/db.ts";
import { createRouter } from "./lib/openapi.ts";
import { requestLogger } from "./middleware/request-logger.ts";
import { derive, keys } from "./routes/keys.ts";
import { usage } from "./routes/usage.ts";
import { startUsagePoller } from "./lib/usage-poller.ts";

sql<{ role: string; db: string }[]>`
  SELECT current_user AS role, current_database() AS db
`
  .then((rows) => {
    const r = rows[0];
    console.log(`[db] connected as role=${r?.role} db=${r?.db}`);
  })
  .catch((err) => console.error("[db] role probe failed:", err));

const app = createRouter();

// Access log first, so it times the whole request.
app.use("*", requestLogger);

app.use(
  "/api/*",
  cors({
    origin: (o) =>
      o === "http://localhost:8080" || o === "https://app.kamuhub.com"
        ? o
        : undefined,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "X-Kamuhub-Authz"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
});

app.get("/health", (c) => c.json({ ok: true }));

// Derive is a SEPARATE auth path: it authenticates with the PARENT KEY
// (sk_live_…), NOT the BFF context (ADR 0001 §9/§7). Mount it BEFORE the
// authMiddleware-protected keys routes so POST /api/keys/derive bypasses the
// BFF-context auth entirely.
app.route("/api", derive);

// Authed keys + usage routes (authMiddleware → requireGrant / withUserContext).
app.route("/api", keys);
app.route("/api", usage);

app.doc("/api/openapi.json", {
  openapi: "3.0.0",
  info: {
    title: "kamu-llm-gateway API",
    version: "0.0.1",
    description:
      "API-key resource server: the key row is the product (ADR 0001). " +
      "Mint/list/revoke top-level keys, derive short-lived sub-keys from a " +
      "can_mint parent, and read the usage ledger keyed by key_id. Driven " +
      "through the kamuhub BFF (signed X-Kamuhub-Authz), except /api/keys/derive " +
      "which is parent-key-authenticated.",
  },
});
app.get("/api/docs", swaggerUI({ url: "/api/openapi.json" }));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  const msg = err instanceof Error ? err.message : String(err);
  console.error("kamu-llm-gateway-api error:", err);
  return c.json({ error: msg }, 500);
});

Deno.serve({ port: env.PORT, hostname: "::" }, app.fetch);
console.log(`kamu-llm-gateway-api listening on :${env.PORT}`);

// Control-plane poller (ADR 0001 §8/§9): pulls the proxy satellite's local
// usage buffer into the durable llm.usage_log table on an interval. Started
// after the server is listening so a slow first poll doesn't delay boot.
startUsagePoller().then((stop) => {
  const shutdown = () => {
    stop();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
});

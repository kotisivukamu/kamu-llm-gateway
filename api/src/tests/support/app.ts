import "./env.ts";
import { HTTPException } from "@hono/hono/http-exception";
import { createRouter } from "../../lib/openapi.ts";
import { derive, keys } from "../../routes/keys.ts";
import { usage } from "../../routes/usage.ts";

// Builds the same route wiring as main.ts, minus the process-level side
// effects (Deno.serve, the usage poller, the DB role probe log) that make
// main.ts unsuitable to import directly in a test process. Call `.fetch(req)`
// on the result, or use `testRequest` below.
export function buildTestApp() {
  const app = createRouter();
  app.route("/api", derive);
  app.route("/api", keys);
  app.route("/api", usage);
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  });
  return app;
}

export type TestApp = ReturnType<typeof buildTestApp>;

/** Convenience wrapper: JSON-body request against a test app instance. */
export async function testRequest(
  app: TestApp,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return await app.request(path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

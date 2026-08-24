import { OpenAPIHono } from "@hono/zod-openapi";
import type { Env } from "@hono/hono";

// Shared factory for OpenAPI-aware routers. The defaultHook turns schema
// validation failures into the same `{ error, details }` shape the rest of the
// api uses for 400s.
export function createRouter<E extends Env = Env>(): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const details = result.error.issues.map((i) => {
          const field = i.path.join(".");
          return field ? `${field}: ${i.message}` : i.message;
        });
        return c.json({ error: details.join(", "), details }, 400);
      }
    },
  });
}

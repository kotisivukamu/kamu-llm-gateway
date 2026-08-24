import type { Context, Next } from "@hono/hono";
import { log } from "../lib/logger.ts";

// Structured access log. Health probes fire every ~15s per machine; keep them
// at debug (flip LOG_LEVEL=debug to see them). 4xx or slow (>1s) → warn;
// 5xx → error.
export async function requestLogger(c: Context, next: Next) {
  const start = Date.now();
  await next();
  const dur_ms = Date.now() - start;
  const path = c.req.path;
  const status = c.res.status;
  const fields = { method: c.req.method, path, status, dur_ms };

  if (path === "/health") log.debug("request", fields);
  else if (status >= 500) log.error("request", fields);
  else if (status >= 400 || dur_ms > 1000) log.warn("request", fields);
  else log.info("request", fields);
}

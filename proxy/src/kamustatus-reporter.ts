// KamuStatus server-side error reporter.
//
// This file is duplicated BYTE-IDENTICALLY into every kotisivukamu service that
// reports errors. Each service builds and deploys from its own Dockerfile with
// its own deno.json, so a shared import would mean a shared build context we
// don't have. Copies must be kept identical -- edit one, copy it over the rest.
//
// It speaks the same v1 wire contract as the browser SDK (see kamustatus
// packages/telemetry/PROTOCOL.md): POST {url}/i/{key}, Content-Type text/plain,
// JSON body. Server-side reporters send no Origin header, which ingest accepts
// by design.
//
// Deliberately dependency-free and deliberately silent: telemetry must never
// throw into a request path, never block a response, and never turn an ingest
// outage into a customer-visible failure.

const SDK = "kamustatus-server/0.1.0";
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_AT_EVENTS = 20;
const MAX_EVENTS_PER_MINUTE = 100;
const MAX_MSG = 2048;
const MAX_STACK = 8192;

interface KamuStatusErrorEvent {
  t: "error";
  ts: number;
  url: string;
  name: string;
  msg: string;
  stack: string | null;
  src: null;
}

const INGEST_URL = (Deno.env.get("KAMUSTATUS_INGEST_URL") ?? "").replace(
  /\/+$/,
  "",
);
const INGEST_KEY = Deno.env.get("KAMUSTATUS_INGEST_KEY") ?? "";
const ENABLED = INGEST_URL !== "" && INGEST_KEY !== "";
const RELEASE = Deno.env.get("VERSION") || null;

// Events need an absolute url. On Fly the app name is the honest identity of
// the process; locally we fall back to localhost so dev noise is obvious.
const FLY_APP = Deno.env.get("FLY_APP_NAME") ?? "";
const BASE_URL = FLY_APP ? `https://${FLY_APP}.fly.dev` : "http://localhost";

// One sid per process, mirroring the browser SDK's one-per-page-load.
const SID = crypto.randomUUID().replaceAll("-", "").slice(0, 16);

let buffer: KamuStatusErrorEvent[] = [];
let dropped = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let windowStart = 0;
let windowCount = 0;
let warned = false;

function warnOnce(message: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[kamustatus] ${message}`);
}

// Query strings can carry tokens and personal data, and the wire contract
// strips them for the browser too.
function normalizeUrl(where: string): string {
  const raw = where.startsWith("http://") || where.startsWith("https://")
    ? where
    : `${BASE_URL}${where.startsWith("/") ? where : `/${where}`}`;
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return BASE_URL;
  }
}

/**
 * Buffer one error for delivery to KamuStatus. Fire-and-forget: it returns
 * immediately and never throws, whatever `err` is.
 *
 * `where` is a request URL or a path; the query string is stripped.
 */
export function reportError(err: unknown, where: string): void {
  if (!ENABLED) {
    warnOnce("KAMUSTATUS_INGEST_URL/KEY unset, error reporting disabled");
    return;
  }

  const now = Date.now();
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_EVENTS_PER_MINUTE) {
    dropped++;
    return;
  }
  windowCount++;

  const e = err instanceof Error ? err : undefined;
  buffer.push({
    t: "error",
    ts: now,
    url: normalizeUrl(where),
    name: e?.name ?? "Error",
    msg: (e?.message ?? String(err)).slice(0, MAX_MSG),
    stack: e?.stack ? e.stack.slice(0, MAX_STACK) : null,
    src: null,
  });

  if (buffer.length >= FLUSH_AT_EVENTS) {
    flush();
    return;
  }
  if (timer === undefined) {
    const t = setTimeout(flush, FLUSH_INTERVAL_MS);
    timer = t;
    // Never hold a worker or a shutting-down server open for telemetry.
    Deno.unrefTimer(t);
  }
}

function flush(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (buffer.length === 0 && dropped === 0) return;

  const body = JSON.stringify({
    v: 1,
    sdk: SDK,
    release: RELEASE,
    sid: SID,
    dropped,
    events: buffer,
  });
  buffer = [];
  dropped = 0;

  fetch(`${INGEST_URL}/i/${INGEST_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  })
    .then((res) => res.body?.cancel())
    .catch(() => warnOnce("ingest unreachable, dropping error events"));
}

/**
 * Report uncaught errors and unhandled rejections. Listeners only observe --
 * nothing is preventDefault()ed, so the process keeps whatever exit semantics
 * it already had (which matters for the workers, where a crash must still
 * crash).
 */
export function installGlobalErrorReporting(): void {
  globalThis.addEventListener("unhandledrejection", (event) => {
    reportError(event.reason, "/unhandledrejection");
  });
  globalThis.addEventListener("error", (event) => {
    reportError(event.error ?? event.message, "/uncaught");
  });
}

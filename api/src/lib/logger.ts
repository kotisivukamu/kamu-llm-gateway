import { env } from "../env.ts";

// Minimal leveled, structured logger — the TS counterpart to the Go services'
// log/slog setup, so a log line reads the same shape whichever runtime emitted
// it: {"level","msg",...fields}. Threshold is LOG_LEVEL (default info); lines
// below it are dropped, which is how you turn debug off in prod.
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const threshold = order[env.LOG_LEVEL];

type Fields = Record<string, unknown>;

function emit(level: Level, msg: string, fields?: Fields): void {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ level, msg, ...fields });
  // warn/error to stderr, the rest to stdout — standard stream hygiene.
  (level === "warn" || level === "error" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, fields?: Fields) => emit("debug", msg, fields),
  info: (msg: string, fields?: Fields) => emit("info", msg, fields),
  warn: (msg: string, fields?: Fields) => emit("warn", msg, fields),
  error: (msg: string, fields?: Fields) => emit("error", msg, fields),
};

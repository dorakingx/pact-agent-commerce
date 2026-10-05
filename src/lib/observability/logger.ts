/**
 * Structured JSON logging for the server. One line per event, with correlation ids
 * (dealId, contractId, paypalOrderId, paypalDebugId, requestId) as top-level fields.
 *
 * Secrets never reach the log: known secret-bearing keys are redacted recursively, and
 * anything that looks like a bearer token or basic-auth header is masked.
 */

type Level = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const REDACT_KEYS =
  /^(authorization|access_token|accesstoken|client_secret|clientsecret|secret|password|token|vault_id|vaultid|cookie|set-cookie|api[_-]?key|apikey|session)$/i;
const TOKEN_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return value.replace(TOKEN_PATTERN, "$1 [redacted]");
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    if (value instanceof Error) {
      return { name: value.name, message: redact(value.message, depth + 1) };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, fields?: LogFields): void {
  if (level === "debug" && process.env.PACT_LOG_LEVEL !== "debug") return;
  if (process.env.PACT_LOG_SILENT === "1") return;
  const line = JSON.stringify({
    level,
    msg,
    at: new Date().toISOString(),
    ...(fields ? (redact(fields) as LogFields) : {}),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields) => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields) => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields) => emit("error", msg, fields),
  /** Child logger with bound correlation fields. */
  with(bound: LogFields) {
    return {
      debug: (msg: string, fields?: LogFields) => emit("debug", msg, { ...bound, ...fields }),
      info: (msg: string, fields?: LogFields) => emit("info", msg, { ...bound, ...fields }),
      warn: (msg: string, fields?: LogFields) => emit("warn", msg, { ...bound, ...fields }),
      error: (msg: string, fields?: LogFields) => emit("error", msg, { ...bound, ...fields }),
    };
  },
};

export type Logger = typeof log;

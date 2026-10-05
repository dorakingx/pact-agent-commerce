/**
 * Typed persistence errors.
 *
 * Drizzle wraps every driver failure in an error whose message contains the full SQL text AND
 * the bound parameters. Parameters can include values that must never reach a log (vault ids,
 * payer e-mail fragments), so nothing from that wrapper is allowed past this module: callers
 * only ever see the driver's own message, the SQLSTATE and the violated constraint.
 */

/** SQLSTATE class 23 "integrity constraint violation": unique_violation. */
const UNIQUE_VIOLATION = "23505";
/** Five characters, and never starting with "E": that is a Node.js errno such as EPIPE, not a SQLSTATE. */
const SQLSTATE = /^(?!E)[0-9A-Z]{5}$/;
/** How far down an error's `cause` chain to look for the driver error. */
const MAX_CAUSE_DEPTH = 5;

export class DbError extends Error {
  /** Repository operation that failed, e.g. "insertMove". */
  readonly operation: string;
  /** Postgres SQLSTATE (e.g. "23503"), or null when the server never answered. */
  readonly code: string | null;

  constructor(operation: string, message: string, options: { code?: string | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DbError";
    this.operation = operation;
    this.code = options.code ?? null;
  }
}

/**
 * A unique constraint rejected the write (Postgres 23505 on both drivers). This is how the
 * database arbitrates races: the second writer of the same (deal, seq) or (deal, round) loses.
 *
 * On real Postgres the surrounding transaction, if any, is aborted by the violation — let it
 * roll back rather than continuing to use the same handle.
 */
export class DuplicateError extends DbError {
  /** Name of the violated constraint or unique index, e.g. "deals_code_idx". */
  readonly constraint: string | null;

  constructor(operation: string, constraint: string | null) {
    super(operation, `${operation}: the record already exists${constraint ? ` (${constraint})` : ""}`, {
      code: UNIQUE_VIOLATION,
    });
    this.name = "DuplicateError";
    this.constraint = constraint;
  }
}

interface DriverError {
  code: string;
  message: string;
  constraint: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** node-postgres and PGlite both throw an error carrying the SQLSTATE in `code`. */
function findDriverError(error: unknown): DriverError | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isRecord(current); depth += 1) {
    const { code, message, constraint } = current;
    if (typeof code === "string" && SQLSTATE.test(code)) {
      return {
        code,
        message: typeof message === "string" ? message : "database error",
        constraint: typeof constraint === "string" && constraint !== "" ? constraint : null,
      };
    }
    current = current.cause;
  }
  return null;
}

/**
 * Drizzle's query wrapper, recognised structurally: `instanceof` is unreliable because the ESM
 * and CommonJS builds of drizzle-orm can both be loaded in one process (tsx scripts).
 */
function isQueryWrapper(error: unknown): error is Error & { query: unknown; params: unknown } {
  return error instanceof Error && "query" in error && "params" in error;
}

/**
 * The original driver error is deliberately NOT attached as `cause`: its `detail` field can
 * quote whole rows ("Failing row contains (…)"), which is exactly what must stay out of logs.
 */
function translate(operation: string, error: unknown): unknown {
  if (error instanceof DbError) return error;
  const driver = findDriverError(error);
  if (driver?.code === UNIQUE_VIOLATION) return new DuplicateError(operation, driver.constraint);
  if (driver) {
    return new DbError(operation, `${operation} failed: ${driver.message} (SQLSTATE ${driver.code})`, {
      code: driver.code,
    });
  }
  if (isQueryWrapper(error)) {
    // No SQLSTATE means the statement never ran (connection refused, timeout, pool closed).
    const reason = error.cause instanceof Error ? error.cause.message : "the database did not answer";
    return new DbError(operation, `${operation} failed: ${reason}`, { cause: error.cause });
  }
  // Not a database failure (validation, programming error): leave it untouched.
  return error;
}

/** Runs one repository operation and converts driver failures into {@link DbError}s. */
export async function dbCall<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translate(operation, error);
  }
}

/** True for a unique-constraint violation, whether already translated or still raw. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof DuplicateError || findDriverError(error)?.code === UNIQUE_VIOLATION;
}

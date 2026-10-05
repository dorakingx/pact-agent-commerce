/**
 * Schema checks at the storage boundary. Text and JSONB columns have no shape of their own, so
 * every domain record is parsed with its Zod schema before it is written and again after it is
 * read: nothing malformed can be stored, and a row edited by hand cannot masquerade as a
 * well-typed domain object.
 */
import type { z } from "zod";

const MAX_REPORTED_ISSUES = 5;

export class InvalidRecordError extends Error {
  /** "write": the caller supplied a malformed record. "read": the stored row is malformed. */
  readonly direction: "write" | "read";

  constructor(what: string, direction: "write" | "read", issues: string) {
    super(
      direction === "write"
        ? `Refusing to store ${what}: it does not match its schema (${issues})`
        : `Stored ${what} does not match its schema (${issues})`,
    );
    this.name = "InvalidRecordError";
    this.direction = direction;
  }
}

/** Issue paths and messages only — never the offending values, which may be sensitive or huge. */
function describeIssues(error: z.ZodError): string {
  const shown = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`);
  const hidden = error.issues.length - shown.length;
  return hidden > 0 ? `${shown.join("; ")}; and ${hidden} more` : shown.join("; ");
}

function parseRecord<T>(schema: z.ZodType<T>, value: unknown, what: string, direction: "write" | "read"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new InvalidRecordError(what, direction, describeIssues(result.error));
  return result.data;
}

/** Validates a record supplied by a caller before it is written. */
export function parseForWrite<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  return parseRecord(schema, value, what, "write");
}

/** Validates (and narrows) a record assembled from a stored row. */
export function parseStored<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  return parseRecord(schema, value, what, "read");
}

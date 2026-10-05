/**
 * Timestamp normalisation at the storage boundary.
 *
 * The schema declares every `timestamptz` column in "string" mode, so both drivers hand back
 * Postgres' text format ("2026-10-06 02:05:33.123456+09") in whatever time zone the session
 * happens to use. The rest of PACT only ever sees ISO-8601 UTC with millisecond precision
 * ("2026-10-05T17:05:33.123Z"), so every value is converted here on the way in and on the way out.
 */

/** Matches ISO-8601 and Postgres text timestamps that carry an explicit UTC offset. */
const TIMESTAMP_WITH_OFFSET =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

function isoOffset(zone: string): string {
  if (zone === "Z" || zone === "z") return "Z";
  const sign = zone[0];
  const digits = zone.slice(1).replace(":", "");
  return `${sign}${digits.slice(0, 2)}:${digits.slice(2, 4).padEnd(2, "0")}`;
}

/**
 * Converts an ISO-8601 or Postgres text timestamp to canonical ISO-8601 UTC
 * (`Date#toISOString()` form). Sub-millisecond digits are truncated, never rounded, so a
 * stored instant can never appear to be later than it was.
 *
 * Timestamps without an offset are rejected: guessing a time zone for a deadline or an
 * authorization expiry would be a silent correctness bug.
 */
export function toIsoUtc(value: string): string {
  const match = TIMESTAMP_WITH_OFFSET.exec(value.trim());
  if (!match) {
    throw new RangeError(`Expected an ISO-8601 timestamp with a UTC offset, received ${JSON.stringify(value)}`);
  }
  const [, date, hoursMinutes, seconds = "00", fraction = "", zone] = match;
  const millis = fraction.slice(0, 3).padEnd(3, "0");
  const parsed = new Date(`${date}T${hoursMinutes}:${seconds}.${millis}${isoOffset(zone)}`);
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Timestamp is out of range: ${JSON.stringify(value)}`);
  }
  return parsed.toISOString();
}

export function toIsoUtcOrNull(value: string | null): string | null {
  return value === null ? null : toIsoUtc(value);
}

/** True when `value` is already in the canonical form produced by {@link toIsoUtc}. */
export function isCanonicalIsoUtc(value: string): boolean {
  try {
    return toIsoUtc(value) === value;
  } catch {
    return false;
  }
}

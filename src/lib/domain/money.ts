/**
 * Money is always represented as an integer number of minor units (cents).
 * Floats never cross a module boundary: the only conversions happen here.
 */

export const CURRENCY = "USD" as const;
export type Currency = typeof CURRENCY;

/** Hard ceiling for any single PACT transaction in the demo: $5,000.00. */
export const MAX_AMOUNT_MINOR = 500_000;

export function isMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertMinor(value: unknown, label = "amount"): asserts value is number {
  if (!isMinor(value)) {
    throw new RangeError(`${label} must be a non-negative integer number of minor units`);
  }
}

/** Convert a major-unit decimal (e.g. 45.5) to minor units, rounding half away from zero. */
export function toMinor(major: number): number {
  if (!Number.isFinite(major) || major < 0) {
    throw new RangeError("major amount must be a finite, non-negative number");
  }
  return Math.round((major + Number.EPSILON) * 100);
}

/** Decimal string PayPal expects, e.g. 4550 -> "45.50". Never uses float division. */
export function toPayPalValue(minor: number): string {
  assertMinor(minor);
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

/** Parse a PayPal decimal string ("45.50", "45", "45.5") into minor units. Rejects anything else. */
export function fromPayPalValue(value: string): number {
  if (typeof value !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(value)) {
    throw new RangeError(`invalid PayPal amount value: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function formatMoney(minor: number, currency: Currency = CURRENCY): string {
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const symbol = currency === "USD" ? "$" : "";
  return `${symbol}${grouped}.${cents.toString().padStart(2, "0")}`;
}

/** Percentage of an amount, rounded to the nearest minor unit. `percent` may be fractional. */
export function percentOf(minor: number, percent: number): number {
  assertMinor(minor);
  if (!Number.isFinite(percent) || percent < 0) throw new RangeError("percent must be >= 0");
  return Math.round((minor * percent) / 100);
}

/** Round to the nearest whole major unit (agents quote in whole dollars to keep offers legible). */
export function roundToMajor(minor: number): number {
  assertMinor(minor);
  return Math.round(minor / 100) * 100;
}

export function clampMinor(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max);
}

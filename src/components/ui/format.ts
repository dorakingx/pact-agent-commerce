/**
 * Pure presentation helpers shared by the UI primitives. Kept free of React and of the DOM so
 * they can be unit-tested and so server and client always produce identical strings.
 */
import { CURRENCY, formatMoney, type Currency } from "@/lib/domain/money";

/** Shorten a long id or hash to `head…tail`. Values that already fit are returned unchanged. */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  const h = Math.max(0, Math.floor(head));
  const t = Math.max(0, Math.floor(tail));
  // +1 for the ellipsis: truncating must actually make the string shorter.
  if (value.length <= h + t + 1) return value;
  return `${value.slice(0, h)}…${t > 0 ? value.slice(-t) : ""}`;
}

export interface MoneyParts {
  negative: boolean;
  /** Symbol and grouped whole units, e.g. "$1,234". */
  whole: string;
  /** Decimal separator and minor units, e.g. ".50". */
  cents: string;
}

/**
 * Split an integer minor-unit amount into display parts. `formatMoney` only accepts
 * non-negative amounts, so the sign is handled here (deltas such as "saved" can be negative).
 */
export function splitMoney(minor: number, currency: Currency = CURRENCY): MoneyParts {
  if (!Number.isSafeInteger(minor)) {
    throw new RangeError("Money expects an integer number of minor units");
  }
  const formatted = formatMoney(Math.abs(minor), currency);
  const dot = formatted.lastIndexOf(".");
  return { negative: minor < 0, whole: formatted.slice(0, dot), cents: formatted.slice(dot) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const pad2 = (n: number): string => n.toString().padStart(2, "0");

/**
 * "6 Oct 2026, 02:05 UTC". Built by hand rather than with Intl so the server render and the
 * browser hydrate to the same text regardless of locale or ICU version.
 */
export function formatUtcDateTime(epochMs: number): string {
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return "Unknown time";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact relative time: "just now", "5 min ago", "in 3 h", "2 d ago". Beyond a week the
 * absolute UTC date is clearer than "23 d ago".
 */
export function formatRelativeTime(targetMs: number, nowMs: number): string {
  if (Number.isNaN(targetMs)) return "Unknown time";
  const diff = targetMs - nowMs;
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  if (abs >= 7 * DAY) return formatUtcDateTime(targetMs);
  const [amount, unit] =
    abs < HOUR
      ? [Math.max(1, Math.round(abs / MINUTE)), "min"]
      : abs < DAY
        ? [Math.round(abs / HOUR), "h"]
        : [Math.round(abs / DAY), "d"];
  return diff < 0 ? `${amount} ${unit} ago` : `in ${amount} ${unit}`;
}

/** Parse the timestamps the UI receives (ISO-8601 strings, epoch milliseconds or Date). NaN when invalid. */
export function toEpochMs(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "number" ? value : Date.parse(value);
}

/** Clamp to the closed interval [0, 1]; non-finite input becomes 0. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 0–1 → "87%". */
export function formatPercent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

/**
 * Plain-language formatting shared by the deterministic engines (guardrail notes, contract
 * rules, verification evidence, scripted negotiation messages).
 *
 * Everything here is locale-independent on purpose: the same input must render the same text
 * on every machine, because several of these strings end up inside the hashed contract.
 */
import type { DeliverableSpec, Language } from "./schemas";

export const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Epoch milliseconds of an ISO timestamp, or null when it cannot be parsed. */
export function parseTimestamp(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Unambiguous, sortable form for contracts and evidence: "2026-10-07 18:00 UTC". */
export function formatUtcTimestamp(iso: string): string {
  const ms = parseTimestamp(iso);
  if (ms === null) return "an invalid date";
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** Conversational form for agent messages: "Oct 7, 18:00 UTC". */
export function formatUtcShort(iso: string): string {
  const ms = parseTimestamp(iso);
  if (ms === null) return "an invalid date";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** Human-sized duration, largest two units: "2d 3h", "14h 20m", "45m", "under a minute". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.abs(ms) / MINUTE_MS);
  if (totalMinutes < 1) return "under a minute";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${pad2(minutes)}m` : `${hours}h`;
  return `${minutes}m`;
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "1 illustration", "3 illustrations". */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Cut to at most `max` UTF-16 units, ending in an ellipsis. Never splits a surrogate pair,
 * so the result is always well-formed text for JSON, Postgres and PayPal.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

/**
 * Collapse untrusted free text to one printable line: control characters, zero-width and
 * bidirectional-override characters become spaces, and whitespace runs collapse.
 */
export function singleLine(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  ja: "Japanese",
  es: "Spanish",
  fr: "French",
  de: "German",
};

export function languageName(language: Language): string {
  return LANGUAGE_NAMES[language];
}

/** "3 illustrations" / "1 copy piece" — the unit a deliverable is counted in. */
export function deliverableCountLabel(kind: DeliverableSpec["kind"], count: number): string {
  switch (kind) {
    case "illustration":
      return plural(count, "illustration");
    case "copy":
      return plural(count, "copy piece");
    default:
      return assertNever(kind);
  }
}

/** "1 revision round" / "no revision rounds". */
export function revisionsLabel(revisionLimit: number): string {
  return revisionLimit === 0 ? "no revision rounds" : plural(revisionLimit, "revision round");
}

/** Exhaustiveness guard: reaching this at runtime means a union gained a member no engine handles. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}

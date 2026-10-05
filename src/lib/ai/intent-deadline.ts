/**
 * Deadline phrases -> instants.
 *
 * "By tomorrow at 6 PM" only means something on the human's own clock, so everything here is
 * resolved in their local time (via the browser's Date#getTimezoneOffset value) and returned as
 * a UTC instant. Date arithmetic is exactly the kind of thing a language model gets subtly
 * wrong, which is why a recognised phrase is always resolved here rather than by the model.
 */
import { overlapsAny, parseQuantity, QUANTITY_SOURCE, type Span } from "./intent-text";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A deadline closer than this cannot realistically be negotiated, contracted, paid and delivered. */
export const MIN_LEAD_MS = 2 * HOUR_MS;
const DEFAULT_LEAD_MS = 72 * HOUR_MS;
const UNREALISTIC_DEADLINE_LEAD_MS = 24 * HOUR_MS;

interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * A deadline given as a date without a time ("by Friday") is read as close of business: the
 * earlier of the plausible readings, so the buyer agent never assumes more time than was meant.
 */
const CLOSE_OF_BUSINESS: TimeOfDay = { hour: 18, minute: 0 };
const TONIGHT: TimeOfDay = { hour: 21, minute: 0 };

const NAMED_TIMES: Readonly<Record<string, TimeOfDay>> = {
  noon: { hour: 12, minute: 0 },
  midday: { hour: 12, minute: 0 },
  midnight: { hour: 23, minute: 59 },
  morning: { hour: 9, minute: 0 },
  afternoon: { hour: 15, minute: 0 },
  evening: CLOSE_OF_BUSINESS,
};

/** Groups: 1-3 = 12-hour clock (hour, minute, a|p), 4-5 = 24-hour clock, 6 = named time. */
const CLOCK_SOURCE = String.raw`(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\b\.?|([01]?\d|2[0-3]):([0-5]\d)(?!\d)|(noon|midday|midnight|morning|afternoon|evening|eod|cob|end of (?:the )?(?:business )?day|close of business)`;
const TIME_AFTER_DAY = new RegExp(String.raw`^[\s,]*(?:at|by|before|around|@)?\s*(?:${CLOCK_SOURCE})`);
const TIME_BEFORE_DAY = new RegExp(String.raw`(?:${CLOCK_SOURCE})\s*(?:on\s+|,\s*)?$`);
/** "tomorrow at 6": no am/pm, so the hour is read the way a working day suggests. */
const BARE_HOUR_AFTER_DAY = /^[\s,]*at\s+(\d{1,2})\b(?![:.]\d)/;
const STANDALONE_TIME = new RegExp(String.raw`\b(?:by|before|until|till|at)\s+(?:${CLOCK_SOURCE})`, "g");

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
/** "Black Friday banners" names a subject, not a deadline. */
const WEEKDAY_PATTERN = new RegExp(
  String.raw`(?<!\b(?:black|cyber|good)\s)\b(?:(next|this|coming)\s+)?(${WEEKDAYS.join("|")})\b`,
  "g",
);

const MONTHS: readonly (readonly [RegExp, number])[] = [
  [/^jan/, 0],
  [/^feb/, 1],
  [/^mar/, 2],
  [/^apr/, 3],
  [/^may/, 4],
  [/^jun/, 5],
  [/^jul/, 6],
  [/^aug/, 7],
  [/^sep/, 8],
  [/^oct/, 9],
  [/^nov/, 10],
  [/^dec/, 11],
];
/** "may" is also a verb ("these may be reused"), so it only counts as a month away from one. */
const MONTH_SOURCE = String.raw`jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may(?!\s+(?:be|i|we|you|not|also|have|need|want)\b)|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?`;
const MONTH_THEN_DAY = new RegExp(
  String.raw`\b(${MONTH_SOURCE})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?![:\d])(?:,?\s*(\d{4})\b)?`,
  "g",
);
const DAY_THEN_MONTH = new RegExp(
  String.raw`(?<![:\d$.])\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_SOURCE})\b(?:,?\s*(\d{4})\b)?`,
  "g",
);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})(?:[t ]([01]\d|2[0-3]):([0-5]\d))?/g;

const UNIT_SOURCE = String.raw`hours?|hrs?|h|days?|weeks?|wks?`;
const RELATIVE_WINDOW = new RegExp(
  String.raw`\b(?:within|in|inside)\s+(?:the\s+)?(?:next\s+)?(${QUANTITY_SOURCE})\s*-?\s*(?:(?:business|working)\s+)?(${UNIT_SOURCE})\b`,
  "g",
);
const TURNAROUND = new RegExp(
  String.raw`\b(${QUANTITY_SOURCE})[\s-]*(${UNIT_SOURCE})\s+(?:turnaround|deadline|delivery|window)\b`,
  "g",
);
const NEXT_WEEK = /\bnext week\b/g;
const END_OF_WEEK = /\b(?:end of (?:the |this )?week|this week|(?:before|by) the weekend)\b/g;
const END_OF_MONTH = /\bend of (?:the |this )?month\b/g;
const URGENT = /\b(?:asap|as soon as possible|urgent(?:ly)?)\b/g;

interface Candidate {
  at: Date;
  span: Span;
  /** See DeadlineReading.exact. */
  exact: boolean;
}

export interface DeadlineReading {
  /** The earliest workable deadline found in the text (or an unworkable one when nothing better exists). */
  at: Date;
  /**
   * True for phrases with exactly one reading ("within 48 hours", "tomorrow at 6 PM", an ISO
   * date). Weekdays, month names and loose phrases ("next week", "ASAP") are recognised too, but
   * their context can change their meaning ("two weeks from Thursday"), so a reader with better
   * language understanding is allowed to overrule them.
   */
  exact: boolean;
  /** Every deadline phrase recognised, so callers can mark the text as understood. */
  spans: Span[];
}

/** Clamp a browser-supplied Date#getTimezoneOffset value to the offsets that exist (UTC+14 .. UTC-12). */
export function normaliseTzOffset(tzOffsetMinutes: number | undefined): number {
  if (tzOffsetMinutes === undefined || !Number.isFinite(tzOffsetMinutes)) return 0;
  return Math.min(Math.max(Math.round(tzOffsetMinutes), -840), 720);
}

/** The human's calendar date and weekday at `instant`. */
function localDate(instant: Date, tz: number): { year: number; month: number; day: number; weekday: number } {
  const wall = new Date(instant.getTime() - tz * MINUTE_MS);
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth(), day: wall.getUTCDate(), weekday: wall.getUTCDay() };
}

/** UTC instant of a local wall-clock time. Out-of-range days/months roll over like Date.UTC. */
function localInstant(year: number, month: number, day: number, time: TimeOfDay, tz: number): Date {
  return new Date(Date.UTC(year, month, day, time.hour, time.minute) + tz * MINUTE_MS);
}

function clockToTime(match: RegExpMatchArray, firstGroup: number): TimeOfDay | null {
  const [hour12, minute12, meridiem, hour24, minute24, named] = match.slice(firstGroup, firstGroup + 6);
  if (hour12 !== undefined && meridiem !== undefined) {
    const hour = Number(hour12);
    if (hour < 1 || hour > 12) return null;
    return { hour: (hour % 12) + (meridiem === "p" ? 12 : 0), minute: Number(minute12 ?? 0) };
  }
  if (hour24 !== undefined && minute24 !== undefined) return { hour: Number(hour24), minute: Number(minute24) };
  if (named !== undefined) return NAMED_TIMES[named] ?? CLOSE_OF_BUSINESS;
  return null;
}

function bareHourToTime(hour: number): TimeOfDay | null {
  if (hour >= 1 && hour <= 7) return { hour: hour + 12, minute: 0 };
  if (hour >= 8 && hour <= 23) return { hour, minute: 0 };
  return null;
}

/** A time of day written next to a day reference ("tomorrow at 6 PM", "6 PM tomorrow"). */
function attachedTime(lower: string, day: Span): { time: TimeOfDay; span: Span } | null {
  const tail = lower.slice(day.end, day.end + 40);
  const after = TIME_AFTER_DAY.exec(tail);
  const afterTime = after ? clockToTime(after, 1) : null;
  if (after && afterTime) return { time: afterTime, span: { start: day.start, end: day.end + after[0].length } };

  const bare = BARE_HOUR_AFTER_DAY.exec(tail);
  const bareTime = bare ? bareHourToTime(Number(bare[1])) : null;
  if (bare && bareTime) return { time: bareTime, span: { start: day.start, end: day.end + bare[0].length } };

  const head = lower.slice(Math.max(0, day.start - 40), day.start);
  const before = TIME_BEFORE_DAY.exec(head);
  const beforeTime = before ? clockToTime(before, 1) : null;
  if (before && beforeTime) return { time: beforeTime, span: { start: day.start - before[0].length, end: day.end } };
  return null;
}

function monthIndex(name: string): number {
  return MONTHS.find(([pattern]) => pattern.test(name))?.[1] ?? 0;
}

function unitMs(unit: string): number {
  if (unit.startsWith("h")) return HOUR_MS;
  if (unit.startsWith("w")) return 7 * DAY_MS;
  return DAY_MS;
}

function spanOf(match: RegExpMatchArray): Span {
  const start = match.index ?? 0;
  return { start, end: start + match[0].length };
}

/** Day references: each resolves to a calendar date, then picks up an attached time of day. */
function dayCandidates(lower: string, now: Date, tz: number): Candidate[] {
  const today = localDate(now, tz);
  const found: Candidate[] = [];
  const add = (
    match: RegExpMatchArray,
    exact: boolean,
    resolve: (time: TimeOfDay) => Date,
    fallbackTime: TimeOfDay = CLOSE_OF_BUSINESS,
  ): void => {
    const day = spanOf(match);
    if (overlapsAny(day, found.map((c) => c.span))) return;
    const attached = attachedTime(lower, day);
    found.push({ at: resolve(attached?.time ?? fallbackTime), span: attached?.span ?? day, exact });
  };
  const onOffset = (offsetDays: number) => (time: TimeOfDay) =>
    localInstant(today.year, today.month, today.day + offsetDays, time, tz);

  for (const m of lower.matchAll(/\bday after tomorrow\b/g)) add(m, true, onOffset(2));
  for (const m of lower.matchAll(/\b(?:tomorrow|tmrw)\b/g)) add(m, true, onOffset(1));
  for (const m of lower.matchAll(/\btoday\b/g)) add(m, true, onOffset(0));
  for (const m of lower.matchAll(/\btonight\b/g)) add(m, true, onOffset(0), TONIGHT);

  for (const m of lower.matchAll(WEEKDAY_PATTERN)) {
    const target = WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number]);
    const ahead = (target - today.weekday + 7) % 7;
    add(m, false, (time) => {
      const at = onOffset(ahead)(time);
      // "By Friday" said on a Friday evening means next week's Friday, not a moment already gone.
      return at.getTime() - now.getTime() < MIN_LEAD_MS ? onOffset(ahead + 7)(time) : at;
    });
  }

  const addCalendarDate = (m: RegExpMatchArray, month: number, day: number, yearText: string | undefined): void => {
    if (day < 1 || day > 31) return;
    add(m, false, (time) => {
      if (yearText !== undefined) return localInstant(Number(yearText), month, day, time, tz);
      const thisYear = localInstant(today.year, month, day, time, tz);
      return thisYear.getTime() < now.getTime() ? localInstant(today.year + 1, month, day, time, tz) : thisYear;
    });
  };
  for (const m of lower.matchAll(MONTH_THEN_DAY)) addCalendarDate(m, monthIndex(m[1]), Number(m[2]), m[3]);
  for (const m of lower.matchAll(DAY_THEN_MONTH)) addCalendarDate(m, monthIndex(m[2]), Number(m[1]), m[3]);

  for (const m of lower.matchAll(ISO_DATE)) {
    const span = spanOf(m);
    if (overlapsAny(span, found.map((c) => c.span))) continue;
    const time = m[4] !== undefined && m[5] !== undefined ? { hour: Number(m[4]), minute: Number(m[5]) } : CLOSE_OF_BUSINESS;
    found.push({ at: localInstant(Number(m[1]), Number(m[2]) - 1, Number(m[3]), time, tz), span, exact: true });
  }
  return found;
}

/** A clock time with no day ("by 6 PM") means the next time the clock shows it. */
function standaloneTimeCandidates(lower: string, now: Date, tz: number, taken: readonly Span[]): Candidate[] {
  const today = localDate(now, tz);
  const found: Candidate[] = [];
  for (const m of lower.matchAll(STANDALONE_TIME)) {
    const span = spanOf(m);
    const time = clockToTime(m, 1);
    if (!time || overlapsAny(span, taken)) continue;
    const sameDay = localInstant(today.year, today.month, today.day, time, tz);
    const at = sameDay.getTime() <= now.getTime() ? localInstant(today.year, today.month, today.day + 1, time, tz) : sameDay;
    found.push({ at, span, exact: false });
  }
  return found;
}

/** Durations and loose phrases measured from now ("within 48 hours", "next week", "ASAP"). */
function relativeCandidates(lower: string, now: Date, tz: number): Candidate[] {
  const today = localDate(now, tz);
  const found: Candidate[] = [];
  for (const pattern of [RELATIVE_WINDOW, TURNAROUND]) {
    for (const m of lower.matchAll(pattern)) {
      const quantity = parseQuantity(m[1]);
      if (quantity === null || quantity < 1) continue;
      found.push({ at: new Date(now.getTime() + quantity * unitMs(m[2])), span: spanOf(m), exact: true });
    }
  }
  const loose = (at: Date, m: RegExpMatchArray): void => {
    found.push({ at, span: spanOf(m), exact: false });
  };
  for (const m of lower.matchAll(NEXT_WEEK)) loose(new Date(now.getTime() + 7 * DAY_MS), m);
  for (const m of lower.matchAll(END_OF_WEEK)) {
    const untilFriday = (5 - today.weekday + 7) % 7;
    loose(localInstant(today.year, today.month, today.day + untilFriday, CLOSE_OF_BUSINESS, tz), m);
  }
  for (const m of lower.matchAll(END_OF_MONTH)) {
    // Day 0 of next month is the last day of this one.
    loose(localInstant(today.year, today.month + 1, 0, CLOSE_OF_BUSINESS, tz), m);
  }
  for (const m of lower.matchAll(URGENT)) loose(new Date(now.getTime() + UNREALISTIC_DEADLINE_LEAD_MS), m);
  return found;
}

/**
 * Find the deadline stated in lower-cased request text, or null when none is recognised.
 * When several phrases appear, the earliest workable one wins: the mandate records the LATEST
 * acceptable delivery time, so the stricter reading is the one that cannot overshoot.
 */
export function readDeadline(lower: string, now: Date, tzOffsetMinutes: number): DeadlineReading | null {
  const tz = normaliseTzOffset(tzOffsetMinutes);
  const days = dayCandidates(lower, now, tz);
  const relative = relativeCandidates(lower, now, tz);
  const times = standaloneTimeCandidates(lower, now, tz, [...days, ...relative].map((c) => c.span));
  const candidates = [...days, ...relative, ...times].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (candidates.length === 0) return null;
  const chosen = candidates.find((c) => c.at.getTime() - now.getTime() >= MIN_LEAD_MS) ?? candidates[candidates.length - 1];
  return { at: chosen.at, exact: chosen.exact, spans: candidates.map((c) => c.span) };
}

/**
 * The deadline that goes into the mandate: 72 hours out when none was given, and 24 hours out
 * when the stated one is already past or too close to be met.
 */
export function settleDeadline(stated: Date | null, now: Date): Date {
  const settled =
    stated === null || Number.isNaN(stated.getTime())
      ? new Date(now.getTime() + DEFAULT_LEAD_MS)
      : stated.getTime() - now.getTime() < MIN_LEAD_MS
        ? new Date(now.getTime() + UNREALISTIC_DEADLINE_LEAD_MS)
        : stated;
  // Whole minutes keep contract deadlines legible; rounding up never shortens what was asked.
  return new Date(Math.ceil(settled.getTime() / MINUTE_MS) * MINUTE_MS);
}

/** "Wed, Oct 7 at 6:00 PM (UTC+9)": the deadline on the human's clock, for the mandate summary. */
export function formatLocalDeadline(deadline: Date, tzOffsetMinutes: number): string {
  const tz = normaliseTzOffset(tzOffsetMinutes);
  const wall = new Date(deadline.getTime() - tz * MINUTE_MS);
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][wall.getUTCDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][wall.getUTCMonth()];
  const hour24 = wall.getUTCHours();
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const minute = wall.getUTCMinutes().toString().padStart(2, "0");
  return `${weekday}, ${month} ${wall.getUTCDate()} at ${hour12}:${minute} ${hour24 < 12 ? "AM" : "PM"} (${formatUtcOffset(tz, "short")})`;
}

/** "+09:00" (long) or "UTC+9" (short) for a Date#getTimezoneOffset value. */
export function formatUtcOffset(tzOffsetMinutes: number, style: "long" | "short"): string {
  const tz = normaliseTzOffset(tzOffsetMinutes);
  const ahead = -tz;
  const sign = ahead < 0 ? "-" : "+";
  const hours = Math.floor(Math.abs(ahead) / 60);
  const minutes = Math.abs(ahead) % 60;
  if (style === "long") return `${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
  if (ahead === 0) return "UTC";
  return `UTC${sign}${hours}${minutes === 0 ? "" : `:${minutes.toString().padStart(2, "0")}`}`;
}

/** "2026-10-06 14:05 (Tuesday)": the human's current wall-clock time, for the model's benefit. */
export function formatLocalNow(now: Date, tzOffsetMinutes: number): string {
  const tz = normaliseTzOffset(tzOffsetMinutes);
  const wall = new Date(now.getTime() - tz * MINUTE_MS);
  const weekday = WEEKDAYS[wall.getUTCDay()];
  return `${wall.toISOString().slice(0, 10)} ${wall.toISOString().slice(11, 16)} (${weekday[0].toUpperCase()}${weekday.slice(1)})`;
}

/**
 * Lexical primitives shared by the deterministic intent extractors: character spans (so that
 * every recognised phrase can be marked as "understood") and small spoken quantities.
 */

/** Half-open character range [start, end) in the analysed text. */
export interface Span {
  start: number;
  end: number;
}

export function overlapsAny(span: Span, spans: readonly Span[]): boolean {
  return spans.some((other) => span.start < other.end && other.start < span.end);
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

/** "three" -> 3. Null for anything that is not a number word. */
export function numberWord(text: string): number | null {
  return NUMBER_WORDS[text] ?? null;
}

/**
 * Regex source for a small quantity as people write it in a request: digits, a number word, or
 * an article standing in for "one" ("within a week"). Longer alternatives come first.
 */
export const QUANTITY_SOURCE = String.raw`a couple of|\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|an|a`;

/** Value of a string matched by QUANTITY_SOURCE. */
export function parseQuantity(text: string): number | null {
  const normalised = text.trim().replace(/\s+/g, " ");
  if (/^\d{1,3}$/.test(normalised)) return Number(normalised);
  if (normalised === "a" || normalised === "an") return 1;
  if (normalised === "a couple of") return 2;
  return numberWord(normalised);
}

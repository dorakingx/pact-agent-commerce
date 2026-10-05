/**
 * Cleaning of the human's free text before it is stored, shown or handed to an agent.
 *
 * The request is the one piece of browser input that reaches a model, an audit trail and other
 * people's screens. Whatever a person cannot see must not survive: invisible characters are how
 * instructions are hidden from the human who is supposed to have written them.
 */
import { truncate } from "../domain/format";
import { invalid } from "./errors";

export const INTENT_MIN_CHARS = 10;
export const INTENT_MAX_CHARS = 600;
export const REASON_MAX_CHARS = 300;

/** Tabs and line breaks separate words, so they become a space instead of disappearing. */
const LAYOUT_WHITESPACE = /[\t\n\v\f\r\u0085\u2028\u2029]/g;

/**
 * Everything that is not visible text: C0/C1 controls, format characters (zero-width spaces and
 * joiners, bidirectional overrides and isolates, soft hyphen, byte-order mark, tag characters),
 * private-use code points, lone surrogates and noncharacters.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Noncharacter_Code_Point}]/gu;

/**
 * One printable line. NFKC runs first so that compatibility forms (full-width digits, ligatures,
 * exotic spaces) are judged — and later parsed for budgets and dates — as the plain characters
 * they look like.
 */
export function cleanText(raw: string): string {
  return raw.normalize("NFKC").replace(LAYOUT_WHITESPACE, " ").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
}

/**
 * The request as it is stored and shown.
 *
 * Length is measured after cleaning and in UTF-16 units, the unit the browser's own character
 * counter and `maxlength` use, so the limit the person sees is the limit that is enforced.
 *
 * @throws ApiError (400) when the cleaned text is shorter than 10 or longer than 600 characters.
 */
export function sanitizeIntent(raw: string): string {
  const text = cleanText(raw);
  if (text.length < INTENT_MIN_CHARS) {
    throw invalid(`Describe what you need in at least ${INTENT_MIN_CHARS} characters.`);
  }
  if (text.length > INTENT_MAX_CHARS) {
    throw invalid(`Keep the request to ${INTENT_MAX_CHARS} characters or fewer.`);
  }
  return text;
}

/** The optional reason a human gives with a decision: cleaned, cut to length, null when empty. */
export function sanitizeReason(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = cleanText(raw);
  return text === "" ? null : truncate(text, REASON_MAX_CHARS);
}

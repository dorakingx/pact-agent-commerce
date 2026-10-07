/**
 * Pure view logic for the workspace composer: how long the request really is (measured the way
 * the server measures it), whether a scenario's text was edited, and what to say when the
 * server refuses to start a deal.
 */
import type { Scenario } from "@/lib/domain/scenarios";
import type { ApiClientError } from "./api";

export const INTENT_MIN_CHARS = 10;
export const INTENT_MAX_CHARS = 600;

const LAYOUT_WHITESPACE = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Noncharacter_Code_Point}]/gu;

/**
 * The request as the server will store it: one printable line. Mirrors `cleanText` in the
 * service layer (a unit test holds the two together), so the counter under the textarea shows
 * the number the server enforces.
 */
export function cleanIntent(raw: string): string {
  return raw.normalize("NFKC").replace(LAYOUT_WHITESPACE, " ").replace(INVISIBLE, "").replace(/\s+/gu, " ").trim();
}

export interface IntentState {
  /** Characters that count, after cleaning. */
  length: number;
  tooShort: boolean;
  tooLong: boolean;
  valid: boolean;
  /** What to tell the person, when the text cannot be sent yet. Null while it is fine or still empty. */
  hint: string | null;
}

export function intentState(raw: string): IntentState {
  const length = cleanIntent(raw).length;
  const tooShort = length < INTENT_MIN_CHARS;
  const tooLong = length > INTENT_MAX_CHARS;
  let hint: string | null = null;
  if (tooLong) hint = `${length - INTENT_MAX_CHARS} over the ${INTENT_MAX_CHARS}-character limit`;
  else if (tooShort && length > 0) hint = `${INTENT_MIN_CHARS - length} more to reach the ${INTENT_MIN_CHARS}-character minimum`;
  return { length, tooShort, tooLong, valid: !tooShort && !tooLong, hint };
}

/** True when a scenario is selected and the text no longer says what the scenario says. */
export function scenarioEdited(text: string, scenario: Pick<Scenario, "intent"> | undefined): boolean {
  return scenario !== undefined && cleanIntent(text) !== cleanIntent(scenario.intent);
}

/** Minutes until a rate limit resets, rounded up; null when the error carries no reset time. */
export function rateLimitMinutes(error: ApiClientError, nowMs: number): number | null {
  if (error.status !== 429 || typeof error.details !== "object" || error.details === null) return null;
  const resetAt = (error.details as { resetAt?: unknown }).resetAt;
  const resetMs = typeof resetAt === "string" ? Date.parse(resetAt) : Number.NaN;
  if (Number.isNaN(resetMs)) return null;
  return Math.max(1, Math.ceil((resetMs - nowMs) / 60_000));
}

/** The sentence shown under the composer when a deal could not be started. */
export function createErrorMessage(error: ApiClientError, nowMs: number): string {
  if (error.status === 429) {
    const minutes = rateLimitMinutes(error, nowMs);
    const wait = minutes === null ? "shortly" : minutes === 1 ? "in about a minute" : `in about ${minutes} minutes`;
    return `This session has started as many deals as the demo allows for now. Try again ${wait}.`;
  }
  return error.message;
}

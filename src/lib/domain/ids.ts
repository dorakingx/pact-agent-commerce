/**
 * Identifier generation. Ids are random (never derived from content) so that they can be
 * minted before the thing they name exists, and prefixed so a stray id in a log is self-describing.
 */
import { customAlphabet } from "nanoid";

export type IdPrefix = "deal" | "ctr" | "sub" | "rep" | "evt" | "sess" | "art";

/** Lowercase alphanumerics only: safe in URLs, PayPal invoice_id and Postgres without quoting. */
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_LENGTH = 12;

/** No 0/O/1/I: a deal code is read aloud and typed by humans. */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_LENGTH = 4;

const randomId = customAlphabet(ID_ALPHABET, ID_LENGTH);
const randomCode = customAlphabet(CODE_ALPHABET, CODE_LENGTH);

/** `${prefix}_${12 lowercase alphanumerics}`, e.g. "ctr_k3v9x0q2m7ab" (62 bits of entropy). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomId()}`;
}

/**
 * Short human-facing deal reference, e.g. "PACT-7KQ2". Only ~1M combinations: it is a display
 * label, and callers that need uniqueness must enforce it (the deals table has a unique index).
 */
export function newDealCode(): string {
  return `PACT-${randomCode()}`;
}

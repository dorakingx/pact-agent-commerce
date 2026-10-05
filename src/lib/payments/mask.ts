/**
 * Payer e-mail masking. A payer's address is personal data PACT has no need to keep:
 * the masked form is enough for a human to recognise which account paid.
 */

const MASK = "****";

/**
 * Keeps the first two characters of the local part and the whole domain:
 * "sb-buyer42@personal.example.com" -> "sb****@personal.example.com".
 * The mask has a fixed width so it does not leak the length of the hidden part, and local parts
 * of one or two characters keep only their first character so they are never shown in full.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  if (trimmed === "") return null;
  const at = trimmed.lastIndexOf("@");
  // Not an address at all: reveal nothing rather than guess which part is safe to show.
  if (at <= 0 || at === trimmed.length - 1) return MASK;
  const local = trimmed.slice(0, at);
  const visible = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visible}${MASK}${trimmed.slice(at)}`;
}

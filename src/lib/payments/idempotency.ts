/**
 * Deterministic idempotency keys.
 *
 * The same key is (a) the primary key of the payment ledger and (b) the PayPal-Request-Id header,
 * so "did we already do this?" has one answer on both sides. Keys are derived from WHAT is being
 * done (operation kind + the ids it applies to), never from when or how often it is attempted:
 * a retry after a crash produces the same key and PayPal replays the original result.
 */
import { sha256Hex } from "../domain/canonical";
import type { PaymentOperationKind } from "./types";

/** Bumping this invalidates every previously derived key, so it only changes with the derivation itself. */
const DERIVATION = "pact-idempotency-v1";

/**
 * UUID-shaped key (8-4-4-4-12 lowercase hex, 36 chars) derived from SHA-256 of the kind and parts.
 * PayPal requires the request id to be unique per request TYPE, which is why `kind` is hashed in:
 * the capture and the void of one authorization can never share a key.
 */
export function idempotencyKey(kind: PaymentOperationKind, ...parts: string[]): string {
  // JSON keeps the part boundaries, so ("a", "bc") and ("ab", "c") hash differently.
  const digest = sha256Hex(JSON.stringify([DERIVATION, kind, ...parts]));
  // Laid out as an RFC 9562 version-8 (custom) UUID so it passes UUID validation anywhere en route.
  const variant = ((Number.parseInt(digest.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `8${digest.slice(13, 16)}`,
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/**
 * In-memory payment ledger — the reference implementation of the PaymentLedger contract.
 * The Postgres implementation (payment_operations table) must behave identically; this one
 * backs the unit tests and documents the semantics:
 *
 *   begin() on an unknown key            -> "new"        (entry recorded as started)
 *   begin() after succeed()              -> "succeeded"  (stored response; never call PayPal again)
 *   begin() after a crash or a transient
 *           failure                      -> "retry"      (same key is safe to resend)
 *   begin() after a terminal failure     -> "failed"     (stored error)
 */
import type { LedgerBeginResult, PaymentLedger, PaymentOperationKind } from "./types";

export type LedgerEntryStatus = "started" | "succeeded" | "retryable" | "failed";

export interface LedgerError {
  issue: string;
  message: string;
  debugId: string | null;
}

export interface MemoryLedgerEntry {
  key: string;
  dealId: string;
  kind: PaymentOperationKind;
  status: LedgerEntryStatus;
  /** What was asked for, as recorded by the FIRST attempt. */
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  error: LedgerError | null;
  /** How many times the operation was begun. */
  attempts: number;
}

export type MemoryLedger = PaymentLedger & {
  /** Read-only view for assertions. */
  entries(): ReadonlyMap<string, MemoryLedgerEntry>;
};

export function createMemoryLedger(): MemoryLedger {
  const entries = new Map<string, MemoryLedgerEntry>();

  function existing(key: string): MemoryLedgerEntry {
    const entry = entries.get(key);
    if (entry === undefined) throw new Error(`Payment ledger has no operation with key ${key}`);
    return entry;
  }

  return {
    async begin(input): Promise<LedgerBeginResult> {
      const entry = entries.get(input.key);
      if (entry === undefined) {
        entries.set(input.key, {
          key: input.key,
          dealId: input.dealId,
          kind: input.kind,
          status: "started",
          request: structuredClone(input.request),
          response: null,
          error: null,
          attempts: 1,
        });
        return { state: "new" };
      }
      // Keys are derived from kind + ids, so a clash means two different operations would share
      // one PayPal-Request-Id. Refuse loudly rather than let one silently replay the other.
      if (entry.dealId !== input.dealId || entry.kind !== input.kind) {
        throw new Error(
          `Idempotency key ${input.key} already belongs to ${entry.kind} of deal ${entry.dealId}; ` +
            `it cannot be reused for ${input.kind} of deal ${input.dealId}`,
        );
      }
      switch (entry.status) {
        case "succeeded":
          return { state: "succeeded", response: structuredClone(entry.response ?? {}) };
        case "failed":
          return {
            state: "failed",
            error: entry.error ?? { issue: "UNKNOWN", message: "The operation failed", debugId: null },
          };
        case "started":
        case "retryable":
          entry.attempts += 1;
          entry.status = "started";
          return { state: "retry", attempts: entry.attempts };
        default: {
          const unhandled: never = entry.status;
          throw new Error(`Unhandled ledger status: ${String(unhandled)}`);
        }
      }
    },

    async succeed(key, response): Promise<void> {
      const entry = existing(key);
      entry.status = "succeeded";
      entry.response = structuredClone(response);
      entry.error = null;
    },

    async fail(key, error, options): Promise<void> {
      const entry = existing(key);
      // A recorded success is final: a late failure report must not reopen an operation that moved money.
      if (entry.status === "succeeded") return;
      entry.status = options.retryable ? "retryable" : "failed";
      entry.error = { issue: error.issue, message: error.message, debugId: error.debugId };
    },

    entries: () => entries,
  };
}

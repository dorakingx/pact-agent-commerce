/**
 * The idempotency ledger on Postgres (table payment_operations).
 *
 * The primary key is the idempotency key that is also sent to PayPal as PayPal-Request-Id.
 * Every state change below is a single statement with its precondition in the WHERE clause,
 * so concurrent requests cannot both believe they are the first to perform an operation and
 * a recorded success can never be overwritten.
 *
 * Give the ledger the root database, not a transaction handle, and call it outside
 * withTransaction(): the "started" row has to survive the failure of whatever happens next,
 * which is the whole point of writing it first. (A PayPal call never belongs inside a database
 * transaction anyway.)
 */
import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { log } from "../../observability/logger";
import type { LedgerBeginResult, PaymentLedger, PaymentOperationKind } from "../../payments/types";
import type { Db } from "../client";
import { DbError, dbCall } from "../errors";
import { paymentOperations, type PaymentOperationRow } from "../schema";
import { toIsoUtc } from "../time";
import { parseStored } from "../validation";

export const PAYMENT_OPERATION_STATUSES = ["started", "succeeded", "failed_retryable", "failed"] as const;
export type PaymentOperationStatus = (typeof PAYMENT_OPERATION_STATUSES)[number];

type OperationError = { issue: string; message: string; debugId: string | null };

/** One row of the ledger, for the operations view and for tests. */
export interface PaymentOperation {
  key: string;
  dealId: string;
  kind: PaymentOperationKind;
  status: PaymentOperationStatus;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  error: OperationError | null;
  /** How many times the operation has been started (1 = never retried). */
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/** A Record rather than an array so that adding a kind to the union without listing it here fails to compile. */
const OPERATION_KINDS: Record<PaymentOperationKind, true> = {
  create_order: true,
  authorize: true,
  capture: true,
  void: true,
  reauthorize: true,
  vault_setup: true,
  vault_exchange: true,
};

const StatusSchema = z.enum(PAYMENT_OPERATION_STATUSES);
const KindSchema = z.custom<PaymentOperationKind>(
  (value) => typeof value === "string" && Object.hasOwn(OPERATION_KINDS, value),
  "unknown payment operation kind",
);
const JsonObjectSchema = z.record(z.string(), z.unknown());
const OperationErrorSchema = z.object({ issue: z.string(), message: z.string(), debugId: z.string().nullable() });

const PaymentOperationSchema = z.object({
  key: z.string(),
  dealId: z.string(),
  kind: KindSchema,
  status: StatusSchema,
  request: JsonObjectSchema.nullable(),
  response: JsonObjectSchema.nullable(),
  error: OperationErrorSchema.nullable(),
  attempts: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<PaymentOperation>;

/** Statuses from which the same key may be attempted again. */
const RESUMABLE: PaymentOperationStatus[] = ["started", "failed_retryable"];
const SUCCEEDED: PaymentOperationStatus = "succeeded";

/** Reported when a terminally failed row somehow has no stored error; never expected in practice. */
const UNRECORDED_ERROR: OperationError = {
  issue: "UNRECORDED_FAILURE",
  message: "The operation failed but no error was recorded.",
  debugId: null,
};

/**
 * begin() re-reads the row when its resume attempt matches nothing. A concurrent fail() can
 * flip the row back to a resumable status between those two statements, so the pair is
 * retried; more than a couple of rounds would mean something is rewriting the row in a loop.
 */
const MAX_BEGIN_ROUNDS = 3;

function toPaymentOperation(row: PaymentOperationRow): PaymentOperation {
  return parseStored(
    PaymentOperationSchema,
    { ...row, createdAt: toIsoUtc(row.createdAt), updatedAt: toIsoUtc(row.updatedAt) },
    `payment operation ${row.key}`,
  );
}

type BeginInput = Parameters<PaymentLedger["begin"]>[0];

async function begin(db: Db, input: BeginInput): Promise<LedgerBeginResult> {
  const now = new Date().toISOString();
  const inserted = await db
    .insert(paymentOperations)
    .values({
      key: input.key,
      dealId: input.dealId,
      kind: input.kind,
      status: "started",
      request: input.request,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: paymentOperations.key })
    .returning({ key: paymentOperations.key });
  if (inserted.length > 0) return { state: "new" };

  for (let round = 0; round < MAX_BEGIN_ROUNDS; round += 1) {
    const [resumed] = await db
      .update(paymentOperations)
      .set({ status: "started", attempts: sql`${paymentOperations.attempts} + 1`, updatedAt: now })
      .where(
        and(
          eq(paymentOperations.key, input.key),
          eq(paymentOperations.dealId, input.dealId),
          eq(paymentOperations.kind, input.kind),
          inArray(paymentOperations.status, RESUMABLE),
        ),
      )
      .returning({ attempts: paymentOperations.attempts });
    if (resumed) return { state: "retry", attempts: resumed.attempts };

    const [row] = await db.select().from(paymentOperations).where(eq(paymentOperations.key, input.key)).limit(1);
    if (!row) {
      throw new DbError("ledger.begin", `ledger.begin: operation ${input.key} was deleted while it was being resumed`);
    }
    const existing = toPaymentOperation(row);
    if (existing.dealId !== input.dealId || existing.kind !== input.kind) {
      // Replaying another operation's stored response would attach the wrong PayPal ids to this deal.
      throw new DbError(
        "ledger.begin",
        `ledger.begin: idempotency key ${input.key} already belongs to a ${existing.kind} operation of deal ${existing.dealId}`,
      );
    }
    switch (existing.status) {
      case "succeeded":
        return { state: "succeeded", response: existing.response ?? {} };
      case "failed":
        return { state: "failed", error: existing.error ?? UNRECORDED_ERROR };
      case "started":
      case "failed_retryable":
        continue;
      default: {
        const unknownStatus: never = existing.status;
        throw new Error(`Unhandled payment operation status: ${String(unknownStatus)}`);
      }
    }
  }
  throw new DbError("ledger.begin", `ledger.begin: operation ${input.key} kept changing state; giving up`);
}

/** Recording an outcome for a key that was never begun is a caller bug, not something to ignore. */
async function assertBegun(db: Db, operation: string, key: string): Promise<void> {
  const [row] = await db
    .select({ key: paymentOperations.key })
    .from(paymentOperations)
    .where(eq(paymentOperations.key, key))
    .limit(1);
  if (!row) throw new DbError(operation, `${operation}: no operation was begun for key ${key}`);
}

async function succeed(db: Db, key: string, response: Record<string, unknown>): Promise<void> {
  const updated = await db
    .update(paymentOperations)
    .set({ status: SUCCEEDED, response, error: null, updatedAt: new Date().toISOString() })
    .where(and(eq(paymentOperations.key, key), ne(paymentOperations.status, SUCCEEDED)))
    .returning({ key: paymentOperations.key });
  if (updated.length > 0) return;
  // The row exists but was not updated, so a success is already recorded. The first response
  // is kept: every replay of this key must return the same PayPal ids.
  await assertBegun(db, "ledger.succeed", key);
}

async function fail(db: Db, key: string, error: OperationError, options: { retryable: boolean }): Promise<void> {
  const status: PaymentOperationStatus = options.retryable ? "failed_retryable" : "failed";
  const updated = await db
    .update(paymentOperations)
    .set({ status, error, updatedAt: new Date().toISOString() })
    .where(and(eq(paymentOperations.key, key), ne(paymentOperations.status, SUCCEEDED)))
    .returning({ key: paymentOperations.key });
  if (updated.length > 0) return;
  await assertBegun(db, "ledger.fail", key);
  // A concurrent attempt with the same key already succeeded, so the money has moved. A late
  // failure report must not erase that fact.
  log.warn("ledger.fail_ignored", { key, issue: error.issue, reason: "operation already succeeded" });
}

export function createDbLedger(db: Db): PaymentLedger {
  return {
    begin: (input) => dbCall("ledger.begin", () => begin(db, input)),
    succeed: (key, response) => dbCall("ledger.succeed", () => succeed(db, key, response)),
    fail: (key, error, options) => dbCall("ledger.fail", () => fail(db, key, error, options)),
  };
}

/** Every money-moving call recorded for a deal, oldest first. */
export function listPaymentOperations(db: Db, dealId: string): Promise<PaymentOperation[]> {
  return dbCall("listPaymentOperations", async () => {
    const rows = await db
      .select()
      .from(paymentOperations)
      .where(eq(paymentOperations.dealId, dealId))
      .orderBy(asc(paymentOperations.createdAt), asc(paymentOperations.key));
    return rows.map(toPaymentOperation);
  });
}

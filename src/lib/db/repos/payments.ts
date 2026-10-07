/** Payment records: one per deal, holding PayPal's ids and the amounts authorized and captured. */
import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { IsoDateTimeSchema } from "../../domain/schemas";
import { PaymentStatusSchema } from "../../domain/status";
import type { PaymentRecord } from "../../payments/types";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { payments, type PaymentRow } from "../schema";
import { toIsoUtc, toIsoUtcOrNull } from "../time";
import { parseForWrite, parseStored } from "../validation";

/** Integer minor units. Float amounts must never reach a money column. */
const StoredMinorSchema = z.number().int().min(0);

const PaymentRecordSchema = z.object({
  provider: z.enum(["paypal_sandbox", "simulated"]),
  mode: z.enum(["interactive", "delegated"]),
  status: PaymentStatusSchema,
  orderId: z.string().min(1).nullable(),
  authorizationId: z.string().min(1).nullable(),
  captureId: z.string().min(1).nullable(),
  amountMinor: StoredMinorSchema,
  authorizedMinor: StoredMinorSchema,
  capturedMinor: StoredMinorSchema,
  currency: z.literal("USD"),
  approveUrl: z.string().nullable(),
  authorizationExpiresAt: IsoDateTimeSchema.nullable(),
  payerEmailMasked: z.string().nullable(),
  lastError: z
    .object({ issue: z.string(), message: z.string(), debugId: z.string().nullable(), at: z.string() })
    .nullable(),
  webhookConfirmed: z.object({ authorized: z.boolean(), captured: z.boolean(), voided: z.boolean() }),
  updatedAt: IsoDateTimeSchema,
}) satisfies z.ZodType<PaymentRecord>;

export function toPaymentRecord(row: PaymentRow): PaymentRecord {
  return parseStored(
    PaymentRecordSchema,
    {
      provider: row.provider,
      mode: row.mode,
      status: row.status,
      orderId: row.orderId,
      authorizationId: row.authorizationId,
      captureId: row.captureId,
      amountMinor: row.amountMinor,
      authorizedMinor: row.authorizedMinor,
      capturedMinor: row.capturedMinor,
      currency: row.currency,
      approveUrl: row.approveUrl,
      authorizationExpiresAt: toIsoUtcOrNull(row.authorizationExpiresAt),
      payerEmailMasked: row.payerEmailMasked,
      lastError: row.lastError,
      webhookConfirmed: row.webhookConfirmed,
      updatedAt: toIsoUtc(row.updatedAt),
    },
    `payment of deal ${row.dealId}`,
  );
}

/**
 * Writes the whole record (insert, or replace when the deal already has one). Last writer
 * wins, so read-modify-write callers must hold the deal lease or lock the row first with
 * `getPayment(tx, dealId, { forUpdate: true })` inside a transaction.
 *
 * Throws DuplicateError (constraint "payments_order_idx") if another deal already uses the order id.
 */
export function upsertPayment(db: Db, dealId: string, record: PaymentRecord): Promise<void> {
  return dbCall("upsertPayment", async () => {
    const valid = parseForWrite(PaymentRecordSchema, record, `payment of deal ${dealId}`);
    const values = {
      provider: valid.provider,
      mode: valid.mode,
      status: valid.status,
      orderId: valid.orderId,
      authorizationId: valid.authorizationId,
      captureId: valid.captureId,
      amountMinor: valid.amountMinor,
      authorizedMinor: valid.authorizedMinor,
      capturedMinor: valid.capturedMinor,
      currency: valid.currency,
      approveUrl: valid.approveUrl,
      authorizationExpiresAt: toIsoUtcOrNull(valid.authorizationExpiresAt),
      payerEmailMasked: valid.payerEmailMasked,
      lastError: valid.lastError,
      webhookConfirmed: valid.webhookConfirmed,
      updatedAt: toIsoUtc(valid.updatedAt),
    };
    await db
      .insert(payments)
      .values({ dealId, ...values })
      .onConflictDoUpdate({ target: payments.dealId, set: values });
  });
}

/**
 * `forUpdate` takes a row lock until the surrounding transaction ends, so a webhook and a
 * step can never overwrite each other's changes. It only has an effect inside withTransaction.
 */
export function getPayment(
  db: Db,
  dealId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PaymentRecord | null> {
  return dbCall("getPayment", async () => {
    const query = db.select().from(payments).where(eq(payments.dealId, dealId)).limit(1);
    const [row] = await (options.forUpdate ? query.for("update") : query);
    return row ? toPaymentRecord(row) : null;
  });
}

/**
 * The wallet a deal's payment is reserved against: `{ walletOwner: null }` for a payment the
 * payer approves in PayPal, null when the deal has no payment row yet.
 */
export function getPaymentFunding(db: Db, dealId: string): Promise<{ walletOwner: string | null } | null> {
  return dbCall("getPaymentFunding", async () => {
    const [row] = await db.select({ walletOwner: payments.walletOwner }).from(payments).where(eq(payments.dealId, dealId)).limit(1);
    return row ?? null;
  });
}

/**
 * Record (or clear, with null) the wallet a payment is reserved against. Kept apart from
 * `upsertPayment` on purpose: the payment record is rewritten by every step, the funding
 * decision is made once and must survive those rewrites.
 */
export function setPaymentFunding(db: Db, dealId: string, walletOwner: string | null): Promise<void> {
  return dbCall("setPaymentFunding", async () => {
    await db.update(payments).set({ walletOwner }).where(eq(payments.dealId, dealId));
  });
}

type PayPalIdColumn = typeof payments.orderId | typeof payments.authorizationId | typeof payments.captureId;

async function findDealId(db: Db, column: PayPalIdColumn, value: string): Promise<string | null> {
  const [row] = await db.select({ dealId: payments.dealId }).from(payments).where(eq(column, value)).limit(1);
  return row?.dealId ?? null;
}

/** Correlates a PayPal order (webhook resource, return URL) back to its deal. */
export function findDealIdByOrderId(db: Db, orderId: string): Promise<string | null> {
  return dbCall("findDealIdByOrderId", () => findDealId(db, payments.orderId, orderId));
}

export function findDealIdByAuthorizationId(db: Db, authorizationId: string): Promise<string | null> {
  return dbCall("findDealIdByAuthorizationId", () => findDealId(db, payments.authorizationId, authorizationId));
}

/** Capture webhooks identify themselves by capture id only. */
export function findDealIdByCaptureId(db: Db, captureId: string): Promise<string | null> {
  return dbCall("findDealIdByCaptureId", () => findDealId(db, payments.captureId, captureId));
}

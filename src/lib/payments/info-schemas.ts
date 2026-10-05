/**
 * Runtime schemas for the provider-neutral payment shapes declared in ./types.ts.
 *
 * They exist because these shapes are persisted (ledger responses, simulator documents) and
 * later read back: anything that comes out of storage is parsed again before the orchestrator
 * acts on it, exactly like data coming from an LLM or the network.
 */
import { z } from "zod";
import type { AuthorizationInfo, CaptureInfo, OrderInfo } from "./types";

export const ORDER_STATUSES = ["CREATED", "SAVED", "APPROVED", "VOIDED", "COMPLETED", "PAYER_ACTION_REQUIRED"] as const;
export const AUTHORIZATION_STATUSES = ["CREATED", "CAPTURED", "DENIED", "PARTIALLY_CAPTURED", "VOIDED", "PENDING"] as const;
export const CAPTURE_STATUSES = ["COMPLETED", "DECLINED", "PARTIALLY_REFUNDED", "PENDING", "REFUNDED", "FAILED"] as const;

const MinorAmountSchema = z.number().int().min(0);

export const AuthorizationInfoSchema = z.object({
  authorizationId: z.string().min(1),
  status: z.enum(AUTHORIZATION_STATUSES),
  amountMinor: MinorAmountSchema,
  currency: z.literal("USD"),
  expiresAt: z.string().nullable(),
  customId: z.string().nullable(),
  invoiceId: z.string().nullable(),
}) satisfies z.ZodType<AuthorizationInfo>;

export const OrderInfoSchema = z.object({
  orderId: z.string().min(1),
  status: z.enum(ORDER_STATUSES),
  amountMinor: MinorAmountSchema,
  currency: z.literal("USD"),
  customId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  approveUrl: z.string().nullable(),
  authorization: AuthorizationInfoSchema.nullable(),
  payerEmailMasked: z.string().nullable(),
  vaultId: z.string().nullable(),
}) satisfies z.ZodType<OrderInfo>;

export const CaptureInfoSchema = z.object({
  captureId: z.string().min(1),
  status: z.enum(CAPTURE_STATUSES),
  amountMinor: MinorAmountSchema,
  currency: z.literal("USD"),
  finalCapture: z.boolean(),
}) satisfies z.ZodType<CaptureInfo>;

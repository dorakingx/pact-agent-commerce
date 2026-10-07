/**
 * PayPal webhook interpretation.
 *
 * Two pure steps, both free of I/O so they can be tested exhaustively:
 *  1. interpretWebhookEvent — reduce PayPal's event payload to the few facts PACT cares about;
 *  2. applyWebhookEffect    — fold those facts into a payment record.
 *
 * Webhooks CONFIRM what the orchestrator already did (webhookConfirmed.*) and may ADVANCE the
 * record only in directions the payment state machine allows — e.g. PayPal completing a pending
 * capture, or releasing an authorization on its own. They never move a settled payment, and an
 * event whose ids or amounts contradict the record changes nothing and is written to the audit
 * trail instead. Callers must verify the signature (PaymentProvider.verifyWebhook) BEFORE
 * interpreting an event, and deduplicate on `eventId`.
 */
import { z } from "zod";
import { assertNever, truncate } from "../domain/format";
import { CURRENCY, formatMoney, fromPayPalValue } from "../domain/money";
import type { AuditEventInput, AuditEventType } from "../domain/schemas";
import { assertPaymentTransition, type PaymentStatus } from "../domain/status";
import type { PaymentRecord } from "./types";

export type WebhookEffect = {
  kind: "approved" | "authorized" | "captured" | "capture_pending" | "capture_denied" | "voided" | "refunded" | "ignored";
  /** PayPal's event id ("WH-…"); empty when the payload has none, i.e. is not a PayPal event. */
  eventId: string;
  eventType: string;
  resourceId: string | null;
  orderId: string | null;
  authorizationId: string | null;
  captureId: string | null;
  amountMinor: number | null;
  customId: string | null;
  invoiceId: string | null;
  /** The resource's own status as PayPal reports it (e.g. an authorization that is still PENDING), or null. */
  resourceStatus: string | null;
  /** When the resource stops being usable (an authorization's expiration_time), as an ISO instant, or null. */
  expiresAt: string | null;
};

type EffectKind = WebhookEffect["kind"];

/** A Map, not an object: event types are untrusted strings and must not hit Object.prototype. */
const EVENT_KINDS: ReadonlyMap<string, Exclude<EffectKind, "ignored">> = new Map([
  ["CHECKOUT.ORDER.APPROVED", "approved"],
  ["PAYMENT.AUTHORIZATION.CREATED", "authorized"],
  ["PAYMENT.AUTHORIZATION.VOIDED", "voided"],
  ["PAYMENT.CAPTURE.COMPLETED", "captured"],
  ["PAYMENT.CAPTURE.PENDING", "capture_pending"],
  ["PAYMENT.CAPTURE.DENIED", "capture_denied"],
  ["PAYMENT.CAPTURE.DECLINED", "capture_denied"],
  ["PAYMENT.CAPTURE.REFUNDED", "refunded"],
  ["PAYMENT.CAPTURE.REVERSED", "refunded"],
]);

/** The event types the PACT webhook endpoint is registered for. */
export const SUBSCRIBED_EVENT_TYPES: string[] = [...EVENT_KINDS.keys()];

/* -------------------------------------------------------------------------- */
/*  Interpretation                                                             */
/* -------------------------------------------------------------------------- */

const MoneySchema = z.object({ currency_code: z.string().nullish(), value: z.string().nullish() });

const ResourceSchema = z.object({
  id: z.string().nullish(),
  status: z.string().nullish(),
  expiration_time: z.string().nullish(),
  amount: MoneySchema.nullish(),
  custom_id: z.string().nullish(),
  invoice_id: z.string().nullish(),
  purchase_units: z
    .array(z.object({ amount: MoneySchema.nullish(), custom_id: z.string().nullish(), invoice_id: z.string().nullish() }))
    .nullish(),
  supplementary_data: z
    .object({
      related_ids: z
        .object({
          order_id: z.string().nullish(),
          authorization_id: z.string().nullish(),
          capture_id: z.string().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  links: z.array(z.object({ rel: z.string().nullish(), href: z.string().nullish() })).nullish(),
});
type Resource = z.infer<typeof ResourceSchema>;

const EnvelopeSchema = z.object({
  id: z.string().nullish(),
  event_type: z.string().nullish(),
  resource_type: z.string().nullish(),
  create_time: z.string().nullish(),
  resource: z.unknown(),
});

/**
 * What is kept of a verified delivery: the envelope's identifying fields and exactly the parts
 * of the resource that interpretation reads. Everything else PayPal sends is dropped before
 * storage — an order resource carries the payer's name, e-mail address and payer id, and PACT
 * has no use for them. A redelivery is processed from its own body, never from this row.
 */
export function storedWebhookPayload(event: unknown): Record<string, unknown> {
  const envelope = EnvelopeSchema.safeParse(event);
  if (!envelope.success) return {};
  const resource = ResourceSchema.safeParse(envelope.data.resource);
  const { id, event_type, resource_type, create_time } = envelope.data;
  return { id, event_type, resource_type, create_time, resource: resource.success ? resource.data : null };
}

function isoOrNull(timestamp: string | null | undefined): string | null {
  if (!timestamp) return null;
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function minorOf(amount: z.infer<typeof MoneySchema> | null | undefined): number | null {
  if (!amount || amount.currency_code !== CURRENCY || typeof amount.value !== "string") return null;
  try {
    return fromPayPalValue(amount.value);
  } catch {
    return null;
  }
}

const CAPTURE_LINK = /\/v2\/payments\/captures\/([^/?#]+)$/;

/** A refund resource names its capture only through the "up" link. */
function captureIdFromLinks(links: Resource["links"]): string | null {
  const href = links?.find((link) => link.rel === "up")?.href;
  const match = typeof href === "string" ? CAPTURE_LINK.exec(href) : null;
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Reduce a PayPal webhook payload to a WebhookEffect. Never throws: anything that is not one of
 * the subscribed event types, or does not carry a usable resource, comes back as "ignored".
 */
export function interpretWebhookEvent(event: unknown): WebhookEffect {
  const envelope = EnvelopeSchema.safeParse(event);
  const parsedResource = envelope.success ? ResourceSchema.safeParse(envelope.data.resource) : null;
  const resource = parsedResource?.success ? parsedResource.data : null;
  const eventType = envelope.success ? (envelope.data.event_type ?? "") : "";
  const ignored: WebhookEffect = {
    kind: "ignored",
    eventId: envelope.success ? (envelope.data.id ?? "") : "",
    eventType,
    resourceId: resource?.id ?? null,
    orderId: null,
    authorizationId: null,
    captureId: null,
    amountMinor: null,
    customId: null,
    invoiceId: null,
    resourceStatus: resource?.status ?? null,
    expiresAt: isoOrNull(resource?.expiration_time),
  };
  const kind = EVENT_KINDS.get(eventType);
  if (kind === undefined || !resource?.id) return ignored;

  const related = resource.supplementary_data?.related_ids;
  const ownFields = {
    amountMinor: minorOf(resource.amount),
    customId: resource.custom_id ?? null,
    invoiceId: resource.invoice_id ?? null,
  };
  switch (kind) {
    case "approved": {
      // The resource is the order; amount and binding fields live on its (single) purchase unit.
      const unit = resource.purchase_units?.[0];
      return {
        ...ignored,
        kind,
        orderId: resource.id,
        amountMinor: minorOf(unit?.amount),
        customId: unit?.custom_id ?? null,
        invoiceId: unit?.invoice_id ?? null,
      };
    }
    case "authorized":
    case "voided":
      return { ...ignored, ...ownFields, kind, authorizationId: resource.id, orderId: related?.order_id ?? null };
    case "captured":
    case "capture_pending":
    case "capture_denied":
      return {
        ...ignored,
        ...ownFields,
        kind,
        captureId: resource.id,
        authorizationId: related?.authorization_id ?? null,
        orderId: related?.order_id ?? null,
      };
    case "refunded":
      // The resource is the refund itself, so resourceId is the refund id.
      return {
        ...ignored,
        ...ownFields,
        kind,
        captureId: related?.capture_id ?? captureIdFromLinks(resource.links),
        authorizationId: related?.authorization_id ?? null,
        orderId: related?.order_id ?? null,
      };
    default:
      return assertNever(kind);
  }
}

/* -------------------------------------------------------------------------- */
/*  Application                                                                */
/* -------------------------------------------------------------------------- */

export interface WebhookApplication {
  payment: PaymentRecord;
  events: AuditEventInput[];
  /** True when the returned record differs from the input and must be persisted. */
  changed: boolean;
}

const AUDIT_TITLE_MAX = 200;

function webhookData(payment: PaymentRecord, effect: WebhookEffect): Record<string, unknown> {
  return {
    provider: payment.provider,
    eventId: effect.eventId,
    eventType: effect.eventType,
    resourceId: effect.resourceId,
    orderId: effect.orderId,
    authorizationId: effect.authorizationId,
    captureId: effect.captureId,
    amountMinor: effect.amountMinor,
  };
}

function auditEvent(
  now: Date,
  type: AuditEventType,
  title: string,
  payment: PaymentRecord,
  effect: WebhookEffect,
  extra: Record<string, unknown> = {},
): AuditEventInput {
  return {
    actor: "paypal",
    type,
    title: truncate(title, AUDIT_TITLE_MAX),
    detail: null,
    data: { ...webhookData(payment, effect), ...extra },
    at: now.toISOString(),
  };
}

function unchanged(payment: PaymentRecord, events: AuditEventInput[] = []): WebhookApplication {
  return { payment, events, changed: false };
}

/** The event contradicts the record: change nothing, but leave a trace a human will see. */
function mismatch(payment: PaymentRecord, effect: WebhookEffect, why: string, now: Date): WebhookApplication {
  return unchanged(payment, [
    auditEvent(now, "payment.webhook", `PayPal webhook ${effect.eventType} not applied: ${why}`, payment, effect, {
      mismatch: true,
      paymentStatus: payment.status,
    }),
  ]);
}

type Confirmation = keyof PaymentRecord["webhookConfirmed"];
type RecordPatch = Partial<Omit<PaymentRecord, "status" | "updatedAt" | "webhookConfirmed">>;

function withConfirmation(payment: PaymentRecord, flag: Confirmation, patch: RecordPatch, now: Date): PaymentRecord {
  return {
    ...payment,
    ...patch,
    webhookConfirmed: { ...payment.webhookConfirmed, [flag]: true },
    updatedAt: now.toISOString(),
  };
}

/** PayPal independently confirms something the record already says. Idempotent: a repeat changes nothing. */
function confirm(
  payment: PaymentRecord,
  effect: WebhookEffect,
  flag: Confirmation,
  patch: RecordPatch,
  title: string,
  now: Date,
): WebhookApplication {
  if (payment.webhookConfirmed[flag] && Object.keys(patch).length === 0) return unchanged(payment);
  return {
    payment: withConfirmation(payment, flag, patch, now),
    events: [auditEvent(now, "payment.webhook", title, payment, effect, { confirmed: flag })],
    changed: true,
  };
}

interface Advance {
  to: PaymentStatus;
  flag: Confirmation | null;
  patch: RecordPatch;
  /** Headline of the payment.webhook event. */
  notice: string;
  /** The state-change event, so a webhook-driven change reads like any other in the audit trail. */
  stateEvent: { type: AuditEventType; title: string };
}

/** PayPal reports something the record does not say yet, and the state machine allows the move. */
function advance(payment: PaymentRecord, effect: WebhookEffect, step: Advance, now: Date): WebhookApplication {
  assertPaymentTransition(payment.status, step.to);
  const base =
    step.flag === null
      ? { ...payment, ...step.patch, updatedAt: now.toISOString() }
      : withConfirmation(payment, step.flag, step.patch, now);
  const record: PaymentRecord = { ...base, status: step.to };
  const origin = { source: "webhook", statusBefore: payment.status, statusAfter: step.to };
  return {
    payment: record,
    events: [
      auditEvent(now, "payment.webhook", step.notice, payment, effect, origin),
      auditEvent(now, step.stateEvent.type, step.stateEvent.title, record, effect, origin),
    ],
    changed: true,
  };
}

type Relation = "match" | "conflict" | "unrelated";

/** Does the event talk about this payment? Every id both sides know must agree, and at least one must. */
function relate(payment: PaymentRecord, effect: WebhookEffect): Relation {
  const pairs: [string | null, string | null][] = [
    [payment.orderId, effect.orderId],
    [payment.authorizationId, effect.authorizationId],
    [payment.captureId, effect.captureId],
  ];
  let matched = false;
  for (const [ours, theirs] of pairs) {
    if (ours === null || theirs === null) continue;
    if (ours !== theirs) return "conflict";
    matched = true;
  }
  return matched ? "match" : "unrelated";
}

function isPast(iso: string | null, now: Date): boolean {
  if (iso === null) return false;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms <= now.getTime();
}

function applyApproved(payment: PaymentRecord, effect: WebhookEffect, now: Date): WebhookApplication {
  // There is no confirmation flag for approval; once the record is past "created" the event is old news.
  if (payment.status !== "created") return unchanged(payment);
  if (effect.amountMinor !== payment.amountMinor) {
    return mismatch(payment, effect, "the approved order amount differs from the contract price on record", now);
  }
  return advance(
    payment,
    effect,
    {
      to: "approved",
      flag: null,
      patch: { lastError: null },
      notice: "PayPal webhook: the payer approved the order",
      stateEvent: { type: "payment.approved", title: "The payer approved the order in PayPal" },
    },
    now,
  );
}

/** PayPal's word for an authorization that holds funds. Absent on older payloads, which only ever described held funds. */
const HELD_AUTHORIZATION_STATUS = "CREATED";

function applyAuthorized(payment: PaymentRecord, effect: WebhookEffect, bound: boolean, now: Date): WebhookApplication {
  switch (payment.status) {
    case "none":
      // A reservation with no order id yet: only an event that carries this contract's own
      // binding can be the answer to the create-order call PACT never heard back from.
      if (!bound || effect.orderId === null) return mismatch(payment, effect, "PACT has no order on record for this payment", now);
      return adoptAuthorization(payment, effect, { orderId: effect.orderId }, now);
    case "created":
    case "approved":
      return adoptAuthorization(payment, effect, {}, now);
    case "authorized":
    case "captured":
    case "voided":
    case "expired":
    case "failed":
      if (payment.authorizedMinor > 0 && effect.amountMinor !== payment.authorizedMinor) {
        return mismatch(payment, effect, "the authorized amount differs from the amount on record", now);
      }
      return confirm(payment, effect, "authorized", {}, "PayPal webhook confirmed the authorization", now);
    default:
      return assertNever(payment.status);
  }
}

/**
 * PayPal reports an authorization the record does not have yet. Funds are only held by one that
 * is CREATED: a PENDING one is still under review (the orchestrator treats the same answer as
 * "no funds are held yet"), and a denied or voided one never will be.
 */
function adoptAuthorization(payment: PaymentRecord, effect: WebhookEffect, extra: RecordPatch, now: Date): WebhookApplication {
  const { authorizationId, amountMinor } = effect;
  if (authorizationId === null) return mismatch(payment, effect, "it carries no authorization id", now);
  if (amountMinor === null || amountMinor !== payment.amountMinor) {
    return mismatch(payment, effect, "the authorized amount differs from the contract price on record", now);
  }
  const status = effect.resourceStatus ?? HELD_AUTHORIZATION_STATUS;
  if (status === "PENDING") {
    return unchanged(payment, [
      auditEvent(now, "payment.webhook", "PayPal webhook: an authorization was created but is still under review — no funds are held yet", payment, effect, {
        resourceStatus: status,
      }),
    ]);
  }
  if (status !== HELD_AUTHORIZATION_STATUS) {
    return mismatch(payment, effect, `PayPal reports the authorization as ${status.toLowerCase()}, which holds no funds`, now);
  }
  return advance(
    payment,
    effect,
    {
      to: "authorized",
      flag: "authorized",
      patch: {
        ...extra,
        authorizationId,
        authorizedMinor: amountMinor,
        // Without it the record could not say when the hold lapses, and reconciliation would report a difference.
        authorizationExpiresAt: effect.expiresAt ?? payment.authorizationExpiresAt,
        approveUrl: null,
        lastError: null,
      },
      notice: "PayPal webhook: an authorization was created for the order",
      stateEvent: {
        type: "payment.authorized",
        title: `PayPal authorized ${formatMoney(amountMinor)} — the funds are held, not captured`,
      },
    },
    now,
  );
}

function applyCaptured(payment: PaymentRecord, effect: WebhookEffect, now: Date): WebhookApplication {
  const { amountMinor, captureId } = effect;
  switch (payment.status) {
    case "authorized": {
      if (amountMinor === null || amountMinor === 0 || amountMinor > payment.authorizedMinor) {
        return mismatch(payment, effect, "the captured amount is not within the authorized amount on record", now);
      }
      return advance(
        payment,
        effect,
        {
          to: "captured",
          flag: "captured",
          patch: { captureId: captureId ?? payment.captureId, capturedMinor: amountMinor, lastError: null },
          notice: "PayPal webhook: the capture completed",
          stateEvent: { type: "payment.captured", title: `PayPal captured ${formatMoney(amountMinor)} — the seller is paid` },
        },
        now,
      );
    }
    case "captured":
      if (amountMinor !== payment.capturedMinor) {
        return mismatch(payment, effect, "the captured amount differs from the amount on record", now);
      }
      // A capture adopted after a crash has no id on record yet; PayPal's confirmation supplies it.
      return confirm(
        payment,
        effect,
        "captured",
        payment.captureId === null && captureId !== null ? { captureId } : {},
        "PayPal webhook confirmed the capture",
        now,
      );
    case "none":
    case "created":
    case "approved":
    case "voided":
    case "expired":
    case "failed":
      return mismatch(payment, effect, `PayPal reports a completed capture, but PACT records the payment as ${payment.status}`, now);
    default:
      return assertNever(payment.status);
  }
}

function applyCapturePending(payment: PaymentRecord, effect: WebhookEffect, now: Date): WebhookApplication {
  if (payment.status !== "authorized") return unchanged(payment);
  // Informational: the funds are still only authorized, which is what the record already says.
  return unchanged(payment, [auditEvent(now, "payment.webhook", "PayPal webhook: the capture is pending — not paid yet", payment, effect)]);
}

function applyCaptureDenied(payment: PaymentRecord, effect: WebhookEffect, now: Date): WebhookApplication {
  switch (payment.status) {
    case "authorized":
      return advance(
        payment,
        effect,
        {
          to: "failed",
          flag: null,
          patch: {
            captureId: effect.captureId ?? payment.captureId,
            lastError: {
              issue: "CAPTURE_DENIED",
              message: "PayPal denied the capture; the seller was not paid.",
              debugId: null,
              at: now.toISOString(),
            },
          },
          notice: "PayPal webhook: the capture was denied",
          stateEvent: { type: "payment.failed", title: "Payment failed: PayPal denied the capture (CAPTURE_DENIED)" },
        },
        now,
      );
    case "captured":
      return mismatch(payment, effect, "PayPal reports the capture as denied, but PACT records it as captured", now);
    case "none":
    case "created":
    case "approved":
    case "voided":
    case "expired":
    case "failed":
      return unchanged(payment);
    default:
      return assertNever(payment.status);
  }
}

function applyVoided(payment: PaymentRecord, effect: WebhookEffect, now: Date): WebhookApplication {
  switch (payment.status) {
    case "authorized": {
      // PayPal sends the same event for a void and for an authorization that ran out of time.
      const expired = isPast(payment.authorizationExpiresAt, now);
      const held = formatMoney(payment.authorizedMinor);
      return advance(
        payment,
        effect,
        {
          to: expired ? "expired" : "voided",
          flag: "voided",
          patch: { lastError: null },
          notice: "PayPal webhook: the authorization was released",
          stateEvent: expired
            ? { type: "payment.expired", title: `The ${held} authorization expired at PayPal — nothing was captured` }
            : { type: "payment.voided", title: `Authorization voided at PayPal — ${held} released back to the payer` },
        },
        now,
      );
    }
    case "voided":
    case "expired":
    case "failed":
      return confirm(payment, effect, "voided", {}, "PayPal webhook confirmed the authorization is released", now);
    case "captured":
      // After a partial final capture PayPal releases the remainder; that is not a contradiction.
      if (payment.capturedMinor < payment.authorizedMinor) return unchanged(payment);
      return mismatch(payment, effect, "PayPal reports the authorization as voided, but PACT records it as fully captured", now);
    case "none":
    case "created":
    case "approved":
      return unchanged(payment);
    default:
      return assertNever(payment.status);
  }
}

function applyRefunded(payment: PaymentRecord, effect: WebhookEffect, now: Date): WebhookApplication {
  if (payment.status !== "captured") {
    return mismatch(payment, effect, `PayPal reports a refund or reversal, but PACT records the payment as ${payment.status}`, now);
  }
  // PACT has no refund state: the capture happened and stays on record. The refund is made visible, not applied.
  const amount = effect.amountMinor === null ? "funds" : formatMoney(effect.amountMinor);
  return unchanged(payment, [
    auditEvent(now, "payment.webhook", `PayPal webhook: ${amount} of the captured payment was refunded or reversed`, payment, effect),
  ]);
}

/**
 * Fold a verified webhook effect into a payment record. Pure: returns a new record (or the same
 * one when nothing changed), the audit events to append, and whether the record must be saved.
 */
export function applyWebhookEffect(
  payment: PaymentRecord,
  effect: WebhookEffect,
  now: Date,
  options: {
    /**
     * The caller has checked that the event carries this deal's contract binding (custom_id with
     * the terms hash, invoice_id with the contract id). It lets an event reach a payment that
     * holds no PayPal id to match on yet; it never overrides ids that disagree.
     */
    boundToContract?: boolean;
  } = {},
): WebhookApplication {
  if (effect.kind === "ignored") return unchanged(payment);
  const bound = options.boundToContract === true;
  const relation = relate(payment, effect);
  if (relation === "conflict") return mismatch(payment, effect, "it names different PayPal ids than this payment", now);
  if (relation === "unrelated" && !bound) return mismatch(payment, effect, "it does not reference this payment's PayPal ids", now);
  switch (effect.kind) {
    case "approved":
      return applyApproved(payment, effect, now);
    case "authorized":
      return applyAuthorized(payment, effect, bound, now);
    case "captured":
      return applyCaptured(payment, effect, now);
    case "capture_pending":
      return applyCapturePending(payment, effect, now);
    case "capture_denied":
      return applyCaptureDenied(payment, effect, now);
    case "voided":
      return applyVoided(payment, effect, now);
    case "refunded":
      return applyRefunded(payment, effect, now);
    default:
      return assertNever(effect.kind);
  }
}

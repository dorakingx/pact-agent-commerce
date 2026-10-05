/** PayPal webhook deliveries, deduplicated on PayPal's event id. */
import "server-only";
import { eq } from "drizzle-orm";
import type { WebhookVerification } from "../../payments/types";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { webhookEvents, type WebhookEventRow } from "../schema";
import { toIsoUtc } from "../time";

export interface WebhookEventInput {
  /** PayPal's event id ("WH-…"): the deduplication key. */
  id: string;
  eventType: string;
  /** Id of the PayPal resource the event is about (order, authorization or capture). */
  resourceId: string | null;
  /** Set when the deal is already known at receipt; otherwise markWebhookProcessed links it later. */
  dealId?: string | null;
  verified: boolean;
  verificationMethod: WebhookVerification["method"];
  payload: Record<string, unknown>;
  /** Defaults to the current time. */
  receivedAt?: string;
}

export interface WebhookRecordResult {
  /** True when this is the first delivery of the event. */
  inserted: boolean;
  /**
   * Whether an earlier delivery was fully processed. PayPal retries until it gets a 2xx, so a
   * redelivery with `inserted: false, processed: false` means the first attempt died half-way
   * and the event still needs handling.
   */
  processed: boolean;
}

/** Records a delivery. ON CONFLICT DO NOTHING keeps a duplicate from aborting a surrounding transaction. */
export function recordWebhookEvent(db: Db, event: WebhookEventInput): Promise<WebhookRecordResult> {
  return dbCall("recordWebhookEvent", async () => {
    const inserted = await db
      .insert(webhookEvents)
      .values({
        id: event.id,
        eventType: event.eventType,
        resourceId: event.resourceId,
        dealId: event.dealId ?? null,
        verified: event.verified,
        verificationMethod: event.verificationMethod,
        payload: event.payload,
        receivedAt: toIsoUtc(event.receivedAt ?? new Date().toISOString()),
      })
      .onConflictDoNothing({ target: webhookEvents.id })
      .returning({ id: webhookEvents.id });
    if (inserted.length > 0) return { inserted: true, processed: false };

    const [existing] = await db
      .select({ processed: webhookEvents.processed })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, event.id))
      .limit(1);
    return { inserted: false, processed: existing?.processed ?? false };
  });
}

/** Marks the event handled and, when it could be correlated, links it to its deal. */
export function markWebhookProcessed(db: Db, id: string, dealId: string | null): Promise<void> {
  return dbCall("markWebhookProcessed", async () => {
    await db
      .update(webhookEvents)
      .set(dealId === null ? { processed: true } : { processed: true, dealId })
      .where(eq(webhookEvents.id, id));
  });
}

export function getWebhookEvent(db: Db, id: string): Promise<WebhookEventRow | null> {
  return dbCall("getWebhookEvent", async () => {
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id)).limit(1);
    return row ? { ...row, receivedAt: toIsoUtc(row.receivedAt) } : null;
  });
}

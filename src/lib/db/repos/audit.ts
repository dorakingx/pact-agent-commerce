/**
 * The audit trail: append-only rows whose order and integrity are protected by a per-deal
 * sequence and a hash chain. Hashing lives in the audit module; this file must only guarantee
 * that an event is read back exactly as it was written.
 */
import "server-only";
import { asc, desc, eq } from "drizzle-orm";
import { AuditEventSchema, type AuditEvent } from "../../domain/schemas";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { auditEvents, type AuditEventRow } from "../schema";
import { isCanonicalIsoUtc, toIsoUtc } from "../time";
import { InvalidRecordError, parseForWrite, parseStored } from "../validation";

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return parseStored(
    AuditEventSchema,
    {
      id: row.id,
      dealId: row.dealId,
      seq: row.seq,
      at: toIsoUtc(row.at),
      actor: row.actor,
      type: row.type,
      title: row.title,
      detail: row.detail,
      data: row.data,
      prevHash: row.prevHash,
      hash: row.hash,
    },
    `audit event ${row.seq} of deal ${row.dealId}`,
  );
}

/**
 * Appends an event. The unique (deal_id, seq) index is what keeps the chain linear: when two
 * writers race for the same sequence number, the loser gets a DuplicateError.
 *
 * `at` must already be canonical UTC (`Date#toISOString()` form). The event's hash covers
 * `at`, and Postgres hands back an instant, not the original text — "…T10:00:00+09:00" or
 * "…T01:00:00Z" would come back as "…T01:00:00.000Z" and the chain would no longer verify.
 * Rejecting such a value here is far better than discovering a "tampered" log on read.
 */
export function insertAuditEvent(db: Db, event: AuditEvent): Promise<void> {
  return dbCall("insertAuditEvent", async () => {
    const what = `audit event ${event.seq} of deal ${event.dealId}`;
    const valid = parseForWrite(AuditEventSchema, event, what);
    if (!isCanonicalIsoUtc(valid.at)) {
      throw new InvalidRecordError(what, "write", "at: must be canonical UTC, e.g. 2026-10-06T02:05:33.123Z");
    }
    await db.insert(auditEvents).values({
      id: valid.id,
      dealId: valid.dealId,
      seq: valid.seq,
      at: valid.at,
      actor: valid.actor,
      type: valid.type,
      title: valid.title,
      detail: valid.detail,
      data: valid.data,
      prevHash: valid.prevHash,
      hash: valid.hash,
    });
  });
}

/** Events in chain order. */
export function listAuditEvents(db: Db, dealId: string): Promise<AuditEvent[]> {
  return dbCall("listAuditEvents", async () => {
    const rows = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.dealId, dealId))
      .orderBy(asc(auditEvents.seq));
    return rows.map(toAuditEvent);
  });
}

/** The chain head: what the next event must link to. Null for a deal with no events yet. */
export function getLastAuditEvent(db: Db, dealId: string): Promise<Pick<AuditEvent, "seq" | "hash"> | null> {
  return dbCall("getLastAuditEvent", async () => {
    const [row] = await db
      .select({ seq: auditEvents.seq, hash: auditEvents.hash })
      .from(auditEvents)
      .where(eq(auditEvents.dealId, dealId))
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    return row ?? null;
  });
}

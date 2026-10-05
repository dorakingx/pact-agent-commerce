/**
 * Appending to a deal's hash-chained audit trail.
 *
 * Hashing and chain verification live in the domain (../domain/audit.ts) and storage in the
 * repository; this file joins the two: it reads the chain head, links the new events to it and
 * writes them, inside the transaction of the step they describe — so an event exists exactly
 * when the change it records does.
 */
import "server-only";
import { DuplicateError, getLastAuditEvent, insertAuditEvent, withTransaction, type Db } from "../db";
import { buildAuditEvent } from "../domain/audit";
import { newId } from "../domain/ids";
import type { AuditEvent, AuditEventInput, AuditEventType } from "../domain/schemas";

async function appendToHead(tx: Db, dealId: string, inputs: readonly AuditEventInput[], now: Date): Promise<AuditEvent[]> {
  let head = await getLastAuditEvent(tx, dealId);
  const appended: AuditEvent[] = [];
  for (const input of inputs) {
    const event = buildAuditEvent(head, dealId, input, { id: newId("evt"), now });
    await insertAuditEvent(tx, event);
    appended.push(event);
    head = event;
  }
  return appended;
}

/**
 * Append events to the deal's chain, in order, and return them as stored.
 *
 * Call it with the handle of the transaction that also writes the change the events describe.
 * The events are written under a savepoint: if another writer took the next sequence number
 * first (the unique index on (deal, seq) arbitrates), only the savepoint is rolled back, the
 * new head is read and the events are linked to it instead. One retry is enough for the single
 * concurrent writer the per-deal lease can leave; a second collision is reported to the caller.
 */
export async function appendAudit(tx: Db, dealId: string, inputs: AuditEventInput[], now: Date): Promise<AuditEvent[]> {
  if (inputs.length === 0) return [];
  try {
    return await withTransaction(tx, (savepoint) => appendToHead(savepoint, dealId, inputs, now));
  } catch (error) {
    if (!(error instanceof DuplicateError)) throw error;
    return withTransaction(tx, (savepoint) => appendToHead(savepoint, dealId, inputs, now));
  }
}

/** True when the trail already carries an event of this type with this exact headline. */
export function hasAuditEvent(audit: readonly AuditEvent[], type: AuditEventType, title: string): boolean {
  return audit.some((event) => event.type === type && event.title === title);
}

/**
 * The events the trail does not carry yet (same type and headline). Used when a step is retried
 * without moving the deal on, so a problem that persists is recorded once, not once per attempt.
 */
export function withoutRecorded(audit: readonly AuditEvent[], inputs: readonly AuditEventInput[]): AuditEventInput[] {
  const fresh: AuditEventInput[] = [];
  for (const input of inputs) {
    const repeated = fresh.some((kept) => kept.type === input.type && kept.title === input.title);
    if (!repeated && !hasAuditEvent(audit, input.type, input.title)) fresh.push(input);
  }
  return fresh;
}

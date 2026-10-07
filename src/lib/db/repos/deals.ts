/**
 * Deals: the aggregate root. Storage only — which status may follow which, and what a step
 * does, is decided by the service layer; this file provides the two concurrency primitives it
 * builds on (optimistic `version` and the step lease).
 */
import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CategorySchema,
  HumanDecisionSchema,
  MandateSchema,
  NegotiationStatusSchema,
  PolicyEvaluationSchema,
  TermsSchema,
  type AuditEventType,
} from "../../domain/schemas";
import { DealStatusSchema, type PaymentStatus } from "../../domain/status";
import type { Db } from "../client";
import { dbCall } from "../errors";
import { auditEvents, deals, payments, type DealInsert, type DealRow } from "../schema";
import { toIsoUtc, toIsoUtcOrNull } from "../time";
import { parseForWrite, parseStored } from "../validation";

const DEAL_TIMESTAMP_KEYS = ["deadline", "lockedUntil", "createdAt", "updatedAt"] as const;
type DealTimestamps = Pick<Partial<DealInsert>, (typeof DEAL_TIMESTAMP_KEYS)[number]>;

/** Payment states in which money is held or has moved, i.e. that count towards spend. */
const SPEND_STATUSES = ["authorized", "captured"] as const satisfies readonly PaymentStatus[];
const AUTHORIZED_EVENT: AuditEventType = "payment.authorized";

const StoredCountSchema = z.number().int().min(0);

/**
 * The deal columns that carry a domain value. Text and JSONB columns have no shape of their own,
 * so these are checked on every write and again on every read, like every other record.
 */
const DealDomainColumnsSchema = z.object({
  status: DealStatusSchema,
  category: CategorySchema.nullable(),
  mandate: MandateSchema.nullable(),
  negotiationStatus: NegotiationStatusSchema,
  agreedTerms: TermsSchema.nullable(),
  policyEvaluation: PolicyEvaluationSchema.nullable(),
  humanDecision: HumanDecisionSchema.nullable(),
  /** Integer minor units. A float must never reach a money column. */
  priceMinor: StoredCountSchema.nullable(),
  revisionLimit: StoredCountSchema.nullable(),
  revisionsUsed: StoredCountSchema,
});
/** For writes: only the columns the caller supplied are checked. */
const SuppliedDealColumnsSchema = DealDomainColumnsSchema.partial();

/** Validation only: the values are stored exactly as supplied. */
function assertValidForWrite(values: Partial<DealInsert>, what: string): void {
  parseForWrite(SuppliedDealColumnsSchema, values, what);
}

export function toDealRow(row: DealRow): DealRow {
  parseStored(DealDomainColumnsSchema, row, `deal ${row.id}`);
  return {
    ...row,
    deadline: toIsoUtcOrNull(row.deadline),
    lockedUntil: toIsoUtcOrNull(row.lockedUntil),
    createdAt: toIsoUtc(row.createdAt),
    updatedAt: toIsoUtc(row.updatedAt),
  };
}

/** Canonical UTC for whichever timestamp columns the caller supplied; null and absent are left alone. */
function isoTimestamps(values: Partial<DealInsert>): DealTimestamps {
  const out: DealTimestamps = {};
  for (const key of DEAL_TIMESTAMP_KEYS) {
    const value = values[key];
    if (typeof value === "string") out[key] = toIsoUtc(value);
  }
  return out;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be a positive integer, received ${limit}`);
  }
}

/**
 * Throws DuplicateError when the id or the human-friendly code (constraint "deals_code_idx") is
 * taken, and InvalidRecordError when a domain column (status, category, mandate, agreed terms,
 * policy evaluation, human decision, amounts) does not hold a valid domain value.
 */
export function insertDeal(db: Db, row: DealInsert): Promise<DealRow> {
  return dbCall("insertDeal", async () => {
    assertValidForWrite(row, `deal ${row.id}`);
    const [inserted] = await db
      .insert(deals)
      .values({ ...row, ...isoTimestamps(row) })
      .returning();
    return toDealRow(inserted);
  });
}

export function getDeal(db: Db, id: string): Promise<DealRow | null> {
  return dbCall("getDeal", async () => {
    const [row] = await db.select().from(deals).where(eq(deals.id, id)).limit(1);
    return row ? toDealRow(row) : null;
  });
}

export function getDealByCode(db: Db, code: string): Promise<DealRow | null> {
  return dbCall("getDealByCode", async () => {
    const [row] = await db.select().from(deals).where(eq(deals.code, code)).limit(1);
    return row ? toDealRow(row) : null;
  });
}

/** Newest first. */
export function listDealsByOwner(db: Db, owner: string, limit: number): Promise<DealRow[]> {
  return listDealsForOwners(db, [owner], limit);
}

/** Newest first across all the given owners (e.g. the browser session plus "system" showcase deals). */
export function listDealsForOwners(db: Db, owners: string[], limit: number): Promise<DealRow[]> {
  return dbCall("listDealsForOwners", async () => {
    assertLimit(limit);
    if (owners.length === 0) return [];
    const rows = await db
      .select()
      .from(deals)
      .where(inArray(deals.owner, owners))
      // The id tie-break keeps the order deterministic when deals share a creation instant.
      .orderBy(desc(deals.createdAt), desc(deals.id))
      .limit(limit);
    return rows.map(toDealRow);
  });
}

/**
 * Optimistic update: applies `patch` only if the row is still at `expectedVersion`, then bumps
 * the version. Returns null when another writer got there first (or the deal does not exist).
 * `id` and `version` in the patch are ignored; `updatedAt` defaults to the current time.
 * Throws InvalidRecordError, changing nothing, when the patch holds an invalid domain value.
 */
export function updateDeal(
  db: Db,
  id: string,
  expectedVersion: number,
  patch: Partial<DealInsert>,
): Promise<DealRow | null> {
  return dbCall("updateDeal", async () => {
    const changes: Partial<DealInsert> = { ...patch };
    // The primary key is immutable and the version is owned by this function.
    delete changes.id;
    delete changes.version;
    assertValidForWrite(changes, `deal ${id}`);
    const [updated] = await db
      .update(deals)
      .set({
        ...changes,
        ...isoTimestamps(changes),
        updatedAt: toIsoUtc(changes.updatedAt ?? new Date().toISOString()),
        version: expectedVersion + 1,
      })
      .where(and(eq(deals.id, id), eq(deals.version, expectedVersion)))
      .returning();
    return updated ? toDealRow(updated) : null;
  });
}

/**
 * Takes the step lease in a single atomic statement. Returns the deal when the lease was free,
 * had expired, or is already held by `lockId` (renewal); null when another holder has it or the
 * deal does not exist. Deliberately leaves `version` and `updatedAt` alone so the holder's
 * subsequent optimistic update still matches.
 */
export function acquireDealLease(
  db: Db,
  id: string,
  lockId: string,
  ttlSeconds: number,
  now: Date,
): Promise<DealRow | null> {
  return dbCall("acquireDealLease", async () => {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError(`ttlSeconds must be a positive number, received ${ttlSeconds}`);
    }
    const nowIso = now.toISOString();
    const [leased] = await db
      .update(deals)
      .set({ lockId, lockedUntil: new Date(now.getTime() + ttlSeconds * 1000).toISOString() })
      .where(
        and(eq(deals.id, id), or(isNull(deals.lockedUntil), lt(deals.lockedUntil, nowIso), eq(deals.lockId, lockId))),
      )
      .returning();
    return leased ? toDealRow(leased) : null;
  });
}

/** Releases the lease only if `lockId` still owns it; a lease that expired and was re-taken is left alone. */
export function releaseDealLease(db: Db, id: string, lockId: string): Promise<void> {
  return dbCall("releaseDealLease", async () => {
    await db
      .update(deals)
      .set({ lockId: null, lockedUntil: null })
      .where(and(eq(deals.id, id), eq(deals.lockId, lockId)));
  });
}

/**
 * Deals in one of `statuses` that nothing has touched since `updatedBefore` and that no step
 * holds a lease on, oldest first. For the system driver: a deal whose owner's browser is
 * stepping it is updated every few seconds and never shows up here.
 */
export function listStalledDealIds(
  db: Db,
  statuses: readonly DealRow["status"][],
  updatedBefore: Date,
  now: Date,
  limit: number,
): Promise<string[]> {
  return dbCall("listStalledDealIds", async () => {
    if (statuses.length === 0) return [];
    const rows = await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          inArray(deals.status, [...statuses]),
          lt(deals.updatedAt, updatedBefore.toISOString()),
          or(isNull(deals.lockedUntil), lt(deals.lockedUntil, now.toISOString())),
        ),
      )
      .orderBy(asc(deals.updatedAt), asc(deals.id))
      .limit(Math.max(1, Math.trunc(limit)));
    return rows.map((row) => row.id);
  });
}

/**
 * Total authorized by the owner's deals since `sinceIso` (the policy engine's "spent today").
 * Counts payments that are currently authorized or captured; voided and expired holds have
 * been released and do not count.
 *
 * A payment's authorization instant is the time of its "payment.authorized" audit event. When
 * that event is missing, the payment's last update is used instead: that can only place the
 * authorization later than it really was, so spend is over- rather than under-counted.
 */
export function sumAuthorizedSince(db: Db, owner: string, sinceIso: string): Promise<number> {
  return dbCall("sumAuthorizedSince", async () => {
    const authorizedAt = sql`coalesce((
      select min(${auditEvents.at}) from ${auditEvents}
      where ${auditEvents.dealId} = ${payments.dealId} and ${auditEvents.type} = ${AUTHORIZED_EVENT}
    ), ${payments.updatedAt})`;
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${payments.authorizedMinor}), 0)`.mapWith(Number) })
      .from(payments)
      .innerJoin(deals, eq(deals.id, payments.dealId))
      .where(
        and(
          eq(deals.owner, owner),
          inArray(payments.status, SPEND_STATUSES),
          sql`${authorizedAt} >= ${toIsoUtc(sinceIso)}::timestamptz`,
        ),
      );
    return row.total;
  });
}

export function countDealsCreatedSince(db: Db, owner: string, sinceIso: string): Promise<number> {
  return dbCall("countDealsCreatedSince", () =>
    db.$count(deals, and(eq(deals.owner, owner), gte(deals.createdAt, toIsoUtc(sinceIso)))),
  );
}

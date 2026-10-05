import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireDealLease,
  closeDb,
  countDealsCreatedSince,
  createTestDb,
  DuplicateError,
  getDeal,
  getDealByCode,
  insertAuditEvent,
  insertDeal,
  InvalidRecordError,
  listDealsByOwner,
  listDealsForOwners,
  releaseDealLease,
  sumAuthorizedSince,
  updateDeal,
  upsertPayment,
  type Db,
  type DealInsert,
} from "@/lib/db";
import { deals } from "@/lib/db/schema";
import { auditFixture, dealFixture, paymentFixture, uniqueId } from "@/lib/db/test-fixtures";
import type { Mandate } from "@/lib/domain/schemas";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const MANDATE: Mandate = {
  summary: "Three launch illustrations",
  category: "illustration",
  deliverable: { kind: "illustration", count: 3, aspectRatios: ["16:9", "1:1"], subject: "Product launch", style: null },
  minCount: 3,
  budgetMinor: 12_000,
  deadline: "2026-10-08T09:00:00.000Z",
  revisionsWanted: 1,
  minRevisions: 0,
  notes: ["Friendly, not corporate"],
};

describe("deal repository", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(db);
  });

  describe("create and read", () => {
    it("inserts a deal and returns it with column defaults applied", async () => {
      const before = Date.now();
      const deal = await insertDeal(db, dealFixture());

      expect(deal).toMatchObject({
        owner: "session-a",
        status: "negotiating",
        negotiationStatus: "open",
        revisionsUsed: 0,
        aiDegraded: false,
        version: 0,
        mandate: null,
        deadline: null,
        lockId: null,
        lockedUntil: null,
      });
      expect(deal.createdAt).toMatch(ISO_UTC);
      expect(deal.updatedAt).toMatch(ISO_UTC);
      expect(Math.abs(new Date(deal.createdAt).getTime() - before)).toBeLessThan(60_000);
    });

    it("normalises every timestamp to ISO-8601 UTC, whatever offset was written", async () => {
      const inserted = await insertDeal(
        db,
        dealFixture({
          deadline: "2026-10-08T18:00:00+09:00",
          createdAt: "2026-10-06T02:05:33.123456Z",
          updatedAt: "2026-10-05T21:35:33.5-04:30",
        }),
      );
      const expected = {
        deadline: "2026-10-08T09:00:00.000Z",
        createdAt: "2026-10-06T02:05:33.123Z",
        updatedAt: "2026-10-06T02:05:33.500Z",
      };

      expect(inserted).toMatchObject(expected);
      expect(await getDeal(db, inserted.id)).toMatchObject(expected);
      expect(await getDealByCode(db, inserted.code)).toMatchObject(expected);
    });

    it("round-trips JSONB documents unchanged", async () => {
      const terms = { priceMinor: 10_500, deadline: "2026-10-08T09:00:00.000Z", revisionLimit: 1, count: 3 };
      const inserted = await insertDeal(db, dealFixture({ mandate: MANDATE, agreedTerms: terms, priceMinor: 10_500 }));

      const read = await getDeal(db, inserted.id);
      expect(read?.mandate).toEqual(MANDATE);
      expect(read?.agreedTerms).toEqual(terms);
      expect(read?.priceMinor).toBe(10_500);
    });

    it("returns null for a deal that does not exist", async () => {
      expect(await getDeal(db, "deal_missing")).toBeNull();
      expect(await getDealByCode(db, "PACT-MISSING")).toBeNull();
    });

    it("rejects a duplicate id or code with a DuplicateError naming the constraint", async () => {
      const existing = await insertDeal(db, dealFixture());

      await expect(insertDeal(db, dealFixture({ id: existing.id }))).rejects.toBeInstanceOf(DuplicateError);
      await expect(insertDeal(db, dealFixture({ code: existing.code }))).rejects.toMatchObject({
        name: "DuplicateError",
        constraint: "deals_code_idx",
        code: "23505",
      });
    });

    it("never leaks SQL or bound parameters through an error message", async () => {
      const existing = await insertDeal(db, dealFixture({ intent: "confidential-intent-text" }));

      const error = await insertDeal(db, dealFixture({ id: existing.id, intent: "confidential-intent-text" })).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(DuplicateError);
      expect((error as Error).message).not.toMatch(/insert into|confidential-intent-text/i);
    });
  });

  describe("domain columns", () => {
    /** A value TypeScript would refuse, as it could arrive from untyped code or a bad cast. */
    const unknownStatus = "shipped" as DealInsert["status"];

    it("refuses to insert a status, category or document that is not a domain value", async () => {
      await expect(insertDeal(db, dealFixture({ status: unknownStatus }))).rejects.toBeInstanceOf(InvalidRecordError);
      await expect(insertDeal(db, dealFixture({ category: "weapons" as DealInsert["category"] }))).rejects.toBeInstanceOf(
        InvalidRecordError,
      );
      // Money is integer minor units: a float budget must never be stored.
      const floatBudget = insertDeal(db, dealFixture({ mandate: { ...MANDATE, budgetMinor: 120.5 } }));
      await expect(floatBudget).rejects.toMatchObject({ name: "InvalidRecordError", direction: "write" });
      await expect(insertDeal(db, dealFixture({ priceMinor: 10.5 }))).rejects.toBeInstanceOf(InvalidRecordError);
    });

    it("refuses an invalid update and leaves the row and its version untouched", async () => {
      const deal = await insertDeal(db, dealFixture());

      await expect(updateDeal(db, deal.id, 0, { status: unknownStatus })).rejects.toBeInstanceOf(InvalidRecordError);
      const badDecision = { kind: "release_partial" as const, percent: 150, reason: null, decidedAt: "2026-10-06T03:00:00.000Z" };
      await expect(updateDeal(db, deal.id, 0, { humanDecision: badDecision })).rejects.toBeInstanceOf(InvalidRecordError);

      expect(await getDeal(db, deal.id)).toEqual(deal);
    });

    it("does not report the offending values, only where the problem is", async () => {
      const error = await insertDeal(db, dealFixture({ mandate: { ...MANDATE, summary: "x" } })).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(InvalidRecordError);
      expect((error as Error).message).toContain("mandate.summary");
      expect((error as Error).message).not.toContain(MANDATE.notes[0]);
    });

    it("refuses to hand out a row that was corrupted behind the repository's back", async () => {
      const deal = await insertDeal(db, dealFixture());
      await db.update(deals).set({ status: unknownStatus }).where(eq(deals.id, deal.id));

      await expect(getDeal(db, deal.id)).rejects.toMatchObject({ name: "InvalidRecordError", direction: "read" });
      await expect(listDealsByOwner(db, deal.owner, 500)).rejects.toBeInstanceOf(InvalidRecordError);
      // Put it back so the shared test database stays readable for the suites below.
      await db.update(deals).set({ status: "negotiating" }).where(eq(deals.id, deal.id));
      expect(await getDeal(db, deal.id)).toMatchObject({ status: "negotiating" });
    });
  });

  describe("listing", () => {
    it("lists an owner's deals newest first and honours the limit", async () => {
      const owner = uniqueId("owner");
      const oldest = await insertDeal(db, dealFixture({ owner, createdAt: "2026-10-01T00:00:00.000Z" }));
      const newest = await insertDeal(db, dealFixture({ owner, createdAt: "2026-10-03T00:00:00.000Z" }));
      const middle = await insertDeal(db, dealFixture({ owner, createdAt: "2026-10-02T00:00:00.000Z" }));
      await insertDeal(db, dealFixture({ owner: uniqueId("owner") }));

      expect((await listDealsByOwner(db, owner, 10)).map((deal) => deal.id)).toEqual([newest.id, middle.id, oldest.id]);
      expect((await listDealsByOwner(db, owner, 2)).map((deal) => deal.id)).toEqual([newest.id, middle.id]);
    });

    it("merges several owners into one newest-first list", async () => {
      const session = uniqueId("owner");
      const system = uniqueId("system");
      const showcase = await insertDeal(db, dealFixture({ owner: system, createdAt: "2026-09-20T00:00:00.000Z" }));
      const mine = await insertDeal(db, dealFixture({ owner: session, createdAt: "2026-10-04T00:00:00.000Z" }));
      const newerShowcase = await insertDeal(db, dealFixture({ owner: system, createdAt: "2026-10-05T00:00:00.000Z" }));

      const listed = await listDealsForOwners(db, [session, system], 10);
      expect(listed.map((deal) => deal.id)).toEqual([newerShowcase.id, mine.id, showcase.id]);
      expect(listed[0].createdAt).toBe("2026-10-05T00:00:00.000Z");
    });

    it("returns nothing for no owners and refuses a non-positive limit", async () => {
      expect(await listDealsForOwners(db, [], 10)).toEqual([]);
      await expect(listDealsByOwner(db, "session-a", 0)).rejects.toThrow(RangeError);
    });

    it("counts the deals an owner created since a timestamp", async () => {
      const owner = uniqueId("owner");
      await insertDeal(db, dealFixture({ owner, createdAt: "2026-10-05T23:59:59.999Z" }));
      await insertDeal(db, dealFixture({ owner, createdAt: "2026-10-06T00:00:00.000Z" }));
      await insertDeal(db, dealFixture({ owner, createdAt: "2026-10-06T08:00:00.000Z" }));
      await insertDeal(db, dealFixture({ owner: uniqueId("owner"), createdAt: "2026-10-06T08:00:00.000Z" }));

      expect(await countDealsCreatedSince(db, owner, "2026-10-06T00:00:00.000Z")).toBe(2);
      // The same instant written with an offset must select the same rows.
      expect(await countDealsCreatedSince(db, owner, "2026-10-06T09:00:00+09:00")).toBe(2);
      expect(await countDealsCreatedSince(db, owner, "2026-10-07T00:00:00.000Z")).toBe(0);
    });
  });

  describe("optimistic update", () => {
    it("applies the patch, bumps the version and refreshes updatedAt", async () => {
      const deal = await insertDeal(db, dealFixture({ updatedAt: "2026-10-01T00:00:00.000Z" }));

      const updated = await updateDeal(db, deal.id, 0, {
        status: "agreed",
        negotiationStatus: "agreed",
        priceMinor: 10_500,
        deadline: "2026-10-08T18:00:00+09:00",
      });

      expect(updated).toMatchObject({
        id: deal.id,
        status: "agreed",
        negotiationStatus: "agreed",
        priceMinor: 10_500,
        deadline: "2026-10-08T09:00:00.000Z",
        version: 1,
        createdAt: deal.createdAt,
      });
      expect(new Date(updated?.updatedAt ?? 0).getTime()).toBeGreaterThan(new Date(deal.updatedAt).getTime());
      expect(await getDeal(db, deal.id)).toEqual(updated);
    });

    it("returns null and changes nothing when the version has moved", async () => {
      const deal = await insertDeal(db, dealFixture());
      const first = await updateDeal(db, deal.id, 0, { status: "agreed" });
      expect(first?.version).toBe(1);

      const stale = await updateDeal(db, deal.id, 0, { status: "negotiation_failed" });

      expect(stale).toBeNull();
      expect(await getDeal(db, deal.id)).toMatchObject({ status: "agreed", version: 1 });
    });

    it("lets exactly one of two concurrent writers win", async () => {
      const deal = await insertDeal(db, dealFixture());

      const results = await Promise.all([
        updateDeal(db, deal.id, 0, { status: "agreed" }),
        updateDeal(db, deal.id, 0, { status: "negotiation_failed" }),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect((await getDeal(db, deal.id))?.version).toBe(1);
    });

    it("ignores id and version in the patch and can clear nullable columns", async () => {
      const deal = await insertDeal(db, dealFixture({ lastError: "temporary failure" }));

      const updated = await updateDeal(db, deal.id, 0, { id: "deal_hijacked", version: 41, lastError: null });

      expect(updated).toMatchObject({ id: deal.id, version: 1, lastError: null });
      expect(await getDeal(db, "deal_hijacked")).toBeNull();
    });

    it("returns null for a deal that does not exist", async () => {
      expect(await updateDeal(db, "deal_missing", 0, { status: "agreed" })).toBeNull();
    });
  });

  describe("step lease", () => {
    const now = new Date("2026-10-06T10:00:00.000Z");
    const secondsLater = (seconds: number) => new Date(now.getTime() + seconds * 1000);

    it("grants the lease once and refuses a second holder until the TTL has passed", async () => {
      const deal = await insertDeal(db, dealFixture());

      const leased = await acquireDealLease(db, deal.id, "lock-a", 30, now);
      expect(leased).toMatchObject({ id: deal.id, lockId: "lock-a", lockedUntil: "2026-10-06T10:00:30.000Z" });

      expect(await acquireDealLease(db, deal.id, "lock-b", 30, secondsLater(10))).toBeNull();
      // Still held at the exact expiry instant; free strictly after it.
      expect(await acquireDealLease(db, deal.id, "lock-b", 30, secondsLater(30))).toBeNull();
      const taken = await acquireDealLease(db, deal.id, "lock-b", 30, secondsLater(31));
      expect(taken).toMatchObject({ lockId: "lock-b", lockedUntil: "2026-10-06T10:01:01.000Z" });
    });

    it("gives the lease to exactly one of two simultaneous requests", async () => {
      const deal = await insertDeal(db, dealFixture());

      const results = await Promise.all([
        acquireDealLease(db, deal.id, "lock-a", 30, now),
        acquireDealLease(db, deal.id, "lock-b", 30, now),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
    });

    it("does not touch version or updatedAt, so the holder's optimistic update still applies", async () => {
      const deal = await insertDeal(db, dealFixture());

      const leased = await acquireDealLease(db, deal.id, "lock-a", 30, now);
      expect(leased).toMatchObject({ version: 0, updatedAt: deal.updatedAt });

      const updated = await updateDeal(db, deal.id, leased?.version ?? -1, { status: "agreed" });
      expect(updated).toMatchObject({ status: "agreed", version: 1, lockId: "lock-a" });
    });

    it("lets the holder renew its own lease", async () => {
      const deal = await insertDeal(db, dealFixture());
      await acquireDealLease(db, deal.id, "lock-a", 30, now);

      const renewed = await acquireDealLease(db, deal.id, "lock-a", 30, secondsLater(20));

      expect(renewed).toMatchObject({ lockId: "lock-a", lockedUntil: "2026-10-06T10:00:50.000Z" });
    });

    it("is released only by its owner", async () => {
      const deal = await insertDeal(db, dealFixture());
      await acquireDealLease(db, deal.id, "lock-a", 30, now);

      await releaseDealLease(db, deal.id, "lock-b");
      expect(await getDeal(db, deal.id)).toMatchObject({ lockId: "lock-a" });
      expect(await acquireDealLease(db, deal.id, "lock-b", 30, secondsLater(1))).toBeNull();

      await releaseDealLease(db, deal.id, "lock-a");
      expect(await getDeal(db, deal.id)).toMatchObject({ lockId: null, lockedUntil: null });
      expect(await acquireDealLease(db, deal.id, "lock-b", 30, secondsLater(1))).toMatchObject({ lockId: "lock-b" });
    });

    it("returns null for a deal that does not exist and rejects a non-positive TTL", async () => {
      expect(await acquireDealLease(db, "deal_missing", "lock-a", 30, now)).toBeNull();
      await expect(acquireDealLease(db, "deal_missing", "lock-a", 0, now)).rejects.toThrow(RangeError);
    });
  });

  describe("sumAuthorizedSince", () => {
    const dayStart = "2026-10-06T00:00:00.000Z";
    const today = "2026-10-06T09:00:00.000Z";
    const yesterday = "2026-10-05T15:00:00.000Z";

    async function dealWithPayment(
      owner: string,
      payment: Parameters<typeof paymentFixture>[0],
      authorizedAt: string | null,
    ): Promise<void> {
      const deal = await insertDeal(db, dealFixture({ owner }));
      await upsertPayment(db, deal.id, paymentFixture(payment));
      if (authorizedAt) {
        await insertAuditEvent(
          db,
          auditFixture(deal.id, 1, { type: "payment.authorized", actor: "paypal", at: authorizedAt }),
        );
      }
    }

    it("sums what the owner's deals authorized since the timestamp", async () => {
      const owner = uniqueId("owner");
      // Counted: held today, and captured today.
      await dealWithPayment(owner, { status: "authorized", authorizedMinor: 10_500, updatedAt: today }, today);
      await dealWithPayment(
        owner,
        { status: "captured", authorizedMinor: 4_000, capturedMinor: 4_000, captureId: "CAP-1", updatedAt: today },
        today,
      );
      // Not counted: authorized yesterday, even though the capture touched the row today.
      await dealWithPayment(
        owner,
        { status: "captured", authorizedMinor: 70_000, capturedMinor: 70_000, updatedAt: today },
        yesterday,
      );
      // Not counted: the hold was released, the order was never authorized, or it is someone else's.
      await dealWithPayment(owner, { status: "voided", authorizedMinor: 20_000, updatedAt: today }, today);
      await dealWithPayment(owner, { status: "created", authorizedMinor: 0, authorizationId: null, updatedAt: today }, null);
      await dealWithPayment(uniqueId("owner"), { status: "authorized", authorizedMinor: 30_000, updatedAt: today }, today);

      expect(await sumAuthorizedSince(db, owner, dayStart)).toBe(14_500);
      expect(await sumAuthorizedSince(db, owner, "2026-10-05T00:00:00.000Z")).toBe(84_500);
    });

    it("falls back to the payment's last update when no authorization event was recorded", async () => {
      const owner = uniqueId("owner");
      await dealWithPayment(owner, { status: "authorized", authorizedMinor: 2_500, updatedAt: today }, null);
      await dealWithPayment(owner, { status: "authorized", authorizedMinor: 9_900, updatedAt: yesterday }, null);

      expect(await sumAuthorizedSince(db, owner, dayStart)).toBe(2_500);
    });

    it("is zero for an owner with no payments", async () => {
      expect(await sumAuthorizedSince(db, uniqueId("owner"), dayStart)).toBe(0);
    });
  });
});

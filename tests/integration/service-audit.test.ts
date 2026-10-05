/**
 * appendAudit: events are linked to the chain head that exists when they are written, inside
 * the caller's transaction, and a writer that loses the race for a sequence number links to
 * the new head instead of failing the step.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateError, closeDb, createTestDb, getDeal, insertDeal, listAuditEvents, updateDeal, withTransaction, type Db } from "@/lib/db";
import { dealFixture } from "@/lib/db/test-fixtures";
import { verifyAuditChain } from "@/lib/domain/audit";
import type { AuditEventInput } from "@/lib/domain/schemas";
import { appendAudit, hasAuditEvent, withoutRecorded } from "@/lib/services/audit-log";

/**
 * How many of the next chain-head reads answer with the head as it was one event earlier — what a
 * writer on another connection sees when a competing transaction commits between its read and its insert.
 */
const race = vi.hoisted(() => ({ staleReads: 0, reads: 0 }));
vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  const getLastAuditEvent: typeof original.getLastAuditEvent = async (db, dealId) => {
    race.reads += 1;
    const head = await original.getLastAuditEvent(db, dealId);
    if (race.staleReads === 0 || head === null) return head;
    race.staleReads -= 1;
    return { seq: head.seq - 1, hash: head.hash };
  };
  return { ...original, getLastAuditEvent };
});

const NOW = new Date("2026-10-06T05:00:00.000Z");
const note = (title: string): AuditEventInput => ({ actor: "system", type: "system.error", title });

let db: Db;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  race.staleReads = 0;
  race.reads = 0;
});

async function newDeal(): Promise<string> {
  return (await insertDeal(db, dealFixture())).id;
}

describe("appendAudit", () => {
  it("appends in order from the first event of a deal, and returns what was stored", async () => {
    const dealId = await newDeal();
    const first = await withTransaction(db, (tx) =>
      appendAudit(tx, dealId, [{ actor: "human", type: "intent.received", title: "Request received", data: { scenarioId: null } }, note("two")], NOW),
    );
    expect(first.map((event) => event.seq)).toEqual([1, 2]);
    expect(first.every((event) => /^evt_[0-9a-z]{12}$/.test(event.id))).toBe(true);
    expect(first[0]).toMatchObject({ dealId, at: NOW.toISOString(), actor: "human", detail: null, data: { scenarioId: null } });

    const later = new Date(NOW.getTime() + 60_000);
    const second = await withTransaction(db, (tx) => appendAudit(tx, dealId, [{ ...note("three"), at: "2026-10-06T14:00:30+09:00" }], later));
    // An explicit timestamp is kept as the same instant, in canonical UTC.
    expect(second[0]).toMatchObject({ seq: 3, at: "2026-10-06T05:00:30.000Z", prevHash: first[1].hash });

    const stored = await listAuditEvents(db, dealId);
    expect(stored).toEqual([...first, ...second]);
    expect(verifyAuditChain(stored)).toEqual({ valid: true, brokenAtSeq: null });
  });

  it("does nothing for an empty list", async () => {
    const dealId = await newDeal();
    expect(await withTransaction(db, (tx) => appendAudit(tx, dealId, [], NOW))).toEqual([]);
    expect(race.reads).toBe(0);
    expect(await listAuditEvents(db, dealId)).toEqual([]);
  });

  it("commits or rolls back with the transaction it is called in", async () => {
    const dealId = await newDeal();
    await expect(
      withTransaction(db, async (tx) => {
        await appendAudit(tx, dealId, [note("never stored")], NOW);
        throw new Error("the step failed after writing its audit event");
      }),
    ).rejects.toThrow("the step failed");
    expect(await listAuditEvents(db, dealId)).toEqual([]);
  });

  it("links to the new head when another writer took the next sequence number first", async () => {
    const dealId = await newDeal();
    await withTransaction(db, (tx) => appendAudit(tx, dealId, [note("one"), note("two")], NOW));

    race.staleReads = 1;
    race.reads = 0;
    const appended = await withTransaction(db, async (tx) => {
      const events = await appendAudit(tx, dealId, [note("three"), note("four")], NOW);
      // The surrounding transaction is still usable after the lost race: only a savepoint was rolled back.
      const deal = await getDeal(tx, dealId);
      await updateDeal(tx, dealId, deal?.version ?? 0, { lastError: "written after the retry" });
      return events;
    });

    expect(race.reads).toBe(2);
    expect(appended.map((event) => event.seq)).toEqual([3, 4]);
    const stored = await listAuditEvents(db, dealId);
    expect(stored.map((event) => event.title)).toEqual(["one", "two", "three", "four"]);
    expect(verifyAuditChain(stored)).toEqual({ valid: true, brokenAtSeq: null });
    expect((await getDeal(db, dealId))?.lastError).toBe("written after the retry");
  });

  it("gives up after a second collision and leaves the chain untouched", async () => {
    const dealId = await newDeal();
    await withTransaction(db, (tx) => appendAudit(tx, dealId, [note("one"), note("two")], NOW));

    race.staleReads = 2;
    await expect(withTransaction(db, (tx) => appendAudit(tx, dealId, [note("three")], NOW))).rejects.toBeInstanceOf(DuplicateError);
    const stored = await listAuditEvents(db, dealId);
    expect(stored.map((event) => event.title)).toEqual(["one", "two"]);
    expect(verifyAuditChain(stored).valid).toBe(true);
  });
});

describe("recording a persistent problem once", () => {
  it("drops events the trail already carries, and repeats within one batch", async () => {
    const dealId = await newDeal();
    const audit = await withTransaction(db, (tx) => appendAudit(tx, dealId, [note("PayPal could not be reached")], NOW));

    expect(hasAuditEvent(audit, "system.error", "PayPal could not be reached")).toBe(true);
    expect(hasAuditEvent(audit, "system.degraded", "PayPal could not be reached")).toBe(false);
    const fresh = withoutRecorded(audit, [
      note("PayPal could not be reached"),
      note("A different problem"),
      note("A different problem"),
      { actor: "system", type: "system.degraded", title: "PayPal could not be reached" },
    ]);
    expect(fresh.map((event) => `${event.type}:${event.title}`)).toEqual(["system.error:A different problem", "system.degraded:PayPal could not be reached"]);
    expect(withoutRecorded([], [])).toEqual([]);
  });
});

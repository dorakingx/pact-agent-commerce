import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createDbLedger,
  createTestDb,
  DbError,
  insertDeal,
  listPaymentOperations,
  withTransaction,
  type Db,
} from "@/lib/db";
import { dealFixture, uniqueId } from "@/lib/db/test-fixtures";
import type { PaymentLedger } from "@/lib/payments/types";

const DECLINED = { issue: "INSTRUMENT_DECLINED", message: "The instrument was declined.", debugId: "f1e2d3" };
const UNAVAILABLE = { issue: "SERVICE_UNAVAILABLE", message: "PayPal is temporarily unavailable.", debugId: null };

describe("payment idempotency ledger", () => {
  let db: Db;
  let ledger: PaymentLedger;

  beforeAll(async () => {
    db = await createTestDb();
    ledger = createDbLedger(db);
  });

  afterAll(async () => {
    await closeDb(db);
  });

  async function newOperation(kind: "capture" | "authorize" = "capture") {
    const deal = await insertDeal(db, dealFixture());
    return { key: uniqueId(`${deal.id}:${kind}`), dealId: deal.id, kind, request: { amountMinor: 10_500 } };
  }

  it("reports a key it has never seen as new and records it as started", async () => {
    const operation = await newOperation();

    expect(await ledger.begin(operation)).toEqual({ state: "new" });

    const [recorded] = await listPaymentOperations(db, operation.dealId);
    expect(recorded).toMatchObject({
      key: operation.key,
      dealId: operation.dealId,
      kind: "capture",
      status: "started",
      request: { amountMinor: 10_500 },
      response: null,
      error: null,
      attempts: 1,
    });
    expect(recorded.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("replays the stored response once an operation has succeeded", async () => {
    const operation = await newOperation();
    await ledger.begin(operation);
    await ledger.succeed(operation.key, { captureId: "CAP-1", status: "COMPLETED" });

    const replay = await ledger.begin(operation);

    expect(replay).toEqual({ state: "succeeded", response: { captureId: "CAP-1", status: "COMPLETED" } });
    expect(await ledger.begin(operation)).toEqual(replay);
    expect(await listPaymentOperations(db, operation.dealId)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("lets an operation that started but never finished be retried, counting attempts", async () => {
    const operation = await newOperation();
    await ledger.begin(operation);

    expect(await ledger.begin(operation)).toEqual({ state: "retry", attempts: 2 });
    expect(await ledger.begin(operation)).toEqual({ state: "retry", attempts: 3 });
    expect(await listPaymentOperations(db, operation.dealId)).toMatchObject([{ status: "started", attempts: 3 }]);
  });

  it("allows a retry after a retryable failure and finishes cleanly on success", async () => {
    const operation = await newOperation();
    await ledger.begin(operation);
    await ledger.fail(operation.key, UNAVAILABLE, { retryable: true });
    expect(await listPaymentOperations(db, operation.dealId)).toMatchObject([
      { status: "failed_retryable", error: UNAVAILABLE, attempts: 1 },
    ]);

    expect(await ledger.begin(operation)).toEqual({ state: "retry", attempts: 2 });
    await ledger.succeed(operation.key, { captureId: "CAP-2" });

    expect(await listPaymentOperations(db, operation.dealId)).toMatchObject([
      { status: "succeeded", response: { captureId: "CAP-2" }, error: null, attempts: 2 },
    ]);
  });

  it("reports a terminal failure and never offers a retry for it", async () => {
    const operation = await newOperation();
    await ledger.begin(operation);
    await ledger.fail(operation.key, DECLINED, { retryable: false });

    expect(await ledger.begin(operation)).toEqual({ state: "failed", error: DECLINED });
    expect(await ledger.begin(operation)).toEqual({ state: "failed", error: DECLINED });
    expect(await listPaymentOperations(db, operation.dealId)).toMatchObject([{ status: "failed", attempts: 1 }]);
  });

  it("treats exactly one of two simultaneous begins as the first attempt", async () => {
    const operation = await newOperation();

    const results = await Promise.all([ledger.begin(operation), ledger.begin(operation)]);

    expect(results.map((result) => result.state).sort()).toEqual(["new", "retry"]);
  });

  it("keeps the first recorded success: a later success or failure report cannot change it", async () => {
    const operation = await newOperation();
    await ledger.begin(operation);
    await ledger.succeed(operation.key, { captureId: "CAP-FIRST" });

    await ledger.succeed(operation.key, { captureId: "CAP-SECOND" });
    await ledger.fail(operation.key, DECLINED, { retryable: false });

    expect(await ledger.begin(operation)).toEqual({ state: "succeeded", response: { captureId: "CAP-FIRST" } });
    expect(await listPaymentOperations(db, operation.dealId)).toMatchObject([{ status: "succeeded", error: null }]);
  });

  it("refuses to reuse an idempotency key for a different deal or kind", async () => {
    const operation = await newOperation();
    await ledger.begin(operation);
    await ledger.succeed(operation.key, { captureId: "CAP-3" });
    const otherDeal = await insertDeal(db, dealFixture());

    await expect(ledger.begin({ ...operation, dealId: otherDeal.id })).rejects.toThrow(/already belongs to/);
    await expect(ledger.begin({ ...operation, kind: "void" })).rejects.toThrow(/already belongs to/);
    expect(await listPaymentOperations(db, otherDeal.id)).toEqual([]);

    // The same holds while the original operation is still in flight, and the attempt is not counted.
    const inFlight = await newOperation();
    await ledger.begin(inFlight);
    await expect(ledger.begin({ ...inFlight, dealId: otherDeal.id })).rejects.toThrow(/already belongs to/);
    expect(await listPaymentOperations(db, inFlight.dealId)).toMatchObject([{ status: "started", attempts: 1 }]);
  });

  it("rejects an outcome for a key that was never begun", async () => {
    await expect(ledger.succeed("never-begun", {})).rejects.toBeInstanceOf(DbError);
    await expect(ledger.fail("never-begun", DECLINED, { retryable: false })).rejects.toThrow(/no operation was begun/);
  });

  it("cannot record an operation for a deal that does not exist", async () => {
    await expect(
      ledger.begin({ key: uniqueId("orphan"), dealId: "deal_missing", kind: "capture", request: {} }),
    ).rejects.toMatchObject({ name: "DbError", code: "23503" });
  });

  it("lists a deal's operations oldest first", async () => {
    const deal = await insertDeal(db, dealFixture());
    for (const kind of ["create_order", "authorize", "capture"] as const) {
      await ledger.begin({ key: `${deal.id}:${kind}`, dealId: deal.id, kind, request: {} });
      // Distinct creation instants, so the order under test is unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect((await listPaymentOperations(db, deal.id)).map((operation) => operation.kind)).toEqual([
      "create_order",
      "authorize",
      "capture",
    ]);
  });

  it("loses its 'started' record if it is given a transaction that rolls back (so give it the root database)", async () => {
    const operation = await newOperation();

    await expect(
      withTransaction(db, async (tx) => {
        await createDbLedger(tx).begin(operation);
        throw new Error("step failed");
      }),
    ).rejects.toThrow("step failed");

    expect(await listPaymentOperations(db, operation.dealId)).toEqual([]);
    expect(await ledger.begin(operation)).toEqual({ state: "new" });
  });
});

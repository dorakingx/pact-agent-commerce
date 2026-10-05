import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeDb,
  createTestDb,
  DbError,
  DuplicateError,
  findDealIdByAuthorizationId,
  findDealIdByCaptureId,
  findDealIdByOrderId,
  getContractByDeal,
  getLastAuditEvent,
  getPayment,
  insertAuditEvent,
  insertContract,
  insertDeal,
  insertMove,
  insertReport,
  insertSubmission,
  InvalidRecordError,
  listAuditEvents,
  listMoves,
  listReports,
  listSubmissions,
  upsertPayment,
  withTransaction,
  type Db,
} from "@/lib/db";
import {
  auditFixture,
  contractFixture,
  dealFixture,
  moveFixture,
  paymentFixture,
  reportFixture,
  submissionFixture,
} from "@/lib/db/test-fixtures";
import type { NegotiationMove } from "@/lib/domain/schemas";

describe("record repositories", () => {
  let db: Db;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await closeDb(db);
  });

  async function newDealId(): Promise<string> {
    return (await insertDeal(db, dealFixture())).id;
  }

  describe("negotiation moves", () => {
    it("stores moves and lists them in seq order, shaped as NegotiationMove", async () => {
      const dealId = await newDealId();
      const accept = moveFixture(3, {
        action: "accept",
        terms: null,
        guardrails: [{ code: "price_above_budget", detail: "Counter was capped at the buyer's budget." }],
        source: "ai",
        model: "google/gemini-2.5-flash",
        latencyMs: 840,
      });
      await insertMove(db, dealId, moveFixture(2));
      await insertMove(db, dealId, accept);
      await insertMove(db, dealId, moveFixture(1));

      const moves = await listMoves(db, dealId);
      expect(moves).toEqual([moveFixture(1), moveFixture(2), accept]);
      expect(Object.keys(moves[0]).sort()).toEqual(Object.keys(moveFixture(1)).sort());
    });

    it("normalises createdAt to UTC", async () => {
      const dealId = await newDealId();
      await insertMove(db, dealId, moveFixture(1, { createdAt: "2026-10-06T10:00:01+09:00" }));

      expect((await listMoves(db, dealId))[0].createdAt).toBe("2026-10-06T01:00:01.000Z");
    });

    it("throws DuplicateError when the same (deal, seq) is written twice", async () => {
      const dealId = await newDealId();
      await insertMove(db, dealId, moveFixture(1));

      await expect(insertMove(db, dealId, moveFixture(1, { message: "Racing writer." }))).rejects.toBeInstanceOf(
        DuplicateError,
      );
      // The same seq on another deal is a different turn.
      await expect(insertMove(db, await newDealId(), moveFixture(1))).resolves.toBeUndefined();
      expect(await listMoves(db, dealId)).toHaveLength(1);
    });

    it("refuses a move that does not match the schema, before touching the database", async () => {
      const dealId = await newDealId();
      const invalid = { ...moveFixture(1), actor: "verifier" } as unknown as NegotiationMove;

      await expect(insertMove(db, dealId, invalid)).rejects.toBeInstanceOf(InvalidRecordError);
      expect(await listMoves(db, dealId)).toEqual([]);
    });

    it("reports a missing deal as a DbError with the foreign-key SQLSTATE", async () => {
      await expect(insertMove(db, "deal_missing", moveFixture(1))).rejects.toMatchObject({
        name: "DbError",
        code: "23503",
        operation: "insertMove",
      });
    });

    it("returns an empty list for a deal with no moves", async () => {
      expect(await listMoves(db, await newDealId())).toEqual([]);
    });
  });

  describe("contracts", () => {
    it("stores the signed contract and returns the identical document", async () => {
      const dealId = await newDealId();
      const signed = contractFixture(dealId);

      await insertContract(db, signed);

      expect(await getContractByDeal(db, dealId)).toEqual(signed);
      expect(await getContractByDeal(db, await newDealId())).toBeNull();
    });

    it("never replaces a deal's contract", async () => {
      const dealId = await newDealId();
      const original = contractFixture(dealId);
      await insertContract(db, original);

      await expect(
        insertContract(db, contractFixture(dealId, { price: { amountMinor: 1_000, currency: "USD" } })),
      ).rejects.toMatchObject({ name: "DuplicateError", constraint: "contracts_deal_idx" });
      expect(await getContractByDeal(db, dealId)).toEqual(original);
    });

    it("refuses a contract whose hash is not a SHA-256 hex digest", async () => {
      const dealId = await newDealId();

      await expect(insertContract(db, { ...contractFixture(dealId), termsHash: "not-a-hash" })).rejects.toBeInstanceOf(
        InvalidRecordError,
      );
    });
  });

  describe("payments", () => {
    it("inserts, then replaces, the deal's single payment record", async () => {
      const dealId = await newDealId();
      const created = paymentFixture({
        status: "created",
        authorizationId: null,
        authorizedMinor: 0,
        approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER",
        authorizationExpiresAt: null,
      });
      await upsertPayment(db, dealId, created);
      expect(await getPayment(db, dealId)).toEqual(created);

      const captured = {
        ...created,
        status: "captured" as const,
        authorizationId: "AUTH-9",
        captureId: "CAP-9",
        authorizedMinor: 10_500,
        capturedMinor: 10_500,
        approveUrl: null,
        authorizationExpiresAt: "2026-11-04T01:20:00.000Z",
        lastError: { issue: "INSTRUMENT_DECLINED", message: "First attempt declined", debugId: "dbg1", at: created.updatedAt },
        webhookConfirmed: { authorized: true, captured: true, voided: false },
        updatedAt: "2026-10-06T05:00:00.000Z",
      };
      await upsertPayment(db, dealId, captured);

      expect(await getPayment(db, dealId)).toEqual(captured);
    });

    it("normalises its timestamps to UTC", async () => {
      const dealId = await newDealId();
      await upsertPayment(
        db,
        dealId,
        paymentFixture({ authorizationExpiresAt: "2026-11-04T10:20:00+09:00", updatedAt: "2026-10-06T10:20:00.25+09:00" }),
      );

      expect(await getPayment(db, dealId)).toMatchObject({
        authorizationExpiresAt: "2026-11-04T01:20:00.000Z",
        updatedAt: "2026-10-06T01:20:00.250Z",
      });
    });

    it("finds the deal behind a PayPal order, authorization or capture id", async () => {
      const dealId = await newDealId();
      const payment = paymentFixture({ captureId: "CAP-LOOKUP" });
      await upsertPayment(db, dealId, payment);

      expect(await findDealIdByOrderId(db, payment.orderId ?? "")).toBe(dealId);
      expect(await findDealIdByAuthorizationId(db, payment.authorizationId ?? "")).toBe(dealId);
      expect(await findDealIdByCaptureId(db, "CAP-LOOKUP")).toBe(dealId);
      expect(await findDealIdByOrderId(db, "ORDER-UNKNOWN")).toBeNull();
      expect(await findDealIdByAuthorizationId(db, "AUTH-UNKNOWN")).toBeNull();
      expect(await findDealIdByCaptureId(db, "CAP-UNKNOWN")).toBeNull();
    });

    it("refuses to attach one PayPal order to two deals", async () => {
      const payment = paymentFixture();
      await upsertPayment(db, await newDealId(), payment);

      await expect(upsertPayment(db, await newDealId(), payment)).rejects.toMatchObject({
        name: "DuplicateError",
        constraint: "payments_order_idx",
      });
    });

    it("refuses fractional money", async () => {
      await expect(
        upsertPayment(db, await newDealId(), paymentFixture({ authorizedMinor: 104.5 })),
      ).rejects.toBeInstanceOf(InvalidRecordError);
    });

    it("loses no update when concurrent read-modify-write transactions lock the row first", async () => {
      const dealId = await newDealId();
      await upsertPayment(db, dealId, paymentFixture());
      // Two webhook handlers, each confirming a different lifecycle event of the same payment.
      const confirm = (event: "authorized" | "captured") =>
        withTransaction(db, async (tx) => {
          const current = await getPayment(tx, dealId, { forUpdate: true });
          if (!current) throw new Error("payment disappeared");
          await upsertPayment(tx, dealId, {
            ...current,
            webhookConfirmed: { ...current.webhookConfirmed, [event]: true },
          });
        });

      await Promise.all([confirm("authorized"), confirm("captured")]);

      expect((await getPayment(db, dealId))?.webhookConfirmed).toEqual({ authorized: true, captured: true, voided: false });
    });

    it("returns null when the deal has no payment", async () => {
      expect(await getPayment(db, await newDealId())).toBeNull();
    });
  });

  describe("submissions", () => {
    it("stores submissions with their artifact bodies and lists them by round", async () => {
      const dealId = await newDealId();
      const revision = submissionFixture(dealId, 2, { source: "ai", model: "openai/gpt-5-mini" });
      const first = submissionFixture(dealId, 1);
      await insertSubmission(db, revision);
      await insertSubmission(db, first);

      expect(await listSubmissions(db, dealId)).toEqual([first, revision]);
    });

    it("throws DuplicateError for a second submission in the same round", async () => {
      const dealId = await newDealId();
      await insertSubmission(db, submissionFixture(dealId, 1));

      await expect(insertSubmission(db, submissionFixture(dealId, 1))).rejects.toMatchObject({
        name: "DuplicateError",
        constraint: "submissions_deal_round_idx",
      });
      expect(await listSubmissions(db, dealId)).toHaveLength(1);
    });

    it("normalises submittedAt to UTC", async () => {
      const dealId = await newDealId();
      await insertSubmission(db, submissionFixture(dealId, 1, { submittedAt: "2026-10-06T11:30:00+09:00" }));

      expect((await listSubmissions(db, dealId))[0].submittedAt).toBe("2026-10-06T02:30:00.000Z");
    });
  });

  describe("verification reports", () => {
    it("stores reports and lists them by round", async () => {
      const dealId = await newDealId();
      const failed = reportFixture(dealId, 1, {
        decision: "revision_required",
        confidence: 0.5,
        failedRuleIds: ["R1"],
        degraded: true,
        model: "google/gemini-2.5-flash",
      });
      const passed = reportFixture(dealId, 2);
      await insertReport(db, passed);
      await insertReport(db, failed);

      expect(await listReports(db, dealId)).toEqual([failed, passed]);
    });

    it("throws DuplicateError when a round is verified twice", async () => {
      const dealId = await newDealId();
      await insertReport(db, reportFixture(dealId, 1));

      await expect(insertReport(db, reportFixture(dealId, 1, { decision: "reject" }))).rejects.toMatchObject({
        name: "DuplicateError",
        constraint: "verification_deal_round_idx",
      });
      expect((await listReports(db, dealId))[0].decision).toBe("capture_eligible");
    });

    it("keeps typical confidence values exact", async () => {
      const dealId = await newDealId();
      const confidences = [0, 0.5, 0.85, 0.92, 1];
      for (const [index, confidence] of confidences.entries()) {
        await insertReport(db, reportFixture(dealId, index + 1, { confidence }));
      }

      expect((await listReports(db, dealId)).map((report) => report.confidence)).toEqual(confidences);
    });
  });

  describe("audit events", () => {
    it("appends events and reads them back identically, in chain order", async () => {
      const dealId = await newDealId();
      const withData = auditFixture(dealId, 2, {
        actor: "payment_orchestrator",
        type: "payment.authorized",
        title: "PayPal authorized $105.00",
        detail: "Funds are held, not captured.",
        data: { orderId: "ORDER-1", amountMinor: 10_500, nested: { flags: [true, null, 1.5] } },
      });
      const withoutData = auditFixture(dealId, 1, { data: null });
      await insertAuditEvent(db, withoutData);
      await insertAuditEvent(db, withData);

      expect(await listAuditEvents(db, dealId)).toEqual([withoutData, withData]);
    });

    it("returns the chain head, or null for an empty chain", async () => {
      const dealId = await newDealId();
      expect(await getLastAuditEvent(db, dealId)).toBeNull();

      const first = auditFixture(dealId, 1);
      const second = auditFixture(dealId, 2);
      await insertAuditEvent(db, first);
      await insertAuditEvent(db, second);

      expect(await getLastAuditEvent(db, dealId)).toEqual({ seq: 2, hash: second.hash });
    });

    it("throws DuplicateError when two writers claim the same seq", async () => {
      const dealId = await newDealId();
      await insertAuditEvent(db, auditFixture(dealId, 1));

      await expect(insertAuditEvent(db, auditFixture(dealId, 1, { title: "Racing writer" }))).rejects.toMatchObject({
        name: "DuplicateError",
        constraint: "audit_deal_seq_idx",
      });
      expect(await listAuditEvents(db, dealId)).toHaveLength(1);
    });

    it("refuses a timestamp that would not read back byte-for-byte (it is part of the hash)", async () => {
      const dealId = await newDealId();

      for (const at of ["2026-10-06T10:00:00+09:00", "2026-10-06T01:00:00Z", "2026-10-06T01:00:00.123456Z"]) {
        await expect(insertAuditEvent(db, auditFixture(dealId, 1, { at }))).rejects.toBeInstanceOf(InvalidRecordError);
      }
      expect(await listAuditEvents(db, dealId)).toEqual([]);
    });

    it("refuses an event type outside the audit vocabulary", async () => {
      const dealId = await newDealId();
      const invalid = { ...auditFixture(dealId, 1), type: "payment.teleported" } as unknown as Parameters<
        typeof insertAuditEvent
      >[1];

      await expect(insertAuditEvent(db, invalid)).rejects.toBeInstanceOf(InvalidRecordError);
    });
  });

  describe("errors", () => {
    it("exposes DuplicateError as a DbError so callers can catch either", async () => {
      const dealId = await newDealId();
      await insertMove(db, dealId, moveFixture(1));

      const error = await insertMove(db, dealId, moveFixture(1)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({ operation: "insertMove", code: "23505" });
    });
  });
});

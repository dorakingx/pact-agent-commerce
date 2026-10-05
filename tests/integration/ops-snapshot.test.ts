/**
 * The operations snapshot read from a real (PGlite) database: who sees which deals, in which
 * order, that every figure agrees with the stored records, and that the whole snapshot costs a
 * fixed number of statements however many deals it contains.
 *
 * The per-column mapping rules are covered exhaustively, without a database, in
 * src/lib/services/operations.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import {
  closeDb,
  createDbSimulatedStore,
  createTestDb,
  DEAL_GRAPH_QUERY_COUNT,
  insertAuditEvent,
  insertContract,
  insertDeal,
  insertMove,
  insertReport,
  insertSubmission,
  upsertPayment,
  type Db,
  type DealInsert,
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
import type { AuditEvent, VerificationReport } from "@/lib/domain/schemas";
import { SimulatedProvider } from "@/lib/payments";
import type { PaymentRecord } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { OPS_DEAL_LIMIT, getOpsSnapshot } from "@/lib/services/operations";
import { SYSTEM_OWNER } from "@/lib/services/session";

const NOW = new Date("2026-10-06T05:00:00.000Z");
const ALICE = "sess_alice0000000000000000000";
const BOB = "sess_bob000000000000000000000";

let db: Db;
let ctx: ServiceContext;
const statements: string[] = [];

beforeAll(async () => {
  db = await createTestDb({ onQuery: (query) => statements.push(query) });
  ctx = {
    db,
    agents: createAgents({ mode: "scripted" }),
    provider: new SimulatedProvider(createDbSimulatedStore(db), { now: () => NOW }),
    now: () => NOW,
  };
});

afterAll(async () => {
  await closeDb(db);
});

interface Seed {
  deal: Partial<DealInsert>;
  priceMinor?: number;
  payment?: Partial<PaymentRecord>;
  reports?: Partial<VerificationReport>[];
  audit?: Partial<AuditEvent>[];
}

/** Stores a deal with a seller opening at $60, a contract and whatever else the seed names. */
async function seed(input: Seed): Promise<string> {
  const deal = await insertDeal(db, dealFixture({ sellerId: "northwind", category: "illustration", ...input.deal }));
  await insertMove(
    db,
    deal.id,
    moveFixture(1, {
      actor: "seller",
      action: "offer",
      terms: { priceMinor: 6_000, deadline: "2026-10-08T09:00:00.000Z", revisionLimit: 1, count: 3 },
    }),
  );
  if (input.priceMinor !== undefined) {
    await insertContract(db, contractFixture(deal.id, { price: { amountMinor: input.priceMinor, currency: "USD" } }));
  }
  if (input.payment) await upsertPayment(db, deal.id, paymentFixture(input.payment));
  for (const [index, overrides] of (input.reports ?? []).entries()) {
    const submission = submissionFixture(deal.id, index + 1);
    await insertSubmission(db, submission);
    await insertReport(db, reportFixture(deal.id, index + 1, { submissionId: submission.id, ...overrides }));
  }
  for (const [index, overrides] of (input.audit ?? []).entries()) {
    await insertAuditEvent(db, auditFixture(deal.id, index + 1, overrides));
  }
  return deal.id;
}

const ids: Record<string, string> = {};

describe("getOpsSnapshot", () => {
  beforeAll(async () => {
    // Alice: one captured deal and one waiting for her review with the money held.
    ids.aliceCaptured = await seed({
      deal: { owner: ALICE, status: "completed", createdAt: "2026-10-06T01:00:00.000Z" },
      priceMinor: 4_700,
      payment: { status: "captured", amountMinor: 4_700, authorizedMinor: 4_700, capturedMinor: 4_700, captureId: "CAP-ALICE" },
      reports: [{ decision: "capture_eligible" }],
      audit: [
        { type: "payment.authorized", actor: "paypal", data: { provider: "simulated", authorizationId: "AUTH-ALICE", amountMinor: 4_700 } },
        { type: "payment.captured", actor: "paypal", data: { provider: "simulated", captureId: "CAP-ALICE", amountMinor: 4_700 } },
      ],
    });
    ids.aliceInReview = await seed({
      deal: { owner: ALICE, status: "in_review", createdAt: "2026-10-06T03:00:00.000Z" },
      priceMinor: 18_000,
      payment: { status: "authorized", amountMinor: 18_000, authorizedMinor: 18_000 },
      reports: [{ decision: "human_review", confidence: 0.6 }],
      audit: [{ type: "human.approved_spend", actor: "human" }],
    });
    // Bob's deal must never appear in Alice's snapshot or in the public one.
    ids.bob = await seed({
      deal: { owner: BOB, status: "completed", createdAt: "2026-10-06T04:00:00.000Z" },
      priceMinor: 9_900,
      payment: { status: "captured", amountMinor: 9_900, authorizedMinor: 9_900, capturedMinor: 9_900 },
    });
    // Showcase: captured after a revision, rejected with the hold voided, and half released by a human.
    ids.showcaseRevised = await seed({
      deal: { owner: SYSTEM_OWNER, status: "completed", scenarioId: "revision", sellerId: "quickdraw", revisionsUsed: 1, createdAt: "2026-10-05T22:00:00.000Z" },
      priceMinor: 2_700,
      payment: { status: "captured", amountMinor: 2_700, authorizedMinor: 2_700, capturedMinor: 2_700 },
      reports: [{ decision: "revision_required", failedRuleIds: ["R2"] }, { decision: "capture_eligible" }],
    });
    ids.showcaseVoided = await seed({
      deal: { owner: SYSTEM_OWNER, status: "rejected", scenarioId: "injection", sellerId: "pixelharbor", createdAt: "2026-10-06T02:00:00.000Z" },
      priceMinor: 1_800,
      payment: { status: "voided", amountMinor: 1_800, authorizedMinor: 1_800 },
      reports: [{ decision: "human_review", failedRuleIds: ["R6"] }],
      audit: [{ type: "payment.voided", actor: "payment_orchestrator", data: { provider: "simulated", authorizationId: "AUTH-VOID", amountMinor: 1_800 } }],
    });
    ids.showcasePartial = await seed({
      deal: { owner: SYSTEM_OWNER, status: "completed", createdAt: "2026-10-05T20:00:00.000Z" },
      priceMinor: 1_800,
      payment: { status: "captured", amountMinor: 1_800, authorizedMinor: 1_800, capturedMinor: 900 },
      reports: [{ decision: "human_review" }],
    });
  });

  it("shows a session its own deals and the showcase, newest first, and nobody else's", async () => {
    const snapshot = await getOpsSnapshot(ctx, ALICE);
    expect(snapshot.generatedAt).toBe(NOW.toISOString());
    expect(snapshot.deals.map((deal) => [deal.id, deal.origin])).toEqual([
      [ids.aliceInReview, "mine"],
      [ids.showcaseVoided, "showcase"],
      [ids.aliceCaptured, "mine"],
      [ids.showcaseRevised, "showcase"],
      [ids.showcasePartial, "showcase"],
    ]);
    expect(snapshot.deals.map((deal) => deal.id)).not.toContain(ids.bob);
  });

  it("shows only the showcase to a visitor without a session", async () => {
    const snapshot = await getOpsSnapshot(ctx, null);
    expect(snapshot.deals.map((deal) => deal.id)).toEqual([ids.showcaseVoided, ids.showcaseRevised, ids.showcasePartial]);
    expect(snapshot.deals.every((deal) => deal.origin === "showcase")).toBe(true);
    const visible = new Set(snapshot.deals.map((deal) => deal.id));
    expect(snapshot.paymentEvents.every((event) => visible.has(event.dealId))).toBe(true);
    expect(snapshot.checks.every((check) => visible.has(check.dealId))).toBe(true);
  });

  it("maps the stored records of each deal onto its row", async () => {
    const snapshot = await getOpsSnapshot(ctx, ALICE);
    const byId = new Map(snapshot.deals.map((deal) => [deal.id, deal]));

    expect(byId.get(ids.aliceCaptured)).toMatchObject({
      status: "completed",
      stage: "settled",
      outcome: "captured",
      seller: "Northwind Studio",
      priceMinor: 4_700,
      listPriceMinor: 6_000,
      savedMinor: 1_300,
      authorizedMinor: 4_700,
      capturedMinor: 4_700,
      heldMinor: 0,
      paymentStatus: "captured",
      paymentProvider: "simulated",
      paypalCaptureId: "CAP-ALICE",
      verificationDecision: "capture_eligible",
      negotiationMoves: 1,
      day: "2026-10-06",
      risk: "low",
    });
    expect(byId.get(ids.aliceInReview)).toMatchObject({
      stage: "verification",
      outcome: "in_progress",
      heldMinor: 18_000,
      verificationDecision: "human_review",
      humanDecisions: 1,
      risk: "high",
    });
    expect(byId.get(ids.aliceInReview)?.confidence).toBeCloseTo(0.6, 6);
    expect(byId.get(ids.showcaseRevised)).toMatchObject({
      scenarioId: "revision",
      seller: "Quickdraw Collective",
      verificationDecision: "capture_eligible",
      revisionsUsed: 1,
      day: "2026-10-05",
    });
    expect(byId.get(ids.showcaseVoided)).toMatchObject({
      stage: "closed",
      outcome: "voided",
      sellerTrust: "new",
      failedRules: 1,
      capturedMinor: 0,
      heldMinor: 0,
    });
  });

  it("lists the payment events and verification checks of exactly the deals shown", async () => {
    const snapshot = await getOpsSnapshot(ctx, ALICE);
    expect(snapshot.paymentEvents.map((event) => [event.dealId, event.type, event.amountMinor, event.reference])).toEqual([
      [ids.showcaseVoided, "voided", 1_800, "AUTH-VOID"],
      [ids.aliceCaptured, "authorized", 4_700, "AUTH-ALICE"],
      [ids.aliceCaptured, "captured", 4_700, "CAP-ALICE"],
    ]);
    // One check per report in the fixtures; the revised deal has two reports.
    expect(snapshot.checks.map((check) => [check.dealId, check.round])).toEqual([
      [ids.aliceInReview, 1],
      [ids.showcaseVoided, 1],
      [ids.aliceCaptured, 1],
      [ids.showcaseRevised, 1],
      [ids.showcaseRevised, 2],
      [ids.showcasePartial, 1],
    ]);
  });

  it("totals agree with the rows: authorized = captured + held + released", async () => {
    const { totals, deals } = await getOpsSnapshot(ctx, ALICE);
    expect(totals).toEqual({
      deals: 5,
      authorizedMinor: 4_700 + 18_000 + 2_700 + 1_800 + 1_800,
      capturedMinor: 4_700 + 2_700 + 900,
      heldMinor: 18_000,
      releasedMinor: 1_800 + 900,
      pendingHumanReview: 1,
      // First deliveries: only Alice's captured deal passed; the revised, reviewed, voided and partial ones did not.
      verificationFailureRate: 0.8,
      firstPassRate: 0.2,
    });
    expect(totals.authorizedMinor).toBe(totals.capturedMinor + totals.heldMinor + totals.releasedMinor);
    expect(totals.capturedMinor).toBe(deals.reduce((sum, deal) => sum + deal.capturedMinor, 0));
  });

  it("reads everything in a fixed number of statements and never loads artifact bodies", async () => {
    statements.length = 0;
    await getOpsSnapshot(ctx, ALICE);
    const forFive = [...statements];
    expect(forFive).toHaveLength(1 + DEAL_GRAPH_QUERY_COUNT);

    statements.length = 0;
    await getOpsSnapshot(ctx, null);
    expect(statements).toHaveLength(forFive.length);

    // The submissions are read through the projection that strips "svg" and "text" in SQL.
    const submissionsQuery = forFive.find((query) => query.includes('from "submissions"'));
    expect(submissionsQuery).toContain("- 'svg' - 'text'");
  });

  it("returns an empty, well-formed snapshot when there is nothing to show", async () => {
    const empty = await createTestDb();
    try {
      const snapshot = await getOpsSnapshot({ ...ctx, db: empty }, null);
      expect(snapshot).toEqual({
        generatedAt: NOW.toISOString(),
        deals: [],
        paymentEvents: [],
        checks: [],
        totals: {
          deals: 0,
          authorizedMinor: 0,
          capturedMinor: 0,
          heldMinor: 0,
          releasedMinor: 0,
          pendingHumanReview: 0,
          verificationFailureRate: 0,
          firstPassRate: 0,
        },
      });
    } finally {
      await closeDb(empty);
    }
  });

  it("is bounded: at most the newest 300 deals, still in the same number of statements", async () => {
    const extra = OPS_DEAL_LIMIT + 5;
    for (let index = 0; index < extra; index += 1) {
      const minute = String(index % 60).padStart(2, "0");
      const hour = String(6 + Math.floor(index / 60)).padStart(2, "0");
      await insertDeal(db, dealFixture({ owner: SYSTEM_OWNER, status: "negotiating", createdAt: `2026-10-07T${hour}:${minute}:00.000Z` }));
    }
    statements.length = 0;
    const snapshot = await getOpsSnapshot(ctx, ALICE);
    expect(statements).toHaveLength(1 + DEAL_GRAPH_QUERY_COUNT);
    expect(snapshot.deals).toHaveLength(OPS_DEAL_LIMIT);
    expect(snapshot.totals.deals).toBe(OPS_DEAL_LIMIT);
    // Newest first: every row is one of the deals just added, and the five oldest of them fell off.
    expect(snapshot.deals.every((deal) => deal.day === "2026-10-07")).toBe(true);
    const createdAt = snapshot.deals.map((deal) => deal.createdAt);
    expect(createdAt).toEqual([...createdAt].sort().reverse());
    expect(createdAt[createdAt.length - 1]).toBe("2026-10-07T06:05:00.000Z");
  });
});

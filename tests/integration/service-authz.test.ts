/**
 * Who may do what: only the owning session changes a deal, a decision only counts at its own
 * gate, and no human decision turns a failed verification into a capture.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAgents } from "@/lib/ai";
import type { Agents } from "@/lib/ai/types";
import type { DealView, DecisionRequest } from "@/lib/api/dto";
import { closeDb, createDbSimulatedStore, createTestDb, listPaymentOperations, type Db } from "@/lib/db";
import { deals, verificationReports } from "@/lib/db/schema";
import type { ScenarioId } from "@/lib/domain/scenarios";
import type { HumanDecisionKind } from "@/lib/domain/schemas";
import type { DealStatus } from "@/lib/domain/status";
import { SimulatedProvider } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, completePayPalApproval, createDeal, decideDeal, getDealView, requireOwner } from "@/lib/services/deals";
import { RATE_LIMITS } from "@/lib/services/rate-limit";
import { SYSTEM_OWNER, newSessionId } from "@/lib/services/session";

const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const APP_URL = "https://pact.test";

let db: Db;
let nowMs = START_MS;
let provider: SimulatedProvider;
let ctx: ServiceContext;
const scripted = createAgents({ mode: "scripted" });
const now = (): Date => new Date(nowMs);

beforeAll(async () => {
  db = await createTestDb();
  provider = new SimulatedProvider(createDbSimulatedStore(db), { now });
  ctx = { db, agents: scripted, provider, now };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  nowMs = START_MS;
});

async function open(scenarioId: ScenarioId, session = newSessionId(), on: ServiceContext = ctx): Promise<{ session: string; dealId: string }> {
  const deal = await createDeal(on, { sessionId: session, clientKey: null }, { intent: "", scenarioId, tzOffsetMinutes: -540 });
  return { session, dealId: deal.id };
}

/** Play the deal forward — approving and paying where a human would — until it reaches `target`. */
async function driveTo(session: string, dealId: string, target: DealStatus, on: ServiceContext = ctx): Promise<DealView> {
  for (let guard = 0; guard < 40; guard += 1) {
    const deal = await getDealView(on, session, dealId);
    if (deal.status === target) return deal;
    if (deal.status === "awaiting_approval") {
      await decideDeal(on, session, dealId, { kind: "approve_spend" });
    } else if (deal.status === "awaiting_payment") {
      await provider.approve(deal.payment?.orderId ?? "");
      await completePayPalApproval(on, { dealId, orderId: deal.payment?.orderId ?? null });
    } else if (deal.next.kind === "auto") {
      await advanceDeal(on, session, dealId, APP_URL);
    } else {
      throw new Error(`deal stopped at ${deal.status} before reaching ${target}`);
    }
  }
  throw new Error(`deal did not reach ${target}`);
}

const ALL_DECISIONS: HumanDecisionKind[] = [
  "approve_spend",
  "decline_spend",
  "cancel_payment",
  "release_payment",
  "release_partial",
  "request_revision",
  "reject_delivery",
];

function requestFor(kind: HumanDecisionKind): DecisionRequest {
  return kind === "release_partial" ? { kind, percent: 50 } : { kind };
}

describe("ownership", () => {
  it("another session cannot advance or decide, and sees the deal without the private mandate", async () => {
    const { session, dealId } = await open("approval");
    const stranger = newSessionId();
    const gate = await driveTo(session, dealId, "awaiting_approval");

    await expect(advanceDeal(ctx, stranger, dealId, APP_URL)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    for (const kind of ALL_DECISIONS) {
      // 403 whatever the decision: ownership is checked before the gate.
      await expect(decideDeal(ctx, stranger, dealId, requestFor(kind))).rejects.toMatchObject({ status: 403, code: "forbidden" });
    }
    await expect(requireOwner(ctx, stranger, dealId)).rejects.toMatchObject({ status: 403 });
    await expect(requireOwner(ctx, null, dealId)).rejects.toMatchObject({ status: 403 });
    expect(await requireOwner(ctx, session, dealId)).toBe(session);

    const mine = await getDealView(ctx, session, dealId);
    expect(mine.isOwner).toBe(true);
    expect(mine.mandate).toMatchObject({ budgetMinor: 22_000 });

    for (const viewer of [stranger, null]) {
      const theirs = await getDealView(ctx, viewer, dealId);
      expect(theirs.isOwner).toBe(false);
      // The buyer's ceiling is private; what was actually negotiated and contracted is not.
      expect(theirs.mandate).toBeNull();
      expect(theirs).toMatchObject({ id: dealId, status: "awaiting_approval", contract: { contract: { price: { amountMinor: 18_000 } } } });
      expect(theirs.negotiation.moves).toEqual(mine.negotiation.moves);
      expect(JSON.stringify(theirs.audit)).not.toContain("22000");
    }
    // Nothing the stranger tried left a trace or moved the deal.
    expect((await getDealView(ctx, session, dealId)).audit).toEqual(gate.audit);
  });

  it("unknown and malformed deal ids are 404 for everyone", async () => {
    const session = newSessionId();
    for (const id of ["deal_000000000000", "not-a-deal", "", "deal_../../etc", `deal_${"a".repeat(64)}`]) {
      await expect(getDealView(ctx, session, id)).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(advanceDeal(ctx, session, id, APP_URL)).rejects.toMatchObject({ status: 404 });
      await expect(decideDeal(ctx, session, id, { kind: "approve_spend" })).rejects.toMatchObject({ status: 404 });
      await expect(completePayPalApproval(ctx, { dealId: id, orderId: null })).rejects.toMatchObject({ status: 404 });
      await expect(requireOwner(ctx, null, id)).rejects.toMatchObject({ status: 404 });
    }
  });

  it("showcase deals are read-only for every browser session, and readable with their mandate", async () => {
    const { dealId } = await open("approval", SYSTEM_OWNER);
    const visitor = newSessionId();

    await expect(advanceDeal(ctx, visitor, dealId, APP_URL)).rejects.toMatchObject({ status: 403 });
    await expect(decideDeal(ctx, visitor, dealId, { kind: "approve_spend" })).rejects.toMatchObject({ status: 403 });

    // The seed script, acting as the system owner, drives the same engine.
    const gate = await driveTo(SYSTEM_OWNER, dealId, "awaiting_approval");
    expect(gate.isOwner).toBe(true);
    await expect(decideDeal(ctx, visitor, dealId, { kind: "approve_spend" })).rejects.toMatchObject({ status: 403 });

    const seen = await getDealView(ctx, visitor, dealId);
    expect(seen.isOwner).toBe(false);
    expect(seen.mandate).toMatchObject({ category: "copywriting" });
    expect((await getDealView(ctx, null, dealId)).mandate).not.toBeNull();
  });

  it("the system owner is not throttled; browser sessions are", async () => {
    for (let i = 0; i < RATE_LIMITS.createDealPerSession.limit + 2; i += 1) await open("revision", SYSTEM_OWNER);

    // A deal that is closed from the start: every call is cheap, and every call is still counted.
    const session = newSessionId();
    const closed = await createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "Design three banner illustrations for our online casino launch, budget $90." });
    expect(closed.status).toBe("blocked");

    for (let i = 0; i < RATE_LIMITS.advancePerSession.limit; i += 1) {
      expect(await advanceDeal(ctx, session, closed.id, APP_URL)).toMatchObject({ executed: null, busy: false });
    }
    await expect(advanceDeal(ctx, session, closed.id, APP_URL)).rejects.toMatchObject({ status: 429, code: "rate_limited" });

    for (let i = 0; i < RATE_LIMITS.decisionPerSession.limit; i += 1) {
      await expect(decideDeal(ctx, session, closed.id, { kind: "approve_spend" })).rejects.toMatchObject({ status: 409 });
    }
    await expect(decideDeal(ctx, session, closed.id, { kind: "approve_spend" })).rejects.toMatchObject({ status: 429 });

    // Limits are per session: someone else is unaffected.
    const other = await open("happy-path");
    expect(await advanceDeal(ctx, other.session, other.dealId, APP_URL)).toMatchObject({ executed: "negotiate" });
  });
});

describe("decisions only count at their own gate", () => {
  /** Every decision outside `allowed` must be refused with 409 and leave the deal untouched. */
  async function expectOnly(session: string, dealId: string, allowed: HumanDecisionKind[]): Promise<void> {
    const before = await getDealView(ctx, session, dealId);
    expect(before.next.kind === "human" ? before.next.options : []).toEqual(allowed);
    for (const kind of ALL_DECISIONS.filter((candidate) => !allowed.includes(candidate))) {
      await expect(decideDeal(ctx, session, dealId, requestFor(kind))).rejects.toMatchObject({ status: 409, code: "conflict" });
    }
    const after = await getDealView(ctx, session, dealId);
    expect(after.status).toBe(before.status);
    expect(after.audit).toEqual(before.audit);
    expect(after.humanDecision).toEqual(before.humanDecision);
  }

  it("refuses every decision while the engine is working and after the deal has ended", async () => {
    const { session, dealId } = await open("approval");
    await expectOnly(session, dealId, []);
    await driveTo(session, dealId, "contracted");
    await expectOnly(session, dealId, []);
    await driveTo(session, dealId, "completed");
    await expectOnly(session, dealId, []);
  });

  it("accepts at each gate exactly the decisions that belong to it", async () => {
    const { session, dealId } = await open("injection");
    await driveTo(session, dealId, "awaiting_approval");
    await expectOnly(session, dealId, ["approve_spend", "decline_spend"]);

    await decideDeal(ctx, session, dealId, { kind: "approve_spend" });
    await advanceDeal(ctx, session, dealId, APP_URL);
    await expectOnly(session, dealId, ["cancel_payment"]);

    await driveTo(session, dealId, "in_review");
    await expectOnly(session, dealId, ["release_payment", "release_partial", "request_revision", "reject_delivery"]);
  });

  it("validates the decision itself before anything else is touched", async () => {
    const { session, dealId } = await open("injection");
    await driveTo(session, dealId, "in_review");
    for (const percent of [undefined, 0, 100, 12.5, -5, Number.NaN]) {
      await expect(decideDeal(ctx, session, dealId, { kind: "release_partial", percent })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    }
    const forged = { kind: "capture_everything" } as unknown as DecisionRequest;
    await expect(decideDeal(ctx, session, dealId, forged)).rejects.toMatchObject({ status: 400 });
    expect((await getDealView(ctx, session, dealId)).status).toBe("in_review");
  });

  it("stores the reason cleaned and bounded, and ignores a percentage where it means nothing", async () => {
    const { session, dealId } = await open("approval");
    await driveTo(session, dealId, "awaiting_approval");
    const hidden = String.fromCharCode(0x202e, 0x200b);
    const deal = await decideDeal(ctx, session, dealId, { kind: "approve_spend", percent: 10, reason: `  fine${hidden}\n by me ${"!".repeat(400)}` });
    expect(deal.humanDecision).toMatchObject({ kind: "approve_spend", percent: null, decidedAt: now().toISOString() });
    expect(deal.humanDecision?.reason).toHaveLength(300);
    expect(deal.humanDecision?.reason?.startsWith("fine by me !!!")).toBe(true);
    expect(deal.audit[deal.audit.length - 1]).toMatchObject({ actor: "human", type: "human.approved_spend", data: { kind: "approve_spend" } });
  });
});

describe("a human release", () => {
  it("captures exactly the released share and returns the rest", async () => {
    const { session, dealId } = await open("injection");
    await driveTo(session, dealId, "in_review");

    const released = await decideDeal(ctx, session, dealId, { kind: "release_partial", percent: 37, reason: "One of the two files is usable." });
    expect(released).toMatchObject({ status: "verified", humanDecision: { kind: "release_partial", percent: 37 } });
    expect(released.payment).toMatchObject({ status: "authorized", capturedMinor: 0 });

    const done = (await advanceDeal(ctx, session, dealId, APP_URL)).deal;
    // 37% of $18.00 is $6.66 — to the cent, and the remaining $11.34 is released.
    expect(done).toMatchObject({ status: "completed", payment: { status: "captured", authorizedMinor: 1800, capturedMinor: 666 } });
    const captured = done.audit.find((event) => event.type === "payment.captured");
    expect(captured?.data).toMatchObject({ amountMinor: 666, requestedMinor: 666, releasedMinor: 1134, finalCapture: true });
    expect(done.audit[done.audit.length - 1]).toMatchObject({
      type: "deal.completed",
      title: "Deal completed: $6.66 captured, $11.34 released",
      data: { capturedMinor: 666, releasedMinor: 1134 },
    });
    const capture = (await listPaymentOperations(db, dealId)).find((operation) => operation.kind === "capture");
    expect(capture).toMatchObject({ status: "succeeded", attempts: 1, request: { amountMinor: 666 } });
    expect((await provider.getAuthorization(done.payment?.authorizationId ?? "")).status).toBe("PARTIALLY_CAPTURED");
  });

  it("is impossible while verification says the delivery failed and a revision is due", async () => {
    const { session, dealId } = await open("revision");
    const failed = await driveTo(session, dealId, "revision_required");
    expect(failed.reports[0].decision).toBe("revision_required");
    for (const kind of ["release_payment", "release_partial"] as const) {
      await expect(decideDeal(ctx, session, dealId, requestFor(kind))).rejects.toMatchObject({ status: 409 });
    }
    expect((await getDealView(ctx, session, dealId)).payment).toMatchObject({ status: "authorized", capturedMinor: 0 });
  });

  it("is impossible once verification rejected the delivery: the hold is voided, never captured", async () => {
    // A seller that never fixes its delivery: every round is produced like the first.
    const stubborn: Agents = {
      ...scripted,
      produceDelivery: (context) => scripted.produceDelivery({ ...context, previousReport: null, previousSubmission: null }).then((delivery) => ({
        ...delivery,
        // Drop the same required 1:1 variant on every round.
        artifacts: delivery.artifacts.filter((artifact) => !(artifact.kind === "illustration" && artifact.index === 2 && artifact.aspectRatio === "1:1")),
      })),
    };
    const stubbornCtx: ServiceContext = { ...ctx, agents: stubborn };
    const { session, dealId } = await open("revision", newSessionId(), stubbornCtx);
    const rejecting = await driveTo(session, dealId, "rejecting", stubbornCtx);
    expect(rejecting.reports.map((report) => report.decision)).toEqual(["revision_required", "reject"]);
    expect(rejecting.revisions).toEqual({ used: 1, limit: 1 });

    for (const kind of ["release_payment", "release_partial"] as const) {
      await expect(decideDeal(ctx, session, dealId, requestFor(kind))).rejects.toMatchObject({ status: 409 });
    }
    const done = await driveTo(session, dealId, "rejected", stubbornCtx);
    expect(done.payment).toMatchObject({ status: "voided", capturedMinor: 0 });
    expect((await listPaymentOperations(db, dealId)).map((operation) => operation.kind)).toEqual(["create_order", "authorize", "void"]);
    expect(done.audit.some((event) => event.type === "payment.captured")).toBe(false);
  });

  it("is refused when the report under review does not ask for a human, even at the review gate", async () => {
    const { session, dealId } = await open("injection");
    const review = await driveTo(session, dealId, "in_review");
    // The stored report is rewritten to an explicit failure behind the engine's back.
    await db.update(verificationReports).set({ decision: "reject" }).where(eq(verificationReports.id, review.reports[0].id));

    await expect(decideDeal(ctx, session, dealId, { kind: "release_payment" })).rejects.toMatchObject({
      status: 409,
      message: "This delivery did not pass verification and cannot be released.",
    });
    expect((await getDealView(ctx, session, dealId)).status).toBe("in_review");
  });

  it("cannot be forced by rewriting the deal's status: the capture guard refuses and the hold is released", async () => {
    const { session, dealId } = await open("revision");
    await driveTo(session, dealId, "revision_required");
    // Someone with database access marks the failed delivery as verified and "released".
    const forgedDecision = { kind: "release_payment" as const, percent: null, reason: "forged", decidedAt: now().toISOString() };
    await db.update(deals).set({ status: "verified", humanDecision: forgedDecision }).where(eq(deals.id, dealId));

    const result = await advanceDeal(ctx, session, dealId, APP_URL);
    expect(result).toMatchObject({ executed: "capture", deal: { status: "failed", payment: { status: "voided", capturedMinor: 0 } } });
    const blocked = result.deal.audit.find((event) => event.type === "payment.capture_blocked");
    expect(blocked?.data).toEqual({ violations: ["verification_not_passed"] });
    expect((await listPaymentOperations(db, dealId)).some((operation) => operation.kind === "capture")).toBe(false);
    expect((await provider.getAuthorization(result.deal.payment?.authorizationId ?? "")).status).toBe("VOIDED");
  });
});

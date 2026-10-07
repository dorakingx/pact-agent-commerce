/**
 * The step engine end to end: the four demo scenarios driven only through the service API
 * (createDeal / advanceDeal / decideDeal / completePayPalApproval), against a real database
 * (PGlite), the scripted agents, the seller studio and the labelled payment simulator.
 *
 * After every step the stored state is read back and the settlement guard is asked whether a
 * capture would be allowed: the answer must be "no" at every stage except "verified".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgents } from "@/lib/ai";
import type { AdvanceResponse, DealView, StepKind } from "@/lib/api/dto";
import {
  closeDb,
  createDbSimulatedStore,
  createTestDb,
  getDealByCode,
  listPaymentOperations,
  loadDealGraphs,
  upsertWallet,
  type Db,
} from "@/lib/db";
import { verifyAuditChain } from "@/lib/domain/audit";
import { verifyContractHash } from "@/lib/domain/contract";
import type { ScenarioId } from "@/lib/domain/scenarios";
import { checkCaptureAllowed } from "@/lib/domain/settlement";
import type { DealStatus } from "@/lib/domain/status";
import { SimulatedProvider, idempotencyKey, simulatedApprovePath } from "@/lib/payments";
import type { ServiceContext } from "@/lib/services/context";
import { advanceDeal, completePayPalApproval, createDeal, decideDeal, getDealView, listMyDeals } from "@/lib/services/deals";
import { ApiError } from "@/lib/services/errors";
import { getPolicy } from "@/lib/services/policy";
import { RATE_LIMITS } from "@/lib/services/rate-limit";
import { newSessionId } from "@/lib/services/session";

/** Lets one test dictate the next deal codes; every other test gets real random ones. */
const dealCodes = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock("@/lib/domain/ids", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/domain/ids")>();
  return { ...original, newDealCode: () => dealCodes.queue.shift() ?? original.newDealCode() };
});

/** 14:00 in Tokyo. "Tomorrow at 6 PM" is then 2026-10-07T09:00Z, 28 hours away. */
const START_MS = Date.parse("2026-10-06T05:00:00.000Z");
const TOKYO_OFFSET_MINUTES = -540;
const APP_URL = "https://pact.test";

let db: Db;
let nowMs = START_MS;
let provider: SimulatedProvider;
let ctx: ServiceContext;

beforeAll(async () => {
  db = await createTestDb();
  const now = (): Date => new Date(nowMs);
  provider = new SimulatedProvider(createDbSimulatedStore(db), { now });
  ctx = { db, agents: createAgents({ mode: "scripted" }), provider, now };
});

afterAll(async () => {
  await closeDb(db);
});

beforeEach(() => {
  nowMs = START_MS;
  dealCodes.queue.length = 0;
});

/* -------------------------------------------------------------------------- */
/*  Driving a deal                                                             */
/* -------------------------------------------------------------------------- */

interface Run {
  session: string;
  dealId: string;
  /** Status after creation and after every executed step or decision, in order. */
  path: DealStatus[];
  /** The automatic steps that ran, in order. */
  steps: StepKind[];
  /** Capture-guard verdict on the stored state at each entry of `path`. */
  captureAllowed: boolean[];
}

async function guardAllows(dealId: string): Promise<boolean> {
  const graph = (await loadDealGraphs(db, [dealId])).get(dealId);
  if (!graph) throw new Error(`deal ${dealId} is not in the database`);
  const guard = checkCaptureAllowed({
    dealStatus: graph.deal.status,
    signed: graph.signed,
    payment: graph.payment,
    latestReport: graph.reports[graph.reports.length - 1] ?? null,
    humanDecision: graph.deal.humanDecision,
    now: ctx.now(),
  });
  if (!guard.allowed) expect(guard.amountMinor).toBe(0);
  return guard.allowed;
}

async function record(run: Run, status: DealStatus): Promise<void> {
  run.path.push(status);
  run.captureAllowed.push(await guardAllows(run.dealId));
}

async function start(scenarioId: ScenarioId, session = newSessionId()): Promise<Run> {
  const deal = await createDeal(
    ctx,
    { sessionId: session, clientKey: null },
    { intent: "", scenarioId, tzOffsetMinutes: TOKYO_OFFSET_MINUTES },
  );
  const run: Run = { session, dealId: deal.id, path: [], steps: [], captureAllowed: [] };
  await record(run, deal.status);
  return run;
}

/** Advance until the engine has nothing automatic left to do, recording every step. */
async function advanceToGate(run: Run): Promise<DealView> {
  for (;;) {
    nowMs += 5_000;
    const result: AdvanceResponse = await advanceDeal(ctx, run.session, run.dealId, APP_URL);
    expect(result.busy).toBe(false);
    if (result.executed === null) return result.deal;
    run.steps.push(result.executed);
    await record(run, result.deal.status);
  }
}

async function decide(run: Run, decision: Parameters<typeof decideDeal>[3]): Promise<DealView> {
  nowMs += 30_000;
  const deal = await decideDeal(ctx, run.session, run.dealId, decision);
  await record(run, deal.status);
  return deal;
}

/** The simulated payer approves in "PayPal", then the browser returns to PACT. */
async function approveInPayPal(run: Run): Promise<DealView> {
  const waiting = await getDealView(ctx, run.session, run.dealId);
  const orderId = waiting.payment?.orderId ?? "";
  expect(waiting.payment?.approveUrl).toBe(simulatedApprovePath(orderId));
  nowMs += 20_000;
  await provider.approve(orderId);
  expect(await completePayPalApproval(ctx, { dealId: run.dealId, orderId })).toEqual({ dealId: run.dealId, outcome: "authorized" });
  const deal = await getDealView(ctx, run.session, run.dealId);
  await record(run, deal.status);
  return deal;
}

function trail(deal: DealView): string[] {
  return deal.audit.map((event) => event.type).filter((type) => type !== "negotiation.move");
}

async function ledger(dealId: string): Promise<string[]> {
  return (await listPaymentOperations(db, dealId)).map((operation) => `${operation.kind}:${operation.status}:${operation.attempts}`);
}

/** What must hold for every deal, whatever path it took. */
function expectSoundRecord(run: Run, deal: DealView): void {
  expect(deal.flags.auditChainValid).toBe(true);
  expect(verifyAuditChain(deal.audit)).toEqual({ valid: true, brokenAtSeq: null });
  expect(deal.audit.map((event) => event.seq)).toEqual(deal.audit.map((_, index) => index + 1));
  if (deal.contract) {
    expect(verifyContractHash(deal.contract)).toBe(true);
    for (const report of deal.reports) expect(report.contractHash).toBe(deal.contract.termsHash);
  }
  // Capture was possible in exactly one state.
  expect(run.captureAllowed).toEqual(run.path.map((status) => status === "verified"));
  expect(deal.flags.simulatedPayment).toBe(true);
  expect(deal.lastError).toBeNull();
}

const NEGOTIATING = (moves: number): DealStatus[] => Array.from({ length: moves }, () => "negotiating");
const OPENING_TRAIL = ["intent.received", "mandate.derived", "seller.matched", "negotiation.agreed", "contract.created", "policy.evaluated"];
const AUTHORIZATION_TRAIL = ["payment.order_created", "payment.approved", "payment.authorized"];

/* -------------------------------------------------------------------------- */
/*  The four scenarios                                                         */
/* -------------------------------------------------------------------------- */

describe("step engine: the four demo scenarios", () => {
  it("happy path: negotiated, authorized after the payer approves, delivered, verified, captured in full", async () => {
    const run = await start("happy-path");
    const created = await getDealView(ctx, run.session, run.dealId);
    expect(created).toMatchObject({
      status: "negotiating",
      isOwner: true,
      scenarioId: "happy-path",
      seller: { id: "northwind" },
      next: { kind: "auto", step: "negotiate", label: "Seller agent is preparing its offer" },
      payment: null,
      contract: null,
    });
    expect(created.code).toMatch(/^PACT-[2-9A-HJ-NP-Z]{4}$/);
    // "under $50" excludes $50 itself.
    expect(created.mandate).toMatchObject({ category: "illustration", budgetMinor: 4999 });

    // One advance, one step: it stops by itself where the payer has to act.
    const waiting = await advanceToGate(run);
    expect(run.path).toEqual([...NEGOTIATING(6), "agreed", "contracted", "payment_pending", "awaiting_payment"]);
    expect(run.steps).toEqual(["negotiate", "negotiate", "negotiate", "negotiate", "negotiate", "negotiate", "contract", "policy", "order"]);
    expect(waiting.negotiation).toMatchObject({
      status: "agreed",
      agreedTerms: { priceMinor: 4700, deadline: "2026-10-07T09:00:00.000Z", revisionLimit: 1, count: 3 },
      maxMoves: 8,
    });
    expect(waiting.negotiation.moves).toHaveLength(6);
    expect(waiting.negotiation.listPriceMinor).toBe(waiting.negotiation.moves[0].terms?.priceMinor);
    expect(waiting.negotiation.listPriceMinor).toBeGreaterThan(4700);
    expect(waiting.policy).toMatchObject({ outcome: "allow", spentTodayMinor: 0 });
    expect(waiting.contract).toMatchObject({ contract: { price: { amountMinor: 4700, currency: "USD" } }, paymentState: "created" });
    expect(waiting.next).toEqual({ kind: "human", gate: "payment", label: "Waiting for approval in PayPal", options: ["cancel_payment"] });
    expect(waiting.payment).toMatchObject({ status: "created", provider: "simulated", mode: "interactive", amountMinor: 4700, authorizedMinor: 0 });

    // A return that arrives before the payer approved (or a forged one) achieves nothing.
    const orderId = waiting.payment?.orderId ?? "";
    expect(await completePayPalApproval(ctx, { dealId: run.dealId, orderId })).toEqual({ dealId: run.dealId, outcome: "pending" });
    expect((await getDealView(ctx, run.session, run.dealId)).status).toBe("awaiting_payment");

    const authorized = await approveInPayPal(run);
    expect(authorized).toMatchObject({ status: "authorized", payment: { status: "authorized", authorizedMinor: 4700, capturedMinor: 0, approveUrl: null } });
    // Returning twice is harmless.
    expect((await completePayPalApproval(ctx, { dealId: run.dealId, orderId })).outcome).toBe("authorized");

    const done = await advanceToGate(run);
    expect(run.path.slice(-4)).toEqual(["authorized", "submitted", "verified", "completed"]);
    expect(run.steps.slice(-3)).toEqual(["fulfill", "verify", "capture"]);
    expect(done.submissions).toHaveLength(1);
    expect(done.submissions[0].artifacts).toHaveLength(6);
    expect(done.reports).toHaveLength(1);
    expect(done.reports[0]).toMatchObject({ decision: "capture_eligible", failedRuleIds: [], degraded: false });
    expect(done.payment).toMatchObject({ status: "captured", capturedMinor: 4700, authorizedMinor: 4700, lastError: null });
    expect(done.payment?.captureId).toMatch(/^SIM-C-/);
    expect(done.contract?.paymentState).toBe("captured");
    expect(done.next).toEqual({ kind: "done", label: "Completed · captured" });
    expect(done.flags.aiDegraded).toBe(false);
    expect(trail(done)).toEqual([...OPENING_TRAIL, ...AUTHORIZATION_TRAIL, "delivery.submitted", "verification.completed", "payment.captured", "deal.completed"]);
    expect(await ledger(run.dealId)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:succeeded:1"]);
    expectSoundRecord(run, done);

    // PayPal's own record is bound to the contract, and nothing further can be advanced.
    const order = await provider.getOrder(orderId);
    expect(order).toMatchObject({ customId: `pact:v1:${done.contract?.termsHash}`, invoiceId: done.contract?.contract.contractId, amountMinor: 4700 });
    expect(await advanceDeal(ctx, run.session, run.dealId, APP_URL)).toMatchObject({ executed: null, busy: false, deal: { status: "completed" } });
  });

  it("revision: a missing 1:1 version blocks capture until the seller fixes it", async () => {
    const run = await start("revision");
    await advanceToGate(run);
    await approveInPayPal(run);
    const done = await advanceToGate(run);

    expect(run.path.slice(run.path.indexOf("agreed"))).toEqual([
      "agreed",
      "contracted",
      "payment_pending",
      "awaiting_payment",
      "authorized",
      "submitted",
      "revision_required",
      "submitted",
      "verified",
      "completed",
    ]);
    expect(done.reports.map((report) => report.decision)).toEqual(["revision_required", "capture_eligible"]);
    expect(done.reports[0]).toMatchObject({ failedRuleIds: ["R2"], summary: "1 condition failed: 1:1 missing on illustration #2." });
    expect(done.submissions.map((submission) => submission.artifacts.length)).toEqual([3, 4]);
    expect(done.revisions).toEqual({ used: 1, limit: 1 });
    expect(done.payment).toMatchObject({ status: "captured", capturedMinor: 2700 });
    expect(trail(done)).toEqual([
      ...OPENING_TRAIL,
      ...AUTHORIZATION_TRAIL,
      "delivery.submitted",
      "verification.completed",
      "revision.requested",
      "delivery.submitted",
      "verification.completed",
      "payment.captured",
      "deal.completed",
    ]);
    // One capture, after the second verification — never after the first.
    expect(await ledger(run.dealId)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "capture:succeeded:1"]);
    expectSoundRecord(run, done);
  });

  it("approval: a price above the autonomous limit waits for a human, then settles normally", async () => {
    const run = await start("approval");
    const gate = await advanceToGate(run);
    expect(run.path[run.path.length - 1]).toBe("awaiting_approval");
    expect(gate.policy?.outcome).toBe("needs_approval");
    expect(gate.policy?.checks.filter((check) => check.outcome !== "pass").map((check) => check.id)).toEqual(["autonomous_limit"]);
    expect(gate.next).toMatchObject({ kind: "human", gate: "approval", options: ["approve_spend", "decline_spend"] });
    // Nothing has been asked of PayPal while the human has not answered.
    expect(gate.payment).toBeNull();
    expect(await ledger(run.dealId)).toEqual([]);

    const approved = await decide(run, { kind: "approve_spend", reason: "Looks right for six descriptions." });
    expect(approved).toMatchObject({ status: "payment_pending", humanDecision: { kind: "approve_spend", percent: null, reason: "Looks right for six descriptions." } });
    await advanceToGate(run);
    await approveInPayPal(run);
    const done = await advanceToGate(run);

    expect(run.path.slice(run.path.indexOf("agreed"))).toEqual([
      "agreed",
      "contracted",
      "awaiting_approval",
      "payment_pending",
      "awaiting_payment",
      "authorized",
      "submitted",
      "verified",
      "completed",
    ]);
    expect(done.submissions[0].artifacts).toHaveLength(12);
    expect(done.payment).toMatchObject({ status: "captured", capturedMinor: 18_000, authorizedMinor: 18_000 });
    expect(trail(done)).toEqual([
      ...OPENING_TRAIL,
      "policy.approval_requested",
      "human.approved_spend",
      ...AUTHORIZATION_TRAIL,
      "delivery.submitted",
      "verification.completed",
      "payment.captured",
      "deal.completed",
    ]);
    expectSoundRecord(run, done);
  });

  it("injection: hidden instructions from a new seller reach a human, who rejects, and the hold is voided", async () => {
    const run = await start("injection");
    const approval = await advanceToGate(run);
    expect(approval.policy?.checks.filter((check) => check.outcome !== "pass").map((check) => check.id)).toEqual(["seller_trust"]);
    await decide(run, { kind: "approve_spend" });
    await advanceToGate(run);
    await approveInPayPal(run);

    const review = await advanceToGate(run);
    expect(review.status).toBe("in_review");
    expect(review.reports[0]).toMatchObject({ decision: "human_review", failedRuleIds: ["R6"] });
    expect(review.next).toMatchObject({ kind: "human", gate: "review", options: ["release_payment", "release_partial", "request_revision", "reject_delivery"] });
    expect(review.payment).toMatchObject({ status: "authorized", capturedMinor: 0 });

    const rejecting = await decide(run, { kind: "reject_delivery", reason: "Hidden text addressed to the verifier." });
    expect(rejecting.status).toBe("rejecting");
    const done = await advanceToGate(run);

    expect(run.path.slice(run.path.indexOf("agreed"))).toEqual([
      "agreed",
      "contracted",
      "awaiting_approval",
      "payment_pending",
      "awaiting_payment",
      "authorized",
      "submitted",
      "in_review",
      "rejecting",
      "rejected",
    ]);
    expect(run.steps.slice(-3)).toEqual(["fulfill", "verify", "void"]);
    // Capture was never possible at any point of this deal.
    expect(run.captureAllowed).not.toContain(true);
    expect(done.payment).toMatchObject({ status: "voided", capturedMinor: 0, captureId: null });
    expect(trail(done)).toEqual([
      ...OPENING_TRAIL,
      "policy.approval_requested",
      "human.approved_spend",
      ...AUTHORIZATION_TRAIL,
      "delivery.submitted",
      "verification.completed",
      "verification.review_requested",
      "human.rejected_delivery",
      "payment.voided",
      "deal.rejected",
    ]);
    expect(await ledger(run.dealId)).toEqual(["create_order:succeeded:1", "authorize:succeeded:1", "void:succeeded:1"]);
    expect((await provider.getAuthorization(done.payment?.authorizationId ?? "")).status).toBe("VOIDED");
    expectSoundRecord(run, done);
    // The released hold no longer counts against today's limit.
    expect((await getPolicy(ctx, run.session)).spentTodayMinor).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Variants                                                                   */
/* -------------------------------------------------------------------------- */

describe("step engine: delegated agent wallet", () => {
  it("authorizes an in-policy deal without a payer redirect, and the vault id never leaves the wallet table", async () => {
    const session = newSessionId();
    const setup = await provider.createVaultSetup({
      returnUrl: `${APP_URL}/api/paypal/vault-return`,
      cancelUrl: `${APP_URL}/policies`,
      idempotencyKey: idempotencyKey("vault_setup", session),
    });
    const token = await provider.exchangeVaultSetup(setup.setupTokenId, idempotencyKey("vault_exchange", setup.setupTokenId));
    await upsertWallet(db, {
      owner: session,
      provider: provider.kind,
      status: "active",
      setupTokenId: null,
      vaultId: token.vaultId,
      payerEmailMasked: token.payerEmailMasked,
    });

    const run = await start("happy-path", session);
    const done = await advanceToGate(run);

    // No human gate at all: the engine ran from the request to the capture.
    expect(run.path).not.toContain("awaiting_payment");
    expect(run.path.slice(-6)).toEqual(["contracted", "payment_pending", "authorized", "submitted", "verified", "completed"]);
    expect(done.payment).toMatchObject({ status: "captured", mode: "delegated", capturedMinor: 4700, approveUrl: null });
    expect(trail(done)).toEqual([
      ...OPENING_TRAIL,
      "payment.order_created",
      "payment.authorized",
      "delivery.submitted",
      "verification.completed",
      "payment.captured",
      "deal.completed",
    ]);
    expect(await ledger(run.dealId)).toEqual(["create_order:succeeded:1", "capture:succeeded:1"]);
    expectSoundRecord(run, done);

    // The vault id is a credential: not in the view, the audit trail or the ledger.
    const exposed = JSON.stringify([done, await listPaymentOperations(db, run.dealId)]);
    expect(exposed).not.toContain(token.vaultId);
    expect(exposed).not.toContain(setup.setupTokenId);
    expect((await getPolicy(ctx, session)).spentTodayMinor).toBe(4700);
  });

  it("still pauses for approval when the price is above the autonomous limit", async () => {
    const session = newSessionId();
    const setup = await provider.createVaultSetup({ returnUrl: `${APP_URL}/r`, cancelUrl: `${APP_URL}/c`, idempotencyKey: idempotencyKey("vault_setup", session) });
    const token = await provider.exchangeVaultSetup(setup.setupTokenId, idempotencyKey("vault_exchange", setup.setupTokenId));
    await upsertWallet(db, { owner: session, provider: provider.kind, status: "active", setupTokenId: null, vaultId: token.vaultId, payerEmailMasked: null });

    const run = await start("approval", session);
    const gate = await advanceToGate(run);
    expect(gate.status).toBe("awaiting_approval");
    expect(gate.payment).toBeNull();

    await decide(run, { kind: "approve_spend" });
    const done = await advanceToGate(run);
    expect(run.path).not.toContain("awaiting_payment");
    expect(done).toMatchObject({ status: "completed", payment: { mode: "delegated", capturedMinor: 18_000 } });
  });
});

describe("step engine: human gates", () => {
  it("declining the spend ends the deal before anything is asked of PayPal", async () => {
    const run = await start("approval");
    await advanceToGate(run);
    const declined = await decide(run, { kind: "decline_spend" });
    expect(declined).toMatchObject({ status: "declined", payment: null, next: { kind: "done" } });
    expect(trail(declined).slice(-2)).toEqual(["policy.approval_requested", "human.declined_spend"]);
    expect(await ledger(run.dealId)).toEqual([]);
    expectSoundRecord(run, declined);
  });

  it("cancelling before approving abandons the order: nothing was ever held", async () => {
    const run = await start("happy-path");
    const waiting = await advanceToGate(run);
    const cancelled = await decide(run, { kind: "cancel_payment", reason: "Changed my mind." });
    expect(cancelled).toMatchObject({ status: "cancelled", payment: { status: "voided", authorizedMinor: 0, approveUrl: null } });
    expect(trail(cancelled).slice(-2)).toEqual(["payment.cancelled", "payment.voided"]);
    // An approval that arrives afterwards is refused: the deal no longer waits for payment.
    await provider.approve(waiting.payment?.orderId ?? "");
    expect((await completePayPalApproval(ctx, { dealId: run.dealId, orderId: waiting.payment?.orderId ?? null })).outcome).toBe("failed");
    expect((await getDealView(ctx, run.session, run.dealId)).status).toBe("cancelled");
    expect((await getPolicy(ctx, run.session)).spentTodayMinor).toBe(0);
  });

  it("a human release after review captures in full; the capture still goes through the guard", async () => {
    const run = await start("injection");
    await advanceToGate(run);
    await decide(run, { kind: "approve_spend" });
    await advanceToGate(run);
    await approveInPayPal(run);
    await advanceToGate(run);

    const released = await decide(run, { kind: "release_payment", reason: "The hidden text is harmless." });
    expect(released).toMatchObject({ status: "verified", payment: { status: "authorized", capturedMinor: 0 } });
    const done = await advanceToGate(run);
    expect(done).toMatchObject({ status: "completed", payment: { status: "captured", capturedMinor: 1800 } });
    expect(trail(done).slice(-3)).toEqual(["human.released_payment", "payment.captured", "deal.completed"]);
    expectSoundRecord(run, done);
  });

  it("a human can send a reviewed delivery back for a revision while one remains", async () => {
    const run = await start("injection");
    await advanceToGate(run);
    await decide(run, { kind: "approve_spend" });
    await advanceToGate(run);
    await approveInPayPal(run);
    await advanceToGate(run);

    const revising = await decide(run, { kind: "request_revision" });
    expect(revising).toMatchObject({ status: "revision_required", revisions: { used: 1, limit: 1 } });
    const again = await advanceToGate(run);
    // The seller embeds the instruction again; with no revision left a human can only release or reject.
    expect(again.status).toBe("in_review");
    expect(again.submissions).toHaveLength(2);
    expect(again.next).toMatchObject({ kind: "human", options: ["release_payment", "release_partial", "reject_delivery"] });
    await expect(decideDeal(ctx, run.session, run.dealId, { kind: "request_revision" })).rejects.toMatchObject({ status: 409 });
  });
});

/* -------------------------------------------------------------------------- */
/*  Creation                                                                   */
/* -------------------------------------------------------------------------- */

describe("createDeal", () => {
  const actor = () => ({ sessionId: newSessionId(), clientKey: null });

  it("stores and shows the cleaned request, never the raw one", async () => {
    const hidden = String.fromCharCode(0x200b, 0x202e);
    const raw = `  Get three landing-page illustrations${hidden} for under $50 by tomorrow\n\tat 6 PM. I need both 16:9 and 1:1 versions and one revision.  `;
    const deal = await createDeal(ctx, actor(), { intent: raw, tzOffsetMinutes: TOKYO_OFFSET_MINUTES });
    expect(deal.intent).toBe(
      "Get three landing-page illustrations for under $50 by tomorrow at 6 PM. I need both 16:9 and 1:1 versions and one revision.",
    );
    expect(deal).toMatchObject({ status: "negotiating", scenarioId: null, seller: { id: "northwind" } });
  });

  it("rejects a request that is too short or too long, and an unknown scenario", async () => {
    await expect(createDeal(ctx, actor(), { intent: "logo pls" })).rejects.toMatchObject({ status: 400, code: "invalid_request" });
    await expect(createDeal(ctx, actor(), { intent: "x".repeat(601) })).rejects.toMatchObject({ status: 400 });
    await expect(createDeal(ctx, actor(), { intent: "", scenarioId: "no-such-scenario" })).rejects.toMatchObject({ status: 400 });
    await expect(createDeal(ctx, actor(), { intent: "" })).rejects.toBeInstanceOf(ApiError);
  });

  it("blocks restricted work at creation, before any negotiation", async () => {
    const deal = await createDeal(ctx, actor(), { intent: "Design three banner illustrations for our online casino launch, budget $90." });
    expect(deal.mandate?.category).toBe("restricted");
    expect(deal).toMatchObject({ status: "blocked", next: { kind: "done", label: "Blocked by policy" }, payment: null });
    expect(deal.policy).toMatchObject({ outcome: "block", checks: [{ id: "category_allowed", outcome: "block" }] });
    expect(deal.negotiation.moves).toEqual([]);
    expect(trail(deal)).toEqual(["intent.received", "mandate.derived", "policy.evaluated"]);
  });

  it("ends at once when no seller agent offers the kind of work", async () => {
    const deal = await createDeal(ctx, actor(), { intent: "Record a 30-second voiceover for our product video by Friday, budget $80." });
    expect(deal.mandate?.category).toBe("other");
    expect(deal).toMatchObject({
      status: "negotiation_failed",
      seller: null,
      negotiation: { status: "failed", failureReason: "No seller agent in the directory offers this kind of work" },
    });
    expect(trail(deal)).toEqual(["intent.received", "mandate.derived", "negotiation.failed"]);
  });

  it("pins a scenario's seller only for the kind of work that seller offers", async () => {
    // The card's own text: the pinned (fault-injecting) seller is used although a more reliable one exists.
    const pinned = await createDeal(ctx, actor(), { intent: "", scenarioId: "revision" });
    expect(pinned).toMatchObject({ scenarioId: "revision", seller: { id: "quickdraw" }, mandate: { category: "illustration" } });
    expect(pinned.audit.find((event) => event.type === "seller.matched")?.data).toMatchObject({ sellerId: "quickdraw", pinnedByScenario: true });

    // The same card, edited into a copywriting request: an illustration studio has no rate for it.
    const edited = await createDeal(ctx, actor(), {
      intent: "Write 6 product descriptions for our new espresso machine lineup, 80 to 120 words each, in English and Japanese, within 3 days. Budget is $220, with two revisions.",
      scenarioId: "happy-path",
    });
    expect(edited).toMatchObject({ status: "negotiating", scenarioId: "happy-path", seller: { id: "lingua" }, mandate: { category: "copywriting" } });
    expect(edited.audit.find((event) => event.type === "seller.matched")?.data).toMatchObject({ sellerId: "lingua", pinnedByScenario: false });

    // Edited into work nobody offers, or into restricted work: no seller is attached at all.
    const unserved = await createDeal(ctx, actor(), { intent: "Record a 30-second voiceover for our product video by Friday, budget $80.", scenarioId: "happy-path" });
    expect(unserved).toMatchObject({ status: "negotiation_failed", seller: null });
    const restricted = await createDeal(ctx, actor(), { intent: "Design three banner illustrations for our online casino launch, budget $90.", scenarioId: "injection" });
    expect(restricted).toMatchObject({ status: "blocked", seller: null, payment: null });
  });

  it("retries with a new deal code when the code is already taken", async () => {
    const first = await createDeal(ctx, actor(), { intent: "", scenarioId: "happy-path" });
    // The next two codes collide with the existing deal; the third is free.
    dealCodes.queue.push(first.code, first.code, "PACT-ZZ99");
    const second = await createDeal(ctx, actor(), { intent: "", scenarioId: "happy-path" });
    expect(second.code).toBe("PACT-ZZ99");
    expect(second.id).not.toBe(first.id);
    expect((await getDealByCode(db, first.code))?.id).toBe(first.id);

    // Five collisions in a row give up cleanly instead of looping.
    dealCodes.queue.push(first.code, first.code, first.code, first.code, first.code);
    await expect(createDeal(ctx, actor(), { intent: "", scenarioId: "happy-path" })).rejects.toMatchObject({ status: 503, code: "unavailable" });
  });

  it("limits how many deals a session and a network address may create", async () => {
    const session = newSessionId();
    const { limit } = RATE_LIMITS.createDealPerSession;
    for (let i = 0; i < limit; i += 1) await createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId: "revision" });
    await expect(createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId: "revision" })).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      details: { resetAt: new Date(START_MS + RATE_LIMITS.createDealPerSession.windowSeconds * 1000).toISOString() },
    });
    // The window passes and the session may create again.
    nowMs += RATE_LIMITS.createDealPerSession.windowSeconds * 1000;
    await expect(createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId: "revision" })).resolves.toBeDefined();
    expect(await listMyDeals(ctx, session)).toHaveLength(limit + 1);

    // New sessions from one address are still counted together.
    const clientKey = "client-key-of-a-busy-address";
    for (let i = 0; i < RATE_LIMITS.createDealPerClient.limit; i += 1) {
      await createDeal(ctx, { sessionId: newSessionId(), clientKey }, { intent: "", scenarioId: "revision" });
    }
    await expect(createDeal(ctx, { sessionId: newSessionId(), clientKey }, { intent: "", scenarioId: "revision" })).rejects.toMatchObject({ status: 429 });
  });

  it("lists a session's deals newest first, as summaries", async () => {
    const session = newSessionId();
    const older = await createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId: "happy-path" });
    nowMs += 60_000;
    const newer = await createDeal(ctx, { sessionId: session, clientKey: null }, { intent: "", scenarioId: "approval" });
    const list = await listMyDeals(ctx, session);
    expect(list.map((deal) => deal.id)).toEqual([newer.id, older.id]);
    expect(list[1]).toMatchObject({ code: older.code, status: "negotiating", statusLabel: "Negotiating", sellerName: "Northwind Studio", priceMinor: null });
    expect(await listMyDeals(ctx, newSessionId())).toEqual([]);
  });
});

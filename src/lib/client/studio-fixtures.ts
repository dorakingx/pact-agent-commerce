/**
 * Test support for the studio-* modules: ledger rows, checks and payment events built per
 * status the way the server's read model builds them, so each test states only what it is
 * about. Not imported by application code.
 */
import type { OpsCheckRow, OpsPaymentEvent, OpsRow, OpsSnapshot } from "../api/dto";
import { DEAL_STATUS_LABEL, type DealStatus } from "../domain/status";

const STAGE: Record<DealStatus, OpsRow["stage"]> = {
  negotiating: "negotiation",
  agreed: "negotiation",
  contracted: "contract",
  awaiting_approval: "contract",
  payment_pending: "payment",
  awaiting_payment: "payment",
  authorized: "fulfillment",
  revision_required: "fulfillment",
  submitted: "verification",
  in_review: "verification",
  verified: "verification",
  rejecting: "verification",
  completed: "settled",
  rejected: "closed",
  declined: "closed",
  blocked: "closed",
  negotiation_failed: "closed",
  cancelled: "closed",
  expired: "closed",
  failed: "closed",
};

const OUTCOME: Partial<Record<DealStatus, OpsRow["outcome"]>> = {
  completed: "captured",
  rejected: "voided",
  cancelled: "voided",
  expired: "voided",
  declined: "declined",
  blocked: "blocked",
  negotiation_failed: "no_agreement",
  failed: "failed",
};

const BEFORE_CONTRACT: readonly DealStatus[] = ["negotiating", "agreed", "negotiation_failed"];
const HOLDING: readonly DealStatus[] = ["authorized", "submitted", "revision_required", "in_review", "verified", "rejecting"];
const VERIFIED: Partial<Record<DealStatus, OpsRow["verificationDecision"]>> = {
  in_review: "human_review",
  verified: "capture_eligible",
  completed: "capture_eligible",
  revision_required: "revision_required",
  rejecting: "reject",
  rejected: "reject",
};

let sequence = 0;

/** A ledger row for a deal in `status`, with the money and verification columns that status implies. */
export function opsRow(status: DealStatus, overrides: Partial<OpsRow> = {}): OpsRow {
  sequence += 1;
  const priceMinor = BEFORE_CONTRACT.includes(status) ? 0 : 4700;
  const holding = HOLDING.includes(status);
  const captured = status === "completed";
  const voided = status === "rejected" || status === "expired";
  const authorizedMinor = holding || captured || voided ? priceMinor : 0;
  const paymentStatus: OpsRow["paymentStatus"] = captured
    ? "captured"
    : status === "rejected"
      ? "voided"
      : status === "expired"
        ? "expired"
        : holding
          ? "authorized"
          : status === "awaiting_payment"
            ? "created"
            : "none";
  const decision = VERIFIED[status] ?? null;
  return {
    id: `deal_fixture${sequence.toString().padStart(4, "0")}`,
    code: `PACT-T${sequence.toString().padStart(3, "0")}`,
    title: "3 landing-page illustrations",
    status,
    statusLabel: DEAL_STATUS_LABEL[status],
    stage: STAGE[status],
    outcome: OUTCOME[status] ?? "in_progress",
    buyer: "Buyer Agent (acting for you)",
    seller: "Northwind Studio",
    sellerId: "northwind",
    sellerTrust: "established",
    category: "illustration",
    scenarioId: null,
    origin: "mine",
    priceMinor,
    listPriceMinor: 5300,
    savedMinor: priceMinor === 0 ? 0 : 600,
    authorizedMinor,
    capturedMinor: captured ? priceMinor : 0,
    heldMinor: holding ? priceMinor : 0,
    currency: "USD",
    paymentStatus,
    paymentProvider: paymentStatus === "none" ? null : "simulated",
    paymentMode: paymentStatus === "none" ? null : "interactive",
    paypalOrderId: paymentStatus === "none" ? null : `SIM-O-${sequence}`,
    paypalAuthorizationId: authorizedMinor > 0 ? `SIM-A-${sequence}` : null,
    paypalCaptureId: captured ? `SIM-C-${sequence}` : null,
    webhookConfirmed: false,
    verificationDecision: decision,
    confidence: decision === null ? null : decision === "human_review" ? 0.62 : 0.95,
    failedRules: decision === "reject" || decision === "revision_required" ? 1 : 0,
    revisionsUsed: 0,
    revisionLimit: 1,
    negotiationMoves: 5,
    guardrailInterventions: 0,
    policyOutcome: priceMinor === 0 ? null : status === "awaiting_approval" || status === "declined" ? "needs_approval" : status === "blocked" ? "block" : "allow",
    policyFlags: status === "awaiting_approval" ? ["autonomous_limit"] : [],
    humanDecisions: 0,
    risk: status === "in_review" ? "high" : status === "awaiting_approval" ? "medium" : "low",
    riskReasons: status === "in_review" ? ["Waiting for human review"] : status === "awaiting_approval" ? ["Spend needs human approval under policy"] : [],
    aiDegraded: false,
    deadline: "2026-10-07T09:00:00.000Z",
    hoursToDeadline: 30,
    createdAt: "2026-10-06T01:00:00.000Z",
    updatedAt: "2026-10-06T01:20:00.000Z",
    day: "2026-10-06",
    ...overrides,
  };
}

export function opsCheck(deal: Pick<OpsRow, "id" | "code" | "seller">, overrides: Partial<OpsCheckRow> = {}): OpsCheckRow {
  const round = overrides.round ?? 1;
  const ruleId = overrides.ruleId ?? "R1";
  return {
    id: `rep_${deal.id}_${round}:${ruleId}`,
    dealId: deal.id,
    dealCode: deal.code,
    round,
    ruleId,
    kind: "deliverable_count",
    condition: "3 illustrations delivered",
    evaluator: "deterministic",
    result: "pass",
    confidence: 1,
    required: true,
    seller: deal.seller,
    at: "2026-10-06T01:15:00.000Z",
    ...overrides,
  };
}

export function opsEvent(deal: Pick<OpsRow, "id" | "code" | "seller">, type: OpsPaymentEvent["type"], overrides: Partial<OpsPaymentEvent> = {}): OpsPaymentEvent {
  return {
    id: `evt_${deal.id}_${type}`,
    dealId: deal.id,
    dealCode: deal.code,
    at: "2026-10-06T01:05:00.000Z",
    day: "2026-10-06",
    type,
    amountMinor: 4700,
    seller: deal.seller,
    provider: "simulated",
    reference: "SIM-O-1",
    ...overrides,
  };
}

export function snapshotOf(deals: OpsRow[], checks: OpsCheckRow[] = [], paymentEvents: OpsPaymentEvent[] = []): OpsSnapshot {
  const sum = (pick: (row: OpsRow) => number): number => deals.reduce((total, row) => total + pick(row), 0);
  return {
    generatedAt: "2026-10-06T02:00:00.000Z",
    deals,
    paymentEvents,
    checks,
    totals: {
      deals: deals.length,
      authorizedMinor: sum((row) => row.authorizedMinor),
      capturedMinor: sum((row) => row.capturedMinor),
      heldMinor: sum((row) => row.heldMinor),
      releasedMinor: 0,
      pendingHumanReview: deals.filter((row) => row.status === "awaiting_approval" || row.status === "in_review").length,
      verificationFailureRate: 0,
      firstPassRate: 0,
    },
  };
}

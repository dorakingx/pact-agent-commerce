/* TEMPORARY development fixture for the AG Studio dashboard. Deleted before hand-off. */
import type { OpsCheckRow, OpsPaymentEvent, OpsRow, OpsSnapshot } from "@/lib/api/dto";
import { DEAL_STATUS_LABEL, type DealStatus } from "@/lib/domain/status";

const SELLERS = [
  { id: "northwind", name: "Northwind Studio", trust: "established" as const, category: "illustration" as const },
  { id: "quickdraw", name: "Quickdraw Collective", trust: "established" as const, category: "illustration" as const },
  { id: "lingua", name: "Lingua Labs", trust: "established" as const, category: "copywriting" as const },
  { id: "pixelharbor", name: "Pixel Harbor", trust: "new" as const, category: "illustration" as const },
];

const STATUS_PLAN: DealStatus[] = [
  "completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed",
  "rejected", "authorized", "authorized", "in_review", "awaiting_approval", "awaiting_approval", "negotiating",
  "submitted", "revision_required", "declined", "negotiation_failed", "blocked", "awaiting_payment", "completed",
  "completed", "cancelled", "in_review", "contracted", "completed", "expired", "completed", "verified",
];

const STAGE: Record<DealStatus, OpsRow["stage"]> = {
  negotiating: "negotiation", agreed: "negotiation", contracted: "contract", awaiting_approval: "contract",
  payment_pending: "payment", awaiting_payment: "payment", authorized: "fulfillment", revision_required: "fulfillment",
  submitted: "verification", in_review: "verification", verified: "verification", rejecting: "verification",
  completed: "settled", rejected: "closed", declined: "closed", blocked: "closed", negotiation_failed: "closed",
  cancelled: "closed", expired: "closed", failed: "closed",
};
const OUTCOME: Partial<Record<DealStatus, OpsRow["outcome"]>> = {
  completed: "captured", rejected: "voided", cancelled: "voided", expired: "voided", declined: "declined",
  blocked: "blocked", negotiation_failed: "no_agreement", failed: "failed",
};

const KINDS = ["deliverable_count", "aspect_ratio_coverage", "valid_format", "deadline", "brief_adherence", "no_embedded_instructions"];

export function fixtureSnapshot(now = Date.now()): OpsSnapshot {
  const deals: OpsRow[] = [];
  const paymentEvents: OpsPaymentEvent[] = [];
  const checks: OpsCheckRow[] = [];
  STATUS_PLAN.forEach((status, i) => {
    const seller = SELLERS[i % SELLERS.length]!;
    const created = new Date(now - (i * 7 + 2) * 3_600_000);
    const createdAt = created.toISOString();
    const price = 1800 + ((i * 1370) % 21000);
    const list = price + 300 + ((i * 97) % 900);
    const stage = STAGE[status];
    const hasContract = !["negotiating", "agreed", "negotiation_failed"].includes(status);
    const authorized = ["authorized", "submitted", "revision_required", "in_review", "verified", "completed", "rejected", "expired"].includes(status);
    const captured = status === "completed";
    const verified = ["in_review", "verified", "completed", "rejected", "revision_required"].includes(status);
    const paymentStatus: OpsRow["paymentStatus"] = captured ? "captured" : status === "rejected" ? "voided" : status === "expired" ? "expired" : authorized ? "authorized" : status === "awaiting_payment" ? "created" : status === "cancelled" ? "voided" : "none";
    const id = `deal_${(i + 10).toString(36)}${"x".repeat(8)}`;
    const code = `PACT-${(4096 + i * 977).toString(36).toUpperCase().padStart(4, "0").slice(0, 4)}`;
    const decision: OpsRow["verificationDecision"] = !verified ? null : status === "in_review" ? "human_review" : status === "rejected" ? "reject" : status === "revision_required" ? "revision_required" : "capture_eligible";
    const revised = verified && i % 5 === 1;
    deals.push({
      id, code,
      title: `${2 + (i % 3)} ${seller.category === "copywriting" ? "product descriptions" : "landing-page illustrations"}`,
      status, statusLabel: DEAL_STATUS_LABEL[status], stage, outcome: OUTCOME[status] ?? "in_progress",
      buyer: "Buyer Agent (acting for you)", seller: seller.name, sellerId: seller.id, sellerTrust: seller.trust,
      category: seller.category, scenarioId: null, origin: i % 3 === 0 ? "mine" : "showcase",
      priceMinor: hasContract ? price : 0, listPriceMinor: list, savedMinor: hasContract ? list - price : 0,
      authorizedMinor: authorized ? price : 0, capturedMinor: captured ? price : 0,
      heldMinor: paymentStatus === "authorized" ? price : 0, currency: "USD", paymentStatus,
      paymentProvider: paymentStatus === "none" ? null : "simulated", paymentMode: paymentStatus === "none" ? null : i % 2 ? "delegated" : "interactive",
      paypalOrderId: paymentStatus === "none" ? null : `SIM-ORDER-${i}`, paypalAuthorizationId: authorized ? `SIM-AUTH-${i}` : null,
      paypalCaptureId: captured ? `SIM-CAP-${i}` : null, webhookConfirmed: false,
      verificationDecision: decision, confidence: verified ? (status === "in_review" ? 0.62 : 0.93) : null,
      failedRules: status === "rejected" || status === "revision_required" ? 1 : 0, revisionsUsed: revised ? 1 : 0, revisionLimit: 1,
      negotiationMoves: 3 + (i % 4), guardrailInterventions: i % 6 === 0 ? 1 : 0,
      policyOutcome: hasContract ? (status === "awaiting_approval" || status === "declined" ? "needs_approval" : status === "blocked" ? "block" : "allow") : null,
      policyFlags: status === "awaiting_approval" ? (seller.trust === "new" ? ["seller_trust"] : ["autonomous_limit"]) : [],
      humanDecisions: status === "declined" ? 1 : 0,
      risk: status === "in_review" ? "high" : status === "awaiting_approval" || status === "revision_required" ? "medium" : i % 9 === 4 ? "medium" : "low",
      riskReasons: status === "in_review" ? ["Waiting for human review"] : status === "awaiting_approval" ? ["Spend needs human approval under policy"] : status === "authorized" && i % 2 === 0 ? ["Deadline in under 24h, not yet delivered"] : [],
      aiDegraded: false, deadline: new Date(created.getTime() + 30 * 3_600_000).toISOString(),
      hoursToDeadline: Math.round((created.getTime() + 30 * 3_600_000 - now) / 360_000) / 10,
      createdAt, updatedAt: new Date(created.getTime() + 20 * 60_000).toISOString(), day: createdAt.slice(0, 10),
    });
    const ev = (type: OpsPaymentEvent["type"], minutes: number, amount: number, reference: string | null): void => {
      const at = new Date(created.getTime() + minutes * 60_000).toISOString();
      paymentEvents.push({ id: `evt_${i}_${type}`, dealId: id, dealCode: code, at, day: at.slice(0, 10), type, amountMinor: amount, seller: seller.name, provider: "simulated", reference });
    };
    if (paymentStatus !== "none") ev("order_created", 2, price, `SIM-ORDER-${i}`);
    if (authorized) ev("authorized", 3, price, `SIM-AUTH-${i}`);
    if (captured) ev("captured", 12, price, `SIM-CAP-${i}`);
    if (paymentStatus === "voided") ev("voided", 14, price, `SIM-AUTH-${i}`);
    if (verified) {
      const rounds = revised ? 2 : 1;
      for (let round = 1; round <= rounds; round += 1) {
        KINDS.forEach((kind, k) => {
          const ai = kind === "brief_adherence" || kind === "no_embedded_instructions";
          const failing = (round < rounds && k === 1) || (round === rounds && status === "rejected" && k === 5) || (round === rounds && status === "revision_required" && k === 1);
          const uncertain = round === rounds && status === "in_review" && k === 4;
          checks.push({
            id: `rep_${i}_${round}:R${k + 1}`, dealId: id, dealCode: code, round, ruleId: `R${k + 1}`, kind,
            condition: ["3 illustrations delivered", "Each illustration in 16:9 and 1:1", "Every file is a valid SVG", "Delivered before the deadline", "Matches the brief", "No instructions embedded in the files"][k]!,
            evaluator: ai ? "ai" : "deterministic", result: failing ? "fail" : uncertain ? "uncertain" : "pass",
            confidence: ai ? (uncertain ? 0.62 : failing ? 0.9 : 0.88 + ((i * 7 + k) % 10) / 100) : 1, required: true, seller: seller.name,
            at: new Date(created.getTime() + (8 + round * 2) * 60_000).toISOString(),
          });
        });
      }
    }
  });
  const sum = (pick: (r: OpsRow) => number): number => deals.reduce((t, r) => t + pick(r), 0);
  return {
    generatedAt: new Date(now).toISOString(), deals, paymentEvents, checks,
    totals: {
      deals: deals.length, authorizedMinor: sum((r) => r.authorizedMinor), capturedMinor: sum((r) => r.capturedMinor), heldMinor: sum((r) => r.heldMinor),
      releasedMinor: 0, pendingHumanReview: deals.filter((r) => r.status === "awaiting_approval" || r.status === "in_review").length,
      verificationFailureRate: 0.2, firstPassRate: 0.8,
    },
  };
}

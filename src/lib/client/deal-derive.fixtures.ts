/**
 * Test support for the deal view logic: small, coherent deal views built per status, so each
 * test states only what it is about. Not imported by application code.
 */
import type { DealView } from "@/lib/api/dto";
import { nextStepFor } from "@/lib/domain/next-step";
import type {
  AuditEvent,
  AuditEventType,
  CheckResult,
  IllustrationArtifact,
  PolicyEvaluation,
  Submission,
  VerificationCheck,
  VerificationDecision,
  VerificationReport,
  VerificationRule,
} from "@/lib/domain/schemas";
import type { DealStatus } from "@/lib/domain/status";
import type { PaymentRecord } from "@/lib/payments/types";

const DEAL_ID = "deal_fixture0001";
const DEADLINE = "2026-10-07T09:00:00.000Z";
const HASH = "18a8ced61cbdb77ad6edd0bef0f05268695c7cd62907be0d7ddb21177f0c94fc";

export function auditEvent(seq: number, type: AuditEventType, overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: `evt_${seq}`,
    dealId: DEAL_ID,
    seq,
    at: "2026-10-05T21:51:14.300Z",
    actor: "system",
    type,
    title: type,
    detail: null,
    data: null,
    prevHash: "0".repeat(64),
    hash: seq.toString(16).padStart(64, "a"),
    ...overrides,
  };
}

export function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    provider: "simulated",
    mode: "interactive",
    status: "authorized",
    orderId: "SIM-O-1",
    authorizationId: "SIM-A-1",
    captureId: null,
    amountMinor: 2800,
    authorizedMinor: 2800,
    capturedMinor: 0,
    currency: "USD",
    approveUrl: null,
    authorizationExpiresAt: "2026-11-03T21:51:35.951Z",
    payerEmailMasked: "si****@personal.example.com",
    lastError: null,
    webhookConfirmed: { authorized: false, captured: false, voided: false },
    updatedAt: "2026-10-05T21:52:04.474Z",
    ...overrides,
  };
}

export const RULES: VerificationRule[] = [
  { id: "R1", kind: "deliverable_count", description: "2 illustrations delivered", required: true, evaluator: "deterministic" },
  { id: "R2", kind: "aspect_ratio_coverage", description: "Every illustration delivered in 16:9 and 1:1", required: true, evaluator: "deterministic" },
  { id: "R3", kind: "valid_format", description: "Files are valid, safe SVG", required: true, evaluator: "deterministic" },
  { id: "R4", kind: "deadline", description: "Delivered by 2026-10-07 09:00 UTC", required: true, evaluator: "deterministic" },
  { id: "R5", kind: "brief_adherence", description: "Illustrations match the brief: launch banners", required: true, evaluator: "ai" },
  { id: "R6", kind: "no_embedded_instructions", description: "Files contain no hidden instructions aimed at the verifier", required: true, evaluator: "deterministic" },
];

export function contractOf(priceMinor: number): NonNullable<DealView["contract"]> {
  return {
    contract: {
      contractId: "ctr_fixture00001",
      schemaVersion: 1,
      dealId: DEAL_ID,
      createdAt: "2026-10-05T21:51:35.720Z",
      title: "2 illustrations · launch banners",
      category: "illustration",
      buyer: { id: "buyer-agent", name: "Buyer Agent (acting for you)" },
      seller: { id: "quickdraw", name: "Quickdraw Collective" },
      price: { amountMinor: priceMinor, currency: "USD" },
      deadline: DEADLINE,
      revisionLimit: 1,
      deliverables: [{ kind: "illustration", count: 2, aspectRatios: ["16:9", "1:1"], subject: "launch banners", style: null }],
      verificationRules: RULES,
      settlement: { trigger: "verified_delivery", autoCaptureMinConfidence: 0.85, humanReviewMinConfidence: 0.5, onExhaustedRevisions: "void_authorization" },
    },
    termsHash: HASH,
    paymentState: "none",
  };
}

export function illustration(id: string, index: number, width: number, height: number, label: string): IllustrationArtifact {
  return {
    id,
    kind: "illustration",
    index,
    title: `Banner ${index}`,
    aspectRatio: label,
    width,
    height,
    format: "svg",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ddd"/></svg>`,
    description: "A banner.",
  };
}

/** Round 1 omits the 1:1 version of illustration #2 (the "revision" scenario); round 2 is complete. */
export function submission(round: number): Submission {
  const files = [
    illustration("art_1w", 1, 1600, 900, "16:9"),
    illustration("art_1s", 1, 1200, 1200, "1:1"),
    illustration("art_2w", 2, 1600, 900, "16:9"),
  ];
  if (round > 1) files.push(illustration("art_2s", 2, 1200, 1200, "1:1"));
  return {
    id: `sub_${round}`,
    dealId: DEAL_ID,
    round,
    artifacts: files,
    note: round > 1 ? "Revision 1: added the missing 1:1 version." : "Delivered 2 illustrations.",
    source: "ai",
    model: "google/gemini-2.5-flash",
    submittedAt: "2026-10-05T21:51:36.034Z",
  };
}

function check(rule: VerificationRule, result: CheckResult, evidence: string, artifactIds: string[] = []): VerificationCheck {
  return {
    ruleId: rule.id,
    kind: rule.kind,
    condition: rule.description,
    required: rule.required,
    evaluator: rule.evaluator,
    result,
    confidence: rule.evaluator === "ai" ? 0.95 : 1,
    evidence,
    explanation: "Explanation.",
    artifactIds,
  };
}

const FAILING_RULE: Partial<Record<VerificationDecision, { ruleId: string; result: CheckResult; evidence: string; artifactIds: string[] }>> = {
  revision_required: { ruleId: "R2", result: "fail", evidence: "1:1 missing on illustration #2", artifactIds: ["art_2w"] },
  reject: { ruleId: "R2", result: "fail", evidence: "1:1 missing on illustration #2", artifactIds: ["art_2w"] },
  human_review: { ruleId: "R5", result: "uncertain", evidence: "Not evaluated: the AI verifier was unavailable.", artifactIds: [] },
};

export function report(round: number, decision: VerificationDecision): VerificationReport {
  const failing = FAILING_RULE[decision];
  const checks = RULES.map((rule) =>
    failing !== undefined && failing.ruleId === rule.id
      ? check(rule, failing.result, failing.evidence, failing.artifactIds)
      : check(rule, "pass", "ok"),
  );
  const failed = checks.filter((entry) => entry.result === "fail");
  return {
    id: `rep_${round}`,
    dealId: DEAL_ID,
    submissionId: `sub_${round}`,
    round,
    contractHash: HASH,
    checks,
    decision,
    confidence: 0.95,
    summary: failed.length > 0 ? "1 condition failed: 1:1 missing on illustration #2." : "All 6 contract conditions verified.",
    failedRuleIds: failed.map((entry) => entry.ruleId),
    degraded: false,
    model: "google/gemini-2.5-flash",
    createdAt: "2026-10-05T21:51:37.448Z",
  };
}

function policyFor(status: DealStatus): PolicyEvaluation | null {
  if (status === "negotiating" || status === "agreed" || status === "contracted" || status === "negotiation_failed") return null;
  const base = { spentTodayMinor: 0, evaluatedAt: "2026-10-05T21:51:35.782Z" };
  if (status === "blocked") {
    return {
      ...base,
      outcome: "block",
      checks: [{ id: "daily_limit", label: "Daily limit", outcome: "block", detail: "$28.00 would exceed the $20.00 daily limit." }],
    };
  }
  if (status === "awaiting_approval" || status === "declined") {
    return {
      ...base,
      outcome: "needs_approval",
      checks: [{ id: "autonomous_limit", label: "Autonomous limit", outcome: "needs_approval", detail: "$28.00 exceeds the $10.00 autonomous limit." }],
    };
  }
  return { ...base, outcome: "allow", checks: [{ id: "autonomous_limit", label: "Autonomous limit", outcome: "pass", detail: "Within the limit." }] };
}

function paymentFor(status: DealStatus): PaymentRecord | null {
  switch (status) {
    case "awaiting_payment":
      return payment({ status: "created", authorizationId: null, authorizedMinor: 0, approveUrl: "/pay/simulated/SIM-O-1" });
    case "authorized":
    case "submitted":
    case "revision_required":
    case "in_review":
    case "verified":
    case "rejecting":
      return payment({ status: "authorized" });
    case "completed":
      return payment({ status: "captured", capturedMinor: 2800, captureId: "SIM-C-1" });
    case "rejected":
      return payment({ status: "voided" });
    case "cancelled":
      return payment({ status: "voided", authorizationId: null, authorizedMinor: 0 });
    case "expired":
      return payment({ status: "expired" });
    case "failed":
      return payment({ status: "failed" });
    default:
      return null;
  }
}

function reportsFor(status: DealStatus): VerificationReport[] {
  switch (status) {
    case "revision_required":
      return [report(1, "revision_required")];
    case "in_review":
      return [report(1, "human_review")];
    case "verified":
    case "completed":
    case "failed":
      return [report(1, "capture_eligible")];
    case "rejecting":
    case "rejected":
      return [report(1, "reject")];
    default:
      return [];
  }
}

const DELIVERED: readonly DealStatus[] = ["submitted", "revision_required", "in_review", "verified", "rejecting", "completed", "rejected", "failed"];
const BEFORE_AGREEMENT: readonly DealStatus[] = ["negotiating", "negotiation_failed"];
const BEFORE_CONTRACT: readonly DealStatus[] = ["negotiating", "negotiation_failed", "agreed"];

/** A deal view as the API would return it for a deal in `status`. Override any field. */
export function deal(overrides: Partial<DealView> & { status: DealStatus }): DealView {
  const { status } = overrides;
  const agreed = !BEFORE_AGREEMENT.includes(status);
  const revisions = overrides.revisions ?? { used: status === "revision_required" ? 1 : 0, limit: 1 };
  const base: DealView = {
    id: DEAL_ID,
    code: "PACT-TEST",
    status,
    statusLabel: status,
    scenarioId: "revision",
    intent: "I need 2 launch banners in 16:9 and 1:1 by tomorrow at 6 PM. Budget is $32, with one revision.",
    createdAt: "2026-10-05T21:51:14.300Z",
    updatedAt: "2026-10-05T21:52:04.460Z",
    isOwner: true,
    seller: {
      id: "quickdraw",
      name: "Quickdraw Collective",
      tagline: "Fast, cheap banner sets.",
      categories: ["illustration"],
      trust: "established",
      completedDeals: 61,
      firstPassRate: 0.72,
      demoFault: "omits_variant",
    },
    mandate: {
      summary: "2 launch banners for $32",
      category: "illustration",
      deliverable: { kind: "illustration", count: 2, aspectRatios: ["16:9", "1:1"], subject: "launch banners", style: null },
      minCount: 2,
      budgetMinor: 3200,
      deadline: DEADLINE,
      revisionsWanted: 1,
      minRevisions: 1,
      notes: [],
    },
    negotiation: {
      status: status === "negotiation_failed" ? "failed" : agreed ? "agreed" : "open",
      moves: [],
      agreedTerms: agreed ? { priceMinor: 2800, deadline: DEADLINE, revisionLimit: 1, count: 2 } : null,
      failureReason: status === "negotiation_failed" ? "The agents could not agree." : null,
      maxMoves: 8,
      listPriceMinor: agreed ? 3000 : null,
    },
    contract: BEFORE_CONTRACT.includes(status) ? null : contractOf(2800),
    policy: policyFor(status),
    payment: paymentFor(status),
    submissions: DELIVERED.includes(status) ? [submission(1)] : [],
    reports: reportsFor(status),
    audit: [],
    revisions,
    humanDecision: null,
    next: nextStepFor({ status, nextNegotiator: status === "negotiating" ? "seller" : null, revisionsUsed: revisions.used, revisionLimit: revisions.limit }),
    flags: { aiDegraded: false, simulatedPayment: true, auditChainValid: true },
    lastError: null,
  };
  return { ...base, ...overrides };
}

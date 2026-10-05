/**
 * Builders shared by the studio's unit tests. Not imported by production code.
 */
import type { CallStructured, StructuredCall } from "../ai/gateway";
import type { DeliveryContext } from "../ai/types";
import { deriveVerificationRules } from "../domain/contract";
import type {
  Artifact,
  Contract,
  DeliverableSpec,
  Submission,
  VerificationCheck,
  VerificationReport,
} from "../domain/schemas";
import { getSeller, type SellerProfile } from "../domain/sellers";

export const TEST_NOW = new Date("2026-10-06T09:00:00.000Z");
export const TEST_MODEL = "test/studio-model";
const DEAL_ID = "deal_studiotest01";
const DEADLINE = "2026-10-07T18:00:00.000Z";

export function seller(id: "northwind" | "quickdraw" | "lingua" | "pixelharbor"): SellerProfile {
  const profile = getSeller(id);
  if (profile === undefined) throw new Error(`unknown test seller ${id}`);
  return profile;
}

export function contractFor(deliverable: DeliverableSpec, profile: SellerProfile): Contract {
  return {
    contractId: "ctr_studiotest01",
    schemaVersion: 1,
    dealId: DEAL_ID,
    createdAt: TEST_NOW.toISOString(),
    title: "Studio test contract",
    category: deliverable.kind === "illustration" ? "illustration" : "copywriting",
    buyer: { id: "buyer-agent", name: "Buyer Agent" },
    seller: { id: profile.id, name: profile.name },
    price: { amountMinor: 4500, currency: "USD" },
    deadline: DEADLINE,
    revisionLimit: 1,
    deliverables: [deliverable],
    verificationRules: deriveVerificationRules(deliverable, {
      priceMinor: 4500,
      deadline: DEADLINE,
      revisionLimit: 1,
      count: deliverable.count,
    }),
    settlement: {
      trigger: "verified_delivery",
      autoCaptureMinConfidence: 0.85,
      humanReviewMinConfidence: 0.5,
      onExhaustedRevisions: "void_authorization",
    },
  };
}

export function firstDelivery(deliverable: DeliverableSpec, profile: SellerProfile): DeliveryContext {
  return {
    contract: contractFor(deliverable, profile),
    seller: profile,
    round: 1,
    previousReport: null,
    previousSubmission: null,
    now: TEST_NOW,
  };
}

export function submissionOf(artifacts: Artifact[], round = 1, source: Submission["source"] = "scripted"): Submission {
  return {
    id: `sub_studiotest0${round}`,
    dealId: DEAL_ID,
    round,
    artifacts,
    note: "Delivered.",
    source,
    model: source === "ai" ? TEST_MODEL : null,
    submittedAt: "2026-10-06T10:00:00.000Z",
  };
}

export function reportOf(submission: Submission, checks: VerificationCheck[]): VerificationReport {
  const failed = checks.filter((check) => check.result === "fail");
  return {
    id: `rep_studiotest0${submission.round}`,
    dealId: DEAL_ID,
    submissionId: submission.id,
    round: submission.round,
    contractHash: "0".repeat(64),
    checks,
    decision: failed.length > 0 ? "revision_required" : "human_review",
    confidence: failed.length > 0 ? 1 : 0,
    summary: failed.length > 0 ? "A required condition failed." : "A human asked for a revision.",
    failedRuleIds: failed.map((check) => check.ruleId),
    degraded: false,
    model: null,
    createdAt: "2026-10-06T10:05:00.000Z",
  };
}

export function failedCheck(
  kind: VerificationCheck["kind"],
  artifactIds: string[],
  evidence = "did not meet the contract",
): VerificationCheck {
  return {
    ruleId: "R9",
    kind,
    condition: `Condition for ${kind}`,
    required: true,
    evaluator: kind === "brief_adherence" ? "ai" : "deterministic",
    result: "fail",
    confidence: 1,
    evidence,
    explanation: "Test finding.",
    artifactIds,
  };
}

export function revision(
  first: DeliveryContext,
  previous: Submission,
  checks: VerificationCheck[],
  round = previous.round + 1,
): DeliveryContext {
  return { ...first, round, previousSubmission: previous, previousReport: reportOf(previous, checks) };
}

export interface StubCall {
  call: CallStructured;
  /** Every request the studio made, in order. */
  requests: StructuredCall<unknown>[];
}

/**
 * A model stand-in. Like the real gateway it only ever returns schema-valid output: whatever
 * `respond` produces is parsed with the caller's schema first.
 */
export function stubCall(respond: (request: StructuredCall<unknown>) => unknown): StubCall {
  const requests: StructuredCall<unknown>[] = [];
  const call: CallStructured = async <T>(request: StructuredCall<T>) => {
    requests.push(request as StructuredCall<unknown>);
    return {
      output: request.schema.parse(respond(request as StructuredCall<unknown>)),
      model: TEST_MODEL,
      latencyMs: 7,
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  };
  return { call, requests };
}

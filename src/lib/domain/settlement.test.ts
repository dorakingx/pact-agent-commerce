import { describe, expect, it } from "vitest";
import type { PaymentRecord } from "../payments/types";
import type { HumanDecision, HumanDecisionKind, SignedContract, VerificationCheck, VerificationReport } from "./schemas";
import { captureAmountMinor, checkCaptureAllowed, checkVoidAllowed, type CaptureGuardInput } from "./settlement";
import { DEAL_STATUSES, PAYMENT_STATUSES, type DealStatus, type PaymentStatus } from "./status";
import { completeIllustrationSet, signedContractFor, submissionOf } from "./test-support";
import { buildReport } from "./verification";

const NOW = new Date("2026-10-07T04:00:00.000Z");
const REPORT_AT = "2026-10-07T03:41:00.000Z";

/** Happy-path contract at $47.00 with one revision. */
const signed = signedContractFor("happy-path");
const submission = submissionOf(completeIllustrationSet());

function checksWith(overrides: Record<string, Partial<VerificationCheck>> = {}): VerificationCheck[] {
  return signed.contract.verificationRules.map((rule) => ({
    ruleId: rule.id,
    kind: rule.kind,
    condition: rule.description,
    required: rule.required,
    evaluator: rule.evaluator,
    result: "pass",
    confidence: rule.evaluator === "ai" ? 0.93 : 1,
    evidence: "observed",
    explanation: "Explanation.",
    artifactIds: [],
    ...overrides[rule.id],
  }));
}

function reportFrom(checks: VerificationCheck[], revisionsUsed = 0, contract: SignedContract = signed): VerificationReport {
  return buildReport({
    id: "rep_test00000001",
    signed: contract,
    submission,
    checks,
    revisionsUsed,
    manipulationSuspected: false,
    degraded: false,
    model: "test/model",
    now: new Date(REPORT_AT),
  });
}

const eligibleReport = reportFrom(checksWith());
const reviewReport = reportFrom(checksWith({ R5: { result: "uncertain", confidence: 0.4 } }));
const revisionReport = reportFrom(checksWith({ R2: { result: "fail", evidence: "1:1 missing on illustration #2" } }));
const rejectReport = reportFrom(checksWith({ R2: { result: "fail", evidence: "1:1 missing on illustration #2" } }), 1);

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    provider: "simulated",
    mode: "interactive",
    status: "authorized",
    orderId: "5O190127TN364715T",
    authorizationId: "0VF52814937998046",
    captureId: null,
    amountMinor: 4700,
    authorizedMinor: 4700,
    capturedMinor: 0,
    currency: "USD",
    approveUrl: null,
    authorizationExpiresAt: "2026-11-04T09:10:00.000Z",
    payerEmailMasked: "sb****@personal.example.com",
    lastError: null,
    webhookConfirmed: { authorized: true, captured: false, voided: false },
    updatedAt: "2026-10-06T09:10:00.000Z",
    ...overrides,
  };
}

function decision(kind: HumanDecisionKind, overrides: Partial<HumanDecision> = {}): HumanDecision {
  return { kind, percent: null, reason: null, decidedAt: "2026-10-07T03:50:00.000Z", ...overrides };
}

const valid: CaptureGuardInput = {
  dealStatus: "verified",
  signed,
  payment: payment(),
  latestReport: eligibleReport,
  humanDecision: null,
  now: NOW,
};
const guard = (overrides: Partial<CaptureGuardInput> = {}) => checkCaptureAllowed({ ...valid, ...overrides });
const codes = (overrides: Partial<CaptureGuardInput> = {}): string[] => guard(overrides).violations.map((v) => v.code);

function expectBlocked(overrides: Partial<CaptureGuardInput>, code: string): void {
  const result = guard(overrides);
  expect(result.allowed).toBe(false);
  expect(result.amountMinor).toBe(0);
  expect(result.violations.map((v) => v.code)).toContain(code);
  for (const violation of result.violations) {
    expect(violation.detail).toMatch(/^[A-Z].*\.$/);
    expect(violation.detail).not.toMatch(/undefined|NaN|\[object/);
  }
}

describe("fixtures", () => {
  it("cover each verification decision", () => {
    expect(eligibleReport.decision).toBe("capture_eligible");
    expect(reviewReport.decision).toBe("human_review");
    expect(revisionReport.decision).toBe("revision_required");
    expect(rejectReport.decision).toBe("reject");
  });
});

describe("checkCaptureAllowed — the one way through", () => {
  it("allows capturing the full contract price when everything agrees", () => {
    expect(guard()).toEqual({ allowed: true, violations: [], amountMinor: 4700 });
  });

  it("is pure", () => {
    const input = structuredClone({ ...valid, now: undefined });
    guard();
    guard();
    expect({ ...valid, now: undefined }).toEqual(input);
  });
});

describe("checkCaptureAllowed — deal status", () => {
  it("refuses in every status except verified [status_not_verified]", () => {
    for (const dealStatus of DEAL_STATUSES) {
      if (dealStatus === "verified") continue;
      expectBlocked({ dealStatus }, "status_not_verified");
      expect(codes({ dealStatus })).toEqual(["status_not_verified"]);
    }
  });
});

describe("checkCaptureAllowed — contract integrity", () => {
  it("refuses without a contract [contract_missing]", () => {
    expectBlocked({ signed: null }, "contract_missing");
  });

  it("refuses when the contract was altered after signing [contract_hash_mismatch]", () => {
    const cheaper = structuredClone(signed);
    cheaper.contract.price.amountMinor = 100;
    expectBlocked({ signed: cheaper, payment: payment({ amountMinor: 100, authorizedMinor: 100 }) }, "contract_hash_mismatch");

    const relaxed = structuredClone(signed);
    relaxed.contract.verificationRules[1].required = false;
    expect(codes({ signed: relaxed })).toEqual(["contract_hash_mismatch"]);

    const lowered = structuredClone(signed);
    lowered.contract.settlement.autoCaptureMinConfidence = 0.5;
    expect(codes({ signed: lowered })).toEqual(["contract_hash_mismatch"]);
  });

  it("refuses when the hash was swapped for another contract's", () => {
    const other = signedContractFor("happy-path", { terms: { priceMinor: 100 } });
    expect(codes({ signed: { contract: signed.contract, termsHash: other.termsHash } })).toEqual(["contract_hash_mismatch", "report_contract_mismatch"]);
  });
});

describe("checkCaptureAllowed — payment state", () => {
  it("refuses without a payment record [payment_missing]", () => {
    expectBlocked({ payment: null }, "payment_missing");
  });

  it("refuses unless funds are authorized [not_authorized]", () => {
    const notHeld: PaymentStatus[] = ["none", "created", "approved", "voided", "expired", "failed"];
    for (const status of notHeld) {
      expectBlocked({ payment: payment({ status }) }, "not_authorized");
      expect(codes({ payment: payment({ status }) })).toEqual(["not_authorized"]);
    }
    expect(guard({ payment: payment({ status: "voided" }) }).violations[0].detail).toContain("Voided");
  });

  it("refuses an authorized record with no PayPal authorization id [not_authorized]", () => {
    expect(codes({ payment: payment({ authorizationId: null }) })).toEqual(["not_authorized"]);
  });

  it("refuses to capture twice [already_captured]", () => {
    // Capture after capture, in each way the record can show it.
    expect(codes({ payment: payment({ status: "captured", capturedMinor: 4700, captureId: "3C679366HH908993F" }) })).toEqual(["already_captured"]);
    expect(codes({ payment: payment({ capturedMinor: 2350 }) })).toEqual(["already_captured"]);
    expect(codes({ payment: payment({ capturedMinor: 2350, captureId: "3C679366HH908993F" }) })).toEqual(["already_captured"]);
    expect(codes({ payment: payment({ status: "captured" }) })).toEqual(["already_captured"]);
    expectBlocked({ payment: payment({ capturedMinor: 1 }) }, "already_captured");
  });

  it("lets a capture PayPal left pending be asked for again: a capture id alone is not a capture", () => {
    // Still authorized, nothing captured, but the id of the pending capture is on record.
    const pending = payment({ captureId: "3C679366HH908993F", lastError: { issue: "CAPTURE_PENDING", message: "pending", debugId: null, at: "2026-10-06T08:00:00.000Z" } });
    expect(guard({ payment: pending })).toEqual({ allowed: true, violations: [], amountMinor: 4700 });
    // Every other check still applies to that record.
    expect(codes({ payment: { ...pending, amountMinor: 4600 } })).toEqual(["amount_mismatch"]);
    expect(codes({ payment: { ...pending, authorizationId: null } })).toEqual(["not_authorized"]);
    expect(codes({ payment: { ...pending, status: "failed" } })).toEqual(["not_authorized"]);
    expect(codes({ payment: pending, dealStatus: "in_review" })).toContain("status_not_verified");
  });

  it("refuses when the payment is not for the contract price [amount_mismatch]", () => {
    expectBlocked({ payment: payment({ amountMinor: 4600 }) }, "amount_mismatch");
    expectBlocked({ payment: payment({ amountMinor: 4800, authorizedMinor: 4800 }) }, "amount_mismatch");
    expect(guard({ payment: payment({ amountMinor: 4800, authorizedMinor: 4800 }) }).violations[0].detail).toBe(
      "The payment is for $48.00 but the contract price is $47.00.",
    );
  });

  it("refuses when less is authorized than would be captured [authorization_insufficient]", () => {
    expect(codes({ payment: payment({ authorizedMinor: 4699 }) })).toEqual(["authorization_insufficient"]);
    expect(codes({ payment: payment({ authorizedMinor: 0 }) })).toEqual(["authorization_insufficient"]);
    expect(guard({ payment: payment({ authorizedMinor: 4700 }) }).allowed).toBe(true);
    expect(guard({ payment: payment({ authorizedMinor: 5000 }) }).allowed).toBe(true);
  });

  it("refuses an expired authorization [authorization_expired]", () => {
    expectBlocked({ payment: payment({ authorizationExpiresAt: "2026-10-07T03:59:59.999Z" }) }, "authorization_expired");
    // Expiring exactly now is already too late.
    expect(codes({ payment: payment({ authorizationExpiresAt: NOW.toISOString() }) })).toEqual(["authorization_expired"]);
    expect(guard({ payment: payment({ authorizationExpiresAt: "2026-10-07T04:00:00.001Z" }) }).allowed).toBe(true);
  });

  it("treats an unknown expiry as open and an unreadable one as expired", () => {
    expect(guard({ payment: payment({ authorizationExpiresAt: null }) }).allowed).toBe(true);
    expect(codes({ payment: payment({ authorizationExpiresAt: "sometime" }) })).toEqual(["authorization_expired"]);
  });
});

describe("checkCaptureAllowed — verification report", () => {
  it("refuses without a report [report_missing]", () => {
    expectBlocked({ latestReport: null }, "report_missing");
    expect(codes({ latestReport: null })).toEqual(["report_missing"]);
  });

  it("refuses a report made for a different contract [report_contract_mismatch]", () => {
    const otherContract = signedContractFor("happy-path", { terms: { priceMinor: 4600 } });
    const foreign = reportFrom(checksWith(), 0, otherContract);
    expect(foreign.decision).toBe("capture_eligible");
    expect(codes({ latestReport: foreign })).toEqual(["report_contract_mismatch"]);
    expectBlocked({ latestReport: { ...eligibleReport, contractHash: "0".repeat(64) } }, "report_contract_mismatch");
  });

  it("can never capture on a failed verification, whatever a human says [verification_not_passed]", () => {
    const releases = [null, decision("release_payment"), decision("release_partial", { percent: 50 }), decision("approve_spend")];
    for (const latestReport of [revisionReport, rejectReport]) {
      for (const humanDecision of releases) {
        expectBlocked({ latestReport, humanDecision }, "verification_not_passed");
        expect(codes({ latestReport, humanDecision })).toEqual(["verification_not_passed"]);
      }
    }
  });

  it("refuses a report whose decision is not one it knows", () => {
    const strange = { ...eligibleReport, decision: "auto_approve" } as unknown as VerificationReport;
    expect(codes({ latestReport: strange })).toEqual(["verification_not_passed"]);
  });

  it("refuses a capture-eligible report whose own checks do not support it [report_inconsistent]", () => {
    const withCheck = (ruleId: string, change: Partial<VerificationCheck>): VerificationReport => ({
      ...eligibleReport,
      checks: eligibleReport.checks.map((check) => (check.ruleId === ruleId ? { ...check, ...change } : check)),
    });
    expect(codes({ latestReport: withCheck("R2", { result: "fail" }) })).toEqual(["report_inconsistent"]);
    expect(codes({ latestReport: withCheck("R5", { result: "uncertain", confidence: 0 }) })).toEqual(["report_inconsistent"]);
    expect(codes({ latestReport: withCheck("R5", { confidence: 0.84 }) })).toEqual(["report_inconsistent"]);
    expect(codes({ latestReport: { ...eligibleReport, checks: eligibleReport.checks.filter((check) => check.ruleId !== "R6") } })).toEqual(["report_inconsistent"]);
    expect(codes({ latestReport: { ...eligibleReport, checks: [] } })).toEqual(["report_inconsistent"]);
    expect(guard({ latestReport: withCheck("R5", { confidence: 0.85 }) }).allowed).toBe(true);
  });
});

describe("checkCaptureAllowed — human review", () => {
  const inReview = { latestReport: reviewReport };

  it("refuses a reviewed delivery until a human releases it [human_release_missing]", () => {
    expectBlocked({ ...inReview, humanDecision: null }, "human_release_missing");
    expect(codes({ ...inReview })).toEqual(["human_release_missing"]);
  });

  it("does not count other kinds of human decision as a release", () => {
    const notReleases: HumanDecisionKind[] = ["approve_spend", "decline_spend", "request_revision", "reject_delivery", "cancel_payment"];
    for (const kind of notReleases) {
      expect(codes({ ...inReview, humanDecision: decision(kind) }), kind).toEqual(["human_release_missing"]);
    }
  });

  it("captures the full price after a release made at or after the report", () => {
    expect(guard({ ...inReview, humanDecision: decision("release_payment") })).toEqual({ allowed: true, violations: [], amountMinor: 4700 });
    expect(guard({ ...inReview, humanDecision: decision("release_payment", { decidedAt: REPORT_AT }) }).allowed).toBe(true);
  });

  it("ignores a release that predates the report it would release", () => {
    // The human released an EARLIER delivery; a newer report has since asked for review again.
    const stale = decision("release_payment", { decidedAt: "2026-10-07T03:40:59.999Z" });
    expect(codes({ ...inReview, humanDecision: stale })).toEqual(["human_release_missing"]);
    const unreadable = decision("release_payment", { decidedAt: "just now" });
    expect(codes({ ...inReview, humanDecision: unreadable })).toEqual(["human_release_missing"]);
  });

  it("captures the stated share for a partial release", () => {
    const partial = (percent: number) => guard({ ...inReview, humanDecision: decision("release_partial", { percent }) });
    expect(partial(50)).toEqual({ allowed: true, violations: [], amountMinor: 2350 });
    expect(partial(1).amountMinor).toBe(47);
    expect(partial(99).amountMinor).toBe(4653);
    expect(partial(33).amountMinor).toBe(1551);
  });

  it("refuses a partial release without a valid whole percentage [partial_percent_invalid]", () => {
    for (const percent of [null, 0, 100, 150, -5, 50.5, Number.NaN]) {
      const result = guard({ ...inReview, humanDecision: decision("release_partial", { percent }) });
      expect(result.allowed, String(percent)).toBe(false);
      expect(result.amountMinor).toBe(0);
      expect(result.violations.map((v) => v.code)).toEqual(["partial_percent_invalid"]);
    }
  });

  it("checks the partial amount, not the full price, against the authorization", () => {
    const half = decision("release_partial", { percent: 50 });
    expect(guard({ ...inReview, humanDecision: half, payment: payment({ authorizedMinor: 2350 }) }).allowed).toBe(true);
    expect(codes({ ...inReview, humanDecision: half, payment: payment({ authorizedMinor: 2349 }) })).toEqual(["authorization_insufficient"]);
  });

  it("does not let a leftover human decision change an automatic capture", () => {
    // The report is capture-eligible on its own; an old partial release must not shrink the capture.
    const leftover = decision("release_partial", { percent: 10 });
    expect(guard({ humanDecision: leftover })).toEqual({ allowed: true, violations: [], amountMinor: 4700 });
    expect(guard({ humanDecision: decision("reject_delivery") }).allowed).toBe(true);
  });

  it("still applies every other guard after a human release", () => {
    const released = { ...inReview, humanDecision: decision("release_payment") };
    expect(codes({ ...released, dealStatus: "in_review" })).toEqual(["status_not_verified"]);
    expect(codes({ ...released, payment: payment({ status: "voided" }) })).toEqual(["not_authorized"]);
    expect(codes({ ...released, payment: payment({ capturedMinor: 4700, status: "captured" }) })).toEqual(["already_captured"]);
  });
});

describe("checkCaptureAllowed — reporting", () => {
  it("collects every violation, not just the first", () => {
    const tampered = structuredClone(signed);
    tampered.contract.price.amountMinor = 4600;
    const result = guard({
      dealStatus: "submitted",
      signed: tampered,
      payment: payment({ status: "authorized", authorizationExpiresAt: "2026-10-01T00:00:00.000Z", authorizedMinor: 100 }),
      latestReport: { ...revisionReport, contractHash: "f".repeat(64) },
    });
    expect(result.allowed).toBe(false);
    expect(result.amountMinor).toBe(0);
    expect(result.violations.map((v) => v.code)).toEqual([
      "status_not_verified",
      "contract_hash_mismatch",
      "amount_mismatch",
      "authorization_expired",
      "report_contract_mismatch",
      "verification_not_passed",
      "authorization_insufficient",
    ]);
  });

  it("reports everything that is missing when nothing exists yet", () => {
    expect(codes({ dealStatus: "negotiating", signed: null, payment: null, latestReport: null })).toEqual([
      "status_not_verified",
      "contract_missing",
      "payment_missing",
      "report_missing",
    ]);
  });
});

describe("captureAmountMinor", () => {
  it("is the full price for an automatic capture and for a full release", () => {
    expect(captureAmountMinor(signed, eligibleReport, null)).toBe(4700);
    expect(captureAmountMinor(signed, reviewReport, decision("release_payment"))).toBe(4700);
  });

  it("is the rounded share of the price for a partial release, never less than one cent", () => {
    expect(captureAmountMinor(signed, reviewReport, decision("release_partial", { percent: 50 }))).toBe(2350);
    expect(captureAmountMinor(signed, reviewReport, decision("release_partial", { percent: 33 }))).toBe(1551);
    const cheap = signedContractFor("happy-path", { terms: { priceMinor: 100 } });
    const cheapReview = reportFrom(checksWith({ R5: { result: "uncertain", confidence: 0.4 } }), 0, cheap);
    expect(captureAmountMinor(cheap, cheapReview, decision("release_partial", { percent: 1 }))).toBe(1);
    expect(captureAmountMinor(cheap, cheapReview, decision("release_partial", { percent: 99 }))).toBe(99);
  });

  it("applies the partial share only to the review it was made for", () => {
    const half = decision("release_partial", { percent: 50 });
    expect(captureAmountMinor(signed, eligibleReport, half)).toBe(4700);
    expect(captureAmountMinor(signed, reviewReport, { ...half, decidedAt: "2026-10-07T03:00:00.000Z" })).toBe(4700);
  });

  it("throws rather than guess when a partial release has no valid percentage", () => {
    expect(() => captureAmountMinor(signed, reviewReport, decision("release_partial"))).toThrow(RangeError);
    expect(() => captureAmountMinor(signed, reviewReport, decision("release_partial", { percent: 100 }))).toThrow(/between 1 and 99/);
  });
});

describe("checkVoidAllowed", () => {
  const voidCodes = (dealStatus: DealStatus, record: PaymentRecord | null): string[] =>
    checkVoidAllowed({ dealStatus, payment: record }).violations.map((v) => v.code);

  it("allows voiding held or not-yet-authorized funds when a delivery is rejected", () => {
    expect(checkVoidAllowed({ dealStatus: "rejecting", payment: payment() })).toEqual({ allowed: true, violations: [] });
    for (const status of ["created", "approved", "authorized"] as const) {
      expect(checkVoidAllowed({ dealStatus: "rejecting", payment: payment({ status }) }).allowed, status).toBe(true);
    }
  });

  it("allows voiding on the cancellation and clean-up paths", () => {
    for (const dealStatus of ["awaiting_payment", "authorized", "cancelled", "expired", "failed", "declined"] as const) {
      expect(checkVoidAllowed({ dealStatus, payment: payment() }).allowed, dealStatus).toBe(true);
    }
  });

  it("refuses when there is no payment [payment_missing]", () => {
    expect(voidCodes("rejecting", null)).toEqual(["payment_missing"]);
  });

  it("refuses once anything has been captured [already_captured]", () => {
    expect(voidCodes("rejecting", payment({ status: "captured", capturedMinor: 4700, captureId: "3C679366HH908993F" }))).toEqual(["already_captured"]);
    expect(voidCodes("rejecting", payment({ capturedMinor: 1 }))).toEqual(["already_captured"]);
    expect(voidCodes("rejecting", payment({ capturedMinor: 1, captureId: "3C679366HH908993F" }))).toEqual(["already_captured"]);
  });

  it("allows releasing a hold whose capture never completed (a capture id with nothing captured)", () => {
    // A pending capture that PayPal then declined leaves the id behind; the hold is still a hold.
    expect(voidCodes("failed", payment({ captureId: "3C679366HH908993F" }))).toEqual([]);
    expect(voidCodes("verified", payment({ captureId: "3C679366HH908993F" }))).toEqual(["status_not_voidable"]);
  });

  it("refuses when there is nothing left to void [not_voidable]", () => {
    for (const status of ["none", "voided", "expired", "failed"] as const) {
      expect(voidCodes("rejecting", payment({ status })), status).toEqual(["not_voidable"]);
    }
    expect(checkVoidAllowed({ dealStatus: "rejecting", payment: payment({ status: "voided" }) }).violations[0].detail).toBe(
      'There is nothing to void: the payment is "Voided".',
    );
  });

  it("refuses to take back a payment the seller has earned [status_not_voidable]", () => {
    expect(voidCodes("verified", payment())).toEqual(["status_not_voidable"]);
    expect(voidCodes("completed", payment({ status: "captured", capturedMinor: 4700 }))).toEqual(["status_not_voidable", "already_captured"]);
  });
});

describe("capture and void are mutually exclusive", () => {
  it("never allows both for the same state", () => {
    const reports = [eligibleReport, reviewReport, revisionReport, rejectReport, null];
    const decisions = [null, decision("release_payment"), decision("release_partial", { percent: 50 }), decision("reject_delivery")];
    let captures = 0;
    let voids = 0;
    for (const dealStatus of DEAL_STATUSES) {
      for (const status of PAYMENT_STATUSES) {
        for (const capturedMinor of [0, 4700]) {
          const record = payment({ status, capturedMinor });
          const mayVoid = checkVoidAllowed({ dealStatus, payment: record }).allowed;
          if (mayVoid) voids += 1;
          for (const latestReport of reports) {
            for (const humanDecision of decisions) {
              const mayCapture = checkCaptureAllowed({ dealStatus, signed, payment: record, latestReport, humanDecision, now: NOW }).allowed;
              if (mayCapture) captures += 1;
              expect(mayCapture && mayVoid, `${dealStatus}/${status}/${capturedMinor}`).toBe(false);
            }
          }
        }
      }
    }
    // Capture is possible in exactly one state (verified + authorized + nothing captured):
    // the eligible report with any of the 4 decisions, or the review report with either release.
    expect(captures).toBe(6);
    expect(voids).toBeGreaterThan(10);
    // Thousands of expect() calls: well under a second alone, but slower than the default 5 s
    // when the whole suite runs in parallel on a busy machine.
  }, 30_000);
});

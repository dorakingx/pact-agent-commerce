/**
 * Settlement guards — the last line of defence before money moves.
 *
 * The payment orchestrator calls these immediately before every capture or void, with the
 * state it has just re-read from storage. They are pure and they trust nothing upstream: the
 * deal status, the contract fingerprint, the PayPal record and the verification report must
 * all agree independently, or the answer is no. Every reason is collected (not just the first)
 * so a blocked capture can be explained in full in the audit log.
 */
import type { PaymentRecord } from "../payments/types";
import { verifyContractHash } from "./contract";
import { formatUtcTimestamp, parseTimestamp } from "./format";
import { formatMoney, percentOf } from "./money";
import type { HumanDecision, SignedContract, VerificationReport } from "./schemas";
import { DEAL_STATUS_LABEL, PAYMENT_STATUS_LABEL, type DealStatus } from "./status";

export interface GuardViolation {
  /** Stable machine code, e.g. "contract_hash_mismatch". */
  code: string;
  /** Plain-language explanation for the audit log. */
  detail: string;
}

export interface CaptureGuardInput {
  dealStatus: DealStatus;
  signed: SignedContract | null;
  payment: PaymentRecord | null;
  latestReport: VerificationReport | null;
  humanDecision: HumanDecision | null;
  now: Date;
}

const MIN_PARTIAL_PERCENT = 1;
const MAX_PARTIAL_PERCENT = 99;

function violation(code: string, detail: string): GuardViolation {
  return { code, detail };
}

function isReleaseDecision(decision: HumanDecision): boolean {
  return decision.kind === "release_payment" || decision.kind === "release_partial";
}

function isValidPartialPercent(percent: number | null): percent is number {
  return (
    percent !== null && Number.isInteger(percent) && percent >= MIN_PARTIAL_PERCENT && percent <= MAX_PARTIAL_PERCENT
  );
}

/**
 * A human release only counts for the report it was made about: the report must be the one
 * awaiting review, and the decision must not predate it.
 */
function humanReleaseApplies(report: VerificationReport, decision: HumanDecision | null): decision is HumanDecision {
  if (decision === null || report.decision !== "human_review" || !isReleaseDecision(decision)) return false;
  const decidedMs = parseTimestamp(decision.decidedAt);
  const reportMs = parseTimestamp(report.createdAt);
  return decidedMs !== null && reportMs !== null && decidedMs >= reportMs;
}

/**
 * The amount a capture would move: the full contract price, or — when a human resolved a
 * review with a partial release — that percentage of the price (at least one minor unit).
 *
 * @throws RangeError when a partial release carries no valid percentage; a malformed partial
 *   decision must never silently become a full capture.
 */
export function captureAmountMinor(
  signed: SignedContract,
  latestReport: VerificationReport,
  humanDecision: HumanDecision | null,
): number {
  const priceMinor = signed.contract.price.amountMinor;
  if (!humanReleaseApplies(latestReport, humanDecision) || humanDecision.kind !== "release_partial") {
    return priceMinor;
  }
  if (!isValidPartialPercent(humanDecision.percent)) {
    throw new RangeError(
      `A partial release needs a whole percentage between ${MIN_PARTIAL_PERCENT} and ${MAX_PARTIAL_PERCENT}`,
    );
  }
  return Math.max(1, percentOf(priceMinor, humanDecision.percent));
}

/** The amount a capture would move, or null while the inputs that determine it are missing or invalid. */
function prospectiveAmountMinor(
  signed: SignedContract | null,
  report: VerificationReport | null,
  humanDecision: HumanDecision | null,
): number | null {
  if (signed === null || report === null) return null;
  const invalidPartial =
    humanReleaseApplies(report, humanDecision) &&
    humanDecision.kind === "release_partial" &&
    !isValidPartialPercent(humanDecision.percent);
  return invalidPartial ? null : captureAmountMinor(signed, report, humanDecision);
}

function contractViolations(signed: SignedContract | null): GuardViolation[] {
  if (signed === null) return [violation("contract_missing", "There is no contract for this deal.")];
  if (!verifyContractHash(signed)) {
    return [
      violation(
        "contract_hash_mismatch",
        "The contract no longer matches its recorded fingerprint, so it may have been altered after signing.",
      ),
    ];
  }
  return [];
}

/**
 * Money has moved: the record says captured, or shows a captured amount.
 *
 * A capture id alone does not mean that. PayPal can accept a capture and leave it PENDING: the
 * orchestrator then keeps the id on a record that is still "authorized" with nothing captured,
 * and the capture is confirmed by asking again with the same idempotency key — which PayPal
 * answers for the capture it already has, so it can never become a second one. Treating that
 * record as captured would refuse the very retry that settles it.
 */
function hasCaptured(payment: PaymentRecord): boolean {
  return payment.status === "captured" || payment.capturedMinor > 0;
}

function paymentViolations(payment: PaymentRecord | null, priceMinor: number | null, now: Date): GuardViolation[] {
  if (payment === null) return [violation("payment_missing", "There is no payment record for this deal.")];
  const violations: GuardViolation[] = [];

  if (hasCaptured(payment)) {
    violations.push(
      violation(
        "already_captured",
        "This payment has already been captured; an authorization can only be captured once.",
      ),
    );
  } else if (payment.status !== "authorized") {
    violations.push(
      violation(
        "not_authorized",
        `Funds are not held: the payment is "${PAYMENT_STATUS_LABEL[payment.status]}", not authorized.`,
      ),
    );
  } else if (payment.authorizationId === null) {
    violations.push(violation("not_authorized", "The payment is marked authorized but has no PayPal authorization id."));
  }

  if (priceMinor !== null && payment.amountMinor !== priceMinor) {
    violations.push(
      violation(
        "amount_mismatch",
        `The payment is for ${formatMoney(payment.amountMinor)} but the contract price is ${formatMoney(priceMinor)}.`,
      ),
    );
  }

  if (payment.authorizationExpiresAt !== null) {
    const expiresMs = parseTimestamp(payment.authorizationExpiresAt);
    // An unreadable expiry is treated as expired: the guard fails closed.
    if (expiresMs === null || expiresMs <= now.getTime()) {
      violations.push(
        violation(
          "authorization_expired",
          `The PayPal authorization expired at ${formatUtcTimestamp(payment.authorizationExpiresAt)}.`,
        ),
      );
    }
  }
  return violations;
}

/** A capture-eligible report must itself show every required contract rule passing with enough confidence. */
function reportSupportsCapture(signed: SignedContract, report: VerificationReport): boolean {
  const { verificationRules, settlement } = signed.contract;
  const required = verificationRules.filter((rule) => rule.required);
  return (
    required.length > 0 &&
    required.every((rule) =>
      report.checks.some(
        (check) =>
          check.ruleId === rule.id &&
          check.result === "pass" &&
          check.confidence >= settlement.autoCaptureMinConfidence,
      ),
    ) &&
    !report.checks.some((check) => check.result === "fail" && required.some((rule) => rule.id === check.ruleId))
  );
}

function reportViolations(
  signed: SignedContract | null,
  report: VerificationReport | null,
  humanDecision: HumanDecision | null,
): GuardViolation[] {
  if (report === null) return [violation("report_missing", "No verification report exists for this deal.")];
  const violations: GuardViolation[] = [];

  if (signed !== null && report.contractHash !== signed.termsHash) {
    violations.push(
      violation("report_contract_mismatch", "The latest verification report was produced for a different contract."),
    );
  }

  switch (report.decision) {
    case "capture_eligible":
      if (signed !== null && !reportSupportsCapture(signed, report)) {
        violations.push(
          violation(
            "report_inconsistent",
            "The report says capture-eligible, but its checks do not show every required condition passing.",
          ),
        );
      }
      break;
    case "human_review":
      if (!humanReleaseApplies(report, humanDecision)) {
        violations.push(
          violation(
            "human_release_missing",
            "Verification asked for human review, and no human has released the payment since that report.",
          ),
        );
      } else if (humanDecision.kind === "release_partial" && !isValidPartialPercent(humanDecision.percent)) {
        violations.push(
          violation(
            "partial_percent_invalid",
            `A partial release needs a whole percentage between ${MIN_PARTIAL_PERCENT} and ${MAX_PARTIAL_PERCENT}.`,
          ),
        );
      }
      break;
    case "revision_required":
    case "reject":
      // No human decision can turn a failed verification into a capture; the deal must be
      // re-verified (after a revision) or voided.
      violations.push(
        violation(
          "verification_not_passed",
          `The latest verification decision is "${report.decision}", which can never be captured.`,
        ),
      );
      break;
    default: {
      const unknown: never = report.decision;
      violations.push(violation("verification_not_passed", `Unknown verification decision: ${String(unknown)}`));
    }
  }
  return violations;
}

/**
 * May the authorization be captured right now, and for how much?
 * `amountMinor` is 0 whenever `allowed` is false, so a caller that forgets to check `allowed`
 * still cannot move money.
 */
export function checkCaptureAllowed(input: CaptureGuardInput): {
  allowed: boolean;
  violations: GuardViolation[];
  amountMinor: number;
} {
  const { dealStatus, signed, payment, latestReport, humanDecision, now } = input;
  const violations: GuardViolation[] = [];

  if (dealStatus !== "verified") {
    violations.push(
      violation(
        "status_not_verified",
        `The deal is "${DEAL_STATUS_LABEL[dealStatus]}"; capture is only possible once delivery is verified.`,
      ),
    );
  }
  violations.push(...contractViolations(signed));
  violations.push(...paymentViolations(payment, signed?.contract.price.amountMinor ?? null, now));
  violations.push(...reportViolations(signed, latestReport, humanDecision));

  const amountMinor = prospectiveAmountMinor(signed, latestReport, humanDecision);
  if (payment !== null && amountMinor !== null && payment.authorizedMinor < amountMinor) {
    violations.push(
      violation(
        "authorization_insufficient",
        `Only ${formatMoney(payment.authorizedMinor)} is authorized, which does not cover the ${formatMoney(amountMinor)} to capture.`,
      ),
    );
  }

  if (violations.length > 0 || amountMinor === null) return { allowed: false, violations, amountMinor: 0 };
  return { allowed: true, violations, amountMinor };
}

/** Payment states from which PayPal can still release the funds or abandon the order. */
const VOIDABLE_PAYMENT_STATUSES: ReadonlySet<PaymentRecord["status"]> = new Set(["created", "approved", "authorized"]);

/**
 * Deal states in which the seller has earned (or already received) the money. Voiding there
 * would take back a payment the contract says is owed.
 */
const VOID_FORBIDDEN_DEAL_STATUSES: ReadonlySet<DealStatus> = new Set(["verified", "completed"]);

/** May the authorization (or a not-yet-authorized order) be voided right now? */
export function checkVoidAllowed(input: { dealStatus: DealStatus; payment: PaymentRecord | null }): {
  allowed: boolean;
  violations: GuardViolation[];
} {
  const { dealStatus, payment } = input;
  const violations: GuardViolation[] = [];

  if (VOID_FORBIDDEN_DEAL_STATUSES.has(dealStatus)) {
    violations.push(
      violation(
        "status_not_voidable",
        `The deal is "${DEAL_STATUS_LABEL[dealStatus]}"; the payment is owed to the seller and cannot be voided.`,
      ),
    );
  }
  if (payment === null) {
    violations.push(violation("payment_missing", "There is no payment record for this deal."));
  } else if (hasCaptured(payment)) {
    violations.push(
      violation("already_captured", "Funds have already been captured; a captured payment cannot be voided."),
    );
  } else if (!VOIDABLE_PAYMENT_STATUSES.has(payment.status)) {
    violations.push(
      violation(
        "not_voidable",
        `There is nothing to void: the payment is "${PAYMENT_STATUS_LABEL[payment.status]}".`,
      ),
    );
  }
  return { allowed: violations.length === 0, violations };
}

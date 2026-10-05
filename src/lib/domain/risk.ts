/**
 * Operational risk rating for the operations ledger. A coarse, explainable signal — every
 * level comes with the reasons that produced it — meant to direct a human's attention, not to
 * gate anything. Money is gated by policy.ts and settlement.ts only.
 */
import type { RiskLevel } from "../api/dto";
import { HOUR_MS, parseTimestamp } from "./format";
import type { PolicyOutcome, VerificationDecision } from "./schemas";
import { isTerminal, type DealStatus, type PaymentStatus } from "./status";

export interface RiskInput {
  status: DealStatus;
  /** Contract (or mandate) deadline; null before terms exist. */
  deadline: string | null;
  now: Date;
  sellerTrust: "established" | "new" | null;
  /** Decision of the latest verification report, if any. */
  verificationDecision: VerificationDecision | null;
  revisionsUsed: number;
  revisionLimit: number;
  aiDegraded: boolean;
  policyOutcome: PolicyOutcome | null;
  paymentStatus: PaymentStatus;
  authorizationExpiresAt: string | null;
}

/** Inside this window a held authorization with no verified delivery needs someone to look. */
const DEADLINE_CRITICAL_HOURS = 6;
const DEADLINE_WARNING_HOURS = 24;
/** PayPal honours an authorization for 3 days; a hold this close to expiry may not be capturable. */
const AUTHORIZATION_EXPIRY_HOURS = 72;

/** Funds can be held while the seller works, while the delivery is checked, or while a human reviews. */
const AWAITING_VERIFIED_DELIVERY: ReadonlySet<DealStatus> = new Set([
  "authorized",
  "submitted",
  "revision_required",
  "in_review",
]);

/** Open states in which the seller has not handed anything over for the current round. */
const UNDELIVERED: ReadonlySet<DealStatus> = new Set([
  "negotiating",
  "agreed",
  "contracted",
  "awaiting_approval",
  "payment_pending",
  "awaiting_payment",
  "authorized",
  "revision_required",
]);

function hoursUntil(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const ms = parseTimestamp(iso);
  return ms === null ? null : (ms - now.getTime()) / HOUR_MS;
}

/**
 * One deadline signal at most: the critical one (funds held, nothing verified) outranks the
 * early warning, so the same deadline is never reported twice.
 */
function deadlineSignal(input: RiskInput): { level: "high" | "medium"; reason: string } | null {
  const toDeadline = hoursUntil(input.deadline, input.now);
  if (toDeadline === null) return null;

  const fundsHeld = input.paymentStatus === "authorized";
  const deliveryVerified = input.verificationDecision === "capture_eligible";
  if (fundsHeld && AWAITING_VERIFIED_DELIVERY.has(input.status) && !deliveryVerified) {
    if (toDeadline <= 0) return { level: "high", reason: "Deadline passed with funds still held" };
    if (toDeadline < DEADLINE_CRITICAL_HOURS) {
      return { level: "high", reason: `Deadline in under ${DEADLINE_CRITICAL_HOURS}h with funds held` };
    }
  }
  if (toDeadline < DEADLINE_WARNING_HOURS && UNDELIVERED.has(input.status)) {
    return {
      level: "medium",
      reason: toDeadline <= 0 ? "Deadline passed with nothing delivered" : `Deadline in under ${DEADLINE_WARNING_HOURS}h, not yet delivered`,
    };
  }
  return null;
}

function highReasons(input: RiskInput): string[] {
  const reasons: string[] = [];
  const { status } = input;

  if (status === "in_review") reasons.push("Waiting for human review");
  if (status === "failed") reasons.push("Payment failed");
  if (status === "revision_required" && input.revisionsUsed >= input.revisionLimit) {
    reasons.push("Revision required but none left");
  }

  const toExpiry = hoursUntil(input.authorizationExpiresAt, input.now);
  if (input.paymentStatus === "authorized" && toExpiry !== null && toExpiry < AUTHORIZATION_EXPIRY_HOURS) {
    reasons.push(toExpiry <= 0 ? "Authorization has expired" : `Authorization expires in under ${AUTHORIZATION_EXPIRY_HOURS}h`);
  }
  return reasons;
}

function mediumReasons(input: RiskInput): string[] {
  const reasons: string[] = [];
  const { status } = input;

  if (status === "revision_required") reasons.push("Delivery failed verification; revision in progress");
  if (status === "awaiting_approval") {
    reasons.push(
      input.policyOutcome === "needs_approval" ? "Spend needs human approval under policy" : "Waiting for human approval",
    );
  }
  if (input.sellerTrust === "new") reasons.push("New seller with no settled history");
  if (input.aiDegraded) reasons.push("AI unavailable; scripted fallback or degraded verification used");
  return reasons;
}

/**
 * Rate a deal for the operations view. High reasons are listed before medium ones.
 * Closed deals carry no exposure and are always low — except a failed payment, which stays
 * high because someone has to find out why PayPal refused.
 */
export function assessRisk(input: RiskInput): { level: RiskLevel; reasons: string[] } {
  if (isTerminal(input.status) && input.status !== "failed") return { level: "low", reasons: [] };

  // "Open deal" conditions do not apply to a deal that has already failed.
  const open = !isTerminal(input.status);
  const deadline = open ? deadlineSignal(input) : null;
  const high = [...highReasons(input), ...(deadline?.level === "high" ? [deadline.reason] : [])];
  const medium = open ? [...mediumReasons(input), ...(deadline?.level === "medium" ? [deadline.reason] : [])] : [];

  if (high.length > 0) return { level: "high", reasons: [...high, ...medium] };
  if (medium.length > 0) return { level: "medium", reasons: medium };
  return { level: "low", reasons: [] };
}

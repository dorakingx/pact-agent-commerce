/**
 * The single mapping from domain state to presentation. Screens should never pick a tone for a
 * deal or payment status by hand: use these maps (or the two pill components) so the same state
 * looks the same in the workspace, the operations ledger and the audit trail.
 *
 * Tone semantics:
 *   info     indigo  agents or the engine are working
 *   hold     amber   funds are authorized (held), not captured
 *   success  emerald verified, or captured
 *   review   violet  waiting on a human
 *   danger   red     failed verification, rejected, blocked, payment failure
 *   neutral  slate   not started, or closed without money moving
 */
import type { CheckResult, PolicyOutcome, VerificationDecision } from "@/lib/domain/schemas";
import {
  DEAL_STATUS_LABEL,
  PAYMENT_RAIL,
  PAYMENT_STATUS_LABEL,
  isAuto,
  type DealStatus,
  type PaymentStatus,
} from "@/lib/domain/status";
import type { PaymentRecord } from "@/lib/payments/types";
import { StatusPill, type StatusPillProps } from "./status-pill";
import type { StepperStep } from "./stepper";
import type { StatusTone } from "./tone";

export const DEAL_STATUS_TONE: Record<DealStatus, StatusTone> = {
  negotiating: "info",
  agreed: "info",
  contracted: "info",
  awaiting_approval: "review",
  payment_pending: "info",
  awaiting_payment: "review",
  authorized: "hold",
  submitted: "info",
  revision_required: "danger",
  in_review: "review",
  verified: "success",
  rejecting: "danger",
  completed: "success",
  rejected: "danger",
  declined: "neutral",
  blocked: "danger",
  negotiation_failed: "neutral",
  cancelled: "neutral",
  expired: "neutral",
  failed: "danger",
};

export const PAYMENT_STATUS_TONE: Record<PaymentStatus, StatusTone> = {
  none: "neutral",
  created: "info",
  approved: "info",
  authorized: "hold",
  captured: "success",
  voided: "neutral",
  expired: "neutral",
  failed: "danger",
};

export const CHECK_RESULT_TONE: Record<CheckResult, StatusTone> = {
  pass: "success",
  fail: "danger",
  uncertain: "review",
};

export const CHECK_RESULT_LABEL: Record<CheckResult, string> = {
  pass: "Pass",
  fail: "Fail",
  uncertain: "Uncertain",
};

export const VERIFICATION_DECISION_TONE: Record<VerificationDecision, StatusTone> = {
  capture_eligible: "success",
  human_review: "review",
  revision_required: "danger",
  reject: "danger",
};

export const VERIFICATION_DECISION_LABEL: Record<VerificationDecision, string> = {
  capture_eligible: "Capture eligible",
  human_review: "Human review",
  revision_required: "Revision required",
  reject: "Rejected",
};

export const POLICY_OUTCOME_TONE: Record<PolicyOutcome, StatusTone> = {
  allow: "success",
  needs_approval: "review",
  block: "danger",
};

export const POLICY_OUTCOME_LABEL: Record<PolicyOutcome, string> = {
  allow: "Within policy",
  needs_approval: "Needs approval",
  block: "Blocked",
};

type PillPassthrough = Omit<StatusPillProps, "tone" | "children" | "pulse">;

export interface DealStatusPillProps extends PillPassthrough {
  status: DealStatus;
  /** Override the default label from `DEAL_STATUS_LABEL`. */
  label?: React.ReactNode;
}

/** Deal lifecycle pill. The dot pulses while the engine is working on the deal by itself. */
export function DealStatusPill({ status, label, ...props }: DealStatusPillProps) {
  return (
    <StatusPill tone={DEAL_STATUS_TONE[status]} pulse={isAuto(status)} data-status={status} {...props}>
      {label ?? DEAL_STATUS_LABEL[status]}
    </StatusPill>
  );
}

export interface PaymentStatusPillProps extends PillPassthrough {
  status: PaymentStatus;
  label?: React.ReactNode;
}

export function PaymentStatusPill({ status, label, ...props }: PaymentStatusPillProps) {
  return (
    <StatusPill tone={PAYMENT_STATUS_TONE[status]} data-status={status} {...props}>
      {label ?? PAYMENT_STATUS_LABEL[status]}
    </StatusPill>
  );
}

/** The fields of a payment record the rail needs. Pass `deal.payment` directly. */
export type PaymentRailInput = Pick<PaymentRecord, "status" | "mode" | "orderId" | "authorizationId">;

/**
 * Steps for the payment rail CREATED → APPROVED → AUTHORIZED → CAPTURED, ready for `<Stepper>`.
 *
 *  - Reached steps are `done`; the step the payment is in right now is `current`.
 *  - A current AUTHORIZED step is amber (`hold`): money is reserved, not moved.
 *  - With a delegated (vaulted) wallet there is no interactive approval, so that step is `skipped`.
 *  - A payment that ended without capture replaces the last step with its real outcome:
 *    "Voided" / "Expired" are `skipped` (no money moved), "Failed" is `failed`. How far it got
 *    is derived from the PayPal ids, because those states are reachable from several steps.
 */
export function paymentRailSteps(payment: PaymentRailInput | null): StepperStep[] {
  const status: PaymentStatus = payment?.status ?? "none";
  const closed = status === "voided" || status === "expired" || status === "failed";
  const reached: PaymentStatus = !closed
    ? status
    : payment?.authorizationId
      ? "authorized"
      : payment?.orderId
        ? "created"
        : "none";
  // -1 when no step has been reached yet ("none" is not on the rail).
  const reachedIndex = PAYMENT_RAIL.indexOf(reached);

  return PAYMENT_RAIL.map((railStatus, index): StepperStep => {
    const isOutcomeStep = index === PAYMENT_RAIL.length - 1;
    if (isOutcomeStep && closed) {
      return { id: status, label: PAYMENT_STATUS_LABEL[status], state: status === "failed" ? "failed" : "skipped" };
    }
    const base = { id: railStatus, label: PAYMENT_STATUS_LABEL[railStatus] };
    if (railStatus === "approved" && payment?.mode === "delegated" && reachedIndex > index) {
      return { ...base, state: "skipped", description: "Pre-consented wallet" };
    }
    if (index > reachedIndex) return { ...base, state: closed ? "skipped" : "upcoming" };
    const settled = closed || status === "captured" || index < reachedIndex;
    if (settled) return { ...base, state: "done" };
    // Amber only while the money is actually being held; once the payment moves on it is history.
    return { ...base, state: "current", tone: railStatus === "authorized" ? "hold" : "success" };
  });
}

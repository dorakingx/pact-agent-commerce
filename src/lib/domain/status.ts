/**
 * Deal and payment lifecycles. Both are closed, table-driven state machines:
 * a transition that is not listed here cannot happen, no matter what an agent says.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/*  Deal lifecycle                                                             */
/* -------------------------------------------------------------------------- */

export const DEAL_STATUSES = [
  "negotiating", // buyer and seller agents are exchanging offers
  "agreed", // terms agreed; contract not yet compiled
  "contracted", // contract compiled and hashed; policy not yet evaluated
  "awaiting_approval", // policy requires a human to approve the spend
  "payment_pending", // cleared by policy; PayPal order not yet created
  "awaiting_payment", // PayPal order created; payer must approve in PayPal
  "authorized", // funds authorized (held, not captured); seller is working
  "submitted", // seller delivered; verification not yet run
  "revision_required", // verification failed; seller must revise
  "in_review", // verification ambiguous; a human must decide
  "verified", // capture-eligible; capture not yet executed
  "rejecting", // delivery rejected; authorization is being voided
  // terminal
  "completed", // payment captured
  "rejected", // delivery rejected, authorization voided
  "declined", // human declined the spend
  "blocked", // blocked by policy
  "negotiation_failed", // agents could not agree
  "cancelled", // payer cancelled / authorization voided before delivery
  "expired", // authorization expired
  "failed", // unrecoverable payment failure
] as const;
export const DealStatusSchema = z.enum(DEAL_STATUSES);
export type DealStatus = z.infer<typeof DealStatusSchema>;

export const TERMINAL_STATUSES = [
  "completed",
  "rejected",
  "declined",
  "blocked",
  "negotiation_failed",
  "cancelled",
  "expired",
  "failed",
] as const satisfies readonly DealStatus[];

/** Statuses in which the engine can take the next step by itself. */
export const AUTO_STATUSES = [
  "negotiating",
  "agreed",
  "contracted",
  "payment_pending",
  "authorized",
  "submitted",
  "revision_required",
  "verified",
  "rejecting",
] as const satisfies readonly DealStatus[];

/** Statuses that wait for a human. */
export const HUMAN_STATUSES = ["awaiting_approval", "awaiting_payment", "in_review"] as const satisfies readonly DealStatus[];

export const DEAL_TRANSITIONS: Record<DealStatus, readonly DealStatus[]> = {
  negotiating: ["negotiating", "agreed", "negotiation_failed"],
  agreed: ["contracted"],
  contracted: ["payment_pending", "awaiting_approval", "blocked"],
  awaiting_approval: ["payment_pending", "declined"],
  // "blocked": the daily limit is re-checked under the owner's lock immediately before the order,
  // and another deal of the same owner may have committed the remaining budget since signing.
  payment_pending: ["awaiting_payment", "authorized", "blocked", "failed"],
  awaiting_payment: ["authorized", "cancelled", "expired", "failed"],
  // "expired" from every state that still counts on the hold: PayPal can release an
  // authorization at any moment, and a deal must not keep working towards a capture that cannot happen.
  authorized: ["submitted", "cancelled", "expired"],
  submitted: ["verified", "revision_required", "in_review", "rejecting", "expired"],
  revision_required: ["submitted", "expired"],
  in_review: ["verified", "revision_required", "rejecting", "expired"],
  verified: ["completed", "failed", "expired"],
  rejecting: ["rejected", "failed"],
  completed: [],
  rejected: [],
  declined: [],
  blocked: [],
  negotiation_failed: [],
  cancelled: [],
  expired: [],
  failed: [],
};

export function isTerminal(status: DealStatus): boolean {
  return (TERMINAL_STATUSES as readonly DealStatus[]).includes(status);
}
export function isAuto(status: DealStatus): boolean {
  return (AUTO_STATUSES as readonly DealStatus[]).includes(status);
}
export function isHumanGate(status: DealStatus): boolean {
  return (HUMAN_STATUSES as readonly DealStatus[]).includes(status);
}
export function canTransition(from: DealStatus, to: DealStatus): boolean {
  return DEAL_TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly machine: "deal" | "payment",
  ) {
    super(`Illegal ${machine} transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(from: DealStatus, to: DealStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, "deal");
}

/** Short labels for UI and audit log. */
export const DEAL_STATUS_LABEL: Record<DealStatus, string> = {
  negotiating: "Negotiating",
  agreed: "Terms agreed",
  contracted: "Contract created",
  awaiting_approval: "Awaiting human approval",
  payment_pending: "Preparing payment",
  awaiting_payment: "Awaiting PayPal approval",
  authorized: "Authorized · work in progress",
  submitted: "Delivered · verifying",
  revision_required: "Revision required",
  in_review: "Human review required",
  verified: "Verified · capturing",
  rejecting: "Rejected · releasing funds",
  completed: "Completed · captured",
  rejected: "Rejected · authorization voided",
  declined: "Declined by human",
  blocked: "Blocked by policy",
  negotiation_failed: "No agreement",
  cancelled: "Cancelled",
  expired: "Expired",
  failed: "Payment failed",
};

/* -------------------------------------------------------------------------- */
/*  Payment lifecycle                                                          */
/* -------------------------------------------------------------------------- */

export const PAYMENT_STATUSES = [
  "none", // no PayPal order yet
  "created", // order created, payer has not approved
  "approved", // payer approved; not yet authorized
  "authorized", // funds held on the payer's account
  "captured", // funds moved to the seller (full or final partial capture)
  "voided", // authorization released, nothing captured
  "expired", // order or authorization expired
  "failed", // PayPal declined or errored terminally
] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  none: ["created", "authorized", "failed"], // "authorized" directly = delegated wallet (vaulted) single-step
  created: ["approved", "authorized", "voided", "expired", "failed"],
  approved: ["authorized", "voided", "expired", "failed"],
  authorized: ["captured", "voided", "expired", "failed"],
  captured: [],
  voided: [],
  expired: [],
  failed: [],
};

export function canPaymentTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return PAYMENT_TRANSITIONS[from].includes(to);
}
export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canPaymentTransition(from, to)) throw new IllegalTransitionError(from, to, "payment");
}

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  none: "Not started",
  created: "Order created",
  approved: "Approved by payer",
  authorized: "Authorized",
  captured: "Captured",
  voided: "Voided",
  expired: "Expired",
  failed: "Failed",
};

/** The canonical happy-path rail shown in the UI. */
export const PAYMENT_RAIL: readonly PaymentStatus[] = ["created", "approved", "authorized", "captured"];

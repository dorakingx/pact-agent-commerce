/**
 * What happens next for a deal: an automatic engine step, a human gate, or nothing.
 * The UI and the step loop both read this, so "what the screen says" and "what the engine will
 * do" can never drift apart.
 */
import type { NextStep } from "../api/dto";
import { assertNever } from "./format";
import type { HumanDecisionKind, Party } from "./schemas";
import { DEAL_STATUS_LABEL, type DealStatus } from "./status";

export function nextStepFor(input: {
  status: DealStatus;
  /** Whose negotiation move is due; only meaningful while negotiating. */
  nextNegotiator: Party | null;
  revisionsUsed: number;
  revisionLimit: number;
}): NextStep {
  const { status } = input;
  switch (status) {
    case "negotiating":
      return { kind: "auto", step: "negotiate", label: negotiationLabel(input.nextNegotiator) };
    case "agreed":
      return { kind: "auto", step: "contract", label: "Compiling and hashing the contract" };
    case "contracted":
      return { kind: "auto", step: "policy", label: "Checking the spending policy" };
    case "payment_pending":
      return { kind: "auto", step: "order", label: "Creating the PayPal order" };
    case "authorized":
      return { kind: "auto", step: "fulfill", label: "Seller agent is producing the work" };
    case "revision_required":
      return { kind: "auto", step: "fulfill", label: "Seller agent is revising the delivery" };
    case "submitted":
      return { kind: "auto", step: "verify", label: "Verifying the delivery against the contract" };
    case "verified":
      return { kind: "auto", step: "capture", label: "Capturing the authorized payment" };
    case "rejecting":
      return { kind: "auto", step: "void", label: "Voiding the authorization to release the funds" };
    case "awaiting_approval":
      return {
        kind: "human",
        gate: "approval",
        label: "Waiting for you to approve this spend",
        options: ["approve_spend", "decline_spend"],
      };
    case "awaiting_payment":
      return {
        kind: "human",
        gate: "payment",
        label: "Waiting for approval in PayPal",
        options: ["cancel_payment"],
      };
    case "in_review":
      return {
        kind: "human",
        gate: "review",
        label: "Waiting for your review of the delivery",
        options: reviewOptions(input.revisionsUsed, input.revisionLimit),
      };
    case "completed":
    case "rejected":
    case "declined":
    case "blocked":
    case "negotiation_failed":
    case "cancelled":
    case "expired":
    case "failed":
      return { kind: "done", label: DEAL_STATUS_LABEL[status] };
    default:
      return assertNever(status);
  }
}

function negotiationLabel(nextNegotiator: Party | null): string {
  switch (nextNegotiator) {
    case "seller":
      return "Seller agent is preparing its offer";
    case "buyer":
      return "Buyer agent is responding";
    case null:
      return "Agents are negotiating";
    default:
      return assertNever(nextNegotiator);
  }
}

/** A revision can only be requested while the contract still has one left. */
function reviewOptions(revisionsUsed: number, revisionLimit: number): HumanDecisionKind[] {
  const options: HumanDecisionKind[] = ["release_payment", "release_partial"];
  if (revisionsUsed < revisionLimit) options.push("request_revision");
  options.push("reject_delivery");
  return options;
}

import { describe, expect, it } from "vitest";
import type { NextStep } from "../api/dto";
import { nextStepFor } from "./next-step";
import { HumanDecisionKindSchema, type Party } from "./schemas";
import { AUTO_STATUSES, DEAL_STATUSES, DEAL_STATUS_LABEL, HUMAN_STATUSES, TERMINAL_STATUSES, type DealStatus } from "./status";

const next = (status: DealStatus, overrides: { nextNegotiator?: Party | null; revisionsUsed?: number; revisionLimit?: number } = {}): NextStep =>
  nextStepFor({ status, nextNegotiator: null, revisionsUsed: 0, revisionLimit: 1, ...overrides });

describe("nextStepFor", () => {
  it("maps every automatic status to the step the engine runs next", () => {
    expect(next("agreed")).toEqual({ kind: "auto", step: "contract", label: "Compiling and hashing the contract" });
    expect(next("contracted")).toEqual({ kind: "auto", step: "policy", label: "Checking the spending policy" });
    expect(next("payment_pending")).toEqual({ kind: "auto", step: "order", label: "Creating the PayPal order" });
    expect(next("authorized")).toEqual({ kind: "auto", step: "fulfill", label: "Seller agent is producing the work" });
    expect(next("revision_required")).toEqual({ kind: "auto", step: "fulfill", label: "Seller agent is revising the delivery" });
    expect(next("submitted")).toEqual({ kind: "auto", step: "verify", label: "Verifying the delivery against the contract" });
    expect(next("verified")).toEqual({ kind: "auto", step: "capture", label: "Capturing the authorized payment" });
    expect(next("rejecting")).toEqual({ kind: "auto", step: "void", label: "Voiding the authorization to release the funds" });
  });

  it("says whose negotiation move is due", () => {
    expect(next("negotiating", { nextNegotiator: "seller" })).toEqual({ kind: "auto", step: "negotiate", label: "Seller agent is preparing its offer" });
    expect(next("negotiating", { nextNegotiator: "buyer" })).toEqual({ kind: "auto", step: "negotiate", label: "Buyer agent is responding" });
    expect(next("negotiating", { nextNegotiator: null })).toEqual({ kind: "auto", step: "negotiate", label: "Agents are negotiating" });
  });

  it("stops at the policy gate with approve and decline", () => {
    expect(next("awaiting_approval")).toEqual({
      kind: "human",
      gate: "approval",
      label: "Waiting for you to approve this spend",
      options: ["approve_spend", "decline_spend"],
    });
  });

  it("stops at the PayPal gate, where the only local action is to cancel", () => {
    expect(next("awaiting_payment")).toEqual({ kind: "human", gate: "payment", label: "Waiting for approval in PayPal", options: ["cancel_payment"] });
  });

  it("offers a revision at the review gate only while one remains", () => {
    expect(next("in_review", { revisionsUsed: 0, revisionLimit: 1 })).toEqual({
      kind: "human",
      gate: "review",
      label: "Waiting for your review of the delivery",
      options: ["release_payment", "release_partial", "request_revision", "reject_delivery"],
    });
    const spent = next("in_review", { revisionsUsed: 1, revisionLimit: 1 });
    expect(spent.kind === "human" && spent.options).toEqual(["release_payment", "release_partial", "reject_delivery"]);
    const none = next("in_review", { revisionsUsed: 0, revisionLimit: 0 });
    expect(none.kind === "human" && none.options).toEqual(["release_payment", "release_partial", "reject_delivery"]);
    const some = next("in_review", { revisionsUsed: 1, revisionLimit: 3 });
    expect(some.kind === "human" && some.options).toContain("request_revision");
  });

  it("is done, with the status label, for every terminal status", () => {
    for (const status of TERMINAL_STATUSES) {
      expect(next(status)).toEqual({ kind: "done", label: DEAL_STATUS_LABEL[status] });
    }
    expect(next("completed")).toEqual({ kind: "done", label: "Completed · captured" });
  });

  it("agrees with the status partition: auto statuses run a step, human statuses wait, terminal ones are done", () => {
    for (const status of DEAL_STATUSES) {
      const step = next(status);
      const expected = (AUTO_STATUSES as readonly DealStatus[]).includes(status) ? "auto" : (HUMAN_STATUSES as readonly DealStatus[]).includes(status) ? "human" : "done";
      expect(step.kind, status).toBe(expected);
      expect(step.label.length, status).toBeGreaterThan(0);
    }
  });

  it("only offers decisions the schema knows, and never a release outside the review gate", () => {
    for (const status of DEAL_STATUSES) {
      const step = next(status);
      if (step.kind !== "human") continue;
      for (const option of step.options) expect(HumanDecisionKindSchema.safeParse(option).success).toBe(true);
      if (step.gate !== "review") {
        expect(step.options).not.toContain("release_payment");
        expect(step.options).not.toContain("release_partial");
      }
    }
  });

  it("never offers capture or void as anything but the verified and rejecting steps", () => {
    const stepsByStatus = DEAL_STATUSES.map((status) => [status, next(status)] as const);
    const capturing = stepsByStatus.filter(([, step]) => step.kind === "auto" && step.step === "capture").map(([status]) => status);
    const voiding = stepsByStatus.filter(([, step]) => step.kind === "auto" && step.step === "void").map(([status]) => status);
    expect(capturing).toEqual(["verified"]);
    expect(voiding).toEqual(["rejecting"]);
  });
});

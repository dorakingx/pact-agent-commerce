import { describe, expect, it } from "vitest";
import { DEAL_STATUSES, PAYMENT_STATUSES, canTransition, type DealStatus, type PaymentStatus } from "../domain/status";
import { newPaymentRecord } from "../payments/orchestrator";
import type { PaymentRecord } from "../payments/types";
import { DEMO_WALLET_OWNER, dealStatusForPayment, isDealId, payPalReturnPath } from "./deals";

const NOW = new Date("2026-10-06T05:00:00.000Z");

function payment(status: PaymentStatus): PaymentRecord {
  return { ...newPaymentRecord("simulated", "interactive", 4700, NOW), status };
}

describe("dealStatusForPayment", () => {
  const forced = (status: DealStatus, paymentStatus: PaymentStatus): DealStatus | null => dealStatusForPayment(status, payment(paymentStatus));

  it("only ever asks for a transition the deal state machine allows", () => {
    for (const status of DEAL_STATUSES) {
      for (const paymentStatus of PAYMENT_STATUSES) {
        const to = forced(status, paymentStatus);
        if (to !== null) expect(canTransition(status, to), `${status} + payment ${paymentStatus} -> ${to}`).toBe(true);
      }
    }
  });

  it("never moves a deal that has ended", () => {
    for (const status of ["completed", "rejected", "declined", "blocked", "negotiation_failed", "cancelled", "expired", "failed"] as const) {
      for (const paymentStatus of PAYMENT_STATUSES) expect(forced(status, paymentStatus)).toBeNull();
    }
  });

  it("maps a hold that is gone to 'expired', whether PayPal calls it voided or expired", () => {
    for (const paymentStatus of ["voided", "expired"] as const) {
      // Every state that still counts on the hold, including a delivery under verification or review.
      for (const status of ["awaiting_payment", "authorized", "submitted", "revision_required", "in_review", "verified"] as const) {
        expect(forced(status, paymentStatus)).toBe("expired");
      }
      // Before an order, and while a rejection is being released, a missing hold changes nothing.
      for (const status of ["negotiating", "agreed", "contracted", "awaiting_approval", "payment_pending", "rejecting"] as const) {
        expect(forced(status, paymentStatus)).toBeNull();
      }
    }
  });

  it("completes a verified deal whose capture PayPal settled, and nothing else", () => {
    for (const status of DEAL_STATUSES) expect(forced(status, "captured")).toBe(status === "verified" ? "completed" : null);
  });

  it("fails a deal PayPal refused for good while it was waiting on the money", () => {
    expect(forced("verified", "failed")).toBe("failed");
    expect(forced("awaiting_payment", "failed")).toBe("failed");
    expect(forced("authorized", "failed")).toBeNull();
    expect(forced("in_review", "failed")).toBeNull();
  });

  it("moves a waiting deal on when PayPal reports the authorization", () => {
    for (const status of DEAL_STATUSES) expect(forced(status, "authorized")).toBe(status === "awaiting_payment" ? "authorized" : null);
  });

  it("asks for nothing while the payment has not reached PayPal's books", () => {
    for (const status of DEAL_STATUSES) {
      for (const paymentStatus of ["none", "created", "approved"] as const) expect(forced(status, paymentStatus)).toBeNull();
    }
  });
});

describe("isDealId", () => {
  it("accepts ids minted by newId and nothing that could carry a path or a host", () => {
    expect(isDealId("deal_k3v9x0q2m7ab")).toBe(true);
    for (const value of ["", "deal_", "deal_ABCDEFGH1234", "deal_abc/../x12345", "https://evil.example", "//evil.example", "deal_k3v9x0q2m7ab?x=1", " deal_k3v9x0q2m7ab", `deal_${"a".repeat(33)}`, "ctr_k3v9x0q2m7ab"]) {
      expect(isDealId(value), value).toBe(false);
    }
  });
});

describe("payPalReturnPath", () => {
  it("always stays on this site", () => {
    expect(payPalReturnPath("deal_k3v9x0q2m7ab", "approved")).toBe("/deals/deal_k3v9x0q2m7ab?paypal=approved");
    expect(payPalReturnPath("deal_k3v9x0q2m7ab", "cancelled")).toBe("/deals/deal_k3v9x0q2m7ab?paypal=cancelled");
    for (const hostile of [null, "", "https://evil.example", "//evil.example/deals", "deal_x/../../admin", "deal_k3v9x0q2m7ab#frag"]) {
      const path = payPalReturnPath(hostile, "error");
      expect(path).toBe("/workspace?paypal=error");
      expect(path.startsWith("//")).toBe(false);
    }
  });
});

describe("DEMO_WALLET_OWNER", () => {
  it("is the fixed key of the shared wallet, and cannot be a browser session id", () => {
    expect(DEMO_WALLET_OWNER).toBe("demo");
    expect(/^sess_[a-z0-9]{24}$/.test(DEMO_WALLET_OWNER)).toBe(false);
  });
});

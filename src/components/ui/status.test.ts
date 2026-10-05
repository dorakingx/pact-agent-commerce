import { describe, expect, it } from "vitest";
import { DEAL_STATUSES, HUMAN_STATUSES, PAYMENT_STATUSES, type PaymentStatus } from "@/lib/domain/status";
import { DEAL_STATUS_TONE, PAYMENT_STATUS_TONE, paymentRailSteps, type PaymentRailInput } from "./status";
import { STATUS_TONES } from "./tone";

function payment(status: PaymentStatus, overrides: Partial<PaymentRailInput> = {}): PaymentRailInput {
  return { status, mode: "interactive", orderId: "ORDER-1", authorizationId: null, ...overrides };
}

const states = (input: PaymentRailInput | null) => paymentRailSteps(input).map((s) => s.state);
const ids = (input: PaymentRailInput | null) => paymentRailSteps(input).map((s) => s.id);

describe("status → tone maps", () => {
  it("gives every deal and payment status a valid tone", () => {
    for (const status of DEAL_STATUSES) expect(STATUS_TONES).toContain(DEAL_STATUS_TONE[status]);
    for (const status of PAYMENT_STATUSES) expect(STATUS_TONES).toContain(PAYMENT_STATUS_TONE[status]);
  });

  it("keeps the colour semantics the product relies on", () => {
    // Amber means "held, not captured" and nothing else.
    expect(DEAL_STATUS_TONE.authorized).toBe("hold");
    expect(PAYMENT_STATUS_TONE.authorized).toBe("hold");
    expect(PAYMENT_STATUS_TONE.captured).toBe("success");
    expect(DEAL_STATUS_TONE.completed).toBe("success");
    // A void moves no money: it is a closed state, not an error.
    expect(PAYMENT_STATUS_TONE.voided).toBe("neutral");
    expect(PAYMENT_STATUS_TONE.failed).toBe("danger");
  });

  it("shows every state that waits on a human in violet", () => {
    for (const status of HUMAN_STATUSES) expect(DEAL_STATUS_TONE[status]).toBe("review");
  });
});

describe("paymentRailSteps", () => {
  it("is all upcoming before any PayPal order exists", () => {
    expect(states(null)).toEqual(["upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(states(payment("none", { orderId: null }))).toEqual(["upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(ids(null)).toEqual(["created", "approved", "authorized", "captured"]);
  });

  it("marks the reached step as current and earlier ones as done", () => {
    expect(states(payment("created"))).toEqual(["current", "upcoming", "upcoming", "upcoming"]);
    expect(states(payment("approved"))).toEqual(["done", "current", "upcoming", "upcoming"]);
    expect(states(payment("authorized", { authorizationId: "AUTH-1" }))).toEqual(["done", "done", "current", "upcoming"]);
  });

  it("colours a live authorization amber, and only while it is live", () => {
    const held = paymentRailSteps(payment("authorized", { authorizationId: "AUTH-1" }));
    expect(held[2]).toMatchObject({ id: "authorized", state: "current", tone: "hold" });

    const captured = paymentRailSteps(payment("captured", { authorizationId: "AUTH-1" }));
    expect(captured.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(captured[2]?.tone).toBeUndefined();
  });

  it("skips interactive approval for a delegated wallet", () => {
    const steps = paymentRailSteps(payment("authorized", { mode: "delegated", authorizationId: "AUTH-1" }));
    expect(steps.map((s) => s.state)).toEqual(["done", "skipped", "current", "upcoming"]);
    expect(steps[1]?.description).toBe("Pre-consented wallet");
  });

  it("ends a void after authorization with a skipped outcome, not an error", () => {
    const steps = paymentRailSteps(payment("voided", { authorizationId: "AUTH-1" }));
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "skipped"]);
    expect(steps[3]).toMatchObject({ id: "voided", label: "Voided" });
  });

  it("does not claim an authorization that never happened", () => {
    // Payer cancelled at PayPal: an order exists, funds were never held.
    expect(states(payment("voided"))).toEqual(["done", "skipped", "skipped", "skipped"]);
    expect(states(payment("expired"))).toEqual(["done", "skipped", "skipped", "skipped"]);
  });

  it("shows a failure as failed, wherever it happened", () => {
    const beforeOrder = paymentRailSteps(payment("failed", { orderId: null }));
    expect(beforeOrder.map((s) => s.state)).toEqual(["skipped", "skipped", "skipped", "failed"]);
    expect(beforeOrder[3]).toMatchObject({ id: "failed", label: "Failed" });

    const atCapture = paymentRailSteps(payment("failed", { authorizationId: "AUTH-1" }));
    expect(atCapture.map((s) => s.state)).toEqual(["done", "done", "done", "failed"]);
  });

  it("always returns four uniquely keyed steps", () => {
    for (const status of PAYMENT_STATUSES) {
      const steps = paymentRailSteps(payment(status, { authorizationId: "AUTH-1" }));
      expect(steps).toHaveLength(4);
      expect(new Set(steps.map((s) => s.id)).size).toBe(4);
    }
  });
});

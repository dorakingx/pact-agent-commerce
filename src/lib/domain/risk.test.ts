import { describe, expect, it } from "vitest";
import { assessRisk, type RiskInput } from "./risk";
import { DEAL_STATUSES, TERMINAL_STATUSES, isTerminal } from "./status";

const NOW = new Date("2026-10-06T09:00:00.000Z");
const HOUR = 3_600_000;
const inHours = (hours: number): string => new Date(NOW.getTime() + hours * HOUR).toISOString();

/** A healthy deal: funds held, seller working, deadline two days out, authorization fresh. */
const healthy: RiskInput = {
  status: "authorized",
  deadline: inHours(48),
  now: NOW,
  sellerTrust: "established",
  verificationDecision: null,
  revisionsUsed: 0,
  revisionLimit: 1,
  aiDegraded: false,
  policyOutcome: "allow",
  paymentStatus: "authorized",
  authorizationExpiresAt: inHours(29 * 24),
};
const assess = (overrides: Partial<RiskInput> = {}) => assessRisk({ ...healthy, ...overrides });

describe("assessRisk — low", () => {
  it("rates a healthy open deal low with no reasons", () => {
    expect(assess()).toEqual({ level: "low", reasons: [] });
    expect(assess({ status: "negotiating", paymentStatus: "none", deadline: null, authorizationExpiresAt: null, policyOutcome: null })).toEqual({ level: "low", reasons: [] });
  });

  it("always rates a completed deal low, whatever else is true", () => {
    const result = assess({
      status: "completed",
      paymentStatus: "captured",
      sellerTrust: "new",
      aiDegraded: true,
      deadline: inHours(-100),
      authorizationExpiresAt: inHours(-1),
      revisionsUsed: 3,
      revisionLimit: 1,
      verificationDecision: "human_review",
      policyOutcome: "needs_approval",
    });
    expect(result).toEqual({ level: "low", reasons: [] });
  });

  it("rates every closed deal except a failed payment low", () => {
    for (const status of TERMINAL_STATUSES) {
      const result = assess({ status, sellerTrust: "new", aiDegraded: true, deadline: inHours(-5), paymentStatus: "voided" });
      if (status === "failed") expect(result.level).toBe("high");
      else expect(result, status).toEqual({ level: "low", reasons: [] });
    }
  });
});

describe("assessRisk — high", () => {
  it("flags a deal waiting for human review", () => {
    expect(assess({ status: "in_review", verificationDecision: "human_review" })).toEqual({ level: "high", reasons: ["Waiting for human review"] });
  });

  it("flags a failed payment, and nothing that only applies to open deals", () => {
    const result = assess({ status: "failed", paymentStatus: "failed", sellerTrust: "new", aiDegraded: true, deadline: inHours(1) });
    expect(result).toEqual({ level: "high", reasons: ["Payment failed"] });
  });

  it("flags a deadline that has passed or is under 6h away while funds are held with nothing verified", () => {
    expect(assess({ deadline: inHours(-0.5) })).toEqual({ level: "high", reasons: ["Deadline passed with funds still held"] });
    expect(assess({ deadline: inHours(0) }).reasons).toEqual(["Deadline passed with funds still held"]);
    expect(assess({ deadline: inHours(5.9) })).toEqual({ level: "high", reasons: ["Deadline in under 6h with funds held"] });
    expect(assess({ status: "submitted", deadline: inHours(2) }).level).toBe("high");
    expect(assess({ status: "revision_required", deadline: inHours(2) }).reasons).toContain("Deadline in under 6h with funds held");
  });

  it("does not raise the deadline alarm at exactly 6h, without held funds, or once delivery is verified", () => {
    expect(assess({ deadline: inHours(6) })).toEqual({ level: "medium", reasons: ["Deadline in under 24h, not yet delivered"] });
    expect(assess({ status: "awaiting_payment", paymentStatus: "created", deadline: inHours(2) })).toEqual({
      level: "medium",
      reasons: ["Deadline in under 24h, not yet delivered"],
    });
    expect(assess({ status: "verified", verificationDecision: "capture_eligible", deadline: inHours(-3) })).toEqual({ level: "low", reasons: [] });
    expect(assess({ status: "submitted", verificationDecision: "capture_eligible", deadline: inHours(1) })).toEqual({ level: "low", reasons: [] });
  });

  it("flags a required revision when none is left", () => {
    const result = assess({ status: "revision_required", revisionsUsed: 1, revisionLimit: 1, verificationDecision: "revision_required" });
    expect(result.level).toBe("high");
    expect(result.reasons).toEqual(["Revision required but none left", "Delivery failed verification; revision in progress"]);
  });

  it("flags an authorization that expires within 72h, or already has, while funds are held", () => {
    expect(assess({ authorizationExpiresAt: inHours(71.9) })).toEqual({ level: "high", reasons: ["Authorization expires in under 72h"] });
    expect(assess({ authorizationExpiresAt: inHours(-1) })).toEqual({ level: "high", reasons: ["Authorization has expired"] });
    expect(assess({ authorizationExpiresAt: inHours(72) }).level).toBe("low");
    expect(assess({ authorizationExpiresAt: inHours(10), paymentStatus: "voided", status: "negotiating" }).level).toBe("low");
    expect(assess({ authorizationExpiresAt: null }).level).toBe("low");
  });

  it("lists high reasons before medium ones", () => {
    const result = assess({ status: "in_review", sellerTrust: "new", aiDegraded: true, deadline: inHours(3), authorizationExpiresAt: inHours(10) });
    expect(result.level).toBe("high");
    expect(result.reasons).toEqual([
      "Waiting for human review",
      "Authorization expires in under 72h",
      "Deadline in under 6h with funds held",
      "New seller with no settled history",
      "AI unavailable; scripted fallback or degraded verification used",
    ]);
  });
});

describe("assessRisk — medium", () => {
  it("flags a revision in progress", () => {
    expect(assess({ status: "revision_required", verificationDecision: "revision_required" })).toEqual({
      level: "medium",
      reasons: ["Delivery failed verification; revision in progress"],
    });
  });

  it("flags a deal waiting for spend approval", () => {
    const base = { status: "awaiting_approval", paymentStatus: "none", authorizationExpiresAt: null } as const;
    expect(assess({ ...base, policyOutcome: "needs_approval" })).toEqual({ level: "medium", reasons: ["Spend needs human approval under policy"] });
    expect(assess({ ...base, policyOutcome: null })).toEqual({ level: "medium", reasons: ["Waiting for human approval"] });
  });

  it("flags a new seller and degraded AI on open deals only", () => {
    expect(assess({ sellerTrust: "new" })).toEqual({ level: "medium", reasons: ["New seller with no settled history"] });
    expect(assess({ aiDegraded: true })).toEqual({ level: "medium", reasons: ["AI unavailable; scripted fallback or degraded verification used"] });
    expect(assess({ sellerTrust: null }).level).toBe("low");
    expect(assess({ status: "rejected", sellerTrust: "new", aiDegraded: true, paymentStatus: "voided" }).level).toBe("low");
  });

  it("flags a deadline under 24h away while nothing has been delivered", () => {
    expect(assess({ deadline: inHours(23.9) })).toEqual({ level: "medium", reasons: ["Deadline in under 24h, not yet delivered"] });
    expect(assess({ deadline: inHours(24) }).level).toBe("low");
    expect(assess({ status: "negotiating", paymentStatus: "none", deadline: inHours(10) }).level).toBe("medium");
    expect(assess({ status: "negotiating", paymentStatus: "none", deadline: inHours(-1) }).reasons).toEqual(["Deadline passed with nothing delivered"]);
    // Once delivered, the clock is no longer the seller's problem.
    expect(assess({ status: "submitted", paymentStatus: "authorized", deadline: inHours(10) }).level).toBe("low");
  });

  it("reports one deadline reason, not two, when the critical one applies", () => {
    const reasons = assess({ deadline: inHours(2) }).reasons;
    expect(reasons.filter((reason) => reason.startsWith("Deadline"))).toEqual(["Deadline in under 6h with funds held"]);
  });

  it("ignores an unreadable deadline rather than inventing urgency", () => {
    expect(assess({ deadline: "soon" })).toEqual({ level: "low", reasons: [] });
  });
});

describe("assessRisk — shape", () => {
  it("returns short phrases suitable for a tooltip, for every status", () => {
    for (const status of DEAL_STATUSES) {
      for (const deadline of [inHours(-1), inHours(3), inHours(100), null]) {
        const result = assess({ status, deadline, sellerTrust: "new", aiDegraded: true, revisionsUsed: 1, authorizationExpiresAt: inHours(5) });
        expect(["low", "medium", "high"]).toContain(result.level);
        expect(result.level === "low").toBe(result.reasons.length === 0);
        expect(new Set(result.reasons).size).toBe(result.reasons.length);
        for (const reason of result.reasons) {
          expect(reason.length).toBeLessThanOrEqual(70);
          expect(reason).toMatch(/^[A-Z]/);
        }
        if (isTerminal(status) && status !== "failed") expect(result.level).toBe("low");
      }
    }
  });

  it("is pure", () => {
    const input = { ...healthy };
    expect(assessRisk(input)).toEqual(assessRisk(input));
    expect(input).toEqual(healthy);
  });
});

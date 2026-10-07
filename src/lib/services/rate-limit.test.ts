import { describe, expect, it } from "vitest";
import { RATE_LIMITS, rateLimitKey } from "./rate-limit";

describe("rateLimitKey", () => {
  const session = "sess_0123456789abcdefghijklmn";

  it("never contains the subject it was derived from", () => {
    for (const subject of [session, "203.0.113.42", "2001:db8::8a2e:370:7334", "someone@example.com"]) {
      const key = rateLimitKey("deal-create", subject);
      expect(key).not.toContain(subject);
      expect(key).toMatch(/^rl:deal-create:[0-9a-f]{32}$/);
    }
  });

  it("is stable for the same scope and subject", () => {
    expect(rateLimitKey("deal-advance", session)).toBe(rateLimitKey("deal-advance", session));
  });

  it("separates subjects, and the same subject under different rules", () => {
    const keys = [
      rateLimitKey("deal-create", session),
      rateLimitKey("deal-create", `${session}x`),
      rateLimitKey("deal-advance", session),
      rateLimitKey("deal-decision", session),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    // The scope is part of what is hashed, so a subject cannot be matched across counters by its digest.
    const digests = keys.map((key) => key.slice(key.lastIndexOf(":") + 1));
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("does not let a crafted subject collide with another scope's key", () => {
    expect(rateLimitKey("deal", "create:abc")).not.toBe(rateLimitKey("deal:create", "abc"));
  });
});

describe("RATE_LIMITS", () => {
  it("holds the limits the API documents", () => {
    expect(RATE_LIMITS.createDealPerSession).toMatchObject({ limit: 8, windowSeconds: 600 });
    expect(RATE_LIMITS.createDealPerClient).toMatchObject({ limit: 40, windowSeconds: 3600 });
    expect(RATE_LIMITS.advancePerSession).toMatchObject({ limit: 300, windowSeconds: 600 });
    expect(RATE_LIMITS.decisionPerSession).toMatchObject({ limit: 60, windowSeconds: 600 });
    expect(RATE_LIMITS.policyUpdatePerSession).toMatchObject({ limit: 30, windowSeconds: 600 });
    expect(RATE_LIMITS.approvalReturnPerDeal).toMatchObject({ limit: 30, windowSeconds: 600 });
  });

  it("backs every per-session rule a new cookie could reset with a per-address rule", () => {
    expect(RATE_LIMITS.policyUpdatePerClient).toMatchObject({ limit: 120, windowSeconds: 3600 });
    expect(RATE_LIMITS.walletConnectPerClient).toMatchObject({ limit: 30, windowSeconds: 3600 });
    expect(RATE_LIMITS.reconcilePerClient).toMatchObject({ limit: 36, windowSeconds: 600 });
    expect(RATE_LIMITS.narratedReconcileGlobal).toMatchObject({ limit: 120, windowSeconds: 3600 });
    expect(RATE_LIMITS.webhookVerificationGlobal).toMatchObject({ limit: 30, windowSeconds: 60 });
  });

  it("gives every rule its own counter", () => {
    const scopes = Object.values(RATE_LIMITS).map((rule) => rule.scope);
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

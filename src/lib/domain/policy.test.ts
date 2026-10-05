import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyInput } from "./policy";
import { DEFAULT_POLICY, PolicyEvaluationSchema, type Policy, type PolicyEvaluation } from "./schemas";
import { TEST_NOW, sellerById } from "./test-support";

const northwind = sellerById("northwind");
const pixelharbor = sellerById("pixelharbor");

/** Default policy: $100 autonomous, $1,000 per transaction, $2,500 per day, new sellers need approval. */
const base: PolicyInput = {
  amountMinor: 4700,
  category: "illustration",
  seller: northwind,
  spentTodayMinor: 0,
  now: TEST_NOW,
};
const evaluate = (input: Partial<PolicyInput> = {}, policy: Policy = DEFAULT_POLICY): PolicyEvaluation =>
  evaluatePolicy(policy, { ...base, ...input });

function outcomeOf(evaluation: PolicyEvaluation, id: string): string {
  const check = evaluation.checks.find((candidate) => candidate.id === id);
  if (check === undefined) throw new Error(`missing check ${id}`);
  return check.outcome;
}
function detailOf(evaluation: PolicyEvaluation, id: string): string {
  return evaluation.checks.find((candidate) => candidate.id === id)?.detail ?? "";
}
const flagged = (evaluation: PolicyEvaluation): string[] =>
  evaluation.checks.filter((check) => check.outcome !== "pass").map((check) => check.id);

describe("evaluatePolicy", () => {
  it("allows a small purchase from an established seller", () => {
    const result = evaluate();
    expect(result.outcome).toBe("allow");
    expect(flagged(result)).toEqual([]);
    expect(result.spentTodayMinor).toBe(0);
    expect(result.evaluatedAt).toBe("2026-10-06T09:00:00.000Z");
    expect(PolicyEvaluationSchema.safeParse(result).success).toBe(true);
  });

  it("always reports all five checks in a fixed order, whatever the outcome", () => {
    const order = ["category_allowed", "per_transaction_max", "daily_limit", "autonomous_limit", "seller_trust"];
    const cases = [
      evaluate(),
      evaluate({ category: "restricted", amountMinor: 400_000, spentTodayMinor: 400_000, seller: pixelharbor }),
      evaluate({ amountMinor: 18_000 }),
    ];
    for (const result of cases) {
      expect(result.checks.map((check) => check.id)).toEqual(order);
      for (const check of result.checks) {
        expect(check.label.length).toBeGreaterThan(0);
        expect(check.detail).toMatch(/^[A-Z$].*\.$/);
      }
    }
  });
});

describe("category_allowed", () => {
  it("passes an allowed category", () => {
    expect(outcomeOf(evaluate({ category: "copywriting" }), "category_allowed")).toBe("pass");
    expect(detailOf(evaluate(), "category_allowed")).toBe("Illustration is an allowed category.");
  });

  it("blocks a category that is not on the allow-list", () => {
    const result = evaluate({ category: "other" });
    expect(result.outcome).toBe("block");
    expect(flagged(result)).toEqual(["category_allowed"]);
    expect(detailOf(result, "category_allowed")).toContain("not in the categories");
    expect(evaluate({}, { ...DEFAULT_POLICY, allowedCategories: [] }).outcome).toBe("block");
  });

  it("blocks restricted work even when a policy lists it as allowed", () => {
    const permissive: Policy = { ...DEFAULT_POLICY, allowedCategories: ["illustration", "restricted"] };
    const result = evaluate({ category: "restricted" }, permissive);
    expect(result.outcome).toBe("block");
    expect(detailOf(result, "category_allowed")).toBe("Restricted work can never be purchased by the agent.");
  });
});

describe("per_transaction_max", () => {
  it("allows exactly the maximum and blocks one cent more", () => {
    const atLimit = evaluate({ amountMinor: 100_000 });
    expect(outcomeOf(atLimit, "per_transaction_max")).toBe("pass");
    expect(atLimit.outcome).toBe("needs_approval"); // above the autonomous limit, but not blocked

    const over = evaluate({ amountMinor: 100_001 });
    expect(outcomeOf(over, "per_transaction_max")).toBe("block");
    expect(over.outcome).toBe("block");
    expect(detailOf(over, "per_transaction_max")).toBe("$1,000.01 exceeds the $1,000.00 per-transaction maximum.");
  });
});

describe("daily_limit", () => {
  it("allows spending exactly up to the limit and blocks one cent beyond", () => {
    const exact = evaluate({ amountMinor: 4700, spentTodayMinor: 245_300 });
    expect(outcomeOf(exact, "daily_limit")).toBe("pass");
    expect(exact.outcome).toBe("allow");

    const over = evaluate({ amountMinor: 4700, spentTodayMinor: 245_301 });
    expect(outcomeOf(over, "daily_limit")).toBe("block");
    expect(over.outcome).toBe("block");
    expect(detailOf(over, "daily_limit")).toBe("$47.00 on top of $2,453.01 already committed today would exceed the $2,500.00 daily limit.");
    expect(over.spentTodayMinor).toBe(245_301);
  });

  it("blocks everything once the day's limit is already used up", () => {
    expect(evaluate({ amountMinor: 100, spentTodayMinor: 250_000 }).outcome).toBe("block");
    expect(outcomeOf(evaluate({ amountMinor: 0, spentTodayMinor: 250_000 }), "daily_limit")).toBe("pass");
  });

  it("stays a valid evaluation when the day's spend is already beyond any single-transaction limit", () => {
    // Two deals that cleared policy at the same moment, or a lowered limit, can leave the day's
    // total above $5,000. The evaluation must still be storable: it is what explains the block.
    const result = evaluate({ spentTodayMinor: 720_000 });
    expect(result.outcome).toBe("block");
    expect(result.spentTodayMinor).toBe(720_000);
    expect(PolicyEvaluationSchema.safeParse(result).success).toBe(true);
  });

  it("counts earlier spending even when this purchase is small", () => {
    const result = evaluate({ amountMinor: 1800, spentTodayMinor: 249_000 });
    expect(flagged(result)).toEqual(["daily_limit"]);
  });
});

describe("autonomous_limit", () => {
  it("lets the agent act alone at exactly the limit and asks a human one cent above", () => {
    const atLimit = evaluate({ amountMinor: 10_000 });
    expect(outcomeOf(atLimit, "autonomous_limit")).toBe("pass");
    expect(atLimit.outcome).toBe("allow");

    const over = evaluate({ amountMinor: 10_001 });
    expect(outcomeOf(over, "autonomous_limit")).toBe("needs_approval");
    expect(over.outcome).toBe("needs_approval");
    expect(flagged(over)).toEqual(["autonomous_limit"]);
  });

  it("explains the approval in plain money terms", () => {
    const result = evaluate({ amountMinor: 18_000, category: "copywriting", seller: sellerById("lingua") });
    expect(result.outcome).toBe("needs_approval");
    expect(detailOf(result, "autonomous_limit")).toContain("$180.00 exceeds the $100.00 autonomous limit");
  });

  it("never needs approval for amount alone when the autonomous limit equals the maximum", () => {
    const trusting: Policy = { ...DEFAULT_POLICY, autonomousLimitMinor: 100_000 };
    expect(evaluate({ amountMinor: 100_000 }, trusting).outcome).toBe("allow");
  });
});

describe("seller_trust", () => {
  it("asks a human before the first deal with a new seller", () => {
    const result = evaluate({ amountMinor: 1800, seller: pixelharbor });
    expect(result.outcome).toBe("needs_approval");
    expect(flagged(result)).toEqual(["seller_trust"]);
    expect(detailOf(result, "seller_trust")).toBe("Pixel Harbor is a new seller with no settled history, so a human must approve the spend.");
  });

  it("does not ask when the policy waives approval for new sellers", () => {
    const relaxed: Policy = { ...DEFAULT_POLICY, requireApprovalForNewSellers: false };
    const result = evaluate({ amountMinor: 1800, seller: pixelharbor }, relaxed);
    expect(result.outcome).toBe("allow");
    expect(detailOf(result, "seller_trust")).toContain("does not require approval");
  });

  it("passes established sellers", () => {
    expect(detailOf(evaluate(), "seller_trust")).toBe("Northwind Studio is an established seller.");
  });
});

describe("overall outcome", () => {
  it("blocks when any check blocks, even if others only need approval", () => {
    const result = evaluate({ amountMinor: 100_001, seller: pixelharbor });
    expect(result.outcome).toBe("block");
    expect(flagged(result)).toEqual(["per_transaction_max", "autonomous_limit", "seller_trust"]);
  });

  it("needs approval when nothing blocks but something needs a human", () => {
    const result = evaluate({ amountMinor: 18_000, seller: pixelharbor });
    expect(result.outcome).toBe("needs_approval");
    expect(flagged(result)).toEqual(["autonomous_limit", "seller_trust"]);
  });

  it("gives the demo scenarios the outcomes they are meant to show", () => {
    expect(evaluate({ amountMinor: 4700 }).outcome).toBe("allow"); // happy path
    expect(evaluate({ amountMinor: 2700, seller: sellerById("quickdraw") }).outcome).toBe("allow"); // revision
    expect(evaluate({ amountMinor: 18_000, category: "copywriting", seller: sellerById("lingua") }).outcome).toBe("needs_approval");
    expect(evaluate({ amountMinor: 1800, seller: pixelharbor }).outcome).toBe("needs_approval"); // new seller
  });

  it("is pure: same input, same evaluation, input untouched", () => {
    const policy = structuredClone(DEFAULT_POLICY);
    const input = { ...base };
    expect(evaluatePolicy(policy, input)).toEqual(evaluatePolicy(policy, input));
    expect(policy).toEqual(DEFAULT_POLICY);
    expect(input).toEqual(base);
  });

  it("rejects amounts that are not integer minor units", () => {
    expect(() => evaluate({ amountMinor: 47.5 })).toThrow(RangeError);
    expect(() => evaluate({ amountMinor: -100 })).toThrow(/amountMinor/);
    expect(() => evaluate({ spentTodayMinor: Number.NaN })).toThrow(/spentTodayMinor/);
  });
});

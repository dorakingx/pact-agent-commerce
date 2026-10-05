/**
 * Spending policy engine.
 *
 * Decides — with plain arithmetic, no model involved — whether the buyer agent may commit
 * funds on its own, must ask a human first, or may not proceed at all. Every check is always
 * evaluated and reported, so the UI can show the full picture rather than only the first failure.
 */
import { assertMinor, formatMoney } from "./money";
import type { Category, Policy, PolicyCheck, PolicyEvaluation, PolicyOutcome } from "./schemas";
import type { SellerProfile } from "./sellers";

export interface PolicyInput {
  /** The contract price about to be authorized. */
  amountMinor: number;
  category: Category;
  seller: Pick<SellerProfile, "id" | "name" | "trust">;
  /** Total already authorized for this buyer in the current UTC day, excluding this deal. */
  spentTodayMinor: number;
  now: Date;
}

const CATEGORY_LABEL: Record<Category, string> = {
  illustration: "Illustration",
  copywriting: "Copywriting",
  translation: "Translation",
  other: "Uncategorised work",
  restricted: "Restricted work",
};

function categoryCheck(policy: Policy, category: Category): PolicyCheck {
  const base = { id: "category_allowed", label: "Category allowed" };
  if (category === "restricted") {
    // "restricted" is blocked even if someone lists it in allowedCategories by mistake.
    return { ...base, outcome: "block", detail: "Restricted work can never be purchased by the agent." };
  }
  if (!policy.allowedCategories.includes(category)) {
    return {
      ...base,
      outcome: "block",
      detail: `${CATEGORY_LABEL[category]} is not in the categories this agent is allowed to buy.`,
    };
  }
  return { ...base, outcome: "pass", detail: `${CATEGORY_LABEL[category]} is an allowed category.` };
}

function perTransactionCheck(policy: Policy, amountMinor: number): PolicyCheck {
  const base = { id: "per_transaction_max", label: "Per-transaction maximum" };
  const amount = formatMoney(amountMinor);
  const max = formatMoney(policy.maxTransactionMinor);
  return amountMinor > policy.maxTransactionMinor
    ? { ...base, outcome: "block", detail: `${amount} exceeds the ${max} per-transaction maximum.` }
    : { ...base, outcome: "pass", detail: `${amount} is within the ${max} per-transaction maximum.` };
}

function dailyLimitCheck(policy: Policy, amountMinor: number, spentTodayMinor: number): PolicyCheck {
  const base = { id: "daily_limit", label: "Daily limit" };
  const amount = formatMoney(amountMinor);
  const spent = formatMoney(spentTodayMinor);
  const limit = formatMoney(policy.dailyLimitMinor);
  const totalMinor = spentTodayMinor + amountMinor;
  return totalMinor > policy.dailyLimitMinor
    ? {
        ...base,
        outcome: "block",
        detail: `${amount} on top of ${spent} already committed today would exceed the ${limit} daily limit.`,
      }
    : {
        ...base,
        outcome: "pass",
        detail: `${amount} on top of ${spent} already committed today stays within the ${limit} daily limit.`,
      };
}

function autonomousLimitCheck(policy: Policy, amountMinor: number): PolicyCheck {
  const base = { id: "autonomous_limit", label: "Autonomous limit" };
  const amount = formatMoney(amountMinor);
  const limit = formatMoney(policy.autonomousLimitMinor);
  return amountMinor > policy.autonomousLimitMinor
    ? {
        ...base,
        outcome: "needs_approval",
        detail: `${amount} exceeds the ${limit} autonomous limit, so a human must approve the spend.`,
      }
    : { ...base, outcome: "pass", detail: `${amount} is within the ${limit} autonomous limit.` };
}

function sellerTrustCheck(policy: Policy, seller: PolicyInput["seller"]): PolicyCheck {
  const base = { id: "seller_trust", label: "Seller trust" };
  if (seller.trust === "established") {
    return { ...base, outcome: "pass", detail: `${seller.name} is an established seller.` };
  }
  return policy.requireApprovalForNewSellers
    ? {
        ...base,
        outcome: "needs_approval",
        detail: `${seller.name} is a new seller with no settled history, so a human must approve the spend.`,
      }
    : {
        ...base,
        outcome: "pass",
        detail: `${seller.name} is a new seller; this policy does not require approval for new sellers.`,
      };
}

function overallOutcome(checks: readonly PolicyCheck[]): PolicyOutcome {
  if (checks.some((check) => check.outcome === "block")) return "block";
  if (checks.some((check) => check.outcome === "needs_approval")) return "needs_approval";
  return "allow";
}

/**
 * Evaluate a prospective authorization against the spending policy.
 * A limit is exceeded only when the amount is strictly greater than it: spending exactly the
 * limit is allowed.
 */
export function evaluatePolicy(policy: Policy, input: PolicyInput): PolicyEvaluation {
  assertMinor(input.amountMinor, "amountMinor");
  assertMinor(input.spentTodayMinor, "spentTodayMinor");

  const checks: PolicyCheck[] = [
    categoryCheck(policy, input.category),
    perTransactionCheck(policy, input.amountMinor),
    dailyLimitCheck(policy, input.amountMinor, input.spentTodayMinor),
    autonomousLimitCheck(policy, input.amountMinor),
    sellerTrustCheck(policy, input.seller),
  ];

  return {
    outcome: overallOutcome(checks),
    checks,
    spentTodayMinor: input.spentTodayMinor,
    evaluatedAt: input.now.toISOString(),
  };
}

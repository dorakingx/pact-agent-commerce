import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, type PolicyInput } from "@/lib/domain/policy";
import { DEFAULT_POLICY, VerificationDecisionSchema, type Policy } from "@/lib/domain/schemas";
import {
  DOCS_BASE_URL,
  HUMAN_GATES,
  IDEMPOTENCY_NOTE,
  PAYPAL_CALLS,
  RESOURCES,
  ROLES,
  VERIFICATION_ROWS,
  spendingControls,
} from "./content";

const repoFile = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const payPalClient = readFileSync(repoFile("src/lib/payments/paypal-client.ts"), "utf8");

describe("PayPal calls on the page", () => {
  it("names only endpoints the PayPal client really calls, with the same method", () => {
    for (const call of PAYPAL_CALLS) {
      // The client declares each request as `method: "POST", path: …, template: "<path>"`.
      const declaration = new RegExp(`method: "${call.method}",\\s*path: [^\\n]+\\n\\s*template: "${call.path.replace(/[{}/]/g, "\\$&")}"`);
      expect(payPalClient, `${call.method} ${call.path}`).toMatch(declaration);
    }
  });

  it("describes the order as the client builds it", () => {
    expect(payPalClient).toContain('intent: "AUTHORIZE"');
    expect(payPalClient).toContain("custom_id: `pact:v1:${input.contractHash}`");
    expect(payPalClient).toContain("invoice_id: input.contractId");
    expect(payPalClient).toContain("final_capture: input.finalCapture");
  });

  it("marks exactly the four calls that hold or move money", () => {
    expect(PAYPAL_CALLS.filter((call) => call.movesMoney).map((call) => call.id)).toEqual([
      "create-order",
      "authorize-order",
      "capture",
      "void",
    ]);
    expect(IDEMPOTENCY_NOTE).toContain("PayPal-Request-Id");
  });

  it("covers Orders v2, Payments v2, Vault v3 and webhooks", () => {
    expect([...new Set(PAYPAL_CALLS.map((call) => call.api))]).toEqual(["Orders v2", "Payments v2", "Vault v3", "Webhooks"]);
    expect(new Set(PAYPAL_CALLS.map((call) => call.id)).size).toBe(PAYPAL_CALLS.length);
  });
});

describe("spending controls on the page", () => {
  const input: PolicyInput = {
    amountMinor: 1_000,
    category: "illustration",
    seller: { id: "s", name: "Seller", trust: "established" },
    spentTodayMinor: 0,
    now: new Date(0),
  };
  const outcomeOf = (id: string, policy: Policy, overrides: Partial<PolicyInput>) =>
    evaluatePolicy(policy, { ...input, ...overrides }).checks.find((check) => check.id === id)?.outcome;

  it("lists the engine's five checks in the engine's order", () => {
    expect(spendingControls().map((control) => control.id)).toEqual([
      "category_allowed",
      "per_transaction_max",
      "daily_limit",
      "autonomous_limit",
      "seller_trust",
    ]);
  });

  it("states for each check what the engine actually does when it does not pass", () => {
    const violations: Record<string, Partial<PolicyInput>> = {
      category_allowed: { category: "restricted" },
      per_transaction_max: { amountMinor: DEFAULT_POLICY.maxTransactionMinor + 1 },
      daily_limit: { spentTodayMinor: DEFAULT_POLICY.dailyLimitMinor },
      autonomous_limit: { amountMinor: DEFAULT_POLICY.autonomousLimitMinor + 1 },
      seller_trust: { seller: { id: "n", name: "New seller", trust: "new" } },
    };
    for (const control of spendingControls()) {
      const violation = violations[control.id];
      expect(violation, control.id).toBeDefined();
      expect(outcomeOf(control.id, DEFAULT_POLICY, violation ?? {}), control.id).toBe(control.effect);
      expect(outcomeOf(control.id, DEFAULT_POLICY, {}), control.id).toBe("pass");
    }
  });

  it("quotes the default limits", () => {
    const rules = spendingControls().map((control) => control.rule).join(" ");
    expect(rules).toContain("$100.00");
    expect(rules).toContain("$1,000.00");
    expect(rules).toContain("$2,500.00");
  });
});

describe("verification decisions on the page", () => {
  it("has exactly one row per decision the engine can reach", () => {
    expect([...VERIFICATION_ROWS.map((row) => row.decision)].sort()).toEqual([...VerificationDecisionSchema.options].sort());
  });

  it("captures only on capture_eligible", () => {
    const captured = VERIFICATION_ROWS.filter((row) => row.money === "Captured").map((row) => row.decision);
    expect(captured).toEqual(["capture_eligible"]);
  });
});

describe("roles and resources", () => {
  it("presents the three roles in the order of the design rule", () => {
    expect(ROLES.map((role) => role.id)).toEqual(["models", "code", "paypal"]);
    expect(HUMAN_GATES).toHaveLength(3);
  });

  it("links to documents that exist in this repository", () => {
    for (const resource of RESOURCES) {
      if (resource.href.startsWith(DOCS_BASE_URL)) {
        expect(resource.external).toBe(true);
        expect(existsSync(repoFile(`docs${resource.href.slice(DOCS_BASE_URL.length)}`)), resource.href).toBe(true);
      } else {
        expect(resource.external).toBe(false);
        expect(existsSync(repoFile(`public${resource.href}`)), resource.href).toBe(true);
      }
    }
    expect(RESOURCES.map((resource) => resource.id)).toEqual(["architecture", "security", "openapi"]);
  });

  it("never describes the product as escrow", () => {
    const everything = JSON.stringify([ROLES, HUMAN_GATES, PAYPAL_CALLS, IDEMPOTENCY_NOTE, VERIFICATION_ROWS, spendingControls(), RESOURCES]);
    expect(everything.toLowerCase()).not.toContain("escrow");
  });
});

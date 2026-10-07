import { describe, expect, it } from "vitest";
import type { WalletStatus } from "../api/dto";
import { MAX_AMOUNT_MINOR } from "../domain/money";
import { ApiClientError } from "./api";
import { DEFAULT_POLICY, PolicySchema, type Policy } from "../domain/schemas";
import { getSeller } from "../domain/sellers";
import {
  EDITABLE_CATEGORIES,
  EXAMPLE_DEALS,
  confidenceRules,
  describeWallet,
  draftFromPolicy,
  formatDollarsInput,
  isDraftDirty,
  parseDollars,
  policiesEqual,
  policyNotes,
  previewExamples,
  reduceDraft,
  resolveApproveUrl,
  serverFieldErrors,
  spendBands,
  spendMeter,
  toFailure,
  validateDraft,
  walletNotice,
  type PolicyDraft,
} from "./policy-derive";

const NOW = new Date("2026-10-06T09:00:00.000Z");

function policy(overrides: Partial<Policy> = {}): Policy {
  return { ...DEFAULT_POLICY, ...overrides };
}

function draft(overrides: Partial<PolicyDraft> = {}): PolicyDraft {
  return { ...draftFromPolicy(DEFAULT_POLICY), ...overrides };
}

function wallet(overrides: Partial<WalletStatus> = {}): WalletStatus {
  return {
    provider: "simulated",
    supportsVault: true,
    session: { connected: false, pending: false, payerEmailMasked: null },
    demo: { connected: false },
    effectiveMode: "interactive",
    ...overrides,
  };
}

describe("parseDollars", () => {
  it.each([
    ["100", 10_000],
    ["100.5", 10_050],
    ["100.50", 10_050],
    ["0.29", 29],
    ["1,000.00", 100_000],
    ["$2,500", 250_000],
    ["  47.00 ", 4_700],
    ["0", 0],
    ["12.", 1_200],
  ])("reads %j as %d minor units", (text, minor) => {
    expect(parseDollars(text)).toEqual({ ok: true, minor });
  });

  it("converts on the digits, so no amount picks up a float error", () => {
    // 1.15 * 100 is 114.99999999999999 in IEEE 754.
    expect(parseDollars("1.15")).toEqual({ ok: true, minor: 115 });
    expect(parseDollars("4999.99")).toEqual({ ok: true, minor: 499_999 });
  });

  it.each(["", "   "])("asks for an amount when the field is empty (%j)", (text) => {
    expect(parseDollars(text)).toEqual({ ok: false, message: "Enter an amount." });
  });

  it.each(["abc", "-5", "1.234", "1,00", "12,34.00", "1e3", "100 USD", "..5", ".5", "１００"])(
    "rejects %j instead of guessing",
    (text) => {
      const parsed = parseDollars(text);
      expect(parsed.ok).toBe(false);
    },
  );

  it("refuses anything above the sandbox ceiling, and accepts the ceiling itself", () => {
    expect(parseDollars("5000")).toEqual({ ok: true, minor: MAX_AMOUNT_MINOR });
    const over = parseDollars("5000.01");
    expect(over).toEqual({ ok: false, message: "Cannot exceed $5,000.00, the ceiling of this sandbox." });
  });
});

describe("formatDollarsInput", () => {
  it("round-trips through parseDollars", () => {
    for (const minor of [0, 29, 4_700, 100_000, MAX_AMOUNT_MINOR]) {
      expect(parseDollars(formatDollarsInput(minor))).toEqual({ ok: true, minor });
    }
    expect(formatDollarsInput(250_000)).toBe("2,500.00");
  });
});

describe("draftFromPolicy and validateDraft", () => {
  it("round-trips the default policy unchanged", () => {
    const result = validateDraft(draftFromPolicy(DEFAULT_POLICY));
    expect(result.errors).toEqual({});
    expect(result.policy).toEqual(DEFAULT_POLICY);
    expect(result.candidate).toEqual(DEFAULT_POLICY);
  });

  it("produces a document the server schema accepts", () => {
    const result = validateDraft(
      draft({ money: { autonomousLimitMinor: "75", maxTransactionMinor: "400.5", dailyLimitMinor: "$1,200" } }),
    );
    expect(result.policy).not.toBeNull();
    expect(PolicySchema.safeParse(result.policy).success).toBe(true);
    expect(result.policy).toMatchObject({ autonomousLimitMinor: 7_500, maxTransactionMinor: 40_050, dailyLimitMinor: 120_000 });
  });

  it("never lets the restricted category into the saved policy", () => {
    const fromServer = draftFromPolicy(policy({ allowedCategories: ["restricted", "translation", "illustration"] }));
    expect(fromServer.allowedCategories).toEqual(["illustration", "translation"]);
    expect(validateDraft(fromServer).policy?.allowedCategories).toEqual(["illustration", "translation"]);
    expect(EDITABLE_CATEGORIES).not.toContain("restricted");
  });

  it("reports an unreadable amount on its own field and yields nothing to save or preview", () => {
    const result = validateDraft(draft({ money: { ...draft().money, dailyLimitMinor: "lots" } }));
    expect(result.policy).toBeNull();
    expect(result.candidate).toBeNull();
    expect(Object.keys(result.errors)).toEqual(["dailyLimitMinor"]);
  });

  it("applies the schema's cross-field rule and still offers a candidate for the preview", () => {
    const result = validateDraft(draft({ money: { ...draft().money, autonomousLimitMinor: "2,000" } }));
    expect(result.policy).toBeNull();
    expect(result.candidate?.autonomousLimitMinor).toBe(200_000);
    expect(result.errors).toEqual({
      autonomousLimitMinor: "Autonomous limit cannot exceed the per-transaction maximum.",
    });
  });

  it("flags a review floor above the capture threshold", () => {
    const result = validateDraft(draft({ autoCapturePercent: 60, humanReviewPercent: 70 }));
    expect(result.policy).toBeNull();
    expect(result.errors.humanReviewMinConfidence).toBe("Human-review threshold cannot exceed the auto-capture threshold.");
  });

  it("stores whole percentages as exact fractions", () => {
    const result = validateDraft(draft({ autoCapturePercent: 85, humanReviewPercent: 7 }));
    expect(result.policy?.autoCaptureMinConfidence).toBe(0.85);
    expect(result.policy?.humanReviewMinConfidence).toBe(0.07);
  });
});

describe("reduceDraft", () => {
  it("keeps half-typed amounts as typed and tidies them on blur", () => {
    const typing = reduceDraft(draft(), { type: "money", field: "autonomousLimitMinor", text: "1250." });
    expect(typing.money.autonomousLimitMinor).toBe("1250.");
    const typed = reduceDraft(typing, { type: "money", field: "autonomousLimitMinor", text: "1250.5" });
    expect(reduceDraft(typed, { type: "money_blur", field: "autonomousLimitMinor" }).money.autonomousLimitMinor).toBe("1,250.50");
  });

  it("leaves an invalid amount alone on blur so the person can correct it", () => {
    const typed = reduceDraft(draft(), { type: "money", field: "dailyLimitMinor", text: "12x" });
    expect(reduceDraft(typed, { type: "money_blur", field: "dailyLimitMinor" })).toBe(typed);
  });

  it("toggles categories in a stable order and ignores the restricted one", () => {
    const without = reduceDraft(draft(), { type: "category", category: "illustration", allowed: false });
    expect(without.allowedCategories).toEqual(["copywriting", "translation"]);
    const withOther = reduceDraft(without, { type: "category", category: "other", allowed: true });
    expect(withOther.allowedCategories).toEqual(["copywriting", "translation", "other"]);
    const again = reduceDraft(withOther, { type: "category", category: "illustration", allowed: true });
    expect(again.allowedCategories).toEqual(["illustration", "copywriting", "translation", "other"]);
    expect(reduceDraft(again, { type: "category", category: "restricted", allowed: true })).toBe(again);
    // Ticking a box that is already ticked must not duplicate the category.
    expect(reduceDraft(again, { type: "category", category: "other", allowed: true }).allowedCategories).toHaveLength(4);
  });

  it("drags the review floor down with the capture threshold and never above it", () => {
    const start = draft({ autoCapturePercent: 85, humanReviewPercent: 70 });
    const lowered = reduceDraft(start, { type: "auto_capture", percent: 60 });
    expect(lowered).toMatchObject({ autoCapturePercent: 60, humanReviewPercent: 60 });
    expect(reduceDraft(lowered, { type: "human_review", percent: 95 }).humanReviewPercent).toBe(60);
    expect(reduceDraft(lowered, { type: "human_review", percent: -4 }).humanReviewPercent).toBe(0);
  });

  it("keeps the capture threshold inside what the schema allows", () => {
    expect(reduceDraft(draft(), { type: "auto_capture", percent: 12 }).autoCapturePercent).toBe(50);
    expect(reduceDraft(draft(), { type: "auto_capture", percent: 140 }).autoCapturePercent).toBe(100);
    expect(reduceDraft(draft(), { type: "auto_capture", percent: Number.NaN }).autoCapturePercent).toBe(50);
  });

  it("every state the reducer can reach through the sliders is valid", () => {
    let state = draft();
    for (const percent of [100, 50, 73, 91]) {
      state = reduceDraft(state, { type: "auto_capture", percent });
      state = reduceDraft(state, { type: "human_review", percent: percent + 10 });
      expect(validateDraft(state).policy).not.toBeNull();
    }
  });

  it("replaces the whole draft and toggles the new-seller rule", () => {
    const custom = policy({ autonomousLimitMinor: 500, requireApprovalForNewSellers: false });
    const replaced = reduceDraft(draft(), { type: "replace", policy: custom });
    expect(validateDraft(replaced).policy).toEqual(custom);
    expect(reduceDraft(replaced, { type: "new_seller_approval", required: true }).requireApprovalForNewSellers).toBe(true);
  });
});

describe("policiesEqual and isDraftDirty", () => {
  it("ignores the order of the categories", () => {
    expect(
      policiesEqual(policy({ allowedCategories: ["translation", "illustration"] }), policy({ allowedCategories: ["illustration", "translation"] })),
    ).toBe(true);
    expect(policiesEqual(policy(), policy({ dailyLimitMinor: 1 }))).toBe(false);
    expect(policiesEqual(policy(), policy({ allowedCategories: ["illustration"] }))).toBe(false);
  });

  it("is clean right after loading, even when the amount is typed another way", () => {
    expect(isDraftDirty(validateDraft(draftFromPolicy(DEFAULT_POLICY)), DEFAULT_POLICY)).toBe(false);
    const sameValue = draft({ money: { ...draft().money, autonomousLimitMinor: "100" } });
    expect(isDraftDirty(validateDraft(sameValue), DEFAULT_POLICY)).toBe(false);
  });

  it("is dirty after a real change, and while an amount cannot be read", () => {
    expect(isDraftDirty(validateDraft(draft({ requireApprovalForNewSellers: false })), DEFAULT_POLICY)).toBe(true);
    expect(isDraftDirty(validateDraft(draft({ money: { ...draft().money, autonomousLimitMinor: "" } })), DEFAULT_POLICY)).toBe(true);
  });
});

describe("toFailure", () => {
  it("keeps the server's message and request id", () => {
    const error = new ApiClientError(429, "rate_limited", "Too many requests.", "req-1", { resetAt: "soon" });
    expect(toFailure(error)).toEqual({ message: "Too many requests.", requestId: "req-1" });
  });

  it("never shows the internals of an unexpected error", () => {
    expect(toFailure(new TypeError("Cannot read properties of undefined (reading 'x')"))).toEqual({
      message: "Something went wrong. Try again.",
      requestId: null,
    });
    expect(toFailure("boom").requestId).toBeNull();
  });
});

describe("serverFieldErrors", () => {
  it("maps the API's issue list onto fields, first message per field", () => {
    const errors = serverFieldErrors({
      issues: [
        { path: "autonomousLimitMinor", message: "autonomous limit cannot exceed the per-transaction maximum" },
        { path: "autonomousLimitMinor", message: "second message" },
        { path: "allowedCategories.2", message: "Invalid option" },
      ],
    });
    expect(errors).toEqual({
      autonomousLimitMinor: "Autonomous limit cannot exceed the per-transaction maximum.",
      allowedCategories: "Invalid option.",
    });
  });

  it.each([null, undefined, "nope", 42, {}, { issues: "x" }, { issues: [null, 3, { path: 1, message: "m" }, { path: "unknownField", message: "m" }] }])(
    "returns no errors for a payload that is not an issue list (%j)",
    (details) => {
      expect(serverFieldErrors(details)).toEqual({});
    },
  );
});

describe("policyNotes", () => {
  it("has nothing to say about the default policy", () => {
    expect(policyNotes(DEFAULT_POLICY)).toEqual({});
  });

  it("points out settings that are valid but surprising", () => {
    const notes = policyNotes(policy({ autonomousLimitMinor: 0, dailyLimitMinor: 50_000, allowedCategories: [] }));
    expect(notes.autonomousLimitMinor).toContain("every purchase waits for your approval");
    expect(notes.dailyLimitMinor).toContain("$500.00");
    expect(notes.allowedCategories).toContain("every purchase will be blocked");
  });
});

describe("spendBands", () => {
  it("splits amounts into alone / approval / blocked at the two limits", () => {
    expect(spendBands(DEFAULT_POLICY)).toEqual([
      { id: "autonomous", title: "Agent decides alone", range: "Up to $100.00", tone: "success" },
      { id: "approval", title: "You approve first", range: "$100.01 – $1,000.00", tone: "review" },
      { id: "blocked", title: "Always blocked", range: "Over $1,000.00", tone: "danger" },
    ]);
  });

  it("drops the approval band when both limits are equal", () => {
    const bands = spendBands({ autonomousLimitMinor: 30_000, maxTransactionMinor: 30_000 });
    expect(bands.map((band) => band.id)).toEqual(["autonomous", "blocked"]);
  });

  it("drops the autonomous band when the agent may never act alone", () => {
    const bands = spendBands({ autonomousLimitMinor: 0, maxTransactionMinor: 30_000 });
    expect(bands.map((band) => band.id)).toEqual(["approval", "blocked"]);
    expect(bands[0]?.range).toBe("Up to $300.00");
  });

  it("lets the maximum win while a draft holds a larger autonomous limit", () => {
    const bands = spendBands({ autonomousLimitMinor: 90_000, maxTransactionMinor: 20_000 });
    expect(bands).toEqual([
      { id: "autonomous", title: "Agent decides alone", range: "Up to $200.00", tone: "success" },
      { id: "blocked", title: "Always blocked", range: "Over $200.00", tone: "danger" },
    ]);
  });

  it("is only the blocked band when nothing may be bought", () => {
    expect(spendBands({ autonomousLimitMinor: 0, maxTransactionMinor: 0 }).map((band) => band.id)).toEqual(["blocked"]);
  });
});

describe("spendMeter", () => {
  it("is calm with most of the limit left", () => {
    expect(spendMeter(4_700, 250_000)).toEqual({ ratio: 4_700 / 250_000, remainingMinor: 245_300, overMinor: 0, tone: "success" });
  });

  it("warns from 80% and turns red once nothing is left", () => {
    expect(spendMeter(200_000, 250_000).tone).toBe("hold");
    expect(spendMeter(199_999, 250_000).tone).toBe("success");
    expect(spendMeter(250_000, 250_000)).toEqual({ ratio: 1, remainingMinor: 0, overMinor: 0, tone: "danger" });
  });

  it("reports how far commitments exceed a limit that was lowered afterwards", () => {
    expect(spendMeter(30_000, 10_000)).toEqual({ ratio: 1, remainingMinor: 0, overMinor: 20_000, tone: "danger" });
  });

  it("treats a zero limit as used up without dividing by zero", () => {
    expect(spendMeter(0, 0)).toEqual({ ratio: 1, remainingMinor: 0, overMinor: 0, tone: "danger" });
  });
});

describe("confidenceRules", () => {
  it("describes the four bands of the default thresholds plus the uncertain case", () => {
    expect(confidenceRules(85, 50).map((rule) => [rule.id, rule.when, rule.tone])).toEqual([
      ["pass_high", "Passes at 85% or higher", "success"],
      ["pass_low", "Passes below 85%", "review"],
      ["fail_high", "Fails at 50% or higher", "danger"],
      ["fail_low", "Fails below 50%", "review"],
      ["uncertain", "Uncertain, or the AI verifier is unavailable", "review"],
    ]);
  });

  it("drops the low-confidence failure band when the floor is zero", () => {
    const rules = confidenceRules(90, 0);
    expect(rules.map((rule) => rule.id)).toEqual(["pass_high", "pass_low", "fail_high", "uncertain"]);
    expect(rules[2]?.when).toBe("Fails at any confidence");
  });
});

describe("previewExamples", () => {
  const outcomes = (p: Policy, spent = 0) => previewExamples(p, spent, NOW).map((row) => row.evaluation.outcome);

  it("uses sellers exactly as the demo directory lists them", () => {
    for (const example of EXAMPLE_DEALS) {
      const seller = getSeller(example.seller.id);
      expect(seller).toBeDefined();
      expect(example.seller).toEqual({ id: seller?.id, name: seller?.name, trust: seller?.trust });
      expect(seller?.categories).toContain(example.category);
    }
  });

  it("shows one deal of each kind under the default policy", () => {
    expect(outcomes(DEFAULT_POLICY)).toEqual(["allow", "needs_approval", "needs_approval"]);
    const [, copy, newSeller] = previewExamples(DEFAULT_POLICY, 0, NOW);
    expect(copy?.evaluation.checks.find((check) => check.outcome !== "pass")?.id).toBe("autonomous_limit");
    expect(newSeller?.evaluation.checks.find((check) => check.outcome !== "pass")?.id).toBe("seller_trust");
  });

  it("always reports all five checks, in the engine's order", () => {
    for (const { evaluation } of previewExamples(DEFAULT_POLICY, 0, NOW)) {
      expect(evaluation.checks.map((check) => check.id)).toEqual([
        "category_allowed",
        "per_transaction_max",
        "daily_limit",
        "autonomous_limit",
        "seller_trust",
      ]);
    }
  });

  it("follows the form: raising the autonomous limit frees the $180 deal", () => {
    expect(outcomes(policy({ autonomousLimitMinor: 18_000 }))).toEqual(["allow", "allow", "needs_approval"]);
    expect(outcomes(policy({ autonomousLimitMinor: 17_999 }))[1]).toBe("needs_approval");
  });

  it("follows the form: limits, categories and the new-seller rule", () => {
    expect(outcomes(policy({ autonomousLimitMinor: 1_000, maxTransactionMinor: 4_000 }))).toEqual(["block", "block", "needs_approval"]);
    expect(outcomes(policy({ allowedCategories: ["copywriting"] }))).toEqual(["block", "needs_approval", "block"]);
    expect(outcomes(policy({ requireApprovalForNewSellers: false }))).toEqual(["allow", "needs_approval", "allow"]);
  });

  it("counts what is already committed today against the daily limit", () => {
    expect(outcomes(DEFAULT_POLICY, 245_000)).toEqual(["allow", "block", "needs_approval"]);
    expect(previewExamples(DEFAULT_POLICY, 245_000, NOW)[1]?.evaluation.spentTodayMinor).toBe(245_000);
  });

  it("stamps the evaluation with the time it was given", () => {
    expect(previewExamples(DEFAULT_POLICY, 0, NOW)[0]?.evaluation.evaluatedAt).toBe(NOW.toISOString());
  });
});

describe("describeWallet", () => {
  it("prefers the session's own wallet", () => {
    const summary = describeWallet(
      wallet({ session: { connected: true, pending: false, payerEmailMasked: "b***@example.com" }, demo: { connected: true }, effectiveMode: "delegated" }),
    );
    expect(summary).toMatchObject({ state: "connected", tone: "success", canConnect: false, canDisconnect: true });
  });

  it("lets an unfinished connection be restarted or cancelled", () => {
    const summary = describeWallet(wallet({ session: { connected: false, pending: true, payerEmailMasked: null } }));
    expect(summary).toMatchObject({ state: "pending", canConnect: true, canDisconnect: true });
  });

  it("says when deals run on the shared demo wallet", () => {
    const summary = describeWallet(wallet({ demo: { connected: true }, effectiveMode: "delegated" }));
    expect(summary).toMatchObject({ state: "shared", tone: "info", canConnect: true, canDisconnect: false });
  });

  it("falls back to interactive approval", () => {
    expect(describeWallet(wallet())).toMatchObject({ state: "interactive", canConnect: true, canDisconnect: false });
  });

  it("offers nothing when the provider cannot vault", () => {
    const summary = describeWallet(wallet({ supportsVault: false, demo: { connected: true } }));
    expect(summary).toMatchObject({ state: "unsupported", canConnect: false, canDisconnect: false });
  });
});

describe("walletNotice", () => {
  it("has a message for each outcome PayPal can send the payer back with", () => {
    expect(walletNotice("connected")?.kind).toBe("success");
    expect(walletNotice("cancelled")?.kind).toBe("info");
    expect(walletNotice("error")?.kind).toBe("error");
  });

  it.each([null, "", "CONNECTED", "<script>"])("ignores anything else (%j)", (value) => {
    expect(walletNotice(value)).toBeNull();
  });
});

describe("resolveApproveUrl", () => {
  const origin = "http://localhost:3100";

  it("keeps an absolute PayPal link and resolves the simulator's path against this origin", () => {
    expect(resolveApproveUrl("https://www.sandbox.paypal.com/agreements/approve?approval_token_id=1AB", origin)).toBe(
      "https://www.sandbox.paypal.com/agreements/approve?approval_token_id=1AB",
    );
    expect(resolveApproveUrl("/api/paypal/vault-return?scope=session", origin)).toBe(
      "http://localhost:3100/api/paypal/vault-return?scope=session",
    );
  });

  it.each(["javascript:alert(1)", "data:text/html,<p>x</p>", "mailto:a@example.com", "http://"])("refuses %j", (value) => {
    expect(resolveApproveUrl(value, origin)).toBeNull();
  });
});

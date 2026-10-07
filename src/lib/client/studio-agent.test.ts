import { describe, expect, it } from "vitest";
import type { ReconciliationView } from "../api/dto";
import { DEAL_STATUSES } from "../domain/status";
import { deal, payment, report } from "./deal-derive.fixtures";
import {
  AGENT_INTRO,
  AUDITOR_AGENT_ID,
  LEAD_ADDENDUM,
  PROMPT_STARTERS,
  TOOL,
  auditorInstructions,
  dealByCode,
  explainDeal,
  findDeals,
  listAttentionItems,
  summarizeReconciliation,
  whyOf,
} from "./studio-agent";
import { opsRow, snapshotOf } from "./studio-fixtures";

const FORBIDDEN_ACTIONS = ["capture", "void", "approve", "decide"];

describe("what the agents are told", () => {
  it("offers the five starters, each sending a fuller question than its label", () => {
    expect(PROMPT_STARTERS.map((starter) => starter.label)).toEqual([
      "Which deals need a human right now?",
      "Show contracts at risk of missing their deadline",
      "Authorized vs captured by seller",
      "Why was the latest failed deal not captured?",
      "Reconcile the most recent captured deal with PayPal",
    ]);
    for (const starter of PROMPT_STARTERS) expect(starter.prompt.startsWith(starter.label.replace(/\?$/, ""))).toBe(true);
  });

  it("says in the panel, to the auditor and to the lead that nothing here can move money or decide", () => {
    const instructions = auditorInstructions(snapshotOf([opsRow("in_review"), opsRow("completed")]));
    for (const text of [AGENT_INTRO, instructions, LEAD_ADDENDUM]) {
      for (const action of FORBIDDEN_ACTIONS) expect(text.toLowerCase()).toContain(action);
      expect(text.toLowerCase()).toContain("read-only");
    }
    expect(instructions).toContain("no tool exists for it");
    expect(LEAD_ADDENDUM).toContain(`type: '${AUDITOR_AGENT_ID}'`);
  });

  it("names every tool the auditor has, and no tool that changes anything", () => {
    const instructions = auditorInstructions(snapshotOf([]));
    for (const name of Object.values(TOOL)) expect(instructions).toContain(name);
    expect(Object.values(TOOL)).toEqual(["list_attention_items", "find_deals", "explain_deal", "reconcile_with_paypal"]);
    for (const name of Object.values(TOOL)) expect(name).not.toMatch(/capture_|void_|approve|decline|decide|release|refund/);
  });

  it("grounds the auditor in the current ledger", () => {
    const instructions = auditorInstructions(snapshotOf([opsRow("in_review"), opsRow("awaiting_approval"), opsRow("completed")]));
    expect(instructions).toContain("3 deals in view, 2 waiting for a human, $47.00 held, $47.00 captured.");
  });

  it("never calls the hold an escrow", () => {
    expect(`${AGENT_INTRO} ${LEAD_ADDENDUM} ${auditorInstructions(snapshotOf([]))}`.toLowerCase()).not.toContain("escrow");
  });
});

describe("listAttentionItems", () => {
  const review = opsRow("in_review", { hoursToDeadline: 40 });
  const approval = opsRow("awaiting_approval", { hoursToDeadline: 12, sellerId: "quickdraw", seller: "Quickdraw Collective" });
  const lateWork = opsRow("authorized", { hoursToDeadline: 3, riskReasons: ["Deadline in under 6h with funds held"], risk: "high" });
  const overdue = opsRow("revision_required", { hoursToDeadline: -2, risk: "medium", riskReasons: ["Delivery failed verification; revision in progress"] });
  const calm = opsRow("authorized", { hoursToDeadline: 60 });
  const done = opsRow("completed", { hoursToDeadline: -100 });
  const verified = opsRow("verified", { hoursToDeadline: 1 });
  const snapshot = snapshotOf([calm, done, verified, overdue, lateWork, approval, review]);

  it("lists human gates first, then by risk, then by the nearest deadline", () => {
    const result = listAttentionItems(snapshot, "all");
    expect(result.items.map((item) => item.code)).toEqual([review.code, approval.code, lateWork.code, overdue.code]);
    expect(result).toMatchObject({ focus: "all", total: 4, needsHuman: 2, omitted: 0, held: "$141.00" });
  });

  it("narrows to deals waiting for a person", () => {
    const result = listAttentionItems(snapshot, "needs_human");
    expect(result.items.map((item) => [item.code, item.ask])).toEqual([
      [review.code, "Review the delivery and decide"],
      [approval.code, "Approve or decline the spend"],
    ]);
  });

  it("finds open deals near or past their deadline, but not finished or already verified ones", () => {
    const result = listAttentionItems(snapshot, "deadline_risk");
    expect(result.items.map((item) => item.code).sort()).toEqual([approval.code, lateWork.code, overdue.code].sort());
    const late = result.items.find((item) => item.code === overdue.code)!;
    expect(late.reasons).toContain("Deadline passed 2h ago");
    // A reason that already speaks of the deadline is not repeated.
    expect(result.items.find((item) => item.code === lateWork.code)!.reasons.filter((reason) => reason.toLowerCase().includes("deadline"))).toHaveLength(1);
  });

  it("gives amounts as finished text and labels simulated payments and demo-fault sellers", () => {
    const [first, second] = listAttentionItems(snapshot, "needs_human").items;
    expect(first).toMatchObject({ contractValue: "$47.00", held: "$47.00", payment: "Simulated", risk: "High", sellerNote: null });
    expect(first!.reasons[0]).toBe("Verification was inconclusive: weakest check at 62% confidence");
    expect(second).toMatchObject({ held: "$0.00", payment: "No payment yet" });
    expect(second!.sellerNote).toMatch(/^Demo fault: /);
  });

  it("bounds the list and says how many were left out", () => {
    const many = snapshotOf(Array.from({ length: 20 }, () => opsRow("in_review")));
    const result = listAttentionItems(many, "needs_human", 5);
    expect(result.items).toHaveLength(5);
    expect(result).toMatchObject({ total: 20, omitted: 15 });
    expect(listAttentionItems(snapshotOf([]), "all")).toMatchObject({ total: 0, items: [], held: "$0.00" });
  });
});

describe("findDeals", () => {
  const captured = opsRow("completed", { updatedAt: "2026-10-06T03:00:00.000Z" });
  const olderCaptured = opsRow("completed", { updatedAt: "2026-10-05T03:00:00.000Z" });
  const rejected = opsRow("rejected", { updatedAt: "2026-10-06T02:00:00.000Z" });
  const declined = opsRow("declined", { updatedAt: "2026-10-06T04:00:00.000Z" });
  const revisedThenCaptured = opsRow("completed", { revisionsUsed: 1, updatedAt: "2026-10-06T01:00:00.000Z" });
  const working = opsRow("authorized", { updatedAt: "2026-10-06T05:00:00.000Z" });
  const snapshot = snapshotOf([olderCaptured, rejected, working, captured, declined, revisedThenCaptured]);

  it("returns the most recently updated match first", () => {
    expect(findDeals(snapshot, "captured").deals.map((entry) => entry.code)).toEqual([captured.code, revisedThenCaptured.code, olderCaptured.code]);
    expect(findDeals(snapshot, "any").deals[0]!.code).toBe(working.code);
  });

  it("separates 'ended without a capture' from 'failed a verification'", () => {
    expect(findDeals(snapshot, "not_captured").deals.map((entry) => entry.code)).toEqual([declined.code, rejected.code]);
    expect(findDeals(snapshot, "failed_verification").deals.map((entry) => entry.code)).toEqual([rejected.code, revisedThenCaptured.code]);
    expect(findDeals(snapshot, "in_progress").deals.map((entry) => entry.code)).toEqual([working.code]);
    expect(findDeals(snapshot, "needs_human")).toMatchObject({ total: 0, deals: [] });
  });

  it("describes each deal in labels and formatted amounts", () => {
    expect(findDeals(snapshot, "captured", 1).deals[0]).toMatchObject({
      status: "Completed · captured",
      outcome: "Captured",
      contractValue: "$47.00",
      captured: "$47.00",
      held: "$0.00",
      verification: "Capture eligible",
      payment: "Simulated",
    });
    expect(findDeals(snapshot, "captured", 1).total).toBe(3);
  });
});

describe("dealByCode", () => {
  const row = opsRow("completed", { code: "PACT-7K2Q" });
  const snapshot = snapshotOf([row]);

  it("finds a deal however the model wrote its code", () => {
    for (const code of ["PACT-7K2Q", "pact-7k2q", "  PACT-7K2Q. ", '"PACT-7K2Q"', "(PACT-7K2Q)"]) expect(dealByCode(snapshot, code)).toBe(row);
  });

  it("returns null for unknown or empty codes", () => {
    for (const code of ["PACT-0000", "", "   ", "7K2Q"]) expect(dealByCode(snapshot, code)).toBeNull();
  });
});

describe("explainDeal", () => {
  it("has a reason for every status a deal can be in", () => {
    for (const status of DEAL_STATUSES) {
      const why = whyOf(deal({ status }));
      expect(why.length, status).toBeGreaterThan(20);
      expect(why, status).not.toMatch(/undefined|null|\s{2,}/);
    }
  });

  it("explains a capture and gives the PayPal ids", () => {
    const explanation = explainDeal(deal({ status: "completed" }));
    expect(explanation.why).toBe("Settled: $28.00 was captured (simulated payment) because every required condition was verified.");
    expect(explanation.payment).toMatchObject({
      rail: "Simulated",
      simulated: true,
      status: "Captured",
      authorized: "$28.00",
      captured: "$28.00",
      paypalOrderId: "SIM-O-1",
      paypalAuthorizationId: "SIM-A-1",
      paypalCaptureId: "SIM-C-1",
    });
    expect(explanation.verification).toMatchObject({ decision: "capture eligible", conditionsChecked: 6, notPassed: [], confidence: "95%" });
    expect(explanation.contract).toMatchObject({ price: "$28.00", revisionLimit: 1 });
  });

  it("names the failed conditions with their evidence when a delivery was rejected", () => {
    const explanation = explainDeal(deal({ status: "rejected" }));
    expect(explanation.why).toContain("Not captured");
    expect(explanation.why).toContain("R2 (Every illustration delivered in 16:9 and 1:1)");
    expect(explanation.verification?.notPassed).toEqual([
      {
        rule: "R2",
        condition: "Every illustration delivered in 16:9 and 1:1",
        result: "fail",
        evaluator: "deterministic",
        confidence: "100%",
        evidence: "1:1 missing on illustration #2",
        explanation: "Explanation.",
      },
    ]);
    expect(explanation.seller).toMatchObject({ name: "Quickdraw Collective", trust: "Established" });
    expect(explanation.seller?.note).toMatch(/^Demo fault: /);
  });

  it("explains both human gates in terms of what is and is not held", () => {
    const approval = explainDeal(deal({ status: "awaiting_approval" }));
    expect(approval.why).toBe(
      "Stopped for a human before any payment: the spending policy requires approval ($28.00 exceeds the $10.00 autonomous limit.). No PayPal order exists yet.",
    );
    expect(approval.policy).toEqual({
      outcome: "Needs human approval",
      flags: [{ check: "Autonomous limit", outcome: "Needs approval", detail: "$28.00 exceeds the $10.00 autonomous limit." }],
    });
    expect(approval.payment).toBeNull();

    const review = explainDeal(deal({ status: "in_review" }));
    expect(review.why).toMatch(/^Stopped for a human: verification was inconclusive/);
    expect(review.why).toContain("$28.00 stays held (simulated payment); nothing is captured until someone decides.");
    expect(review.verification?.notPassed.map((check) => check.result)).toEqual(["uncertain"]);
  });

  it("credits a human release, records the decision, and surfaces a payment error", () => {
    const released = explainDeal(
      deal({
        status: "completed",
        reports: [report(1, "human_review")],
        humanDecision: { kind: "release_payment", percent: null, reason: "Looks right to me", decidedAt: "2026-10-06T02:00:00.000Z" },
      }),
    );
    expect(released.why).toContain("a human released it after review");
    expect(released.humanDecision).toEqual({ decision: "Released the full payment", reason: "Looks right to me", at: "2026-10-06T02:00:00.000Z" });

    const failed = explainDeal(
      deal({
        status: "failed",
        payment: payment({ status: "failed", lastError: { issue: "INSTRUMENT_DECLINED", message: "The instrument was declined.", debugId: "abc", at: "2026-10-06T02:00:00.000Z" } }),
      }),
    );
    expect(failed.why).toContain("INSTRUMENT_DECLINED: The instrument was declined.");
    expect(failed.payment?.lastError).toBe("INSTRUMENT_DECLINED: The instrument was declined.");
  });

  it("carries nothing private: no budget, no mandate, no payer, no deliverable bodies", () => {
    for (const status of DEAL_STATUSES) {
      const json = JSON.stringify(explainDeal(deal({ status })));
      expect(json).not.toMatch(/budget|mandate|payerEmail|si\*\*\*\*|<svg/i);
    }
  });
});

describe("summarizeReconciliation", () => {
  const view = (overrides: Partial<ReconciliationView> = {}): ReconciliationView => ({
    dealId: "deal_1",
    status: "match",
    checkedAt: "2026-10-06T02:00:00.000Z",
    facts: [
      { field: "Order status", pact: "captured (expects COMPLETED)", paypal: "COMPLETED", match: true },
      { field: "Captured amount", pact: "$47.00", paypal: "$47.00", match: true },
    ],
    narrative: null,
    toolCalls: [],
    source: "deterministic",
    model: null,
    note: null,
    ...overrides,
  });

  it("states a match and where the comparison came from", () => {
    expect(summarizeReconciliation("PACT-7K2Q", view())).toMatchObject({
      code: "PACT-7K2Q",
      status: "match",
      verdict: "PACT's ledger and PayPal agree on all 2 fields.",
      mismatches: [],
      statement: null,
      source: "Deterministic comparison (no model involved)",
    });
  });

  it("names the fields that disagree", () => {
    const summary = summarizeReconciliation(
      "PACT-7K2Q",
      view({ status: "mismatch", facts: [...view().facts, { field: "Contract binding (custom_id)", pact: "abc", paypal: "xyz", match: false }] }),
    );
    expect(summary.verdict).toBe("PACT's ledger and PayPal disagree on 1 of 3 fields: Contract binding (custom_id).");
    expect(summary.mismatches).toEqual(["Contract binding (custom_id)"]);
  });

  it("says when PayPal could not be read, and credits the server's auditor when it narrated", () => {
    expect(summarizeReconciliation("PACT-7K2Q", view({ status: "unavailable", facts: [], note: "PayPal did not answer." }))).toMatchObject({
      verdict: "PayPal's record could not be read, so nothing was compared.",
      note: "PayPal did not answer.",
    });
    const narrated = summarizeReconciliation(
      "PACT-7K2Q",
      view({ source: "ai", model: "google/gemini-2.5-flash", narrative: "Everything lines up.", toolCalls: [{ tool: "get_order", ok: true }] }),
    );
    expect(narrated.statement).toBe("Everything lines up.");
    expect(narrated.source).toBe(
      "Deterministic comparison, narrated by the server-side auditor agent (google/gemini-2.5-flash) using read-only PayPal tools: get_order",
    );
  });
});

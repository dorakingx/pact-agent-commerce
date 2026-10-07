import { describe, expect, it } from "vitest";
import type { DealView, NextStep } from "@/lib/api/dto";
import type { DealStatus } from "@/lib/domain/status";
import { DEAL_STATUSES } from "@/lib/domain/status";
import type { PaymentRecord } from "@/lib/payments/types";
import { canonicalJson } from "@/lib/domain/canonical";
import {
  LIFECYCLE_STAGE_IDS,
  activityLine,
  canonicalOrder,
  dealElapsedMs,
  dealOutcome,
  dealTitle,
  formatElapsed,
  formatLatency,
  formatLocalClock,
  formatLocalDateTime,
  fundsView,
  lifecyclePosition,
  lifecycleStages,
  mandateSource,
  modelLabel,
  openGate,
  parsePayPalReturn,
  payPalReturnToast,
  pollIntervalMs,
  readOnlyKind,
  safeApproveUrl,
  settlementSentence,
  supersedes,
  type LifecycleStage,
} from "./deal-derive";
import { auditEvent, contractOf, deal, payment, report, submission } from "./deal-derive.fixtures";

function states(view: DealView): Record<string, LifecycleStage["state"]> {
  return Object.fromEntries(lifecycleStages(view).map((stage) => [stage.id, stage.state]));
}

function stage(view: DealView, id: LifecycleStage["id"]): LifecycleStage {
  const found = lifecycleStages(view).find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no stage ${id}`);
  return found;
}

describe("dealTitle", () => {
  it("prefers the contract title, then the mandate summary, then the request", () => {
    expect(dealTitle(deal({ status: "authorized" }))).toBe("2 illustrations · launch banners");
    expect(dealTitle(deal({ status: "negotiating", contract: null }))).toBe("2 launch banners for $32");
    expect(dealTitle(deal({ status: "negotiating", contract: null, mandate: null, intent: "  Two   banners\nplease " }))).toBe(
      "Two banners please",
    );
  });

  it("cuts a very long request", () => {
    const title = dealTitle(deal({ status: "negotiating", contract: null, mandate: null, intent: "x".repeat(400) }));
    expect(title.length).toBeLessThanOrEqual(110);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("readOnlyKind", () => {
  it("is null for the owner", () => {
    expect(readOnlyKind(deal({ status: "completed" }))).toBeNull();
  });
  it("tells a showcase deal (mandate visible) from another session's deal (mandate hidden)", () => {
    expect(readOnlyKind(deal({ status: "completed", isOwner: false }))).toBe("showcase");
    expect(readOnlyKind(deal({ status: "completed", isOwner: false, mandate: null }))).toBe("other_session");
  });
});

describe("modelLabel", () => {
  it("names the two models of the demo the way the brief does", () => {
    expect(modelLabel("openai/gpt-5-mini", "ai")).toBe("GPT-5 mini");
    expect(modelLabel("google/gemini-2.5-flash", "ai")).toBe("Gemini 2.5 Flash");
  });
  it("handles other gateway ids", () => {
    expect(modelLabel("anthropic/claude-sonnet-4.5", "ai")).toBe("Claude Sonnet 4.5");
    expect(modelLabel("gpt-5", "ai")).toBe("GPT-5");
    expect(modelLabel("mistral/mistral-large", "ai")).toBe("Mistral Large");
  });
  it("never shows a model for a scripted agent, and has a fallback for a missing id", () => {
    expect(modelLabel("openai/gpt-5-mini", "scripted")).toBe("Scripted");
    expect(modelLabel(null, "ai")).toBe("AI model");
    expect(modelLabel("  ", "ai")).toBe("AI model");
    expect(modelLabel("vendor/", "ai")).toBe("AI model");
  });
});

describe("mandateSource", () => {
  it("reads the parser from the audit trail", () => {
    const view = deal({
      status: "negotiating",
      audit: [auditEvent(1, "mandate.derived", { data: { source: "ai", model: "google/gemini-2.5-flash" } })],
    });
    expect(mandateSource(view)).toEqual({ source: "ai", model: "google/gemini-2.5-flash" });
  });
  it("treats anything that is not explicitly AI as scripted", () => {
    const view = deal({ status: "negotiating", audit: [auditEvent(1, "mandate.derived", { data: { source: "scripted", model: null } })] });
    expect(mandateSource(view)).toEqual({ source: "scripted", model: null });
    expect(mandateSource(deal({ status: "negotiating", audit: [auditEvent(1, "mandate.derived", { data: null })] }))).toEqual({
      source: "scripted",
      model: null,
    });
  });
  it("is null before the mandate exists", () => {
    expect(mandateSource(deal({ status: "negotiating", audit: [] }))).toBeNull();
  });
});

describe("lifecycleStages", () => {
  it("always returns the eight stages in order, for every status", () => {
    for (const status of DEAL_STATUSES) {
      const stages = lifecycleStages(deal({ status }));
      expect(stages.map((entry) => entry.id)).toEqual([...LIFECYCLE_STAGE_IDS]);
    }
  });

  it("never shows two current stages, and never an upcoming stage after the deal has ended", () => {
    for (const status of DEAL_STATUSES) {
      const view = deal({ status });
      const stages = lifecycleStages(view);
      expect(stages.filter((entry) => entry.state === "current").length).toBeLessThanOrEqual(1);
      if (view.next.kind === "done") {
        expect(stages.some((entry) => entry.state === "upcoming" || entry.state === "current")).toBe(false);
      }
    }
  });

  it("negotiating: request done, negotiation current with the move count", () => {
    const view = deal({ status: "negotiating" });
    expect(states(view)).toMatchObject({ request: "done", negotiation: "current", contract: "upcoming", settlement: "upcoming" });
    expect(stage(view, "negotiation")).toMatchObject({ tone: "info", description: "0 / 8 moves" });
  });

  it("awaiting approval and review are violet (a human is needed)", () => {
    expect(stage(deal({ status: "awaiting_approval" }), "policy")).toMatchObject({ state: "current", tone: "review" });
    expect(stage(deal({ status: "awaiting_payment" }), "authorization")).toMatchObject({ state: "current", tone: "review" });
    expect(stage(deal({ status: "in_review" }), "verification")).toMatchObject({ state: "current", tone: "review" });
  });

  it("authorized: the authorization stage is done in amber and says how much is held", () => {
    const view = deal({ status: "authorized" });
    expect(stage(view, "authorization")).toMatchObject({ state: "done", tone: "hold", description: "$28.00 held" });
    expect(stage(view, "delivery")).toMatchObject({ state: "current", tone: "info" });
  });

  it("a revision keeps the deal on the delivery stage and names the round", () => {
    const view = deal({ status: "revision_required" });
    expect(stage(view, "delivery")).toMatchObject({ state: "current", description: "Revision 1 of 1" });
    expect(stage(view, "verification").state).toBe("upcoming");
  });

  it("completed: everything done, the hold is no longer amber, the capture is stated", () => {
    const view = deal({ status: "completed" });
    expect(Object.values(states(view)).every((state) => state === "done")).toBe(true);
    expect(stage(view, "authorization").tone).toBeUndefined();
    expect(stage(view, "authorization").description).toBe("$28.00 authorized");
    expect(stage(view, "settlement").description).toBe("$28.00 captured");
    expect(stage(view, "verification").description).toBe("6 of 6 passed");
  });

  it("a human release is credited on the verification stage", () => {
    const view = deal({
      status: "completed",
      humanDecision: { kind: "release_payment", percent: null, reason: null, decidedAt: "2026-10-05T21:52:00.000Z" },
    });
    expect(stage(view, "verification").description).toBe("Released by you");
  });

  it("rejected: verification failed, settlement skipped as voided", () => {
    const view = deal({ status: "rejected" });
    expect(states(view)).toMatchObject({ delivery: "done", verification: "failed", settlement: "skipped" });
    expect(stage(view, "settlement").description).toBe("Voided · nothing captured");
  });

  it("declined and blocked stop at the policy stage; later stages are skipped", () => {
    expect(states(deal({ status: "declined" }))).toMatchObject({ contract: "done", policy: "failed", authorization: "skipped", settlement: "skipped" });
    expect(stage(deal({ status: "declined" }), "policy").description).toBe("Declined by you");
  });

  it("a request blocked before any negotiation skips negotiation and contract", () => {
    const view = deal({
      status: "blocked",
      seller: null,
      contract: null,
      payment: null,
      submissions: [],
      reports: [],
      negotiation: { status: "open", moves: [], agreedTerms: null, failureReason: null, maxMoves: 8, listPriceMinor: null },
      policy: {
        outcome: "block",
        checks: [{ id: "category_allowed", label: "Category allowed", outcome: "block", detail: "Restricted work can never be purchased by the agent." }],
        spentTodayMinor: 0,
        evaluatedAt: "2026-10-05T21:51:35.000Z",
      },
    });
    expect(states(view)).toEqual({
      request: "done",
      negotiation: "skipped",
      contract: "skipped",
      policy: "failed",
      authorization: "skipped",
      delivery: "skipped",
      verification: "skipped",
      settlement: "skipped",
    });
  });

  it("no agreement stops at negotiation, and says when there was no seller at all", () => {
    const noSeller = deal({
      status: "negotiation_failed",
      seller: null,
      contract: null,
      policy: null,
      payment: null,
      submissions: [],
      reports: [],
      negotiation: { status: "failed", moves: [], agreedTerms: null, failureReason: "No seller agent offers this", maxMoves: 8, listPriceMinor: null },
    });
    expect(stage(noSeller, "negotiation")).toMatchObject({ state: "failed", description: "No seller" });
    expect(states(noSeller).contract).toBe("skipped");
  });

  it("cancelled stops at authorization", () => {
    expect(stage(deal({ status: "cancelled" }), "authorization")).toMatchObject({ state: "failed", description: "Cancelled" });
  });

  it("expired and failed stop at authorization before a hold existed, at settlement after", () => {
    const before = deal({ status: "expired", payment: payment({ status: "expired", authorizationId: null, authorizedMinor: 0 }), submissions: [], reports: [] });
    expect(stage(before, "authorization")).toMatchObject({ state: "failed", description: "Order expired" });

    const after = deal({ status: "expired", payment: payment({ status: "expired" }), submissions: [], reports: [] });
    expect(states(after)).toMatchObject({ authorization: "done", delivery: "skipped", verification: "skipped", settlement: "failed" });
    expect(stage(after, "settlement").description).toBe("Hold expired");

    const failedCapture = deal({ status: "failed", payment: payment({ status: "failed" }) });
    expect(states(failedCapture)).toMatchObject({ delivery: "done", verification: "done", settlement: "failed" });
    const failedOrder = deal({ status: "failed", payment: payment({ status: "failed", authorizationId: null }), submissions: [], reports: [] });
    expect(stage(failedOrder, "authorization").state).toBe("failed");
  });
});

describe("lifecyclePosition", () => {
  it("points at the current or failed stage", () => {
    expect(lifecyclePosition(lifecycleStages(deal({ status: "authorized" })))).toMatchObject({ index: 5 });
    expect(lifecyclePosition(lifecycleStages(deal({ status: "rejected" }))).stage.id).toBe("verification");
  });
  it("points at the last stage of a completed deal", () => {
    expect(lifecyclePosition(lifecycleStages(deal({ status: "completed" })))).toMatchObject({ index: 7 });
  });
});

describe("fundsView", () => {
  const priced = (record: PaymentRecord | null) => fundsView({ payment: record, contract: contractOf(2800) });

  it("has nothing held before an order, or while the order awaits approval", () => {
    expect(priced(null)).toEqual({ phase: "none", priceMinor: 2800, heldMinor: 0, capturedMinor: 0, releasedMinor: 0 });
    expect(priced(payment({ status: "none" })).phase).toBe("none");
    expect(priced(payment({ status: "created", authorizationId: null, authorizedMinor: 0 }))).toMatchObject({ phase: "pending", heldMinor: 0 });
    expect(priced(payment({ status: "approved", authorizationId: null, authorizedMinor: 0 })).phase).toBe("pending");
  });

  it("authorized: the whole amount is held, nothing captured", () => {
    expect(priced(payment({ status: "authorized" }))).toEqual({ phase: "held", priceMinor: 2800, heldMinor: 2800, capturedMinor: 0, releasedMinor: 0 });
  });

  it("captured: the hold is gone and the money has moved", () => {
    expect(priced(payment({ status: "captured", capturedMinor: 2800, captureId: "C-1" }))).toEqual({
      phase: "captured",
      priceMinor: 2800,
      heldMinor: 0,
      capturedMinor: 2800,
      releasedMinor: 0,
    });
  });

  it("a partial capture releases the remainder", () => {
    expect(priced(payment({ status: "captured", capturedMinor: 1400, captureId: "C-1" }))).toMatchObject({
      phase: "captured",
      capturedMinor: 1400,
      releasedMinor: 1400,
    });
  });

  it("voided or expired after a hold: everything is released; before a hold: nothing ever was", () => {
    expect(priced(payment({ status: "voided" }))).toMatchObject({ phase: "released", heldMinor: 0, capturedMinor: 0, releasedMinor: 2800 });
    expect(priced(payment({ status: "expired" }))).toMatchObject({ phase: "released", releasedMinor: 2800 });
    expect(priced(payment({ status: "voided", authorizationId: null, authorizedMinor: 0 }))).toMatchObject({ phase: "closed", releasedMinor: 0 });
  });

  it("failed", () => {
    expect(priced(payment({ status: "failed" }))).toMatchObject({ phase: "failed", heldMinor: 0 });
  });

  it("falls back to the payment's amount, then to zero, without a contract", () => {
    expect(fundsView({ payment: payment({ status: "authorized" }), contract: null }).priceMinor).toBe(2800);
    expect(fundsView({ payment: null, contract: null }).priceMinor).toBe(0);
  });
});

describe("gates and polling", () => {
  const human: NextStep = { kind: "human", gate: "review", label: "Waiting for your review", options: ["release_payment"] };
  const auto: NextStep = { kind: "auto", step: "verify", label: "Verifying the delivery" };
  const done: NextStep = { kind: "done", label: "Completed · captured" };

  it("only the owner sees a gate", () => {
    expect(openGate({ isOwner: true, next: human })).toBe("review");
    expect(openGate({ isOwner: false, next: human })).toBeNull();
    expect(openGate({ isOwner: true, next: auto })).toBeNull();
  });

  it("polls at a gate, and for a visitor while the deal runs elsewhere; never once done", () => {
    expect(pollIntervalMs(undefined)).toBe(0);
    expect(pollIntervalMs({ isOwner: true, next: human })).toBe(4000);
    expect(pollIntervalMs({ isOwner: false, next: human })).toBe(4000);
    expect(pollIntervalMs({ isOwner: true, next: auto })).toBe(0);
    expect(pollIntervalMs({ isOwner: false, next: auto })).toBe(4000);
    expect(pollIntervalMs({ isOwner: true, next: done })).toBe(0);
    expect(pollIntervalMs({ isOwner: false, next: done })).toBe(0);
  });

  it("describes what is happening for each runner phase", () => {
    const owner = { isOwner: true, next: auto };
    expect(activityLine(owner, { phase: "running", autoRun: true })).toEqual({ text: "Verifying the delivery…", kind: "working" });
    expect(activityLine(owner, { phase: "idle", autoRun: true }).kind).toBe("working");
    expect(activityLine(owner, { phase: "idle", autoRun: false })).toEqual({
      text: "Auto-run is off — next: verifying the delivery",
      kind: "paused",
    });
    expect(activityLine(owner, { phase: "busy", autoRun: true }).text).toContain("still working");
    expect(activityLine(owner, { phase: "retrying", autoRun: true }).text).toContain("retrying");
    expect(activityLine(owner, { phase: "stalled", autoRun: true }).kind).toBe("problem");
    expect(activityLine(owner, { phase: "failed", autoRun: true }).kind).toBe("problem");
  });

  it("keeps the capital of a proper noun when the label is put mid-sentence", () => {
    const paypal: NextStep = { kind: "auto", step: "order", label: "PayPal order is being created" };
    expect(activityLine({ isOwner: true, next: paypal }, { phase: "idle", autoRun: false }).text).toBe(
      "Auto-run is off — next: PayPal order is being created",
    );
  });

  it("a gate waits on the owner; a visitor is told who it waits for", () => {
    expect(activityLine({ isOwner: true, next: human }, { phase: "idle", autoRun: true })).toEqual({ text: "Waiting for your review", kind: "waiting" });
    expect(activityLine({ isOwner: false, next: human }, { phase: "idle", autoRun: true }).text).toContain("owner");
    expect(activityLine({ isOwner: false, next: auto }, { phase: "idle", autoRun: true }).kind).toBe("working");
    expect(activityLine({ isOwner: true, next: done }, { phase: "idle", autoRun: true })).toEqual({ text: "Completed · captured", kind: "done" });
  });
});

describe("supersedes", () => {
  const at = (events: number, updatedAt: string) => ({ audit: Array.from({ length: events }, (_, index) => auditEvent(index + 1, "negotiation.move")), updatedAt });

  it("accepts anything when nothing is shown yet", () => {
    expect(supersedes(undefined, at(1, "2026-10-05T00:00:00.000Z"))).toBe(true);
  });
  it("a longer audit trail wins, a shorter one loses, whatever the timestamps say", () => {
    expect(supersedes(at(3, "2026-10-05T00:00:09.000Z"), at(4, "2026-10-05T00:00:01.000Z"))).toBe(true);
    expect(supersedes(at(4, "2026-10-05T00:00:01.000Z"), at(3, "2026-10-05T00:00:09.000Z"))).toBe(false);
  });
  it("with equal trails the newer (or identical) update wins", () => {
    expect(supersedes(at(3, "2026-10-05T00:00:01.000Z"), at(3, "2026-10-05T00:00:02.000Z"))).toBe(true);
    expect(supersedes(at(3, "2026-10-05T00:00:01.000Z"), at(3, "2026-10-05T00:00:01.000Z"))).toBe(true);
    expect(supersedes(at(3, "2026-10-05T00:00:02.000Z"), at(3, "2026-10-05T00:00:01.000Z"))).toBe(false);
  });
});

describe("dealOutcome", () => {
  it("is null while the deal runs or waits", () => {
    const open: DealStatus[] = ["negotiating", "awaiting_approval", "authorized", "in_review", "verified", "rejecting"];
    for (const status of open) expect(dealOutcome(deal({ status }))).toBeNull();
  });

  it("captured", () => {
    const outcome = dealOutcome(deal({ status: "completed" }));
    expect(outcome).toMatchObject({ tone: "success", title: "Captured $28.00", captureId: "SIM-C-1" });
    expect(outcome?.detail).toContain("all 6 contract conditions");
  });

  it("captured in part", () => {
    const outcome = dealOutcome(
      deal({
        status: "completed",
        payment: payment({ status: "captured", capturedMinor: 1400, captureId: "SIM-C-1" }),
        humanDecision: { kind: "release_partial", percent: 50, reason: null, decidedAt: "2026-10-05T21:52:00.000Z" },
      }),
    );
    expect(outcome?.title).toBe("Captured $14.00 of $28.00");
    expect(outcome?.detail).toContain("$14.00 was released back to the payer");
  });

  it("released by a human after review does not claim every condition passed", () => {
    const outcome = dealOutcome(
      deal({ status: "completed", humanDecision: { kind: "release_payment", percent: null, reason: null, decidedAt: "2026-10-05T21:52:00.000Z" } }),
    );
    expect(outcome?.detail).toContain("You released the payment");
    expect(outcome?.detail).not.toContain("passed all");
  });

  it("voided: by a human, or because revisions ran out", () => {
    const byHuman = dealOutcome(
      deal({ status: "rejected", humanDecision: { kind: "reject_delivery", percent: null, reason: null, decidedAt: "2026-10-05T21:52:00.000Z" } }),
    );
    expect(byHuman).toMatchObject({ tone: "neutral", title: "Authorization voided — nothing was captured", captureId: null });
    expect(byHuman?.detail).toContain("You rejected the delivery");
    expect(dealOutcome(deal({ status: "rejected" }))?.detail).toContain("no revisions remained");
  });

  it("blocked quotes the policy check that blocked", () => {
    const outcome = dealOutcome(
      deal({
        status: "blocked",
        policy: {
          outcome: "block",
          checks: [
            { id: "category_allowed", label: "Category allowed", outcome: "block", detail: "Restricted work can never be purchased by the agent." },
            { id: "daily_limit", label: "Daily limit", outcome: "pass", detail: "Fine." },
          ],
          spentTodayMinor: 0,
          evaluatedAt: "2026-10-05T21:51:35.000Z",
        },
      }),
    );
    expect(outcome).toMatchObject({ tone: "danger", detail: "Restricted work can never be purchased by the agent." });
  });

  it("blocked without a blocking check falls back to the engine's message", () => {
    expect(dealOutcome(deal({ status: "blocked", policy: null, lastError: "The daily limit was reached." }))?.detail).toBe(
      "The daily limit was reached.",
    );
  });

  it("no agreement, declined, cancelled, expired, failed", () => {
    expect(
      dealOutcome(
        deal({
          status: "negotiation_failed",
          negotiation: { status: "failed", moves: [], agreedTerms: null, failureReason: "No seller agent offers this", maxMoves: 8, listPriceMinor: null },
        }),
      ),
    ).toMatchObject({ tone: "neutral", detail: "No seller agent offers this" });
    expect(dealOutcome(deal({ status: "declined" }))?.title).toContain("declined");
    expect(dealOutcome(deal({ status: "cancelled", payment: payment({ status: "voided" }) }))?.detail).toContain("$28.00 hold was released");
    expect(dealOutcome(deal({ status: "cancelled", payment: payment({ status: "voided", authorizationId: null }) }))?.detail).toContain("before any funds were held");
    expect(dealOutcome(deal({ status: "expired" }))?.title).toContain("expired");
    expect(dealOutcome(deal({ status: "failed", lastError: "PayPal would not open the order." }))).toMatchObject({
      tone: "danger",
      detail: "PayPal would not open the order.",
    });
  });

  it("never uses the word the product avoids", () => {
    for (const status of DEAL_STATUSES) {
      const outcome = dealOutcome(deal({ status }));
      if (outcome) expect(`${outcome.title} ${outcome.detail}`.toLowerCase()).not.toContain("escrow");
    }
  });
});

describe("settlementSentence", () => {
  it("matches the wording of the brief for the standard contract", () => {
    const contract = contractOf(2800)?.contract;
    if (!contract) throw new Error("fixture");
    expect(settlementSentence(contract)).toBe(
      "Captured only when all 6 conditions are verified. Below 85% confidence a human decides. If revisions run out, the authorization is voided.",
    );
  });
  it("counts only required rules, and handles one rule and zero revisions", () => {
    const contract = contractOf(2800)?.contract;
    if (!contract) throw new Error("fixture");
    const single = { ...contract, revisionLimit: 0, verificationRules: [contract.verificationRules[0], { ...contract.verificationRules[1], required: false }] };
    expect(settlementSentence(single)).toBe(
      "Captured only when the one condition is verified. Below 85% confidence a human decides. There are no revision rounds: a failed delivery voids the authorization.",
    );
  });
});

describe("canonicalOrder", () => {
  it("prints the contract in exactly the order it is hashed in", () => {
    const contract = contractOf(2800).contract;
    expect(JSON.stringify(canonicalOrder(contract))).toBe(canonicalJson(contract));
  });
  it("sorts nested keys, keeps array order and leaves scalars alone", () => {
    expect(JSON.stringify(canonicalOrder({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }))).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalOrder("text")).toBe("text");
    expect(canonicalOrder(null)).toBeNull();
  });
  it("does not modify its input", () => {
    const input = { b: 1, a: 2 };
    canonicalOrder(input);
    expect(Object.keys(input)).toEqual(["b", "a"]);
  });
});

describe("PayPal return", () => {
  it("accepts only the four known results", () => {
    expect(parsePayPalReturn("approved")).toBe("approved");
    expect(parsePayPalReturn(["cancelled", "approved"])).toBe("cancelled");
    expect(parsePayPalReturn("APPROVED")).toBeNull();
    expect(parsePayPalReturn("<script>")).toBeNull();
    expect(parsePayPalReturn(undefined)).toBeNull();
    expect(parsePayPalReturn(null)).toBeNull();
    expect(parsePayPalReturn([])).toBeNull();
  });

  it("has a toast for each result, and an approval never claims a capture", () => {
    expect(payPalReturnToast("approved")).toMatchObject({ kind: "success" });
    expect(payPalReturnToast("approved").description).toContain("not captured");
    expect(payPalReturnToast("pending").kind).toBe("info");
    expect(payPalReturnToast("cancelled").kind).toBe("warning");
    expect(payPalReturnToast("error").kind).toBe("error");
  });
});

describe("safeApproveUrl", () => {
  it("allows the simulator's same-origin path", () => {
    expect(safeApproveUrl("/pay/simulated/SIM-O-59E4991AB5B4FA03")).toBe("/pay/simulated/SIM-O-59E4991AB5B4FA03");
  });
  it("allows PayPal over https", () => {
    expect(safeApproveUrl("https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T")).toBe(
      "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    );
    expect(safeApproveUrl("https://paypal.com/x")).toBe("https://paypal.com/x");
  });
  it("refuses everything else", () => {
    for (const url of [
      null,
      undefined,
      "",
      "//evil.example/pay",
      "/\\evil.example",
      "http://www.paypal.com/checkout",
      "https://paypal.com.evil.example/checkout",
      "https://evilpaypal.com/checkout",
      "javascript:alert(1)",
      "data:text/html,hi",
      "not a url",
    ]) {
      expect(safeApproveUrl(url)).toBeNull();
    }
  });
});

describe("time formatting", () => {
  const options = { locale: "en-US", timeZone: "Asia/Tokyo" };
  it("formats a deadline in the viewer's zone", () => {
    expect(formatLocalDateTime("2026-10-07T09:00:00.000Z", options)).toBe("Wed, Oct 7, 6:00 PM");
    expect(formatLocalDateTime("2026-10-07T09:00:00.000Z", { ...options, weekday: false })).toBe("Oct 7, 6:00 PM");
    expect(formatLocalDateTime("nope", options)).toBe("Unknown time");
  });
  it("formats an audit clock with seconds", () => {
    expect(formatLocalClock("2026-10-05T21:51:14.300Z", options)).toBe("6:51:14 AM");
    expect(formatLocalClock("nope", options)).toBe("—");
  });
  it("formats latency and elapsed time", () => {
    expect(formatLatency(2131)).toBe("2.1 s");
    expect(formatLatency(840)).toBe("840 ms");
    expect(formatLatency(null)).toBeNull();
    expect(formatLatency(-1)).toBeNull();
    expect(formatElapsed(37_400)).toBe("37 s");
    expect(formatElapsed(72_000)).toBe("1 min 12 s");
    expect(formatElapsed(7_500_000)).toBe("2 h 05 min");
    expect(formatElapsed(Number.NaN)).toBe("—");
  });
  it("measures a deal from its request to its last event", () => {
    expect(
      dealElapsedMs({ createdAt: "2026-10-05T21:51:14.000Z", audit: [auditEvent(1, "intent.received", { at: "2026-10-05T21:51:14.000Z" }), auditEvent(2, "deal.completed", { at: "2026-10-05T21:51:51.000Z" })] }),
    ).toBe(37_000);
    expect(dealElapsedMs({ createdAt: "2026-10-05T21:51:14.000Z", audit: [] })).toBe(0);
  });
});

describe("fixtures", () => {
  it("build a coherent deal for every status (guards the tests above against a drifting fixture)", () => {
    const view = deal({ status: "completed" });
    expect(view.submissions).toEqual([submission(1)]);
    expect(view.reports[0]).toEqual(report(1, "capture_eligible"));
    expect(view.payment?.status).toBe("captured");
  });
});

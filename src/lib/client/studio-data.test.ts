import { describe, expect, it } from "vitest";
import type { OpsPaymentEvent } from "../api/dto";
import { DEAL_STATUSES } from "../domain/status";
import {
  CONFIDENCE_BANDS,
  FUNNEL_STAGES,
  PAYMENT_EVENT_GROUP,
  STAGE_KEYS,
  STAGE_LABEL,
  buildStudioRows,
  confidenceBandIndex,
  firstPassOf,
  humanizeKey,
  isAwaitingHuman,
  minorToUsd,
  policyFlagText,
  releasedMinorOf,
  sellerNoteOf,
  stageKeyOf,
  stagesReached,
  stopReasonOf,
  studioRowsFingerprint,
  toStudioCheckRow,
  toStudioDealRow,
  toStudioPaymentEventRow,
  toStudioStageRows,
} from "./studio-data";
import { opsCheck, opsEvent, opsRow, snapshotOf } from "./studio-fixtures";

describe("minorToUsd", () => {
  it("converts cents to display dollars exactly", () => {
    expect(minorToUsd(4700)).toBe(47);
    expect(minorToUsd(1999)).toBe(19.99);
    expect(minorToUsd(1)).toBe(0.01);
    expect(minorToUsd(0)).toBe(0);
  });
});

describe("stagesReached", () => {
  it("places an open deal at the stage it is working in", () => {
    expect(stagesReached(opsRow("negotiating"))).toEqual(["negotiation"]);
    expect(stagesReached(opsRow("awaiting_approval"))).toEqual(["negotiation", "contract"]);
    expect(stagesReached(opsRow("awaiting_payment"))).toEqual(["negotiation", "contract", "payment"]);
    expect(stagesReached(opsRow("authorized"))).toEqual(["negotiation", "contract", "payment", "fulfillment"]);
    expect(stagesReached(opsRow("in_review"))).toEqual(["negotiation", "contract", "payment", "fulfillment", "verification"]);
  });

  it("recovers how far a closed deal got from what it left behind", () => {
    expect(stagesReached(opsRow("negotiation_failed"))).toEqual(["negotiation"]);
    // Declined at the approval gate: a contract existed, no order did.
    expect(stagesReached(opsRow("declined"))).toEqual(["negotiation", "contract"]);
    // Rejected after verification: everything but the capture happened.
    expect(stagesReached(opsRow("rejected"))).toEqual(["negotiation", "contract", "payment", "fulfillment", "verification"]);
    expect(stagesReached(opsRow("completed"))).toEqual([...FUNNEL_STAGES]);
  });

  it("counts an authorization that expired before any delivery as having reached fulfillment only", () => {
    const expired = opsRow("expired", { verificationDecision: null });
    expect(stagesReached(expired)).toEqual(["negotiation", "contract", "payment", "fulfillment"]);
  });

  it("always returns a prefix of the funnel, whatever the status", () => {
    for (const status of DEAL_STATUSES) {
      const reached = stagesReached(opsRow(status));
      expect(reached).toEqual(FUNNEL_STAGES.slice(0, reached.length));
      expect(reached.length).toBeGreaterThan(0);
    }
  });
});

describe("firstPassOf", () => {
  it("is null until a delivery has been verified", () => {
    expect(firstPassOf(opsRow("authorized"), new Set())).toBeNull();
  });

  it("is 1 only when the first delivery was capture eligible", () => {
    const captured = opsRow("completed");
    expect(firstPassOf(captured, new Set())).toBe(1);
    expect(firstPassOf(opsRow("in_review"), new Set())).toBe(0);
    expect(firstPassOf(opsRow("rejected"), new Set())).toBe(0);
  });

  it("is 0 for a deal captured after a revision: its first delivery failed", () => {
    const captured = opsRow("completed");
    expect(firstPassOf(captured, new Set([captured.id]))).toBe(0);
  });
});

describe("releasedMinorOf", () => {
  it("releases the whole authorization of a voided or expired payment", () => {
    expect(releasedMinorOf({ paymentStatus: "voided", authorizedMinor: 4700, capturedMinor: 0 })).toBe(4700);
    expect(releasedMinorOf({ paymentStatus: "expired", authorizedMinor: 4700, capturedMinor: 0 })).toBe(4700);
  });

  it("releases only the remainder of a partial capture", () => {
    expect(releasedMinorOf({ paymentStatus: "captured", authorizedMinor: 4700, capturedMinor: 3000 })).toBe(1700);
    expect(releasedMinorOf({ paymentStatus: "captured", authorizedMinor: 4700, capturedMinor: 4700 })).toBe(0);
  });

  it("releases nothing while money is held, before it is held, or when the payment failed", () => {
    for (const paymentStatus of ["none", "created", "approved", "authorized", "failed"] as const) {
      expect(releasedMinorOf({ paymentStatus, authorizedMinor: 4700, capturedMinor: 0 })).toBe(0);
    }
  });
});

describe("stopReasonOf", () => {
  it("explains an approval gate with the policy checks that did not pass", () => {
    const row = opsRow("awaiting_approval", { policyFlags: ["autonomous_limit", "seller_trust"] });
    expect(stopReasonOf(row)).toBe("Price is above the agent's autonomous limit; New seller: first spend needs approval");
  });

  it("falls back to a general sentence when no flag is recorded", () => {
    expect(stopReasonOf(opsRow("awaiting_approval", { policyFlags: [] }))).toBe("Spend needs human approval under policy");
  });

  it("explains a review gate with the failed conditions and the weakest confidence", () => {
    expect(stopReasonOf(opsRow("in_review", { failedRules: 0, confidence: 0.62 }))).toBe(
      "Verification was inconclusive: weakest check at 62% confidence",
    );
    expect(stopReasonOf(opsRow("in_review", { failedRules: 2, confidence: 0.4 }))).toBe(
      "Verification was inconclusive: 2 required conditions failed, weakest check at 40% confidence",
    );
  });

  it("uses the first risk reason for other deals, and nothing for healthy ones", () => {
    expect(stopReasonOf(opsRow("authorized", { riskReasons: ["Deadline in under 24h, not yet delivered"] }))).toBe(
      "Deadline in under 24h, not yet delivered",
    );
    expect(stopReasonOf(opsRow("completed"))).toBeNull();
  });
});

describe("labels", () => {
  it("names unknown policy flags and keys as words", () => {
    expect(policyFlagText("some_new_check")).toBe("Some new check");
    expect(humanizeKey("no_embedded_instructions")).toBe("No embedded instructions");
    expect(humanizeKey("")).toBe("");
  });

  it("resolves a stage from its key or its label, in any case", () => {
    for (const key of STAGE_KEYS) {
      expect(stageKeyOf(key)).toBe(key);
      expect(stageKeyOf(STAGE_LABEL[key])).toBe(key);
      expect(stageKeyOf(STAGE_LABEL[key].toUpperCase())).toBe(key);
    }
    expect(stageKeyOf("Somewhere else")).toBeNull();
    expect(stageKeyOf(3)).toBeNull();
    expect(stageKeyOf(null)).toBeNull();
  });

  it("gives every stage a distinct label, so a label names exactly one stage", () => {
    expect(new Set(STAGE_KEYS.map((key) => STAGE_LABEL[key])).size).toBe(STAGE_KEYS.length);
  });

  it("labels controlled demo-fault sellers and no one else", () => {
    expect(sellerNoteOf("quickdraw")).toMatch(/^Demo fault: /);
    expect(sellerNoteOf("pixelharbor")).toMatch(/^Demo fault: /);
    expect(sellerNoteOf("northwind")).toBeNull();
    expect(sellerNoteOf("—")).toBeNull();
  });

  it("knows the two gates that wait for a person", () => {
    expect(DEAL_STATUSES.filter(isAwaitingHuman)).toEqual(["awaiting_approval", "in_review"]);
  });
});

describe("toStudioDealRow", () => {
  it("turns enums into finished labels and minor units into display dollars", () => {
    const row = toStudioDealRow(opsRow("in_review", { sellerId: "pixelharbor", seller: "Pixel Harbor", sellerTrust: "new" }), new Set());
    expect(row).toMatchObject({
      status: "Human review required",
      stage: "Verification",
      stageOrder: 5,
      outcome: "In progress",
      seller: "Pixel Harbor",
      sellerTrust: "New seller",
      category: "Illustration",
      origin: "This session",
      deals: 1,
      priceUsd: 47,
      listPriceUsd: 53,
      savedUsd: 6,
      authorizedUsd: 47,
      heldUsd: 47,
      capturedUsd: 0,
      releasedUsd: 0,
      paymentStatus: "Authorized · held",
      paymentRail: "Simulated",
      verification: "Human review",
      confidence: 0.62,
      firstPass: 0,
      awaitingHuman: 1,
      risk: "High",
      riskOrder: 1,
      riskReasons: "Waiting for human review",
    });
    expect(row.sellerNote).toMatch(/^Demo fault: /);
  });

  it("leaves what does not exist yet blank rather than zero-valued text", () => {
    const row = toStudioDealRow(opsRow("negotiating", { category: null }), new Set());
    expect(row).toMatchObject({
      priceUsd: 0,
      paymentStatus: "No payment yet",
      paymentRail: null,
      approvalMode: null,
      verification: null,
      confidence: null,
      firstPass: null,
      policy: null,
      policyFlags: null,
      category: null,
      stopReason: null,
      riskReasons: null,
      awaitingHuman: 0,
    });
  });

  it("holds only primitives, as Studio's data engine requires", () => {
    for (const status of DEAL_STATUSES) {
      for (const value of Object.values(toStudioDealRow(opsRow(status), new Set()))) {
        expect(value === null || ["string", "number", "boolean"].includes(typeof value)).toBe(true);
      }
    }
  });
});

describe("funnel rows", () => {
  it("emits one row per stage reached, each carrying the contract value", () => {
    const deal = opsRow("authorized");
    expect(toStudioStageRows(deal)).toEqual([
      { id: `${deal.id}:negotiation`, dealId: deal.id, stage: "Negotiation", stageOrder: 1, deals: 1, valueUsd: 47 },
      { id: `${deal.id}:contract`, dealId: deal.id, stage: "Contract", stageOrder: 2, deals: 1, valueUsd: 47 },
      { id: `${deal.id}:payment`, dealId: deal.id, stage: "Payment", stageOrder: 3, deals: 1, valueUsd: 47 },
      { id: `${deal.id}:fulfillment`, dealId: deal.id, stage: "Fulfillment", stageOrder: 4, deals: 1, valueUsd: 47 },
    ]);
  });

  it("is monotonic across a ledger: no stage has more deals than the one before it", () => {
    const { stages } = buildStudioRows(snapshotOf(DEAL_STATUSES.map((status) => opsRow(status))));
    const counts = FUNNEL_STAGES.map((_, index) => stages.filter((row) => row.stageOrder === index + 1).length);
    expect(counts[0]).toBe(DEAL_STATUSES.length);
    for (let index = 1; index < counts.length; index += 1) expect(counts[index]).toBeLessThanOrEqual(counts[index - 1]!);
  });
});

describe("check rows", () => {
  it("buckets confidence into bands whose labels sort into numeric order", () => {
    expect([0, 0.49, 0.5, 0.69, 0.7, 0.849, 0.85, 0.949, 0.95, 1].map(confidenceBandIndex)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
    const labels = CONFIDENCE_BANDS.map((band) => band.label);
    expect([...labels].sort()).toEqual(labels);
  });

  it("flags the result as countable columns", () => {
    const deal = opsRow("rejected");
    expect(toStudioCheckRow(opsCheck(deal, { result: "fail", evaluator: "ai", confidence: 0.9, kind: "brief_adherence" }))).toMatchObject({
      deal: deal.code,
      kind: "Brief adherence",
      evaluator: "AI",
      result: "Fail",
      confidenceBand: "85–94%",
      checks: 1,
      passed: 0,
      failed: 1,
      uncertain: 0,
      failPercent: 100,
      day: "2026-10-06",
    });
    expect(toStudioCheckRow(opsCheck(deal, { result: "uncertain" }))).toMatchObject({ passed: 0, failed: 0, uncertain: 1, failPercent: 0 });
    expect(toStudioCheckRow(opsCheck(deal))).toMatchObject({ passed: 1, failed: 0, uncertain: 0, evaluator: "Deterministic", result: "Pass" });
  });
});

describe("payment event rows", () => {
  it("counts every event in exactly one group", () => {
    const deal = opsRow("completed");
    const types = Object.keys(PAYMENT_EVENT_GROUP) as OpsPaymentEvent["type"][];
    for (const type of types) {
      const row = toStudioPaymentEventRow(opsEvent(deal, type));
      const flags = row.captures + row.authorizations + row.problems + row.orders + row.releases + row.confirmations;
      expect(flags).toBe(1);
      expect(row[PAYMENT_EVENT_GROUP[type]]).toBe(1);
      expect(row.events).toBe(1);
    }
  });

  it("labels the event and keeps the amount the event itself stated", () => {
    const deal = opsRow("completed");
    expect(toStudioPaymentEventRow(opsEvent(deal, "captured", { amountMinor: 4700, reference: "SIM-C-9" }))).toMatchObject({
      deal: deal.code,
      type: "Captured",
      amountUsd: 47,
      paymentRail: "Simulated",
      reference: "SIM-C-9",
      captures: 1,
    });
    expect(toStudioPaymentEventRow(opsEvent(deal, "webhook", { amountMinor: 0, provider: null }))).toMatchObject({
      type: "Webhook confirmation",
      amountUsd: 0,
      paymentRail: null,
      confirmations: 1,
    });
  });
});

describe("buildStudioRows", () => {
  it("derives the first-pass flag from second-round checks", () => {
    const revised = opsRow("completed");
    const clean = opsRow("completed");
    const rows = buildStudioRows(snapshotOf([revised, clean], [opsCheck(revised, { round: 1 }), opsCheck(revised, { round: 2 }), opsCheck(clean)]));
    expect(rows.deals.map((row) => row.firstPass)).toEqual([0, 1]);
    expect(rows.checks).toHaveLength(3);
  });

  it("fingerprints rows, not the time the snapshot was taken", () => {
    const deals = [opsRow("authorized"), opsRow("completed")];
    const first = snapshotOf(deals);
    const later = { ...first, generatedAt: "2026-10-06T02:00:15.000Z" };
    expect(studioRowsFingerprint(buildStudioRows(later))).toBe(studioRowsFingerprint(buildStudioRows(first)));
    const changed = snapshotOf([{ ...deals[0]!, status: "submitted", statusLabel: "Delivered · verifying", stage: "verification" }, deals[1]!]);
    expect(studioRowsFingerprint(buildStudioRows(changed))).not.toBe(studioRowsFingerprint(buildStudioRows(first)));
  });
});

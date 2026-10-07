import { describe, expect, it } from "vitest";
import { DEAL_STATUSES, DEAL_STATUS_LABEL } from "../domain/status";
import { deal, report } from "./deal-derive.fixtures";
import { buildReviewQueue, reviewGateOf, reviewReasonFromDeal, toEpochMs } from "./studio-review";

const row = (deal: string, status: string, since: string | null = null, extra: Record<string, unknown> = {}) => ({ deal, status, since, ...extra });

describe("reviewGateOf", () => {
  it("recognises exactly the two human gates, by label or by key", () => {
    expect(reviewGateOf(DEAL_STATUS_LABEL.awaiting_approval)).toBe("approval");
    expect(reviewGateOf(DEAL_STATUS_LABEL.in_review)).toBe("review");
    expect(reviewGateOf("awaiting_approval")).toBe("approval");
    expect(reviewGateOf(" IN_REVIEW ")).toBe("review");
    const others = DEAL_STATUSES.filter((status) => status !== "awaiting_approval" && status !== "in_review");
    for (const status of others) {
      expect(reviewGateOf(status)).toBeNull();
      expect(reviewGateOf(DEAL_STATUS_LABEL[status])).toBeNull();
    }
    expect(reviewGateOf(null)).toBeNull();
    expect(reviewGateOf(7)).toBeNull();
  });
});

describe("buildReviewQueue", () => {
  it("lists only deals waiting for a person", () => {
    const queue = buildReviewQueue(
      [
        row("PACT-A", "Completed · captured"),
        row("PACT-B", "Human review required"),
        row("PACT-C", "Awaiting human approval"),
        row("PACT-D", "Awaiting PayPal approval"),
      ],
      6,
    );
    expect(queue.items.map((item) => item.code)).toEqual(["PACT-B", "PACT-C"]);
    expect(queue).toMatchObject({ total: 2, approvals: 1, reviews: 1, hidden: 0 });
  });

  it("puts the longest-waiting deal first and undated ones last", () => {
    const queue = buildReviewQueue(
      [
        row("PACT-NEW", "Human review required", "2026-10-06T08:00:00.000Z"),
        row("PACT-NONE", "Human review required", null),
        row("PACT-OLD", "Awaiting human approval", "2026-10-05T08:00:00.000Z"),
      ],
      6,
    );
    expect(queue.items.map((item) => item.code)).toEqual(["PACT-OLD", "PACT-NEW", "PACT-NONE"]);
  });

  it("says what each gate asks of the person", () => {
    const queue = buildReviewQueue([row("PACT-B", "Human review required"), row("PACT-C", "Awaiting human approval")], 6);
    expect(queue.items.map((item) => [item.gate, item.ask])).toEqual([
      ["review", "Review the delivery"],
      ["approval", "Approve or decline the spend"],
    ]);
  });

  it("carries the mapped details and leaves unmapped ones null", () => {
    const [full, bare] = buildReviewQueue(
      [
        row("PACT-B", "Human review required", "2026-10-06T08:00:00.000Z", { seller: "Pixel Harbor", amount: 18, reason: "  Inconclusive  " }),
        row("PACT-C", "Awaiting human approval", "2026-10-06T09:00:00.000Z", { seller: "", amount: "18", reason: null }),
      ],
      6,
    ).items;
    expect(full).toMatchObject({ seller: "Pixel Harbor", amountUsd: 18, reason: "Inconclusive", sinceMs: Date.parse("2026-10-06T08:00:00.000Z") });
    expect(bare).toMatchObject({ seller: null, amountUsd: null, reason: null });
  });

  it("caps the cards and counts the rest", () => {
    const rows = Array.from({ length: 9 }, (_, index) => row(`PACT-${index}`, "Human review required", `2026-10-06T0${index}:00:00.000Z`));
    const queue = buildReviewQueue(rows, 4);
    expect(queue.items).toHaveLength(4);
    expect(queue).toMatchObject({ total: 9, hidden: 5, reviews: 9 });
    // A nonsensical limit still shows one card rather than none.
    expect(buildReviewQueue(rows, 0).items).toHaveLength(1);
  });

  it("skips rows without a deal code", () => {
    expect(buildReviewQueue([row("", "Human review required"), { deal: null, status: "Human review required" }], 6).total).toBe(0);
  });
});

describe("toEpochMs", () => {
  it("reads the three shapes Studio returns a datetime in", () => {
    const iso = "2026-10-06T08:00:00.000Z";
    expect(toEpochMs(iso)).toBe(Date.parse(iso));
    expect(toEpochMs(new Date(iso))).toBe(Date.parse(iso));
    expect(toEpochMs(Date.parse(iso))).toBe(Date.parse(iso));
  });

  it("returns null for anything that is not a time", () => {
    for (const value of [null, undefined, "", "not a date", new Date("nope"), Number.NaN, {}, true]) expect(toEpochMs(value)).toBeNull();
  });
});

describe("reviewReasonFromDeal", () => {
  it("quotes the policy checks that did not pass at an approval gate", () => {
    expect(reviewReasonFromDeal(deal({ status: "awaiting_approval" }))).toBe("$28.00 exceeds the $10.00 autonomous limit.");
  });

  it("quotes the verifier's summary at a review gate", () => {
    const inReview = deal({ status: "in_review", reports: [{ ...report(1, "human_review"), summary: "1 condition could not be evaluated." }] });
    expect(reviewReasonFromDeal(inReview)).toBe("1 condition could not be evaluated.");
  });

  it("offers nothing for deals that are not waiting, or when the deal has no better account", () => {
    expect(reviewReasonFromDeal(deal({ status: "completed" }))).toBeNull();
    expect(reviewReasonFromDeal(deal({ status: "in_review", reports: [] }))).toBeNull();
    expect(reviewReasonFromDeal(deal({ status: "awaiting_approval", policy: null }))).toBeNull();
  });
});

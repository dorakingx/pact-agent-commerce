import { describe, expect, it } from "vitest";
import type { MoveAction, NegotiationMove, Party, Terms } from "@/lib/domain/schemas";
import {
  MOVE_ACTION_LABEL,
  annotateMoves,
  countDeltaLabel,
  deadlineDeltaLabel,
  guardrailCount,
  negotiationResult,
  nextNegotiator,
  priceDeltaLabel,
} from "./deal-derive-negotiation";

const DEADLINE = "2026-10-07T09:00:00.000Z";

function terms(priceMinor: number, overrides: Partial<Terms> = {}): Terms {
  return { priceMinor, deadline: DEADLINE, revisionLimit: 1, count: 2, ...overrides };
}

function move(seq: number, actor: Party, action: MoveAction, moveTerms: Terms | null, guardrails: NegotiationMove["guardrails"] = []): NegotiationMove {
  return {
    seq,
    actor,
    action,
    terms: moveTerms,
    message: "…",
    guardrails,
    source: "ai",
    model: actor === "seller" ? "openai/gpt-5-mini" : "google/gemini-2.5-flash",
    latencyMs: 1800,
    createdAt: "2026-10-05T21:51:18.720Z",
  };
}

describe("annotateMoves", () => {
  it("compares each move with the same party's previous position, not with the counterparty's", () => {
    const views = annotateMoves([
      move(1, "seller", "offer", terms(3000)),
      move(2, "buyer", "offer", terms(2700)),
      move(3, "seller", "counter", terms(2800)),
      move(4, "buyer", "counter", terms(2700)),
      move(5, "seller", "counter", terms(2700, { revisionLimit: 0 })),
      move(6, "buyer", "counter", terms(2800)),
      move(7, "seller", "accept", terms(2800)),
    ]);
    expect(views.map((view) => view.delta?.priceMinor ?? null)).toEqual([null, null, -200, 0, -100, 100, 100]);
    expect(views[4].delta).toMatchObject({ revisionLimit: -1, count: 0, deadlineMs: 0 });
    expect(views[6].delta).toMatchObject({ priceMinor: 100, revisionLimit: 1 });
  });

  it("gives the first position of each party no delta", () => {
    const views = annotateMoves([move(1, "seller", "offer", terms(2000)), move(2, "buyer", "accept", terms(2000))]);
    expect(views[0].delta).toBeNull();
    expect(views[1].delta).toBeNull();
  });

  it("skips moves without terms and keeps comparing across them", () => {
    const views = annotateMoves([
      move(1, "seller", "offer", terms(3000)),
      move(2, "buyer", "offer", terms(2500)),
      move(3, "seller", "reject", null),
      move(4, "buyer", "counter", terms(2600, { deadline: "2026-10-08T15:00:00.000Z", count: 3 })),
    ]);
    expect(views[2].delta).toBeNull();
    expect(views[3].delta).toEqual({ priceMinor: 100, deadlineMs: 30 * 3_600_000, revisionLimit: 0, count: 1 });
  });

  it("returns one view per move, in order, for an empty or long history", () => {
    expect(annotateMoves([])).toEqual([]);
    const history = Array.from({ length: 8 }, (_, index) => move(index + 1, index % 2 === 0 ? "seller" : "buyer", "counter", terms(3000 - index * 100)));
    expect(annotateMoves(history).map((view) => view.move.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("delta labels", () => {
  it("shows the direction and the size of a price move", () => {
    expect(priceDeltaLabel(-600)).toBe("▼ $6.00");
    expect(priceDeltaLabel(200)).toBe("▲ $2.00");
    expect(priceDeltaLabel(0)).toBeNull();
  });
  it("shows count and revision changes", () => {
    expect(countDeltaLabel(1)).toBe("▲ 1");
    expect(countDeltaLabel(-2)).toBe("▼ 2");
    expect(countDeltaLabel(0)).toBeNull();
  });
  it("shows a deadline that moved, later or sooner", () => {
    expect(deadlineDeltaLabel(26 * 3_600_000)).toBe("+1d 2h");
    expect(deadlineDeltaLabel(-6 * 3_600_000)).toBe("−6h");
    expect(deadlineDeltaLabel(0)).toBeNull();
    expect(deadlineDeltaLabel(Number.NaN)).toBeNull();
  });
});

describe("nextNegotiator", () => {
  it("lets the seller open, then alternates", () => {
    expect(nextNegotiator([])).toBe("seller");
    expect(nextNegotiator([{ actor: "seller" }])).toBe("buyer");
    expect(nextNegotiator([{ actor: "seller" }, { actor: "buyer" }])).toBe("seller");
  });
});

describe("guardrailCount", () => {
  it("counts every correction across the transcript", () => {
    expect(guardrailCount([])).toBe(0);
    expect(
      guardrailCount([
        move(1, "seller", "offer", terms(3000)),
        move(2, "buyer", "counter", terms(3200), [
          { code: "price_above_budget", detail: "Lowered to the budget." },
          { code: "price_rounded", detail: "Rounded to whole dollars." },
        ]),
        move(3, "seller", "counter", terms(2800), [{ code: "private_limit_redacted", detail: "Message replaced." }]),
      ]),
    ).toBe(3);
  });
});

describe("negotiationResult", () => {
  const base = { moves: Array.from({ length: 6 }, (_, index) => move(index + 1, index % 2 === 0 ? "seller" : "buyer", "counter", terms(4700))), maxMoves: 8 };

  it("is null while the agents are still talking", () => {
    expect(negotiationResult({ ...base, status: "open", agreedTerms: null, failureReason: null, listPriceMinor: 5300 })).toBeNull();
  });

  it("states the price, the saving against the opening quote and the number of moves", () => {
    expect(negotiationResult({ ...base, status: "agreed", agreedTerms: terms(4700), failureReason: null, listPriceMinor: 5300 })).toEqual({
      tone: "success",
      text: "Agreed at $47.00 — $6.00 under the opening quote, in 6 moves.",
    });
  });

  it("handles an accepted opening quote and a single move", () => {
    expect(
      negotiationResult({ moves: [move(1, "seller", "offer", terms(2000))], maxMoves: 8, status: "agreed", agreedTerms: terms(2000), failureReason: null, listPriceMinor: 2000 })?.text,
    ).toBe("Agreed at $20.00 — the opening quote, in 1 move.");
    expect(negotiationResult({ ...base, status: "agreed", agreedTerms: terms(2000), failureReason: null, listPriceMinor: null })?.text).toContain("the opening quote");
  });

  it("says so when the price ended above the opening quote", () => {
    expect(negotiationResult({ ...base, status: "agreed", agreedTerms: terms(5500), failureReason: null, listPriceMinor: 5300 })?.text).toBe(
      "Agreed at $55.00 — $2.00 over the opening quote, in 6 moves.",
    );
  });

  it("gives the reason of a failure, or a default", () => {
    expect(negotiationResult({ ...base, status: "failed", agreedTerms: null, failureReason: "The seller walked away.", listPriceMinor: 5300 })).toEqual({
      tone: "neutral",
      text: "The seller walked away.",
    });
    expect(negotiationResult({ ...base, status: "failed", agreedTerms: null, failureReason: null, listPriceMinor: null })?.text).toBe(
      "The agents could not agree on terms.",
    );
  });

  it("returns nothing for an agreement without terms (never invents a price)", () => {
    expect(negotiationResult({ ...base, status: "agreed", agreedTerms: null, failureReason: null, listPriceMinor: 5300 })).toBeNull();
  });
});

describe("MOVE_ACTION_LABEL", () => {
  it("names the four actions the way the transcript shows them", () => {
    expect(MOVE_ACTION_LABEL).toEqual({ offer: "Offer", counter: "Counter", accept: "Accept", reject: "Walk away" });
  });
});

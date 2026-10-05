import { describe, expect, it } from "vitest";
import type { BuyerContext, SellerContext } from "../ai/types";
import { MAX_MOVES, applyMove, initialNegotiation, nextActor } from "./negotiation";
import { scriptedBuyerMove, scriptedSellerMove } from "./negotiation-strategy";
import { quoteFor } from "./quote";
import { ProposedMoveSchema, type Mandate, type NegotiationMove, type NegotiationState, type Party, type Terms } from "./schemas";
import { SCENARIOS, type ScenarioId } from "./scenarios";
import { SELLERS, toSellerPublic, type SellerProfile } from "./sellers";
import { SCENARIO_MANDATES, TEST_NOW, playScripted, sellerById } from "./test-support";

const HOUR = 3_600_000;
const inHours = (hours: number, from: Date = TEST_NOW): string => new Date(from.getTime() + hours * HOUR).toISOString();

const happy = SCENARIO_MANDATES["happy-path"].mandate;
const northwind = sellerById("northwind");
/** The happy-path request for quote: three illustrations by tomorrow 18:00 UTC with one revision. */
const happyRequest = { count: 3, deadline: happy.deadline, revisionLimit: 1 };
/** northwind's quote for that request: list $53, floor $45. */
const happyQuote = quoteFor(northwind, happy.deliverable, happyRequest, TEST_NOW);

function recorded(seq: number, actor: Party, action: NegotiationMove["action"], terms: Terms | null): NegotiationMove {
  return {
    seq,
    actor,
    action,
    terms,
    message: "…",
    guardrails: [],
    source: "scripted",
    model: null,
    latencyMs: null,
    createdAt: TEST_NOW.toISOString(),
  };
}

const happyTerms = (priceMinor: number, overrides: Partial<Terms> = {}): Terms => ({
  priceMinor,
  deadline: happy.deadline,
  revisionLimit: 1,
  count: 3,
  ...overrides,
});

/** A history alternating seller/buyer offers at the given prices, seller first. */
function historyOf(prices: number[], overrides: Partial<Terms> = {}): NegotiationMove[] {
  return prices.map((priceMinor, i) => {
    const actor: Party = i % 2 === 0 ? "seller" : "buyer";
    return recorded(i + 1, actor, i < 2 ? "offer" : "counter", happyTerms(priceMinor, overrides));
  });
}

function sellerCtx(history: NegotiationMove[], overrides: Partial<SellerContext> = {}): SellerContext {
  return {
    seller: northwind,
    requested: happyRequest,
    quote: happyQuote,
    deliverable: happy.deliverable,
    history,
    movesRemaining: MAX_MOVES - history.length,
    now: TEST_NOW,
    ...overrides,
  };
}

function buyerCtx(history: NegotiationMove[], overrides: Partial<BuyerContext> = {}): BuyerContext {
  return {
    mandate: happy,
    seller: toSellerPublic(northwind),
    history,
    movesRemaining: MAX_MOVES - history.length,
    now: TEST_NOW,
    ...overrides,
  };
}

function floorFor(seller: SellerProfile, mandate: Mandate, terms: Terms, now: Date = TEST_NOW): number {
  return quoteFor(seller, mandate.deliverable, terms, now).floorMinor;
}

function expectWithinBothLimits(state: NegotiationState, mandate: Mandate, seller: SellerProfile, now: Date = TEST_NOW): void {
  const agreed = state.agreedTerms;
  if (agreed === null) throw new Error("expected an agreement");
  expect(agreed.priceMinor).toBeLessThanOrEqual(mandate.budgetMinor);
  expect(agreed.priceMinor).toBeGreaterThanOrEqual(floorFor(seller, mandate, agreed, now));
  expect(Date.parse(agreed.deadline)).toBeLessThanOrEqual(Date.parse(mandate.deadline));
  expect(Date.parse(agreed.deadline)).toBeGreaterThanOrEqual(now.getTime() + seller.rateCard.minHours * HOUR);
  expect(agreed.count).toBeGreaterThanOrEqual(mandate.minCount);
  expect(agreed.count).toBeLessThanOrEqual(mandate.deliverable.count);
  expect(agreed.revisionLimit).toBeGreaterThanOrEqual(mandate.minRevisions);
  expect(agreed.priceMinor % 100).toBe(0);
}

describe("demo scenarios played by the scripted agents", () => {
  /** Expected settlement price per scenario, as a range around the ladder crossing point. */
  const expectedPrice: Record<ScenarioId, readonly [min: number, max: number]> = {
    "happy-path": [4500, 4900],
    revision: [2500, 2900],
    approval: [17200, 19000],
    injection: [1600, 2000],
  };

  it("covers every scenario in the catalogue with the seller it pins", () => {
    expect(Object.keys(SCENARIO_MANDATES).sort()).toEqual(SCENARIOS.map((scenario) => scenario.id).sort());
    for (const scenario of SCENARIOS) {
      expect(SCENARIO_MANDATES[scenario.id].sellerId).toBe(scenario.sellerId);
    }
  });

  for (const scenario of SCENARIOS) {
    it(`${scenario.id}: agrees in 4–6 moves inside both parties' limits`, () => {
      const { mandate, sellerId } = SCENARIO_MANDATES[scenario.id];
      const seller = sellerById(sellerId);
      const state = playScripted(mandate, seller);

      expect(state.status).toBe("agreed");
      expect(state.failureReason).toBeNull();
      expect(state.moves.length).toBeGreaterThanOrEqual(4);
      expect(state.moves.length).toBeLessThanOrEqual(6);
      expectWithinBothLimits(state, mandate, seller);

      const [min, max] = expectedPrice[scenario.id];
      expect(state.agreedTerms?.priceMinor).toBeGreaterThanOrEqual(min);
      expect(state.agreedTerms?.priceMinor).toBeLessThanOrEqual(max);

      // The buyer gets exactly what the human asked for.
      expect(state.agreedTerms).toMatchObject({
        deadline: mandate.deadline,
        revisionLimit: mandate.revisionsWanted,
        count: mandate.deliverable.count,
      });
      // The seller opened at list, and the deal closed below it.
      const opening = state.moves[0];
      expect(opening.actor).toBe("seller");
      expect(opening.action).toBe("offer");
      expect(state.agreedTerms?.priceMinor).toBeLessThan(opening.terms?.priceMinor ?? 0);
      // Scripts stay inside their own limits: the engine never had to correct them.
      expect(state.moves.flatMap((move) => move.guardrails)).toEqual([]);
      expect(state.moves.every((move) => move.source === "scripted")).toBe(true);
    });
  }

  it("is deterministic: the same inputs replay the same transcript", () => {
    for (const { mandate, sellerId } of Object.values(SCENARIO_MANDATES)) {
      const seller = sellerById(sellerId);
      expect(playScripted(mandate, seller)).toEqual(playScripted(mandate, seller));
    }
  });

  it("still agrees when the request is made at other times of day", () => {
    for (const hoursEarlier of [-6, 3, 9, 14]) {
      const now = new Date(TEST_NOW.getTime() - hoursEarlier * HOUR);
      for (const { mandate, sellerId } of Object.values(SCENARIO_MANDATES)) {
        const seller = sellerById(sellerId);
        const state = playScripted(mandate, seller, now);
        expect(state.status, `${sellerId} at ${now.toISOString()}`).toBe("agreed");
        expectWithinBothLimits(state, mandate, seller, now);
        expect(state.moves.flatMap((move) => move.guardrails)).toEqual([]);
      }
    }
  });
});

describe("scripted agents — outcomes at the edges", () => {
  it("fails, and never agrees, when the budget is far below the seller's floor", () => {
    const state = playScripted({ ...happy, budgetMinor: 2000 }, northwind);
    expect(state.status).toBe("failed");
    expect(state.agreedTerms).toBeNull();
    expect(state.failureReason).toBe("Buyer agent walked away");
    expect(state.moves).toHaveLength(MAX_MOVES);
    expect(state.moves[MAX_MOVES - 1]).toMatchObject({ actor: "buyer", action: "reject" });
    // The seller's last word was its floor, never less.
    expect(state.moves[6].terms?.priceMinor).toBe(4500);
    for (const move of state.moves) {
      if (move.actor === "buyer" && move.terms) expect(move.terms.priceMinor).toBeLessThanOrEqual(2000);
      if (move.actor === "seller" && move.terms) expect(move.terms.priceMinor).toBeGreaterThanOrEqual(4500);
    }
  });

  it("closes on the last move when the budget only just covers the floor", () => {
    const state = playScripted({ ...happy, budgetMinor: 4500 }, northwind);
    expect(state.status).toBe("agreed");
    expect(state.moves).toHaveLength(MAX_MOVES);
    expect(state.agreedTerms?.priceMinor).toBe(4500);
  });

  it("fails one dollar under the floor", () => {
    const state = playScripted({ ...happy, budgetMinor: 4400 }, northwind);
    expect(state.status).toBe("failed");
    expect(state.agreedTerms).toBeNull();
  });

  it("does not overpay when the budget is far above the list price", () => {
    const state = playScripted({ ...happy, budgetMinor: 50_000 }, northwind);
    expect(state.status).toBe("agreed");
    expect(state.agreedTerms?.priceMinor).toBeLessThan(5300);
    expectWithinBothLimits(state, { ...happy, budgetMinor: 50_000 }, northwind);
  });

  it("fails when the deadline is impossible for the seller, whatever the budget", () => {
    const rushed: Mandate = { ...happy, budgetMinor: 50_000, deadline: inHours(1) };
    const state = playScripted(rushed, northwind);
    expect(state.status).toBe("failed");
    expect(state.agreedTerms).toBeNull();
  });

  it("pays the rush price when the deadline is tight but feasible and the budget allows", () => {
    const rushed: Mandate = { ...happy, budgetMinor: 8000, deadline: inHours(8) };
    const state = playScripted(rushed, northwind);
    expect(state.status).toBe("agreed");
    // 8h out: list $63, floor $53.
    expect(state.agreedTerms?.priceMinor).toBeGreaterThanOrEqual(5300);
    expectWithinBothLimits(state, rushed, northwind);
  });

  it("for every seller and a sweep of budgets: terminates, and any agreement respects both limits", () => {
    for (const { mandate, sellerId } of Object.values(SCENARIO_MANDATES)) {
      for (const seller of SELLERS.filter((candidate) => candidate.categories.includes(mandate.category))) {
        const requestFloor = floorFor(seller, mandate, {
          priceMinor: 100,
          deadline: mandate.deadline,
          revisionLimit: mandate.revisionsWanted,
          count: mandate.deliverable.count,
        });
        for (let budgetMinor = 500; budgetMinor <= 30_000; budgetMinor += 350) {
          const custom = { ...mandate, budgetMinor };
          const state = playScripted(custom, seller);
          const label = `${sellerId}/${seller.id} budget ${budgetMinor}`;
          expect(state.status, label).not.toBe("open");
          expect(state.moves.length, label).toBeLessThanOrEqual(MAX_MOVES);
          expect(state.moves.flatMap((move) => move.guardrails), label).toEqual([]);
          // A deal exists exactly when the budget covers the floor for what the buyer asked for.
          expect(state.status, label).toBe(budgetMinor >= requestFloor ? "agreed" : "failed");
          if (state.status === "agreed") expectWithinBothLimits(state, custom, seller);
        }
      }
    }
  });
});

describe("scriptedSellerMove", () => {
  it("opens at list for exactly what was requested: count, revisions and deadline", () => {
    const now = new Date("2026-10-06T09:20:00.000Z");
    const move = scriptedSellerMove(sellerCtx([], { now }));
    expect(move.action).toBe("offer");
    expect(move.terms).toEqual({ priceMinor: 5300, deadline: happy.deadline, revisionLimit: 1, count: 3 });
    expect(move.message).toBe(
      "We can deliver 3 illustrations in 16:9 and 1:1 by Oct 7, 18:00 UTC for $53.00, with 1 revision round included.",
    );
    expect(ProposedMoveSchema.safeParse(move).success).toBe(true);
  });

  it("opens with the requested revision rounds, priced by the quote for them", () => {
    const requested = { count: 3, deadline: inHours(72), revisionLimit: 3 };
    const quote = quoteFor(northwind, happy.deliverable, requested, TEST_NOW);
    const move = scriptedSellerMove(sellerCtx([], { requested, quote }));
    // Two more revision rounds than the happy-path request: 2 × $3.00 on top of $53.
    expect(move.terms).toEqual({ priceMinor: 5900, deadline: inHours(72), revisionLimit: 3, count: 3 });
  });

  it("opens with the earliest deadline it can commit to when the requested one is too soon", () => {
    const slow: SellerProfile = { ...northwind, rateCard: { ...northwind.rateCard, minHours: 40 } };
    const requested = { count: 3, deadline: inHours(30), revisionLimit: 1 };
    const quote = quoteFor(slow, happy.deliverable, requested, TEST_NOW);
    const move = scriptedSellerMove(sellerCtx([], { seller: slow, requested, quote }));
    expect(move.terms?.deadline).toBe(inHours(40));
    // Off the hour the earliest deadline is rounded up, never down.
    const later = new Date(TEST_NOW.getTime() + 20 * 60_000);
    const offHour = scriptedSellerMove(sellerCtx([], { seller: slow, requested, quote, now: later }));
    expect(offHour.terms?.deadline).toBe(inHours(41));
  });

  it("never opens below its own floor for the terms it proposes, even with a stale quote", () => {
    // The quote prices no revisions (list $13.00), but the request it should answer includes one.
    const tiny = { ...happy.deliverable, count: 1, aspectRatios: ["16:9" as const] };
    const staleQuote = quoteFor(northwind, tiny, { count: 1, deadline: happy.deadline, revisionLimit: 0 }, TEST_NOW);
    expect(staleQuote.listMinor).toBe(1300);
    const requested = { count: 1, deadline: happy.deadline, revisionLimit: 1 };
    const move = scriptedSellerMove(sellerCtx([], { deliverable: tiny, requested, quote: staleQuote }));
    const ownFloor = quoteFor(northwind, tiny, move.terms as Terms, TEST_NOW).floorMinor;
    expect(ownFloor).toBe(1400);
    expect(move.terms?.priceMinor).toBe(1400);
  });

  it("concedes along the ladder: list, 45%, 80% and finally 100% of the gap to the floor", () => {
    // list 5300, floor 4500 → 5300, 4940→4900, 4660→4700, 4500
    const lowball = 1000;
    const second = scriptedSellerMove(sellerCtx(historyOf([5300, lowball])));
    expect(second).toMatchObject({ action: "counter", terms: happyTerms(4900) });
    const third = scriptedSellerMove(sellerCtx(historyOf([5300, lowball, 4900, lowball])));
    expect(third).toMatchObject({ action: "counter", terms: happyTerms(4700) });
    const fourth = scriptedSellerMove(sellerCtx(historyOf([5300, lowball, 4900, lowball, 4700, lowball])));
    expect(fourth).toMatchObject({ action: "counter", terms: happyTerms(4500) });
    expect(fourth.message).toMatch(/^Final offer/);
  });

  it("mirrors the deadline, revisions and count the buyer asked for", () => {
    const asked = { deadline: inHours(20), revisionLimit: 2, count: 2 };
    const move = scriptedSellerMove(sellerCtx(historyOf([5300, 1000], asked)));
    expect(move.terms).toMatchObject(asked);
  });

  it("accepts once the buyer reaches the next rung", () => {
    expect(scriptedSellerMove(sellerCtx(historyOf([5300, 4900]))).action).toBe("accept");
    expect(scriptedSellerMove(sellerCtx(historyOf([5300, 4800]))).action).toBe("counter");
    expect(scriptedSellerMove(sellerCtx(historyOf([5300, 4000, 4900, 4700]))).action).toBe("accept");
    expect(scriptedSellerMove(sellerCtx(historyOf([5300, 4000, 4900, 4600]))).action).toBe("counter");
  });

  it("does not accept a good price with a deadline it cannot meet, and proposes the earliest it can", () => {
    const move = scriptedSellerMove(sellerCtx(historyOf([5300, 9000], { deadline: inHours(1) })));
    expect(move.action).toBe("counter");
    expect(move.terms?.deadline).toBe(inHours(2));
    // It keeps the price the buyer already offered rather than undercutting it.
    expect(move.terms?.priceMinor).toBe(9000);
    expect(move.message).toContain("earliest we can commit to");
  });

  it("does not propose an accept below its floor for the buyer's exact terms, even with a stale quote", () => {
    // The supplied quote prices 1 revision (floor $45); the buyer asks for 3, whose floor is $50.
    const move = scriptedSellerMove(sellerCtx(historyOf([5300, 4900], { revisionLimit: 3 })));
    expect(move.action).toBe("counter");
    expect(move.terms).toEqual(happyTerms(5000, { revisionLimit: 3 }));
  });

  it("on its last word accepts anything at or above the floor, otherwise offers the floor", () => {
    const atFloor = historyOf([5300, 4000, 4900, 4200, 4700, 4500]);
    expect(scriptedSellerMove(sellerCtx(atFloor)).action).toBe("accept");
    const belowFloor = historyOf([5300, 4000, 4900, 4200, 4700, 4400]);
    const last = scriptedSellerMove(sellerCtx(belowFloor));
    expect(last).toMatchObject({ action: "counter", terms: happyTerms(4500) });
    // The same applies whenever only two moves remain, even if the seller has moved fewer times.
    const early = scriptedSellerMove(sellerCtx(historyOf([5300, 4600]), { movesRemaining: 2 }));
    expect(early.action).toBe("accept");
  });

  it("must accept or reject when a single move remains", () => {
    const ok = scriptedSellerMove(sellerCtx(historyOf([5300, 4500]), { movesRemaining: 1 }));
    expect(ok.action).toBe("accept");
    const low = scriptedSellerMove(sellerCtx(historyOf([5300, 4400]), { movesRemaining: 1 }));
    expect(low).toMatchObject({ action: "reject", terms: null });
    const nothing = scriptedSellerMove(sellerCtx([], { movesRemaining: 1 }));
    expect(nothing.action).toBe("reject");
  });

  it("returns schema-valid proposals with null terms on accept and reject", () => {
    const moves = [
      scriptedSellerMove(sellerCtx([])),
      scriptedSellerMove(sellerCtx(historyOf([5300, 1000]))),
      scriptedSellerMove(sellerCtx(historyOf([5300, 5300]))),
      scriptedSellerMove(sellerCtx(historyOf([5300, 1000]), { movesRemaining: 1 })),
    ];
    expect(moves.map((move) => move.action)).toEqual(["offer", "counter", "accept", "reject"]);
    for (const move of moves) {
      expect(ProposedMoveSchema.safeParse(move).success).toBe(true);
      if (move.action === "accept" || move.action === "reject") expect(move.terms).toBeNull();
    }
  });
});

describe("scriptedBuyerMove", () => {
  it("offers 80%, 90% and 96% of its target, always asking for the mandate's terms", () => {
    // target = min(budget $50, opening $53) = $50 → 4000, 4500, 4800
    const first = scriptedBuyerMove(buyerCtx(historyOf([5300])));
    expect(first).toMatchObject({ action: "offer", terms: happyTerms(4000) });
    const second = scriptedBuyerMove(buyerCtx(historyOf([5300, 4000, 5200])));
    expect(second).toMatchObject({ action: "counter", terms: happyTerms(4500) });
    const third = scriptedBuyerMove(buyerCtx(historyOf([5300, 4000, 5200, 4500, 5100])));
    expect(third).toMatchObject({ action: "counter", terms: happyTerms(4800) });
  });

  it("targets the seller's opening price when that is below the budget", () => {
    const rich = { ...happy, budgetMinor: 9000 };
    const first = scriptedBuyerMove(buyerCtx(historyOf([5300]), { mandate: rich }));
    expect(first.terms?.priceMinor).toBe(4200); // 80% of 5300 = 4240 → $42
  });

  it("never offers above the budget, even when rounding would", () => {
    const odd = { ...happy, budgetMinor: 3250 };
    for (const prices of [[5300], [5300, 2600, 5200], [5300, 2600, 5200, 2900, 5100]]) {
      const move = scriptedBuyerMove(buyerCtx(historyOf(prices), { mandate: odd }));
      expect(move.terms?.priceMinor).toBeLessThanOrEqual(3250);
      expect((move.terms?.priceMinor ?? 1) % 100).toBe(0);
    }
    // 4th rung = 100% of $32.50 would round to $33; the cap keeps it at $32.
    const late = scriptedBuyerMove(buyerCtx(historyOf([5300, 2600, 5200, 2900, 5100, 3100, 5000]), { mandate: odd, movesRemaining: 3 }));
    expect(late.terms?.priceMinor).toBe(3200);
  });

  it("asks for the wanted revisions, never fewer than the minimum", () => {
    const wants2 = { ...happy, revisionsWanted: 2, minRevisions: 1 };
    expect(scriptedBuyerMove(buyerCtx(historyOf([5300]), { mandate: wants2 })).terms?.revisionLimit).toBe(2);
    const inconsistent = { ...happy, revisionsWanted: 0, minRevisions: 2 };
    expect(scriptedBuyerMove(buyerCtx(historyOf([5300]), { mandate: inconsistent })).terms?.revisionLimit).toBe(2);
  });

  it("accepts when the seller's price is at or under its next rung", () => {
    // Even a cheap opening is answered with a first offer at 80% of it: 4000 → 3200.
    expect(scriptedBuyerMove(buyerCtx(historyOf([4000])))).toMatchObject({ action: "offer", terms: happyTerms(3200) });
    expect(scriptedBuyerMove(buyerCtx(historyOf([5300, 4000, 4500]))).action).toBe("accept");
    expect(scriptedBuyerMove(buyerCtx(historyOf([5300, 4000, 4600]))).action).toBe("counter");
    expect(scriptedBuyerMove(buyerCtx(historyOf([5300, 4000, 5200, 4500, 4800]))).action).toBe("accept");
  });

  it("does not accept a good price on terms outside the mandate", () => {
    const cheapButLate = historyOf([5300, 4000, 4000], { deadline: inHours(60) });
    const late = scriptedBuyerMove(buyerCtx(cheapButLate));
    expect(late.action).toBe("counter");
    expect(late.terms?.deadline).toBe(happy.deadline);
    // It does not offer more than the seller is already asking.
    expect(late.terms?.priceMinor).toBe(4000);
    expect(late.message).toMatch(/^We need 3 illustrations/);

    const tooFew = historyOf([5300, 4000, 3000], { count: 2 });
    expect(scriptedBuyerMove(buyerCtx(tooFew)).action).toBe("counter");
    const noRevisions = historyOf([5300, 4000, 3000], { revisionLimit: 0 });
    expect(scriptedBuyerMove(buyerCtx(noRevisions)).action).toBe("counter");
  });

  it("on the final move accepts anything inside the mandate and rejects everything else", () => {
    const within = historyOf([5300, 4000, 5200, 4500, 5100, 4800, 5000]);
    expect(scriptedBuyerMove(buyerCtx(within)).action).toBe("accept");
    const over = historyOf([5300, 4000, 5200, 4500, 5100, 4800, 5100]);
    expect(scriptedBuyerMove(buyerCtx(over))).toMatchObject({ action: "reject", terms: null });
    const late = historyOf([5300, 4000, 5200, 4500, 5100, 4800, 4000], { deadline: inHours(60) });
    expect(scriptedBuyerMove(buyerCtx(late)).action).toBe("reject");
  });
});

describe("scripted messages", () => {
  const privateWords = /\b(budget|floor|limit|maximum|minimum|walk[- ]away|at most|lowest|ceiling|cap)\b/i;

  function transcript(mandate: Mandate, seller: SellerProfile): NegotiationState {
    return playScripted(mandate, seller);
  }

  it("are short, concrete, and never name a private limit", () => {
    const runs: Array<{ mandate: Mandate; seller: SellerProfile }> = [
      ...Object.values(SCENARIO_MANDATES).map(({ mandate, sellerId }) => ({ mandate, seller: sellerById(sellerId) })),
      { mandate: { ...happy, budgetMinor: 2000 }, seller: northwind },
      { mandate: { ...happy, budgetMinor: 4500 }, seller: northwind },
      { mandate: { ...happy, budgetMinor: 50_000, deadline: inHours(1) }, seller: northwind },
    ];
    for (const { mandate, seller } of runs) {
      const state = transcript(mandate, seller);
      for (const move of state.moves) {
        expect(move.message.length).toBeGreaterThan(20);
        expect(move.message.length).toBeLessThanOrEqual(240);
        expect(move.message.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2);
        expect(move.message, move.message).not.toMatch(privateWords);
        expect(move.message).not.toMatch(/undefined|NaN|null/);
        // A message names its own price, so offers are self-explanatory in the transcript.
        if (move.terms) expect(move.message).toContain(`$${move.terms.priceMinor / 100}.00`);
      }
    }
  });

  it("never mention the budget or the floor unless that is the price being offered", () => {
    const dollars = (minor: number): string => `$${minor / 100}.00`;
    for (const { mandate, sellerId } of Object.values(SCENARIO_MANDATES)) {
      const seller = sellerById(sellerId);
      let state = initialNegotiation();
      const played = playScripted(mandate, seller);
      for (const move of played.moves) {
        const actor = nextActor(state);
        const price = move.terms?.priceMinor ?? null;
        if (actor === "buyer" && price !== mandate.budgetMinor) {
          expect(move.message).not.toContain(dollars(mandate.budgetMinor));
        }
        if (actor === "seller" && move.terms) {
          const floor = floorFor(seller, mandate, move.terms);
          if (price !== floor) expect(move.message).not.toContain(dollars(floor));
        }
        state = { ...state, moves: [...state.moves, move] };
      }
    }
  });

  it("survive the rules engine unchanged", () => {
    // If the engine had to rewrite a scripted message, the script and the engine disagree.
    const mandate = SCENARIO_MANDATES.approval.mandate;
    const seller = sellerById("lingua");
    let state = initialNegotiation();
    const requested = { count: 6, deadline: mandate.deadline, revisionLimit: 2 };
    const quote = quoteFor(seller, mandate.deliverable, requested, TEST_NOW);
    const proposed = scriptedSellerMove({
      seller,
      requested,
      quote,
      deliverable: mandate.deliverable,
      history: [],
      movesRemaining: MAX_MOVES,
      now: TEST_NOW,
    });
    const result = applyMove(state, "seller", proposed, { source: "scripted", model: null, latencyMs: null }, { mandate, seller, now: TEST_NOW });
    state = result.state;
    expect(result.move.message).toBe(proposed.message);
    expect(result.move.message).toBe(
      "We can deliver 6 copy pieces of 80–120 words in English and Japanese by Oct 9, 09:00 UTC for $200.00, with 2 revision rounds included.",
    );
    expect(state.status).toBe("open");
  });
});

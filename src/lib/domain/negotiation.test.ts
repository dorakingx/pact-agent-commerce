import { describe, expect, it } from "vitest";
import {
  GUARDRAIL_CODES,
  InvalidMoveError,
  MAX_MOVES,
  applyMove,
  buyerContextFor,
  initialNegotiation,
  lastOfferBy,
  movesRemaining,
  nextActor,
  sellerContextFor,
  termsOnTable,
  type RulesContext,
} from "./negotiation";
import { quoteFor } from "./quote";
import {
  NegotiationMoveSchema,
  NegotiationStateSchema,
  type Mandate,
  type NegotiationMove,
  type NegotiationState,
  type Party,
  type ProposedMove,
  type Terms,
} from "./schemas";
import { toSellerPublic } from "./sellers";
import { SCENARIO_MANDATES, TEST_NOW, sellerById } from "./test-support";

const HOUR = 3_600_000;
const inHours = (hours: number): string => new Date(TEST_NOW.getTime() + hours * HOUR).toISOString();

/** Happy-path deal: budget $50, deadline 33h out, 3 illustrations, 1 revision; northwind list $53, floor $45. */
const mandate: Mandate = SCENARIO_MANDATES["happy-path"].mandate;
const northwind = sellerById("northwind");
const ctx: RulesContext = { mandate, seller: northwind, now: TEST_NOW };
const meta = { source: "ai" as const, model: "test/model", latencyMs: 120 };

const terms = (overrides: Partial<Terms> = {}): Terms => ({
  priceMinor: 5300,
  deadline: mandate.deadline,
  revisionLimit: 1,
  count: 3,
  ...overrides,
});
const offer = (overrides: Partial<Terms> = {}, message = "Here is what we can do."): ProposedMove => ({
  action: "offer",
  terms: terms(overrides),
  message,
});
const accept = (message = "Deal."): ProposedMove => ({ action: "accept", terms: null, message });
const reject = (message = "No deal."): ProposedMove => ({ action: "reject", terms: null, message });

function step(state: NegotiationState, proposed: ProposedMove, context: RulesContext = ctx) {
  return applyMove(state, nextActor(state), proposed, meta, context);
}

/** Apply proposals in turn order (seller first) and return the final state. */
function play(proposals: ProposedMove[], context: RulesContext = ctx): NegotiationState {
  return proposals.reduce((state, proposed) => step(state, proposed, context).state, initialNegotiation());
}

function codes(move: NegotiationMove): string[] {
  return move.guardrails.map((note) => note.code);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("turn order and bookkeeping", () => {
  it("starts open and empty, with the seller to move", () => {
    const state = initialNegotiation();
    expect(state).toEqual({ status: "open", moves: [], agreedTerms: null, failureReason: null });
    expect(nextActor(state)).toBe("seller");
    expect(movesRemaining(state)).toBe(MAX_MOVES);
    expect(MAX_MOVES).toBe(8);
  });

  it("alternates seller, buyer, seller, …", () => {
    let state = initialNegotiation();
    const actors: Party[] = [];
    for (const price of [5300, 4000, 5200, 4100, 5100]) {
      actors.push(nextActor(state));
      state = step(state, offer({ priceMinor: price })).state;
    }
    expect(actors).toEqual(["seller", "buyer", "seller", "buyer", "seller"]);
    expect(movesRemaining(state)).toBe(3);
  });

  it("numbers moves from 1 without gaps and stamps them with ctx.now", () => {
    const state = play([offer(), offer({ priceMinor: 4000 }), offer({ priceMinor: 5000 })]);
    expect(state.moves.map((move) => move.seq)).toEqual([1, 2, 3]);
    expect(state.moves.every((move) => move.createdAt === TEST_NOW.toISOString())).toBe(true);
  });

  it("records who produced the move", () => {
    const { move } = applyMove(initialNegotiation(), "seller", offer(), { source: "scripted", model: null, latencyMs: null }, ctx);
    expect(move).toMatchObject({ source: "scripted", model: null, latencyMs: null });
    const ai = applyMove(initialNegotiation(), "seller", offer(), { source: "ai", model: "openai/gpt-5-mini", latencyMs: 812.6 }, ctx);
    expect(ai.move).toMatchObject({ source: "ai", model: "openai/gpt-5-mini", latencyMs: 813 });
    const odd = applyMove(initialNegotiation(), "seller", offer(), { source: "ai", model: "m", latencyMs: -5 }, ctx);
    expect(odd.move.latencyMs).toBe(0);
    const nan = applyMove(initialNegotiation(), "seller", offer(), { source: "ai", model: "m", latencyMs: Number.NaN }, ctx);
    expect(nan.move.latencyMs).toBeNull();
  });

  it("produces moves and states that satisfy the persistence schemas", () => {
    const state = play([offer(), offer({ priceMinor: 6000 }), offer({ priceMinor: 100 }), accept()]);
    expect(NegotiationStateSchema.safeParse(state).success).toBe(true);
    for (const move of state.moves) expect(NegotiationMoveSchema.safeParse(move).success).toBe(true);
  });

  it("finds the latest term-bearing move of each party", () => {
    const state = play([offer({ priceMinor: 5300 }), offer({ priceMinor: 4000 }), offer({ priceMinor: 5000 })]);
    expect(lastOfferBy(state, "seller")?.terms?.priceMinor).toBe(5000);
    expect(lastOfferBy(state, "buyer")?.terms?.priceMinor).toBe(4000);
    expect(lastOfferBy(initialNegotiation(), "buyer")).toBeNull();
    expect(lastOfferBy(initialNegotiation(), "seller")).toBeNull();
  });

  it("prices the mandate's request first, then the buyer's latest offer", () => {
    expect(termsOnTable(initialNegotiation(), mandate)).toEqual({ count: 3, deadline: mandate.deadline, revisionLimit: 1 });
    const state = play([offer(), offer({ priceMinor: 4000, revisionLimit: 2, deadline: inHours(20) })]);
    expect(termsOnTable(state, mandate)).toEqual({ count: 3, deadline: inHours(20), revisionLimit: 2 });
  });

  it("briefs the seller with the request and a quote priced for exactly that request", () => {
    const opening = sellerContextFor(initialNegotiation(), ctx);
    expect(opening).toEqual({
      seller: northwind,
      requested: { count: 3, deadline: mandate.deadline, revisionLimit: 1 },
      quote: quoteFor(northwind, mandate.deliverable, { count: 3, deadline: mandate.deadline, revisionLimit: 1 }, TEST_NOW),
      deliverable: mandate.deliverable,
      history: [],
      movesRemaining: MAX_MOVES,
      now: TEST_NOW,
    });
    expect(opening.quote).toMatchObject({ listMinor: 5300, floorMinor: 4500 });

    // Once the buyer has countered, the request (and with it the quote) follows the buyer's terms.
    const asked = { revisionLimit: 3, deadline: inHours(8) };
    const state = play([offer(), offer({ priceMinor: 4000, ...asked })]);
    const next = sellerContextFor(state, ctx);
    expect(next.requested).toEqual({ count: 3, ...asked });
    expect(next.quote).toEqual(quoteFor(northwind, mandate.deliverable, next.requested, TEST_NOW));
    expect(next.quote.listMinor).toBeGreaterThan(opening.quote.listMinor);
    expect(next).toMatchObject({ history: state.moves, movesRemaining: MAX_MOVES - 2 });
  });

  it("briefs the buyer with its mandate and only the seller's public profile", () => {
    const state = play([offer()]);
    const briefing = buyerContextFor(state, ctx);
    expect(briefing).toEqual({
      mandate,
      seller: toSellerPublic(northwind),
      history: state.moves,
      movesRemaining: MAX_MOVES - 1,
      now: TEST_NOW,
    });
    // Nothing of the seller's pricing reaches the buyer's side.
    expect(JSON.stringify(briefing.seller)).not.toMatch(/rateCard|floor/i);
  });

  it("does not mutate the state, the proposal or the context", () => {
    const before = deepFreeze(play([offer(), offer({ priceMinor: 4000 })]));
    const proposed = deepFreeze(offer({ priceMinor: 4000.4, revisionLimit: 1 }, "  spaced   out  "));
    const frozenCtx = deepFreeze({ mandate: structuredClone(mandate), seller: structuredClone(northwind), now: TEST_NOW });
    const { state } = applyMove(before, "seller", proposed, meta, frozenCtx);
    expect(before.moves).toHaveLength(2);
    expect(state.moves).toHaveLength(3);
    expect(state.moves).not.toBe(before.moves);
    expect(state.moves[2].terms).not.toBe(proposed.terms);
  });
});

describe("invalid moves", () => {
  it("rejects a move by the party whose turn it is not", () => {
    expect(() => applyMove(initialNegotiation(), "buyer", offer(), meta, ctx)).toThrow(InvalidMoveError);
    const state = play([offer()]);
    expect(() => applyMove(state, "seller", offer(), meta, ctx)).toThrow(/buyer's turn/);
  });

  it("rejects any move once the negotiation is agreed or failed", () => {
    const agreed = play([offer({ priceMinor: 4800 }), accept()]);
    expect(agreed.status).toBe("agreed");
    expect(() => step(agreed, offer())).toThrow(InvalidMoveError);
    const failed = play([offer(), reject()]);
    expect(failed.status).toBe("failed");
    expect(() => step(failed, offer())).toThrow(/already failed/);
  });

  it("rejects an offer or counter without terms", () => {
    expect(() => step(initialNegotiation(), { action: "offer", terms: null, message: "trust me" })).toThrow(InvalidMoveError);
    expect(() => step(play([offer()]), { action: "counter", terms: null, message: "lower" })).toThrow(/must include terms/);
  });

  it("rejects structurally broken terms instead of guessing", () => {
    const broken: Array<Partial<Terms>> = [
      { priceMinor: Number.NaN },
      { priceMinor: Number.POSITIVE_INFINITY },
      { priceMinor: -100 },
      { count: 2.5 },
      { revisionLimit: 1.5 },
      { revisionLimit: -1 },
      { deadline: "tomorrow at 6 PM" },
      { deadline: "2026-10-07" },
      { deadline: "" },
    ];
    for (const bad of broken) {
      expect(() => step(initialNegotiation(), offer(bad)), JSON.stringify(bad)).toThrow(InvalidMoveError);
    }
    const stringPrice = { ...terms(), priceMinor: "5300" } as unknown as Terms;
    expect(() => step(initialNegotiation(), { action: "offer", terms: stringPrice, message: "x" })).toThrow(InvalidMoveError);
  });

  it("rejects an accept when the counterparty has made no offer", () => {
    expect(() => step(initialNegotiation(), accept())).toThrow(/no offer on the table/);
  });

  it("rejects an action it does not know", () => {
    const invented = { action: "stall", terms: null, message: "..." } as unknown as ProposedMove;
    expect(() => step(initialNegotiation(), invented)).toThrow(InvalidMoveError);
  });

  it("leaves the state untouched when a move is invalid", () => {
    const state = play([offer()]);
    expect(() => step(state, { action: "counter", terms: null, message: "x" })).toThrow(InvalidMoveError);
    expect(state.moves).toHaveLength(1);
    expect(state.status).toBe("open");
  });
});

describe("normalisation", () => {
  it("records each party's first move as an offer and later term-bearing moves as counters", () => {
    const state = play([
      { ...offer(), action: "counter" },
      { ...offer({ priceMinor: 4000 }), action: "counter" },
      { ...offer({ priceMinor: 5000 }), action: "offer" },
      { ...offer({ priceMinor: 4200 }), action: "offer" },
    ]);
    expect(state.moves.map((move) => move.action)).toEqual(["offer", "offer", "counter", "counter"]);
    // Coercing the label is silent: it is bookkeeping, not a correction of the terms.
    expect(state.moves.flatMap((move) => move.guardrails)).toEqual([]);
  });

  it("cleans the message: trims, strips control characters, collapses whitespace", () => {
    const { move } = step(initialNegotiation(), offer({}, "  We can\tdo\n\nthis \u0007 for you.  "));
    expect(move.message).toBe("We can do this for you.");
  });

  it("caps the message at 480 characters", () => {
    const { move } = step(initialNegotiation(), offer({}, "word ".repeat(400)));
    expect(move.message.length).toBeLessThanOrEqual(480);
    expect(move.message.endsWith("…")).toBe(true);
  });

  it("writes a factual message when the agent supplied none", () => {
    const { move } = step(initialNegotiation(), offer({}, " \n\t "));
    expect(move.message).toBe("Our offer: $53.00 for 3 illustrations with 1 revision round, delivered by Oct 7, 18:00 UTC.");
    expect(move.guardrails).toEqual([]);
  });

  it("stores deadlines as UTC instants", () => {
    const { move } = step(initialNegotiation(), offer({ deadline: "2026-10-08T03:00:00+09:00" }));
    expect(move.terms?.deadline).toBe("2026-10-07T18:00:00.000Z");
    expect(move.guardrails).toEqual([]);
  });

  it("rounds prices to whole dollars and says so", () => {
    const { move } = step(initialNegotiation(), offer({ priceMinor: 5149 }, "We can do $51.49."));
    expect(move.terms?.priceMinor).toBe(5100);
    expect(codes(move)).toEqual(["price_rounded"]);
    expect(move.guardrails[0].detail).toContain("$51.00");
    // The agent's sentence describes a price that no longer exists.
    expect(move.message).not.toContain("51.49");
    expect(move.message).toContain("$51.00");
    expect(step(initialNegotiation(), offer({ priceMinor: 5150 })).move.terms?.priceMinor).toBe(5200);
  });

  it("keeps prices inside the platform range", () => {
    const high = step(initialNegotiation(), offer({ priceMinor: 900_000 })).move;
    expect(high.terms?.priceMinor).toBe(500_000);
    expect(codes(high)).toEqual(["price_out_of_range"]);

    const zero = step(play([offer()]), offer({ priceMinor: 0 })).move;
    expect(zero.terms?.priceMinor).toBe(100);
    expect(codes(zero)).toEqual(["price_out_of_range"]);
  });

  it("caps revision rounds at three for either party", () => {
    const seller = step(initialNegotiation(), offer({ revisionLimit: 7 })).move;
    expect(seller.terms?.revisionLimit).toBe(3);
    expect(codes(seller)).toEqual(["revisions_above_limit"]);
    const buyer = step(play([offer()]), offer({ priceMinor: 4000, revisionLimit: 4 })).move;
    expect(buyer.terms?.revisionLimit).toBe(3);
    expect(codes(buyer)).toEqual(["revisions_above_limit"]);
  });
});

describe("buyer limits on the buyer's own offers", () => {
  const afterSellerOpens = play([offer()]);
  const buyerOffer = (overrides: Partial<Terms>, m: Mandate = mandate) =>
    step(afterSellerOpens, offer({ priceMinor: 4000, ...overrides }), { ...ctx, mandate: m }).move;

  it("leaves an offer inside the mandate alone", () => {
    const move = buyerOffer({});
    expect(move.guardrails).toEqual([]);
    expect(move.terms).toEqual(terms({ priceMinor: 4000 }));
    expect(move.message).toBe("Here is what we can do.");
  });

  it("caps the price at the budget [price_above_budget]", () => {
    const move = buyerOffer({ priceMinor: 6000 });
    expect(move.terms?.priceMinor).toBe(5000);
    expect(codes(move)).toEqual(["price_above_budget"]);
    expect(move.guardrails[0].detail).toMatch(/\$60\.00 is above the budget.*capped at \$50\.00/);
  });

  it("allows exactly the budget and blocks one dollar more", () => {
    expect(buyerOffer({ priceMinor: 5000 }).guardrails).toEqual([]);
    expect(codes(buyerOffer({ priceMinor: 5100 }))).toEqual(["price_above_budget"]);
  });

  it("caps to whole dollars BELOW a budget with cents", () => {
    const move = buyerOffer({ priceMinor: 3300 }, { ...mandate, budgetMinor: 3250 });
    expect(move.terms?.priceMinor).toBe(3200);
    expect(codes(move)).toEqual(["price_above_budget"]);
    expect(buyerOffer({ priceMinor: 3200 }, { ...mandate, budgetMinor: 3250 }).guardrails).toEqual([]);
  });

  it("pulls a late deadline back to the mandate's [deadline_after_mandate]", () => {
    const move = buyerOffer({ deadline: inHours(60) });
    expect(move.terms?.deadline).toBe(mandate.deadline);
    expect(codes(move)).toEqual(["deadline_after_mandate"]);
    expect(move.guardrails[0].detail).toContain("2026-10-07 18:00 UTC");
    expect(buyerOffer({ deadline: mandate.deadline }).guardrails).toEqual([]);
    expect(buyerOffer({ deadline: inHours(10) }).guardrails).toEqual([]);
  });

  it("keeps the count between minCount and the requested count [count_outside_mandate]", () => {
    const flexible = { ...mandate, minCount: 2 };
    expect(buyerOffer({ count: 2 }, flexible).guardrails).toEqual([]);
    const low = buyerOffer({ count: 1 }, flexible);
    expect(low.terms?.count).toBe(2);
    expect(codes(low)).toEqual(["count_outside_mandate"]);
    expect(low.guardrails[0].detail).toContain("between 2 and 3");
    const high = buyerOffer({ count: 5 });
    expect(high.terms?.count).toBe(3);
    expect(codes(high)).toEqual(["count_outside_mandate"]);
    expect(high.guardrails[0].detail).toContain("exactly 3");
  });

  it("raises revisions to the mandate minimum [revisions_below_mandate]", () => {
    const move = buyerOffer({ revisionLimit: 0 });
    expect(move.terms?.revisionLimit).toBe(1);
    expect(codes(move)).toEqual(["revisions_below_mandate"]);
    expect(buyerOffer({ revisionLimit: 3 }).guardrails).toEqual([]);
  });

  it("reports every limit that was enforced, and rewrites the message to match", () => {
    const move = buyerOffer({ priceMinor: 9900, deadline: inHours(100), count: 6, revisionLimit: 0 });
    expect(codes(move)).toEqual(["price_above_budget", "deadline_after_mandate", "count_outside_mandate", "revisions_below_mandate"]);
    expect(move.terms).toEqual(terms({ priceMinor: 5000 }));
    expect(move.message).toBe("Our offer: $50.00 for 3 illustrations with 1 revision round, delivered by Oct 7, 18:00 UTC.");
  });

  it("is not constrained by the seller's limits", () => {
    // $10 is far below the seller's floor, but it is the buyer's offer to make.
    expect(buyerOffer({ priceMinor: 1000 }).guardrails).toEqual([]);
  });
});

describe("seller limits on the seller's own offers", () => {
  const sellerOpens = (overrides: Partial<Terms>, context: RulesContext = ctx) =>
    step(initialNegotiation(), offer(overrides), context).move;

  it("leaves an offer above the floor alone", () => {
    const move = sellerOpens({ priceMinor: 5300 });
    expect(move.guardrails).toEqual([]);
    expect(move.terms).toEqual(terms());
  });

  it("raises a price below the floor to the floor [price_below_floor]", () => {
    const move = sellerOpens({ priceMinor: 4000 });
    expect(move.terms?.priceMinor).toBe(4500);
    expect(codes(move)).toEqual(["price_below_floor"]);
    expect(move.guardrails[0].detail).toMatch(/\$40\.00 is below the seller's minimum.*raised to \$45\.00/);
  });

  it("allows exactly the floor and blocks one dollar less", () => {
    expect(sellerOpens({ priceMinor: 4500 }).guardrails).toEqual([]);
    expect(codes(sellerOpens({ priceMinor: 4400 }))).toEqual(["price_below_floor"]);
  });

  it("recomputes the floor for the terms actually on the table", () => {
    // 8h out is a rush job: list $63, floor $53. A price that is fine at 33h is too low here.
    const rush = sellerOpens({ priceMinor: 5000, deadline: inHours(8) });
    expect(rush.terms?.priceMinor).toBe(5300);
    expect(codes(rush)).toEqual(["price_below_floor"]);
    // Fewer illustrations cost less: 2 × 1650 + 300 = 3600, floor 3024 → $31.
    const smaller = sellerOpens({ priceMinor: 3100, count: 2 });
    expect(smaller.guardrails).toEqual([]);
    const floor = quoteFor(northwind, mandate.deliverable, { count: 2, deadline: mandate.deadline, revisionLimit: 1 }, TEST_NOW).floorMinor;
    expect(floor).toBe(3100);
  });

  it("pushes an impossible deadline out to the minimum turnaround [deadline_too_soon]", () => {
    const move = sellerOpens({ priceMinor: 9000, deadline: inHours(1) });
    expect(move.terms?.deadline).toBe(inHours(2));
    expect(codes(move)).toEqual(["deadline_too_soon"]);
    expect(move.guardrails[0].detail).toContain("2h minimum turnaround");
    expect(sellerOpens({ priceMinor: 9000, deadline: inHours(2) }).guardrails).toEqual([]);
  });

  it("prices the floor after fixing the deadline", () => {
    // Deadline moved to now+2h → under-4h tier: list 5250 × 1.5 = 7875 → $79, floor 6636 → $67.
    const move = sellerOpens({ priceMinor: 5300, deadline: inHours(0.5) });
    expect(move.terms).toEqual(terms({ priceMinor: 6700, deadline: inHours(2) }));
    expect(codes(move)).toEqual(["deadline_too_soon", "price_below_floor"]);
  });

  it("keeps the count inside the requested scope [count_outside_scope]", () => {
    const high = sellerOpens({ count: 5 });
    expect(high.terms?.count).toBe(3);
    expect(codes(high)).toEqual(["count_outside_scope"]);
    const zero = sellerOpens({ count: 0 });
    expect(zero.terms?.count).toBe(1);
    expect(codes(zero)).toEqual(["count_outside_scope"]);
    expect(sellerOpens({ count: 1 }).guardrails).toEqual([]);
  });

  it("is not constrained by the buyer's limits", () => {
    // Above budget, later than the mandate deadline, fewer revisions than the buyer wants: all allowed.
    const move = sellerOpens({ priceMinor: 9000, deadline: inHours(200), revisionLimit: 0 });
    expect(move.guardrails).toEqual([]);
  });

  it("declines when the scope cannot be priced inside the platform maximum [scope_above_platform_maximum]", () => {
    const lingua = sellerById("lingua");
    const huge: Mandate = {
      ...SCENARIO_MANDATES.approval.mandate,
      deliverable: { kind: "copy", count: 8, languages: ["en", "ja", "de"], minWords: 2000, maxWords: 4000, subject: "long-form guides", tone: null },
      minCount: 8,
      budgetMinor: 500_000,
    };
    const context: RulesContext = { mandate: huge, seller: lingua, now: TEST_NOW };
    const quote = quoteFor(lingua, huge.deliverable, { count: 8, deadline: huge.deadline, revisionLimit: 1 }, TEST_NOW);
    expect(quote.floorMinor).toBeGreaterThan(500_000);

    const { state, move } = step(initialNegotiation(), offer({ priceMinor: 500_000, count: 8, deadline: huge.deadline }), context);
    expect(move.action).toBe("reject");
    expect(move.terms).toBeNull();
    expect(codes(move)).toEqual(["scope_above_platform_maximum"]);
    expect(state.status).toBe("failed");
    expect(state.failureReason).toBe("Seller agent declined");
  });
});

describe("accept", () => {
  it("copies the counterparty's terms verbatim and closes the deal", () => {
    const state = play([offer({ priceMinor: 4800 }, "We can do $48.")]);
    const { state: agreed, move } = step(state, accept("Agreed, thank you."));
    expect(move.action).toBe("accept");
    expect(move.terms).toEqual(terms({ priceMinor: 4800 }));
    expect(move.terms).not.toBe(state.moves[0].terms);
    expect(move.guardrails).toEqual([]);
    expect(move.message).toBe("Agreed, thank you.");
    expect(agreed.status).toBe("agreed");
    expect(agreed.agreedTerms).toEqual(terms({ priceMinor: 4800 }));
    expect(agreed.failureReason).toBeNull();
  });

  it("ignores whatever terms the acceptor restates", () => {
    const state = play([offer({ priceMinor: 4800 })]);
    const sneaky: ProposedMove = { action: "accept", terms: terms({ priceMinor: 100, revisionLimit: 3 }), message: "Accepting $1 with 3 revisions." };
    const { state: agreed } = step(state, sneaky);
    expect(agreed.agreedTerms).toEqual(terms({ priceMinor: 4800 }));
  });

  it("accepts the counterparty's LATEST offer, never an earlier one", () => {
    const state = play([offer({ priceMinor: 4600 }), offer({ priceMinor: 4000 }), offer({ priceMinor: 4900 })]);
    const { state: agreed } = step(state, accept());
    expect(agreed.agreedTerms?.priceMinor).toBe(4900);
  });

  it("lets the seller accept a buyer offer at or above its floor", () => {
    const state = play([offer(), offer({ priceMinor: 4500 })]);
    const { state: agreed, move } = step(state, accept("Deal at $45."));
    expect(agreed.status).toBe("agreed");
    expect(agreed.agreedTerms).toEqual(terms({ priceMinor: 4500 }));
    expect(move.guardrails).toEqual([]);
  });

  it("writes a factual message for an accept without one", () => {
    const { move } = step(play([offer({ priceMinor: 4800 })]), accept("   "));
    expect(move.message).toBe("Agreed: $48.00 for 3 illustrations with 1 revision round, delivered by Oct 7, 18:00 UTC.");
  });
});

describe("accept veto", () => {
  it("turns a buyer accept above budget into a counter at the budget [accept_vetoed]", () => {
    const state = play([offer({ priceMinor: 5300 }), offer({ priceMinor: 4000 }), offer({ priceMinor: 5200 })]);
    const { state: next, move } = step(state, accept("Fine, $52 it is. Deal!"));
    expect(move.action).toBe("counter");
    expect(move.terms).toEqual(terms({ priceMinor: 5000 }));
    expect(codes(move)).toEqual(["accept_vetoed", "price_above_budget"]);
    expect(move.guardrails[0].detail).toContain("Buyer agent tried to accept terms outside its limits");
    // The agent's "Deal!" must not appear on a move that is not a deal.
    expect(move.message).toBe("We can't accept those terms as they stand. We can do $50.00 for 3 illustrations with 1 revision round, delivered by Oct 7, 18:00 UTC.");
    expect(next.status).toBe("open");
    expect(next.agreedTerms).toBeNull();
  });

  it("records a vetoed accept on the buyer's first move as an offer", () => {
    const { move, state } = step(play([offer({ priceMinor: 5300 })]), accept());
    expect(move.action).toBe("offer");
    expect(move.terms?.priceMinor).toBe(5000);
    expect(codes(move)).toContain("accept_vetoed");
    expect(state.status).toBe("open");
  });

  it("vetoes for every buyer limit, not just price", () => {
    const late = play([offer({ priceMinor: 4800, deadline: inHours(60) })]);
    expect(codes(step(late, accept()).move)).toEqual(["accept_vetoed", "deadline_after_mandate"]);
    const fewer = play([offer({ priceMinor: 4000, count: 2 })]);
    expect(codes(step(fewer, accept()).move)).toEqual(["accept_vetoed", "count_outside_mandate"]);
    const noRevisions = play([offer({ priceMinor: 4800, revisionLimit: 0 })]);
    const move = step(noRevisions, accept()).move;
    expect(codes(move)).toEqual(["accept_vetoed", "revisions_below_mandate"]);
    expect(move.terms).toEqual(terms({ priceMinor: 4800, revisionLimit: 1 }));
  });

  it("turns a seller accept below its floor into a counter at the floor", () => {
    const state = play([offer(), offer({ priceMinor: 4000 })]);
    const { state: next, move } = step(state, accept("We accept $40."));
    expect(move.action).toBe("counter");
    expect(move.terms).toEqual(terms({ priceMinor: 4500 }));
    expect(codes(move)).toEqual(["accept_vetoed", "price_below_floor"]);
    expect(move.guardrails[0].detail).toContain("Seller agent tried to accept");
    expect(next.status).toBe("open");
  });

  it("vetoes a seller accept of a deadline it cannot meet", () => {
    const state = play([offer(), offer({ priceMinor: 9900, deadline: inHours(1) })], { ...ctx, mandate: { ...mandate, budgetMinor: 10_000 } });
    const move = step(state, accept(), { ...ctx, mandate: { ...mandate, budgetMinor: 10_000 } }).move;
    expect(move.action).toBe("counter");
    expect(move.terms?.deadline).toBe(inHours(2));
    expect(codes(move)).toEqual(["accept_vetoed", "deadline_too_soon"]);
  });

  it("uses the floor for the buyer's terms, not for the seller's own last offer", () => {
    // Buyer asks for 3 revisions: 4950 + 900 = 5850 → list $59, floor 4956 → $50. $47 no longer clears it.
    const roomy = { ...ctx, mandate: { ...mandate, budgetMinor: 6000 } };
    const state = play([offer(), offer({ priceMinor: 4700, revisionLimit: 3 })], roomy);
    const move = step(state, accept(), roomy).move;
    expect(move.action).toBe("counter");
    expect(move.terms).toEqual(terms({ priceMinor: 5000, revisionLimit: 3 }));
  });

  it("becomes a rejection when vetoed on the final move", () => {
    const haggle = [5300, 4000, 5290, 4100, 5280, 4200, 5200].map((priceMinor) => offer({ priceMinor }));
    const state = play(haggle);
    expect(movesRemaining(state)).toBe(1);
    expect(nextActor(state)).toBe("buyer");
    const { state: closed, move } = step(state, accept("OK, we accept $52."));
    expect(move.seq).toBe(8);
    expect(move.action).toBe("reject");
    expect(move.terms).toBeNull();
    expect(codes(move)).toEqual(["accept_vetoed", "price_above_budget"]);
    expect(move.guardrails[0].detail).toContain("recorded as a rejection");
    expect(move.message).not.toContain("accept $52");
    expect(closed.status).toBe("failed");
    expect(closed.failureReason).toBe("Buyer agent walked away");
    expect(closed.agreedTerms).toBeNull();
  });

  it("still counters when vetoed on the second-to-last move, so the other side can answer", () => {
    const state = play([5300, 4000, 5290, 4100, 5280, 4200].map((priceMinor) => offer({ priceMinor })));
    expect(movesRemaining(state)).toBe(2);
    const { state: next, move } = step(state, accept());
    expect(move.action).toBe("counter");
    expect(move.terms?.priceMinor).toBe(4500);
    expect(next.status).toBe("open");
    const { state: closed } = step(next, accept());
    expect(closed.status).toBe("agreed");
    expect(closed.agreedTerms?.priceMinor).toBe(4500);
  });

  it("can never produce an agreement outside either party's limits", () => {
    const sellerPrices = [100, 2000, 4400, 4500, 5000, 5100, 9000];
    const buyerPrices = [100, 4400, 4500, 5000, 5100, 9000];
    for (const sellerPrice of sellerPrices) {
      for (const buyerPrice of buyerPrices) {
        // Seller offers, buyer tries to accept; then buyer offers, seller tries to accept.
        const first = step(play([offer({ priceMinor: sellerPrice })]), accept()).state;
        const second = step(play([offer({ priceMinor: sellerPrice }), offer({ priceMinor: buyerPrice })]), accept()).state;
        for (const state of [first, second]) {
          if (state.status !== "agreed") continue;
          expect(state.agreedTerms?.priceMinor).toBeLessThanOrEqual(mandate.budgetMinor);
          expect(state.agreedTerms?.priceMinor).toBeGreaterThanOrEqual(4500);
        }
      }
    }
    // The only way to agree on the seller's opening is for it to already be within budget.
    expect(step(play([offer({ priceMinor: 5000 })]), accept()).state.status).toBe("agreed");
    expect(step(play([offer({ priceMinor: 5100 })]), accept()).state.status).toBe("open");
  });
});

describe("reject and exhaustion", () => {
  it("fails with the buyer walking away", () => {
    const { state, move } = step(play([offer()]), reject("Too expensive for us."));
    expect(move).toMatchObject({ action: "reject", terms: null, message: "Too expensive for us.", guardrails: [] });
    expect(state).toMatchObject({ status: "failed", failureReason: "Buyer agent walked away", agreedTerms: null });
  });

  it("fails with the seller declining", () => {
    const { state } = step(play([offer(), offer({ priceMinor: 1000 })]), reject());
    expect(state).toMatchObject({ status: "failed", failureReason: "Seller agent declined" });
    const immediate = step(initialNegotiation(), reject("We are fully booked.")).state;
    expect(immediate).toMatchObject({ status: "failed", failureReason: "Seller agent declined" });
  });

  it("fails after eight moves without agreement", () => {
    const prices = [5300, 4000, 5290, 4100, 5280, 4200, 5270, 4300];
    let state = initialNegotiation();
    for (const [i, priceMinor] of prices.entries()) {
      state = step(state, offer({ priceMinor })).state;
      if (i < prices.length - 1) expect(state.status).toBe("open");
    }
    expect(state.moves).toHaveLength(MAX_MOVES);
    expect(state.status).toBe("failed");
    expect(state.failureReason).toBe("No agreement within 8 moves");
    expect(movesRemaining(state)).toBe(0);
    expect(() => step(state, offer())).toThrow(InvalidMoveError);
  });

  it("still agrees when the eighth move is a valid accept", () => {
    const state = play([5300, 4000, 5290, 4100, 5280, 4200, 4900].map((priceMinor) => offer({ priceMinor })));
    const { state: closed, move } = step(state, accept());
    expect(move.seq).toBe(8);
    expect(closed.status).toBe("agreed");
    expect(closed.agreedTerms?.priceMinor).toBe(4900);
  });

  it("refuses to extend a state that claims to be open but has no moves left", () => {
    const exhausted = play([5300, 4000, 5290, 4100, 5280, 4200, 5270, 4300].map((priceMinor) => offer({ priceMinor })));
    const tampered: NegotiationState = { ...exhausted, status: "open", failureReason: null };
    expect(() => step(tampered, offer())).toThrow(/all 8 moves/);
  });
});

describe("private limits in messages", () => {
  it("replaces a buyer message that states its budget while offering less [private_limit_redacted]", () => {
    const { move } = step(play([offer()]), offer({ priceMinor: 4000 }, "Our budget is $50, but we'd like to pay $40."));
    expect(move.terms?.priceMinor).toBe(4000);
    expect(codes(move)).toEqual(["private_limit_redacted"]);
    expect(move.message).not.toContain("50");
    expect(move.message).toContain("$40.00");
    expect(move.guardrails[0].detail).not.toContain("$50");
  });

  it("recognises the common ways of writing the amount", () => {
    for (const leak of ["we have $50.00 for this", "max is 50 dollars", "USD 50 is the ceiling", "50 USD tops", "cap: $ 50"]) {
      const { move } = step(play([offer()]), offer({ priceMinor: 4000 }, leak));
      expect(codes(move), leak).toEqual(["private_limit_redacted"]);
    }
  });

  it("does not react to other amounts or to longer numbers containing the same digits", () => {
    for (const fine of ["We can do $40.", "Your $53 is too high for us.", "Even $500 would not buy 30 of these.", "That is 150 dollars short.", "$50.50 is odd.", "Delivery by 18:00 please, 50% upfront is not possible."]) {
      const { move } = step(play([offer()]), offer({ priceMinor: 4000 }, fine));
      expect(move.guardrails, fine).toEqual([]);
      expect(move.message).toBe(fine);
    }
  });

  it("leaves the message alone when the limit is the price on the table", () => {
    const { move } = step(play([offer()]), offer({ priceMinor: 5000 }, "We can go to $50 for the full set."));
    expect(move.guardrails).toEqual([]);
    expect(move.message).toBe("We can go to $50 for the full set.");
  });

  it("replaces a seller message that states its floor while asking for more", () => {
    const { move } = step(initialNegotiation(), offer({ priceMinor: 5300 }, "List is $53; honestly we cannot go below $45."));
    expect(codes(move)).toEqual(["private_limit_redacted"]);
    expect(move.message).toBe("Our offer: $53.00 for 3 illustrations with 1 revision round, delivered by Oct 7, 18:00 UTC.");
  });

  it("also covers accept and reject messages", () => {
    const accepting = step(play([offer({ priceMinor: 4800 })]), accept("Deal at $48 — we had up to $50 anyway.")).move;
    expect(accepting.action).toBe("accept");
    expect(codes(accepting)).toEqual(["private_limit_redacted"]);
    expect(accepting.message).toBe("Agreed: $48.00 for 3 illustrations with 1 revision round, delivered by Oct 7, 18:00 UTC.");

    const rejecting = step(play([offer(), offer({ priceMinor: 4000 })]), reject("We never go under $45, sorry.")).move;
    expect(rejecting.action).toBe("reject");
    expect(codes(rejecting)).toEqual(["private_limit_redacted"]);
    expect(rejecting.message).not.toContain("45");
  });
});

describe("guardrail codes", () => {
  it("only ever emits codes from the published list", () => {
    const states = [
      play([offer({ priceMinor: 4000.5, count: 9, revisionLimit: 9, deadline: inHours(0.1) })]),
      play([offer(), offer({ priceMinor: 990_000, deadline: inHours(900), count: 0, revisionLimit: 0 })]),
      play([offer({ priceMinor: 5300 }), accept()]),
      play([offer(), offer({ priceMinor: 4000 }, "budget $50")]),
    ];
    const emitted = new Set(states.flatMap((state) => state.moves.flatMap(codes)));
    expect(emitted.size).toBeGreaterThanOrEqual(8);
    for (const code of emitted) expect(GUARDRAIL_CODES as readonly string[]).toContain(code);
  });

  it("writes every detail as a plain sentence", () => {
    const state = play([offer({ priceMinor: 4000.5, count: 9, deadline: inHours(0.1) }), offer({ priceMinor: 9000, deadline: inHours(900), count: 0, revisionLimit: 0 })]);
    const notes = state.moves.flatMap((move) => move.guardrails);
    expect(notes.length).toBeGreaterThanOrEqual(6);
    for (const note of notes) {
      expect(note.detail).toMatch(/^[A-Z$0-9].*\.$/);
      expect(note.detail).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});
